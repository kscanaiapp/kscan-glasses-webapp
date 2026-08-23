// Constrained wearable pairing + session — Meta companion Phase A.
//
// Trust model:
//   - The companion phone is the account/auth authority. The HUD receives
//     only a short-lived, capability-constrained wearable session.
//   - Sessions live in memory ONLY. Nothing here is persisted to storage,
//     URLs, logs, or diagnostics beyond presence/expiry metadata.
//   - No refresh tokens, bearer credentials, service-role material, or
//     permanent pairing secrets ever appear on the HUD.
//
// Pairing lifecycle:
//   unpaired → pairing (pair.request sent; 2-minute window)
//            → paired (pair.approved with matching nonce → session issued)
//   pairing → unpaired on denial, expiry, revocation, or supersede.
//   paired → unpaired on revocation, expiry, sign-out, device change, or
//   trust failure. Re-pairing is then required.

import { MESSAGE_TYPES } from './protocol.js';

export const PAIRING_STATE = Object.freeze({
  UNPAIRED: 'unpaired',
  PAIRING: 'pairing',
  PAIRED: 'paired',
});

export const WEARABLE_CAPABILITIES = Object.freeze([
  'scan.trigger',
  'result.receive',
  'result.dismiss',
  'action.save',
  'action.open_on_phone',
  'action.retry',
  'action.cancel',
]);

export const SESSION_TTL_MS = 30 * 60 * 1000; // short-lived wearable session
export const PAIRING_WINDOW_MS = 2 * 60 * 1000;
export const MAX_CAPABILITIES = WEARABLE_CAPABILITIES.length;

export const SESSION_CODES = Object.freeze({
  OK: 'OK',
  NO_SESSION: 'NO_SESSION',
  SESSION_MISMATCH: 'SESSION_MISMATCH',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  DEVICE_MISMATCH: 'DEVICE_MISMATCH',
});

export const PAIRING_ERRORS = Object.freeze({
  NO_ACTIVE_PAIRING: 'NO_ACTIVE_PAIRING',
  NONCE_MISMATCH: 'NONCE_MISMATCH',
  PAIRING_WINDOW_EXPIRED: 'PAIRING_WINDOW_EXPIRED',
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  INVALID_SESSION_EXPIRY: 'INVALID_SESSION_EXPIRY',
  INVALID_CAPABILITIES: 'INVALID_CAPABILITIES',
});

function isNonEmptyString(value, maxLen = 128) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

