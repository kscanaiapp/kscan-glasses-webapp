// Phone-side companion runtime — Meta companion Phase A+.
//
// This is the mobile counterpart to the HUD companionRuntime.
// It receives protocol messages from the Meta glasses, manages the real
// backend pairing/session lifecycle, runs the capture → privacy → analyze
// pipeline, and sends structured results back to the HUD.
//
// Trust model:
//   - The phone is the auth authority (Supabase JWT).
//   - The HUD receives only short-lived wearable session tokens.
//   - No long-lived refresh tokens ever leave the phone.

import { MESSAGE_TYPES, buildMessage, validateMessage } from './protocol.js';
import { handleCompanionSave } from './companionSave.js';
import { handleCompanionOpenOnPhone } from './companionOpenOnPhone.js';
import {
  createPairingChallenge,
  approvePairingChallenge,
  revokePairing,
  wearableScan,
} from './wearableBackend.js';
import { sanitizeImageBeforeUpload } from '../privacyImageSanitizer.js';

const HEARTBEAT_MS = 1000;
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 8000;

export const PHONE_STATE = Object.freeze({
  IDLE: 'idle',
  PAIRING: 'pairing',
  PAIRED: 'paired',
  CAPTURING: 'capturing',
  SCANNING: 'scanning',
  RESULT_READY: 'result_ready',
  ACTION_PENDING: 'action_pending',
  ERROR: 'error',
  DISCONNECTED: 'disconnected',
});

function isNonEmptyString(value, maxLen = 128) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

