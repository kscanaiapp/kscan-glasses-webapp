// Wearable backend integration — real Supabase Edge Function calls for the
// Meta physical device candidate.
//
// BACKEND AUTHORITY (takeover convergence, 2026-08-19):
//   The authoritative shared wearable backend is the `wearable-bridge` Edge
//   Function (pairing, sessions, frame relay, result store, action ledger) —
//   see supabase/README.md and supabase/functions/wearable-bridge/.
//   This module calls:
//     - wearable-bridge          → pairing approval/denial, session list/revoke
//     - wearable-scan            → canonical scanner gateway (scan-identify)
//     - wearable-save            → idempotent saved_scans persistence
//     - wearable-open-on-phone   → deep-link handoff
//
// Trust: the phone is the auth authority. Bridge phone-side operations run
// with the phone's Supabase user JWT (attached by invokeSupabaseFunction);
// scan/save/open run with the HUD's short-lived wearable session token.
// The deleted wearable-pairing / wearable-session functions (body-trusted
// userId — a confirmed takeover defect) must not be reintroduced.

import { invokeSupabaseFunction } from '../services/supabaseClient.js';

export const BACKEND_ERROR_CODES = Object.freeze({
  NETWORK: 'NETWORK',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  BACKEND_ERROR: 'BACKEND_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function safeInvoke(functionName, body) {
  try {
    const { data, error } = await invokeSupabaseFunction(functionName, { body });
    if (error) {
      // Supabase Functions error shapes vary; normalize.
      const code = error.code || error.statusCode || 'BACKEND_ERROR';
      return { ok: false, code, message: error.message || 'Backend error' };
    }
    if (!isObject(data)) {
      return { ok: false, code: 'INVALID_RESPONSE', message: 'Unexpected response shape' };
    }
    if (data.ok === false) {
      return { ok: false, code: data.code || 'BACKEND_ERROR', message: data.message || 'Backend error' };
    }
    return { ok: true, data };
  } catch (err) {
    if (err?.code === 'AUTH_REQUIRED') {
      return { ok: false, code: 'AUTH_REQUIRED', message: 'Authentication required' };
    }
    return { ok: false, code: 'NETWORK', message: err?.message || 'Network error' };
  }
}

// ── Pairing lifecycle (via wearable-bridge, phone JWT) ─────────────────────

/**
 * Create a pairing challenge on behalf of a wearable's local pair.request.
 * UNAUTHENTICATED by design (wearable-bridge's pair.create takes no user
 * JWT) — the wearable has no identity yet. wearableDeviceId is a fresh
 * per-attempt UUID minted by the caller (the phone, standing in for the
 * wearable in this reference topology), never the local companion-protocol
 * deviceId (which is not UUID-shaped and would fail wearable-bridge's frame
 * validation).
 * @param {string} wearableDeviceId - fresh UUID identifying this pairing attempt.
 * @param {string} [hudDeviceName] - display name/model, bounded server-side.
 */
export async function createPairingChallenge(wearableDeviceId, hudDeviceName) {
  const requestId = crypto.randomUUID();
  const frame = JSON.stringify({
    protocolVersion: 1,
    messageType: 'pair.request',
    messageId: `pair_${requestId}`,
    requestId,
    sessionId: '',
    deviceId: wearableDeviceId,
    timestamp: Date.now(),
    expiresAt: Date.now() + 60_000,
    payload: { model: String(hudDeviceName || 'K Scan Meta HUD').slice(0, 80), appVersion: '' },
  });
  const res = await safeInvoke('wearable-bridge', { operation: 'pair.create', frame });
  if (!res.ok) return res;
  const ticket = res.data.ticket;
  if (!ticket || typeof ticket.challengeCode !== 'string') {
    return { ok: false, code: 'INVALID_RESPONSE', message: 'Malformed pairing ticket' };
  }
  return {
    ok: true,
    challenge: ticket.challengeCode,
    pairingHandle: ticket.pairingHandle,
    pairingSecret: ticket.pairingSecret,
    expiresAt: ticket.expiresAt,
  };
}

/**
 * Poll for pairing outcome and, once approved, the issued wearable session.
 * UNAUTHENTICATED — trust is the pairingHandle+pairingSecret pair minted by
 * createPairingChallenge, exactly as wearable-bridge's pair.poll expects.
 */
export async function pollPairing(pairingHandle, pairingSecret) {
  const res = await safeInvoke('wearable-bridge', { operation: 'pair.poll', pairingHandle, pairingSecret });
  if (!res.ok) return res;
  const poll = res.data.poll;
  if (!poll || !Array.isArray(poll.frames)) {
    return { ok: false, code: 'INVALID_RESPONSE', message: 'Malformed poll response' };
  }
  const parsedFrames = poll.frames
    .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
    .filter(Boolean);
  if (parsedFrames.some((f) => f.messageType === 'pair.denied')) {
    return { ok: false, code: 'PAIR_DENIED', message: 'Pairing was denied' };
  }
  if (parsedFrames.some((f) => f.messageType === 'pair.expired')) {
    return { ok: false, code: 'PAIR_EXPIRED', message: 'Pairing challenge expired' };
  }
  const approved = parsedFrames.find((f) => f.messageType === 'pair.approved');
  const ready = parsedFrames.find((f) => f.messageType === 'session.ready');
  if (!poll.wearableToken || !approved) {
    return { ok: false, code: 'PAIR_PENDING', message: 'Pairing not yet approved' };
  }
  return {
    ok: true,
    wearableToken: poll.wearableToken,
    sessionId: approved.sessionId,
    sessionExpiresAt: approved.payload?.sessionExpiresAt ?? null,
    capabilities: Array.isArray(ready?.payload?.features) ? ready.payload.features : [],
  };
}

/**
 * Approve a pending pairing by the 6-digit challenge code shown on the HUD.
 * The approving user identity comes from the caller JWT — never from args.
 * @param {string} challengeCode - 6-digit code displayed on the glasses.
 * @param {string} phoneDeviceId - stable UUID for this phone.
 */
export async function approvePairingByCode(challengeCode, phoneDeviceId) {
  if (typeof challengeCode !== 'string' || !/^\d{6}$/.test(challengeCode)) {
    return { ok: false, code: 'INVALID_CHALLENGE', message: 'Challenge code must be 6 digits' };
  }
  const res = await safeInvoke('wearable-bridge', {
    operation: 'pair.approve',
    challengeCode,
    phoneDeviceId,
  });
  if (!res.ok) return res;
  return { ok: true, pairingHandle: res.data.pairingHandle, deviceModel: res.data.deviceModel };
}

/**
 * Deny a pending pairing by challenge code.
 */
export async function denyPairingByCode(challengeCode) {
  if (typeof challengeCode !== 'string' || !/^\d{6}$/.test(challengeCode)) {
    return { ok: false, code: 'INVALID_CHALLENGE', message: 'Challenge code must be 6 digits' };
  }
  return safeInvoke('wearable-bridge', { operation: 'pair.deny', challengeCode });
}

// ── Session lifecycle (via wearable-bridge, phone JWT) ─────────────────────

/**
 * List the authenticated user's active wearable sessions.
 */
export async function listWearableSessions() {
  const res = await safeInvoke('wearable-bridge', { operation: 'phone.sessions' });
  if (!res.ok) return res;
  return { ok: true, sessions: Array.isArray(res.data.sessions) ? res.data.sessions : [] };
}

/**
 * Revoke one wearable session (explicit unpair / device removal).
 */
export async function revokeWearableSession(sessionId, reason) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, code: 'INVALID_SESSION', message: 'sessionId is required' };
  }
  return safeInvoke('wearable-bridge', {
    operation: 'phone.revoke',
    sessionId,
    reason: reason === 'sign_out' ? 'sign_out' : 'user_revoked',
  });
}

