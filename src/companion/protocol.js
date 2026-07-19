// Canonical Meta companion protocol — kscan.meta.companion.v1
//
// This module is the SINGLE source of truth for the versioned message
// envelope, message families, per-type payload schemas, and the canonical
// decoder used by both the Meta HUD runtime and the development mock phone
// companion. Do not implement message types that have no defined behavior.
//
// Trust layering (do not weaken):
//   1. Transport trust (origin/source pinning) — src/messageTrust.js stays
//      authoritative; this module assumes transport trust already passed.
//   2. Envelope + schema validation — this module.
//   3. Session/device/request correlation + lifecycle — session.js and
//      runtimeState.js.
//
// Size policy:
//   - Every message must serialize below MAX_MESSAGE_BYTES (128 KB hard).
//   - Structured result payloads must stay below MAX_RESULT_PAYLOAD_BYTES
//     (100 KB). Results carry structured fields only — never image data.
//
// Clock policy:
//   - timestamp must not be in the future beyond CLOCK_SKEW_MS.
//   - expiresAt must be present, after timestamp, within MAX_MESSAGE_TTL_MS,
//     and still in the future at decode time (expired messages rejected).

export const PROTOCOL_VERSION = 'kscan.meta.companion.v1';

export const MAX_MESSAGE_BYTES = 128 * 1024;
export const MAX_RESULT_PAYLOAD_BYTES = 100 * 1024;
export const CLOCK_SKEW_MS = 30 * 1000;
export const MAX_MESSAGE_TTL_MS = 5 * 60 * 1000;

// ── Message families ─────────────────────────────────────────────────────
export const MESSAGE_TYPES = Object.freeze({
  // Pairing
  PAIR_REQUEST: 'pair.request',
  PAIR_CHALLENGE: 'pair.challenge',
  PAIR_APPROVED: 'pair.approved',
  PAIR_DENIED: 'pair.denied',
  PAIR_EXPIRED: 'pair.expired',
  PAIR_REVOKED: 'pair.revoked',
  // Session
  SESSION_READY: 'session.ready',
  SESSION_REFRESH_REQUIRED: 'session.refresh_required',
  SESSION_REVOKED: 'session.revoked',
  SESSION_ERROR: 'session.error',
  // Capture (phone-side camera authority)
  CAPTURE_REQUEST: 'capture.request',
  CAPTURE_STARTED: 'capture.started',
  CAPTURE_COMPLETED: 'capture.completed',
  CAPTURE_FAILED: 'capture.failed',
  CAPTURE_CANCELLED: 'capture.cancelled',
  // Scan lifecycle
  SCAN_PROCESSING: 'scan.processing',
  SCAN_PROGRESS: 'scan.progress',
  SCAN_COMPLETED: 'scan.completed',
  SCAN_FAILED: 'scan.failed',
  SCAN_CANCELLED: 'scan.cancelled',
  // Result handoff
  RESULT_SHOW: 'result.show',
  RESULT_UPDATE: 'result.update',
  RESULT_DISMISS: 'result.dismiss',
  // Action return channel (HUD → phone)
  ACTION_SAVE: 'action.save',
  ACTION_OPEN_ON_PHONE: 'action.open_on_phone',
  ACTION_RETRY: 'action.retry',
  ACTION_CANCEL: 'action.cancel',
  ACTION_DISMISS: 'action.dismiss',
  // Action acknowledgements (phone → HUD)
  ACTION_ACCEPTED: 'action.accepted',
  ACTION_COMPLETED: 'action.completed',
  ACTION_FAILED: 'action.failed',
  // Connection liveness
  CONNECTION_PING: 'connection.ping',
  CONNECTION_PONG: 'connection.pong',
  CONNECTION_LOST: 'connection.lost',
  CONNECTION_RESTORED: 'connection.restored',
});

const ALL_TYPES = new Set(Object.values(MESSAGE_TYPES));

// Types that terminate a request lifecycle — duplicates of these must be
// suppressed by the runtime (duplicate terminal events are rejected).
const TERMINAL_TYPES = new Set([
  MESSAGE_TYPES.PAIR_DENIED,
  MESSAGE_TYPES.PAIR_EXPIRED,
  MESSAGE_TYPES.PAIR_REVOKED,
  MESSAGE_TYPES.SESSION_REVOKED,
  MESSAGE_TYPES.SESSION_ERROR,
  MESSAGE_TYPES.CAPTURE_COMPLETED,
  MESSAGE_TYPES.CAPTURE_FAILED,
  MESSAGE_TYPES.CAPTURE_CANCELLED,
  MESSAGE_TYPES.SCAN_COMPLETED,
  MESSAGE_TYPES.SCAN_FAILED,
  MESSAGE_TYPES.SCAN_CANCELLED,
  MESSAGE_TYPES.ACTION_COMPLETED,
  MESSAGE_TYPES.ACTION_FAILED,
]);