function makeNonce() {
  return `phone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a phone-side companion for managing the Meta glasses connection.
 *
 * @param {object} options
 * @param {object} options.transport - transport interface (connect, disconnect, send, subscribe, getConnectionState)
 * @param {string} options.userId - authenticated K Scan user ID
 * @param {() => string} [options.deviceId] - phone device identifier factory
 * @param {() => Promise<string>} [options.capture] - phone capture hook returning a
 *   capture payload for the privacy sanitizer. REQUIRED for real scans — in the K Scan
 *   mobile app this is the camera/gallery capture; in local QA it is the fixture
 *   generator. Default throws CAPTURE_NOT_AVAILABLE (fail closed).
 * @param {boolean} [options.autoApprove=false] - LOCAL QA ONLY: approve pairing
 *   without a user tap. Must remain false in any candidate/production context —
 *   phone approval is a required trust gate in the product contract.
 * @param {(snapshot: object) => void} [options.onStateChange]
 * @param {(message: object) => void} [options.onOutboundSent] - test hook
 */
export function createPhoneCompanion({
  transport,
  userId,
  deviceId = () => `phone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
  capture = null,
  autoApprove = false,
  onStateChange = () => {},
  onOutboundSent = () => {},
  now = () => Date.now(),
} = {}) {
  if (!transport) throw new Error('phone companion requires a transport');
  if (!isNonEmptyString(userId)) throw new Error('phone companion requires a userId');

  const phoneDeviceId = deviceId();
  let state = PHONE_STATE.IDLE;
  let pairedHudDeviceId = null;
  let currentPairingNonce = null;
  let currentChallenge = null;
  let activeSessionToken = null;
  let activeSessionId = null;
  let activeRequestId = null;
  let currentResult = null;
  let heartbeat = null;
  let lastPingAt = null;
  let lastPingSentAt = 0;
  let outstandingPingNonce = null;
  let pingSeq = 0;
  let started = false;

  const counters = { sent: 0, received: 0, dropped: 0, ignored: 0 };

  function snapshot() {
    return {
      state,
      pairedHudDeviceId,
      hasSession: activeSessionToken !== null,
      requestInFlight: activeRequestId !== null,
      hasResult: currentResult !== null,
    };
  }

  function transition(next) {
    if (state === next) return;
    state = next;
    onStateChange(snapshot());
  }

  function send(messageType, payload = {}, { requestId = activeRequestId, sessionId = activeSessionId, ttlMs } = {}) {
    const message = buildMessage(messageType, {
      requestId,
      sessionId,
      deviceId: phoneDeviceId,
      payload,
      now: now(),
      ttlMs,
    });
    if (!message) return null;
    counters.sent += 1;
    onOutboundSent(message);
    const ok = transport.send(message);
    if (!ok) transition(PHONE_STATE.DISCONNECTED);
    return message;
  }

  function synthesizeConnectionLost(reason) {
    send(MESSAGE_TYPES.CONNECTION_LOST, { reason: String(reason || 'transport-lost').slice(0, 60) }, { requestId: null, sessionId: null });
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  async function onPairRequest(msg) {
    if (state !== PHONE_STATE.IDLE && state !== PHONE_STATE.DISCONNECTED) {
      // Already paired or pairing — reject or supersede
      return;
    }
    transition(PHONE_STATE.PAIRING);
    pairedHudDeviceId = msg.deviceId;
    currentPairingNonce = msg.payload.pairingNonce;

    // Create backend challenge
    const res = await createPairingChallenge(userId, msg.deviceId, msg.payload.hudDeviceName);
    if (!res.ok) {
      send(MESSAGE_TYPES.PAIR_DENIED, { pairingNonce: currentPairingNonce, reason: 'backend-error' }, { requestId: null, sessionId: null });
      transition(PHONE_STATE.IDLE);
      return;
    }
    currentChallenge = res.challenge;

    // Send challenge to HUD (nonce confirmation)
    send(MESSAGE_TYPES.PAIR_CHALLENGE, {
      pairingNonce: currentPairingNonce,
      challenge: currentChallenge,
    }, { requestId: null, sessionId: null });

    // Phone approval is a required trust gate. Pairing completes only via an
    // explicit approvePairing() user intent from the phone UI. The autoApprove
    // option exists solely for LOCAL QA harnesses and defaults to false.
    if (autoApprove === true) {
      setTimeout(() => {
        if (state === PHONE_STATE.PAIRING && currentChallenge) {
          approvePairing();
        }
      }, 500);
    }
  }

  async function approvePairing() {
    if (state !== PHONE_STATE.PAIRING || !currentChallenge) return;

    const res = await approvePairingChallenge(currentChallenge, userId, phoneDeviceId);
    if (!res.ok) {
      send(MESSAGE_TYPES.PAIR_DENIED, { pairingNonce: currentPairingNonce, reason: 'approval-failed' }, { requestId: null, sessionId: null });
      transition(PHONE_STATE.IDLE);
      return;
    }

    activeSessionToken = res.sessionToken;
    activeSessionId = res.sessionId;

    send(MESSAGE_TYPES.PAIR_APPROVED, {
      pairingNonce: currentPairingNonce,
      sessionId: res.sessionId,
      sessionExpiresAt: new Date(res.expiresAt).getTime(),
      capabilities: res.capabilities,
      phoneDeviceName: phoneDeviceId,
    }, { requestId: null, sessionId: null });

    // Send session.ready after a brief moment
    setTimeout(() => {
      if (state === PHONE_STATE.PAIRING) {
        send(MESSAGE_TYPES.SESSION_READY, { phoneDeviceName: phoneDeviceId }, { requestId: null, sessionId: activeSessionId });
        transition(PHONE_STATE.PAIRED);
      }
    }, 300);
  }

  function denyPairing(reason) {
    if (state !== PHONE_STATE.PAIRING) return;
    send(MESSAGE_TYPES.PAIR_DENIED, { pairingNonce: currentPairingNonce, reason: reason || 'user-denied' }, { requestId: null, sessionId: null });
    transition(PHONE_STATE.IDLE);
    currentPairingNonce = null;
    currentChallenge = null;
  }

  // ── Scan pipeline ────────────────────────────────────────────────────────

  async function onCaptureRequest(msg) {
    if (state !== PHONE_STATE.PAIRED) {
      send(MESSAGE_TYPES.CAPTURE_FAILED, { code: 'NOT_PAIRED', safeMessage: 'Not paired.' }, { requestId: msg.requestId });
      return;
    }

    activeRequestId = msg.requestId;
    transition(PHONE_STATE.CAPTURING);

    send(MESSAGE_TYPES.CAPTURE_STARTED, { stageLabel: 'Capturing on phone' }, { requestId: activeRequestId });

    try {
      // Phone capture (camera or gallery)
      const captured = await phoneCapture();

      // Privacy sanitize
      transition(PHONE_STATE.SCANNING);
      send(MESSAGE_TYPES.SCAN_PROCESSING, { stage: 'privacy', stageLabel: 'Protecting privacy' }, { requestId: activeRequestId });

      const sanitized = await sanitizeImageBeforeUpload(captured);

      // Analyze via wearable-scan Edge Function (authenticated, rate-limited)
      send(MESSAGE_TYPES.SCAN_PROCESSING, { stage: 'analyzing', stageLabel: 'Finding matches' }, { requestId: activeRequestId });

      const scanRes = await wearableScan(activeSessionToken, sanitized, activeRequestId);
      if (!scanRes.ok) {
        send(MESSAGE_TYPES.SCAN_FAILED, { code: 'SCAN_BACKEND_FAILED', safeMessage: 'Analysis failed.' }, { requestId: activeRequestId });
        transition(PHONE_STATE.PAIRED);
        return;
      }

      currentResult = scanRes.result;

      send(MESSAGE_TYPES.SCAN_COMPLETED, { resultId: currentResult.resultId }, { requestId: activeRequestId });
      send(MESSAGE_TYPES.RESULT_SHOW, { result: currentResult }, { requestId: activeRequestId });
      transition(PHONE_STATE.RESULT_READY);
    } catch (err) {
      const code = err?.code || 'CAPTURE_FAILED';
      send(MESSAGE_TYPES.CAPTURE_FAILED, { code, safeMessage: err?.message || 'Capture failed.' }, { requestId: activeRequestId });
      transition(PHONE_STATE.PAIRED);
    }
  }

  // Phone capture hook. Injected by the host app (mobile camera/gallery, or a
  // LOCAL QA fixture generator). Default fails closed — no silent mock capture.
  async function phoneCapture() {
    if (typeof capture !== 'function') {
      const err = new Error('Phone capture requires a host-provided capture hook.');
      err.code = 'CAPTURE_NOT_AVAILABLE';
      throw err;
    }
    return capture();
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async function onActionSave(msg) {
    if (state !== PHONE_STATE.RESULT_READY || !currentResult) return;
    activeRequestId = msg.requestId;
    transition(PHONE_STATE.ACTION_PENDING);

    send(MESSAGE_TYPES.ACTION_ACCEPTED, { actionType: 'save', resultId: msg.payload.resultId }, { requestId: activeRequestId });

    // Guard: the HUD must save the result it is actually showing.
    if (msg.payload.resultId !== currentResult.resultId) {
      send(MESSAGE_TYPES.ACTION_FAILED, { actionType: 'save', code: 'STALE_RESULT', resultId: msg.payload.resultId, safeMessage: 'Result is no longer current.' }, { requestId: activeRequestId });
      transition(PHONE_STATE.RESULT_READY);
      return;
    }

    const res = await handleCompanionSave({ sessionToken: activeSessionToken, result: currentResult, requestId: activeRequestId });
    if (res.ok) {
      send(MESSAGE_TYPES.ACTION_COMPLETED, { actionType: 'save', resultId: msg.payload.resultId, savedScanId: res.savedScanId, idempotent: res.idempotent === true, safeMessage: 'Saved.' }, { requestId: activeRequestId });
    } else {
      send(MESSAGE_TYPES.ACTION_FAILED, { actionType: 'save', code: res.code || 'SAVE_FAILED', resultId: msg.payload.resultId, safeMessage: res.message || 'Save failed.' }, { requestId: activeRequestId });
    }
    transition(PHONE_STATE.RESULT_READY);
  }

  async function onActionOpenOnPhone(msg) {
    if (state !== PHONE_STATE.RESULT_READY || !currentResult) return;
    activeRequestId = msg.requestId;
    transition(PHONE_STATE.ACTION_PENDING);

    send(MESSAGE_TYPES.ACTION_ACCEPTED, { actionType: 'open_on_phone', resultId: msg.payload.resultId }, { requestId: activeRequestId });

    // Guard: reject open-on-phone for a stale/non-current result.
    if (msg.payload.resultId !== currentResult.resultId) {
      send(MESSAGE_TYPES.ACTION_FAILED, { actionType: 'open_on_phone', code: 'STALE_RESULT', resultId: msg.payload.resultId, safeMessage: 'Result is no longer current.' }, { requestId: activeRequestId });
      transition(PHONE_STATE.RESULT_READY);
      return;
    }

    const res = await handleCompanionOpenOnPhone({ sessionToken: activeSessionToken, result: currentResult, requestId: activeRequestId });
    if (res.ok) {
      // The host app opens res.deepLink via its router; the companion only ACKs
      // after the backend confirms the handoff record exists.
      send(MESSAGE_TYPES.ACTION_COMPLETED, { actionType: 'open_on_phone', resultId: msg.payload.resultId, deepLink: res.deepLink, safeMessage: 'Opened on phone.' }, { requestId: activeRequestId });
    } else {
      send(MESSAGE_TYPES.ACTION_FAILED, { actionType: 'open_on_phone', code: res.code || 'OPEN_FAILED', resultId: msg.payload.resultId, safeMessage: res.message || 'Open failed.' }, { requestId: activeRequestId });
    }
    transition(PHONE_STATE.RESULT_READY);
  }

  function onActionDismiss(msg) {
    currentResult = null;
    activeRequestId = null;
    transition(PHONE_STATE.PAIRED);
  }

  function onActionCancel(msg) {
    // Cancel any in-flight scan
    activeRequestId = null;
    currentResult = null;
    transition(PHONE_STATE.PAIRED);
  }

  // ── Connection liveness ──────────────────────────────────────────────────

  function handleInbound(raw) {
    const verdict = validateMessage(raw, { deviceId: phoneDeviceId, paired: state !== PHONE_STATE.IDLE, now: now() });
    if (!verdict.ok) {
      counters.dropped += 1;
      return;
    }
    const message = verdict.message;
    counters.received += 1;

    if (message.messageType === MESSAGE_TYPES.CONNECTION_PING) {
      send(MESSAGE_TYPES.CONNECTION_PONG, { nonce: message.payload.nonce }, { requestId: null, sessionId: null });
      return;
    }
    if (message.messageType === MESSAGE_TYPES.CONNECTION_PONG) {
      if (outstandingPingNonce !== null && message.payload.nonce === outstandingPingNonce) {
        lastPingAt = null;
        outstandingPingNonce = null;
      }
      return;
    }

    // Dispatch by type
    switch (message.messageType) {
      case MESSAGE_TYPES.PAIR_REQUEST:
        onPairRequest(message);
        break;
      case MESSAGE_TYPES.CAPTURE_REQUEST:
        onCaptureRequest(message);
        break;
      case MESSAGE_TYPES.ACTION_SAVE:
        onActionSave(message);
        break;
      case MESSAGE_TYPES.ACTION_OPEN_ON_PHONE:
        onActionOpenOnPhone(message);
        break;
      case MESSAGE_TYPES.ACTION_DISMISS:
        onActionDismiss(message);
        break;
      case MESSAGE_TYPES.ACTION_CANCEL:
        onActionCancel(message);
        break;
      case MESSAGE_TYPES.CONNECTION_LOST:
        transition(PHONE_STATE.DISCONNECTED);
        break;
      default:
        counters.ignored += 1;
    }
  }

  function heartbeatTick() {
    const transportState = transport.getConnectionState();
    if (state !== PHONE_STATE.DISCONNECTED && transportState !== 'open') {
      transition(PHONE_STATE.DISCONNECTED);
      return;
    }

    // Liveness ping
    if (transportState === 'open' && outstandingPingNonce === null && now() - lastPingSentAt >= PING_INTERVAL_MS) {
      pingSeq += 1;
      lastPingAt = now();
      lastPingSentAt = now();
      outstandingPingNonce = `phone-probe-${pingSeq}`;
      send(MESSAGE_TYPES.CONNECTION_PING, { nonce: outstandingPingNonce }, { requestId: null, sessionId: null });
    }
    if (outstandingPingNonce !== null && lastPingAt && now() - lastPingAt >= PING_TIMEOUT_MS) {
      lastPingAt = null;
      outstandingPingNonce = null;
      synthesizeConnectionLost('pong-timeout');
    }
  }

  const companion = {
    start() {
      if (started) return;
      started = true;
      transport.connect();
      transport.subscribe(handleInbound);
      heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    },
    stop() {
      started = false;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      transport.disconnect();
    },
    // User intents from phone UI
    approvePairing,
    denyPairing,
    unpair() {
      if (activeSessionId) {
        revokePairing(null, userId, 'user-unpair'); // pairingId not tracked here; backend handles by user+device
      }
      activeSessionToken = null;
      activeSessionId = null;
      pairedHudDeviceId = null;
      currentResult = null;
      transition(PHONE_STATE.IDLE);
    },
    getSnapshot: snapshot,
    getDiagnostics() {
      return {
        state,
        pairedHudDeviceId,
        hasSession: activeSessionToken !== null,
        requestInFlight: activeRequestId !== null,
        hasResult: currentResult !== null,
        transport: transport.getConnectionState(),
        sent: counters.sent,
        received: counters.received,
        dropped: counters.dropped,
        ignored: counters.ignored,
      };
    },
    // Test hooks
    __test: { handleInbound, heartbeatTick, send },
  };

  return companion;
}