/**
 * Revoke ALL wearable sessions for the authenticated user (sign-out path).
 */
export async function revokeAllWearableSessions() {
  return safeInvoke('wearable-bridge', { operation: 'phone.revoke_all' });
}

// ── Scan wrapper (wearable session token) ──────────────────────────────────

/**
 * Submit a sanitized image for wearable scan analysis.
 * @param {string} sessionToken - the HUD's wearable session token.
 * @param {string} image - sanitized JPEG data URL (privacy pipeline output).
 * @param {string} requestId - correlation ID from the bridge.
 */
export async function wearableScan(sessionToken, image, requestId) {
  const res = await safeInvoke('wearable-scan', {
    action: 'scan',
    sessionToken,
    image,
    requestId,
  });
  if (!res.ok) return res;
  return { ok: true, result: res.data.result, requestId: res.data.requestId };
}

// ── Save ───────────────────────────────────────────────────────────────────

/**
 * Save a scan result from the wearable (idempotent on resultId).
 */
export async function wearableSave(sessionToken, result, requestId) {
  const res = await safeInvoke('wearable-save', {
    action: 'save',
    sessionToken,
    result,
    requestId,
  });
  if (!res.ok) return res;
  return { ok: true, savedScanId: res.data.savedScanId, idempotent: res.data.idempotent };
}

/**
 * Phone-authorized save (no wearable token required): the phone authenticates
 * with its user JWT and saves a result it owns (backend verifies ownership
 * against wearable_results). Idempotent on resultId.
 */
export async function saveResultAsPhone(resultId, requestId) {
  if (typeof resultId !== 'string' || !resultId) {
    return { ok: false, code: 'INVALID_RESULT', message: 'resultId is required' };
  }
  const res = await safeInvoke('wearable-save', {
    action: 'save_as_phone',
    resultId,
    requestId,
  });
  if (!res.ok) return res;
  return { ok: true, savedScanId: res.data.savedScanId, idempotent: res.data.idempotent };
}

// ── Open on Phone ──────────────────────────────────────────────────────────

/**
 * Generate a deep link for phone handoff.
 */
export async function wearableOpenOnPhone(sessionToken, resultId, result) {
  const res = await safeInvoke('wearable-open-on-phone', {
    action: 'generate_link',
    sessionToken,
    resultId,
    result,
  });
  if (!res.ok) return res;
  return { ok: true, deepLink: res.data.deepLink };
}