export function isTerminalType(messageType) {
  return TERMINAL_TYPES.has(messageType);
}

// Session-bearing messages: everything except the pairing handshake and the
// raw connection family (transport-level signals that must be decodable even
// while the session state is being re-validated after a drop).
const SESSION_BEARING_TYPES = new Set(ALL_TYPES);
for (const t of [
  MESSAGE_TYPES.PAIR_REQUEST,
  MESSAGE_TYPES.PAIR_CHALLENGE,
  MESSAGE_TYPES.PAIR_APPROVED,
  MESSAGE_TYPES.PAIR_DENIED,
  MESSAGE_TYPES.PAIR_EXPIRED,
  MESSAGE_TYPES.CONNECTION_PING,
  MESSAGE_TYPES.CONNECTION_PONG,
  MESSAGE_TYPES.CONNECTION_LOST,
  MESSAGE_TYPES.CONNECTION_RESTORED,
]) {
  SESSION_BEARING_TYPES.delete(t);
}

export function isSessionBearingType(messageType) {
  return SESSION_BEARING_TYPES.has(messageType);
}

// Request-correlated messages must carry a non-empty requestId.
const REQUEST_CORRELATED_TYPES = new Set([
  MESSAGE_TYPES.CAPTURE_REQUEST,
  MESSAGE_TYPES.CAPTURE_STARTED,
  MESSAGE_TYPES.CAPTURE_COMPLETED,
  MESSAGE_TYPES.CAPTURE_FAILED,
  MESSAGE_TYPES.CAPTURE_CANCELLED,
  MESSAGE_TYPES.SCAN_PROCESSING,
  MESSAGE_TYPES.SCAN_PROGRESS,
  MESSAGE_TYPES.SCAN_COMPLETED,
  MESSAGE_TYPES.SCAN_FAILED,
  MESSAGE_TYPES.SCAN_CANCELLED,
  MESSAGE_TYPES.RESULT_SHOW,
  MESSAGE_TYPES.RESULT_UPDATE,
  MESSAGE_TYPES.RESULT_DISMISS,
  MESSAGE_TYPES.ACTION_SAVE,
  MESSAGE_TYPES.ACTION_OPEN_ON_PHONE,
  MESSAGE_TYPES.ACTION_RETRY,
  MESSAGE_TYPES.ACTION_CANCEL,
  MESSAGE_TYPES.ACTION_DISMISS,
  MESSAGE_TYPES.ACTION_ACCEPTED,
  MESSAGE_TYPES.ACTION_COMPLETED,
  MESSAGE_TYPES.ACTION_FAILED,
]);

export function isRequestCorrelatedType(messageType) {
  return REQUEST_CORRELATED_TYPES.has(messageType);
}

// ── Validation codes ─────────────────────────────────────────────────────
export const PROTOCOL_ERRORS = Object.freeze({
  OVERSIZED_MESSAGE: 'OVERSIZED_MESSAGE',
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  UNEXPECTED_FIELDS: 'UNEXPECTED_FIELDS',
  UNKNOWN_VERSION: 'UNKNOWN_VERSION',
  UNKNOWN_MESSAGE_TYPE: 'UNKNOWN_MESSAGE_TYPE',
  MISSING_MESSAGE_ID: 'MISSING_MESSAGE_ID',
  MISSING_REQUEST_ID: 'MISSING_REQUEST_ID',
  MISSING_SESSION_ID: 'MISSING_SESSION_ID',
  MISSING_DEVICE_ID: 'MISSING_DEVICE_ID',
  WRONG_DEVICE: 'WRONG_DEVICE',
  MISSING_TIMESTAMP: 'MISSING_TIMESTAMP',
  FUTURE_TIMESTAMP: 'FUTURE_TIMESTAMP',
  MISSING_EXPIRY: 'MISSING_EXPIRY',
  INVALID_EXPIRY: 'INVALID_EXPIRY',
  EXPIRED_MESSAGE: 'EXPIRED_MESSAGE',
  MISSING_PAYLOAD: 'MISSING_PAYLOAD',
  MALFORMED_PAYLOAD: 'MALFORMED_PAYLOAD',
  UNSAFE_URL: 'UNSAFE_URL',
  UNPAIRED_SENDER: 'UNPAIRED_SENDER',
});