function makeNonce() {
  return `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a pairing/session manager for one device identity.
 * @param {object} options
 * @param {string} options.deviceId - this HUD's stable device id.
 * @param {() => number} [options.now] - clock override for tests.
 */
export function createSessionManager({ deviceId, now = () => Date.now() } = {}) {
  if (!isNonEmptyString(deviceId)) throw new Error('session manager requires a deviceId');

  let pairingState = PAIRING_STATE.UNPAIRED;
  let pairing = null; // { pairingNonce, expiresAt }
  let session = null; // { sessionId, deviceId, issuedAt, expiresAt, capabilities[], phoneDeviceName }
  let lastTerminalReason = null;

  function snapshot() {
    return {
      pairingState,
      pairingNonce: pairing ? pairing.pairingNonce : null,
      pairingExpiresAt: pairing ? pairing.expiresAt : null,
      session: session ? { ...session, capabilities: [...session.capabilities] } : null,
      lastTerminalReason,
    };
  }

  function beginPairing() {
    // A new pairing request supersedes any older one — new nonce, new window.
    pairing = { pairingNonce: makeNonce(), expiresAt: now() + PAIRING_WINDOW_MS };
    pairingState = PAIRING_STATE.PAIRING;
    lastTerminalReason = null;
    return { pairingNonce: pairing.pairingNonce, expiresAt: pairing.expiresAt };
  }

  function isPairingActive() {
    return pairingState === PAIRING_STATE.PAIRING && pairing !== null && pairing.expiresAt > now();
  }

  function nonceMatches(payload) {
    return isNonEmptyString(payload?.pairingNonce) && pairing !== null && payload.pairingNonce === pairing.pairingNonce;
  }

  function validateCapabilities(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAPABILITIES) return false;
    const seen = new Set();
    for (const cap of value) {
      if (!WEARABLE_CAPABILITIES.includes(cap) || seen.has(cap)) return false;
      seen.add(cap);
    }
    return true;
  }

  function handlePairApproved(payload) {
    const E = PAIRING_ERRORS;
    if (!isPairingActive()) return { ok: false, code: pairing ? E.PAIRING_WINDOW_EXPIRED : E.NO_ACTIVE_PAIRING };
    if (!nonceMatches(payload)) return { ok: false, code: E.NONCE_MISMATCH };
    if (!isNonEmptyString(payload.sessionId)) return { ok: false, code: E.INVALID_SESSION_ID };
    const expiresAt = payload.sessionExpiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
      || expiresAt <= now() || expiresAt > now() + SESSION_TTL_MS) {
      return { ok: false, code: E.INVALID_SESSION_EXPIRY };
    }
    if (!validateCapabilities(payload.capabilities)) return { ok: false, code: E.INVALID_CAPABILITIES };

    session = {
      sessionId: payload.sessionId,
      deviceId,
      issuedAt: now(),
      expiresAt,
      capabilities: [...payload.capabilities],
      phoneDeviceName: isNonEmptyString(payload.phoneDeviceName, 64) ? payload.phoneDeviceName : null,
    };
    pairing = null;
    pairingState = PAIRING_STATE.PAIRED;
    lastTerminalReason = null;
    return { ok: true, session: { ...session, capabilities: [...session.capabilities] } };
  }

  function endPairingTerminal(reason) {
    pairing = null;
    if (pairingState !== PAIRING_STATE.PAIRED) pairingState = PAIRING_STATE.UNPAIRED;
    lastTerminalReason = isNonEmptyString(reason, 60) ? reason : null;
  }

  function clearSession(reason) {
    session = null;
    pairing = null;
    pairingState = PAIRING_STATE.UNPAIRED;
    lastTerminalReason = isNonEmptyString(reason, 60) ? reason : null;
  }

  function isSessionValid() {
    return pairingState === PAIRING_STATE.PAIRED && session !== null && session.expiresAt > now();
  }

  function hasCapability(capability) {
    return isSessionValid() && session.capabilities.includes(capability);
  }

  /**
   * Correlate an inbound session-bearing message with the active session.
   * Returns one of SESSION_CODES.
   */
  function validateSessionMessage(message) {
    const C = SESSION_CODES;
    if (!isSessionValid()) return session ? C.SESSION_EXPIRED : C.NO_SESSION;
    if (message.sessionId !== session.sessionId) return C.SESSION_MISMATCH;
    if (message.deviceId !== deviceId) return C.DEVICE_MISMATCH;
    return C.OK;
  }

  /** True when the message type is one the active capability set permits. */
  function capabilityForMessage(messageType) {
    switch (messageType) {
      case MESSAGE_TYPES.CAPTURE_REQUEST: return 'scan.trigger';
      case MESSAGE_TYPES.RESULT_SHOW:
      case MESSAGE_TYPES.RESULT_UPDATE: return 'result.receive';
      case MESSAGE_TYPES.RESULT_DISMISS:
      case MESSAGE_TYPES.ACTION_DISMISS: return 'result.dismiss';
      case MESSAGE_TYPES.ACTION_SAVE: return 'action.save';
      case MESSAGE_TYPES.ACTION_OPEN_ON_PHONE: return 'action.open_on_phone';
      case MESSAGE_TYPES.ACTION_RETRY: return 'action.retry';
      case MESSAGE_TYPES.ACTION_CANCEL: return 'action.cancel';
      default: return null; // uncapability-gated (progress/acks/connection)
    }
  }

  /** Whether an outbound/inbound action is allowed by the session capabilities. */
  function isMessagePermitted(messageType) {
    const cap = capabilityForMessage(messageType);
    return cap === null ? isSessionValid() : hasCapability(cap);
  }

  return {
    snapshot,
    beginPairing,
    isPairingActive,
    nonceMatches,
    handlePairApproved,
    endPairingTerminal,
    clearSession,
    isSessionValid,
    hasCapability,
    isMessagePermitted,
    validateSessionMessage,
    getSessionId: () => (session ? session.sessionId : null),
    getDeviceId: () => deviceId,
  };
}