const ENVELOPE_FIELDS = new Set([
  'protocolVersion',
  'messageType',
  'messageId',
  'requestId',
  'sessionId',
  'deviceId',
  'timestamp',
  'expiresAt',
  'payload',
]);

// ── Per-type payload schemas ─────────────────────────────────────────────
// Each schema: { fields: Set<string>, required: string[] }. Payloads must
// be plain objects; unknown fields are rejected (strict schemas).
const PAYLOAD_SCHEMAS = {
  [MESSAGE_TYPES.PAIR_REQUEST]: {
    required: ['pairingNonce'],
    fields: new Set(['pairingNonce', 'hudDeviceName', 'requestedCapabilities']),
  },
  [MESSAGE_TYPES.PAIR_CHALLENGE]: {
    required: ['pairingNonce'],
    fields: new Set(['pairingNonce', 'challenge']),
  },
  [MESSAGE_TYPES.PAIR_APPROVED]: {
    required: ['pairingNonce', 'sessionId', 'sessionExpiresAt', 'capabilities'],
    fields: new Set(['pairingNonce', 'sessionId', 'sessionExpiresAt', 'capabilities', 'phoneDeviceName']),
  },
  [MESSAGE_TYPES.PAIR_DENIED]: {
    required: [],
    fields: new Set(['pairingNonce', 'reason']),
  },
  [MESSAGE_TYPES.PAIR_EXPIRED]: {
    required: [],
    fields: new Set(['pairingNonce', 'reason']),
  },
  [MESSAGE_TYPES.PAIR_REVOKED]: {
    required: [],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.SESSION_READY]: {
    required: [],
    fields: new Set(['phoneDeviceName']),
  },
  [MESSAGE_TYPES.SESSION_REFRESH_REQUIRED]: {
    required: ['reason'],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.SESSION_REVOKED]: {
    required: [],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.SESSION_ERROR]: {
    required: ['code'],
    fields: new Set(['code', 'safeMessage']),
  },
  [MESSAGE_TYPES.CAPTURE_REQUEST]: {
    required: [],
    fields: new Set(['scanIntent']),
  },
  [MESSAGE_TYPES.CAPTURE_STARTED]: {
    required: [],
    fields: new Set(['stageLabel']),
  },
  [MESSAGE_TYPES.CAPTURE_COMPLETED]: {
    required: [],
    // Result-first architecture: capture.completed carries metadata only,
    // never image data. Analysis output arrives via result.show.
    fields: new Set(['captureMeta']),
  },
  [MESSAGE_TYPES.CAPTURE_FAILED]: {
    required: ['code'],
    fields: new Set(['code', 'safeMessage']),
  },
  [MESSAGE_TYPES.CAPTURE_CANCELLED]: {
    required: [],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.SCAN_PROCESSING]: {
    required: ['stage'],
    fields: new Set(['stage', 'stageLabel']),
  },
  [MESSAGE_TYPES.SCAN_PROGRESS]: {
    required: ['stage'],
    fields: new Set(['stage', 'stageLabel', 'percent']),
  },
  [MESSAGE_TYPES.SCAN_COMPLETED]: {
    required: [],
    fields: new Set(['resultId']),
  },
  [MESSAGE_TYPES.SCAN_FAILED]: {
    required: ['code'],
    fields: new Set(['code', 'safeMessage']),
  },
  [MESSAGE_TYPES.SCAN_CANCELLED]: {
    required: [],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.RESULT_SHOW]: {
    required: ['result'],
    fields: new Set(['result']),
  },
  [MESSAGE_TYPES.RESULT_UPDATE]: {
    required: ['result'],
    fields: new Set(['result']),
  },
  [MESSAGE_TYPES.RESULT_DISMISS]: {
    required: [],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.ACTION_SAVE]: {
    required: ['resultId'],
    fields: new Set(['resultId']),
  },
  [MESSAGE_TYPES.ACTION_OPEN_ON_PHONE]: {
    required: ['resultId'],
    fields: new Set(['resultId']),
  },
  [MESSAGE_TYPES.ACTION_RETRY]: {
    required: [],
    fields: new Set(['resultId']),
  },
  [MESSAGE_TYPES.ACTION_CANCEL]: {
    required: [],
    fields: new Set(['reason']),
  },
  [MESSAGE_TYPES.ACTION_DISMISS]: {
    required: ['resultId'],
    fields: new Set(['resultId']),
  },
  [MESSAGE_TYPES.ACTION_ACCEPTED]: {
    required: ['actionType'],
    fields: new Set(['actionType', 'resultId']),
  },
  [MESSAGE_TYPES.ACTION_COMPLETED]: {
    required: ['actionType'],
    fields: new Set(['actionType', 'resultId', 'safeMessage']),
  },
  [MESSAGE_TYPES.ACTION_FAILED]: {
    required: ['actionType', 'code'],
    fields: new Set(['actionType', 'code', 'resultId', 'safeMessage']),
  },
  [MESSAGE_TYPES.CONNECTION_PING]: {
    required: ['nonce'],
    fields: new Set(['nonce']),
  },
  [MESSAGE_TYPES.CONNECTION_PONG]: {
    required: ['nonce'],
    fields: new Set(['nonce']),
  },
  [MESSAGE_TYPES.CONNECTION_LOST]: {
    required: ['reason'],
    fields: new Set(['reason', 'code']),
  },
  [MESSAGE_TYPES.CONNECTION_RESTORED]: {
    required: [],
    fields: new Set(['resumedRequestId']),
  },
};

// ── URL safety ───────────────────────────────────────────────────────────
// https: everywhere; http: only for localhost dev endpoints. Anything else
// (javascript:, data:, file:, protocol-relative, malformed) is unsafe.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isSafeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)) return true;
  return false;
}

// ── ID / string helpers ──────────────────────────────────────────────────
function isNonEmptyString(value, maxLen = 128) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

let idCounter = 0;
/** Compact unique message id — time-ordered, collision-safe per session. */
export function makeMessageId(prefix = 'msg') {
  idCounter = (idCounter + 1) % 0xffff;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${rand}`;
}

// ── Canonical encoder ────────────────────────────────────────────────────
/**
 * Build a protocol envelope. requestId/sessionId are nullable ONLY where
 * the type permits (pair.* family, connection.ping/pong). Returns null when
 * asked to build an invalid envelope — callers must not send it.
 */
export function buildMessage(messageType, {
  requestId = null,
  sessionId = null,
  deviceId,
  payload = {},
  now = Date.now(),
  ttlMs = 60 * 1000,
} = {}) {
  if (!ALL_TYPES.has(messageType)) return null;
  if (!isNonEmptyString(deviceId)) return null;
  if (isSessionBearingType(messageType) && !isNonEmptyString(sessionId)) return null;
  if (isRequestCorrelatedType(messageType) && !isNonEmptyString(requestId)) return null;
  const ttl = Math.min(Math.max(1, ttlMs), MAX_MESSAGE_TTL_MS);
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageType,
    messageId: makeMessageId(messageType.split('.')[0]),
    requestId,
    sessionId,
    deviceId,
    timestamp: now,
    expiresAt: now + ttl,
    payload,
  };
}

// ── Canonical decoder ────────────────────────────────────────────────────
/**
 * Validate a raw inbound message.
 *
 * @param {unknown} raw - the decoded postMessage/WS payload (object form).
 * @param {object} context
 * @param {string} context.deviceId - THIS device's id; inbound messages must
 *   target it. (The mock phone validates against its own id likewise.)
 * @param {number} [context.now] - clock override for tests.
 * @param {boolean} [context.paired] - whether a session is active; when
 *   false, session-bearing messages are rejected as UNPAIRED_SENDER.
 * @param {string} [context.serializedSize] - optional pre-measured byte size
 *   (transports that serialize before decode should pass the wire size).
 * @returns {{ ok: boolean, code?: string, message?: object }}
 */
export function validateMessage(raw, context = {}) {
  const { deviceId, now = Date.now(), paired = true } = context;
  const E = PROTOCOL_ERRORS;

  // Size ceiling (hard). Measure the canonical serialization when the
  // transport did not supply a wire size.
  let size = typeof context.serializedSize === 'number' ? context.serializedSize : 0;
  if (!size) {
    try {
      size = JSON.stringify(raw)?.length ?? 0;
    } catch {
      size = 0;
    }
  }
  if (!size || size > MAX_MESSAGE_BYTES) return { ok: false, code: E.OVERSIZED_MESSAGE };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: E.NOT_AN_OBJECT };

  // Strict envelope: no unexpected top-level fields.
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_FIELDS.has(key)) return { ok: false, code: E.UNEXPECTED_FIELDS };
  }

  if (raw.protocolVersion !== PROTOCOL_VERSION) return { ok: false, code: E.UNKNOWN_VERSION };
  if (!ALL_TYPES.has(raw.messageType)) return { ok: false, code: E.UNKNOWN_MESSAGE_TYPE };

  if (!isNonEmptyString(raw.messageId)) return { ok: false, code: E.MISSING_MESSAGE_ID };
  if (isRequestCorrelatedType(raw.messageType) && !isNonEmptyString(raw.requestId)) {
    return { ok: false, code: E.MISSING_REQUEST_ID };
  }
  if (raw.requestId !== null && !isNonEmptyString(raw.requestId)) {
    return { ok: false, code: E.MISSING_REQUEST_ID };
  }
  if (isSessionBearingType(raw.messageType) && !isNonEmptyString(raw.sessionId)) {
    return { ok: false, code: E.MISSING_SESSION_ID };
  }
  if (raw.sessionId !== null && !isNonEmptyString(raw.sessionId)) {
    return { ok: false, code: E.MISSING_SESSION_ID };
  }
  if (!isNonEmptyString(raw.deviceId)) return { ok: false, code: E.MISSING_DEVICE_ID };
  if (isNonEmptyString(deviceId) && raw.deviceId !== deviceId) {
    return { ok: false, code: E.WRONG_DEVICE };
  }

  if (!isFiniteNumber(raw.timestamp)) return { ok: false, code: E.MISSING_TIMESTAMP };
  if (raw.timestamp > now + CLOCK_SKEW_MS) return { ok: false, code: E.FUTURE_TIMESTAMP };
  if (!isFiniteNumber(raw.expiresAt)) return { ok: false, code: E.MISSING_EXPIRY };
  if (raw.expiresAt <= raw.timestamp || raw.expiresAt - raw.timestamp > MAX_MESSAGE_TTL_MS) {
    return { ok: false, code: E.INVALID_EXPIRY };
  }
  if (raw.expiresAt <= now) return { ok: false, code: E.EXPIRED_MESSAGE };

  // Session-bearing messages require an active pairing on the receiver.
  if (!paired && isSessionBearingType(raw.messageType)) {
    return { ok: false, code: E.UNPAIRED_SENDER };
  }

  // Payload schema validation (strict fields).
  const schema = PAYLOAD_SCHEMAS[raw.messageType];
  const payload = raw.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: E.MISSING_PAYLOAD };
  }
  for (const key of Object.keys(payload)) {
    if (!schema.fields.has(key)) return { ok: false, code: E.MALFORMED_PAYLOAD };
  }
  for (const key of schema.required) {
    const value = payload[key];
    if (value === undefined || value === null) return { ok: false, code: E.MALFORMED_PAYLOAD };
  }

  // Result payloads: bounded + no unsafe URLs anywhere in known URL slots.
  if (raw.messageType === MESSAGE_TYPES.RESULT_SHOW || raw.messageType === MESSAGE_TYPES.RESULT_UPDATE) {
    let resultSize = 0;
    try {
      resultSize = JSON.stringify(payload.result)?.length ?? 0;
    } catch {
      // Unserializable result payload — resultSize stays 0 → rejected below.
    }
    if (!resultSize || resultSize > MAX_RESULT_PAYLOAD_BYTES) {
      return { ok: false, code: E.MALFORMED_PAYLOAD };
    }
    if (containsUnsafeUrl(payload.result)) return { ok: false, code: E.UNSAFE_URL };
  }

  return { ok: true, message: raw };
}

// Scan known URL-bearing fields of a result payload for unsafe URLs.
// Deep-free of assumptions: any key ending in 'Url' or named 'href' must
// hold a safe URL when it holds a non-empty string.
function containsUnsafeUrl(node, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return false;
  if (Array.isArray(node)) return node.some((v) => containsUnsafeUrl(v, depth + 1));
  if (typeof node === 'object') {
    return Object.entries(node).some(([key, value]) => {
      if ((key.endsWith('Url') || key === 'href') && typeof value === 'string' && value.trim()) {
        if (!isSafeUrl(value)) return true;
      }
      return containsUnsafeUrl(value, depth + 1);
    });
  }
  return false;
}

/** Serialize for the wire. Returns null when the message is oversized. */
export function serializeMessage(message) {
  try {
    const text = JSON.stringify(message);
    return text.length <= MAX_MESSAGE_BYTES ? text : null;
  } catch {
    return null;
  }
}
