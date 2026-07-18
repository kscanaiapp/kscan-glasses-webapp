// Bridge state scaffold — Phase 28A, hardened for the hardware-validation
// candidate (Phase 31 WS7: explicit settle on cancel/timeout/supersede).
//
// Minimal, safe client-side state machine for the future DAT/camera bridge.
// This scaffold lets the simulator (and later the Meta runtime) drive HUD
// bridge status via postMessage events BEFORE real hardware validation.
//
// TODO: Replace scaffold with real DAT/mobile bridge call after hardware validation.
//
// SAFETY RULES (do not weaken):
//   - State stores status + safe metadata only — never base64, never image
//     payloads, never tokens.
//   - Logs are DEV-only and log status strings only.
//   - Error text shown in HUD is clamped short.
//   - This scaffold never triggers real camera capture and never posts
//     image data anywhere.
//
// LIFECYCLE RULES (do not weaken):
//   - Every pending requestCapture() promise is ALWAYS settled — resolve,
//     reject, timeout, cancel, or supersede. Never silently dropped.
//   - Cancel/Back/replacement scans reject with a safe code
//     (BRIDGE_CANCELLED / BRIDGE_SUPERSEDED / BRIDGE_TIMEOUT / STALE_CAPTURE).
//   - Inbound events carrying a requestId that does not match the active
//     request are stale and ignored.
//
// Origin note: inbound trust is evaluated by the canonical evaluator in
// src/messageTrust.js (same-origin default; explicit allowlist for hardware
// testing; no wildcards; source pinned to the parent window).

import { buildMessageOriginAllowlist, evaluateMessageTrust } from './messageTrust.js';

export const BRIDGE_STATUS = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CAPTURING: 'capturing',
  SUCCESS: 'success',
  ERROR: 'error',
  TIMEOUT: 'timeout',
};

export const BRIDGE_CANCEL_CODES = {
  CANCELLED: 'BRIDGE_CANCELLED',
  SUPERSEDED: 'BRIDGE_SUPERSEDED',
  TIMEOUT: 'BRIDGE_TIMEOUT',
  STALE: 'STALE_CAPTURE',
};

const REQUEST_TIMEOUT_MS = 10000;
const MAX_ERROR_LEN = 60;

const state = {
  status: BRIDGE_STATUS.IDLE,
  lastError: null,
  imageMetadata: null,
};

const listeners = new Set();
let listenerInstalled = false;
let timeoutId = null;
let pendingRequest = null;
let requestSeq = 0;

// Maps inbound event types (including kscan: aliases) to scaffold actions.
const TYPE_ALIASES = {
  'capture.request': 'request',
  'kscan:capture-request': 'request',
  'capture.capturing': 'capturing',
  'kscan:capture-capturing': 'capturing',
  'capture.success': 'success',
  'kscan:capture-success': 'success',
  'capture.error': 'error',
  'kscan:capture-error': 'error',
  'photo-captured': 'photoCaptured',
  'photo-capture-error': 'photoCaptureError',
};

function devLog(status) {
  try {
    if (import.meta.env.DEV) console.log('[Bridge] State:', status); // status only — never payloads
  } catch {
    // env unavailable (e.g. tests) — stay silent
  }
}

function makeBridgeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function clampErrorText(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : 'Bridge error.';
  return text.length <= MAX_ERROR_LEN ? text : `${text.slice(0, MAX_ERROR_LEN - 1).trim()}…`;
}

function validateImagePayload(image) {
  if (typeof image !== 'string') return false;
  const trimmed = image.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('data:image/')) return false;
  return true;
}

// Whitelist-copies safe fields only. Raw payloads/base64 are never stored.
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {
    timestamp: typeof meta.timestamp === 'string' && meta.timestamp.trim()
      ? meta.timestamp.trim()
      : new Date().toISOString(),
  };
  if (typeof meta.size === 'number' && Number.isFinite(meta.size)) out.size = meta.size;
  else if (typeof meta.size === 'string' && meta.size.length <= 20) out.size = meta.size;
  if (typeof meta.width === 'number' && Number.isFinite(meta.width)) out.width = meta.width;
  if (typeof meta.height === 'number' && Number.isFinite(meta.height)) out.height = meta.height;
  return out;
}

export function getBridgeState() {
  return {
    status: state.status,
    lastError: state.lastError,
    imageMetadata: state.imageMetadata ? { ...state.imageMetadata } : null,
  };
}

function notify() {
  const snapshot = getBridgeState();
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch {
      // Listener failures must never break bridge state handling.
    }
  });
}

function setStatus(status, { lastError = null, imageMetadata = null } = {}) {
  state.status = status;
  state.lastError = lastError;
  state.imageMetadata = status === BRIDGE_STATUS.SUCCESS ? imageMetadata : null;
  devLog(status);
  notify();
}

function clearPendingTimeout() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

/**
 * Settle the pending request promise with a rejection carrying a safe code.
 * Clears the per-request timeout and releases the request reference.
 * Returns true when a pending promise was settled.
 */
function rejectPendingRequest(code, message) {
  if (!pendingRequest) return false;
  const pending = pendingRequest;
  pendingRequest = null;
  if (pending.timeoutId) clearTimeout(pending.timeoutId);
  pending.reject(makeBridgeError(code, message));
  return true;
}

/**
 * Settle the pending request promise with a success value.
 * Clears the per-request timeout and releases the request reference.
 */
function resolvePendingRequest(value) {
  if (!pendingRequest) return false;
  const pending = pendingRequest;
  pendingRequest = null;
  if (pending.timeoutId) clearTimeout(pending.timeoutId);
  pending.resolve(value);
  return true;
}

// Whether an inbound event belongs to the active request. Events that carry
// no requestId are accepted for compatibility with the simulator scaffold;
// events carrying a mismatched requestId are stale.
function matchesActiveRequest(data) {
  const incomingId = typeof data?.requestId === 'string' && data.requestId ? data.requestId : null;
  if (!incomingId) return true; // legacy/untagged event — accepted
  return Boolean(pendingRequest) && pendingRequest.requestId === incomingId;
}

function armTimeout() {
  clearPendingTimeout();
  timeoutId = setTimeout(() => {
    if (state.status === BRIDGE_STATUS.REQUESTING || state.status === BRIDGE_STATUS.CAPTURING) {
      setStatus(BRIDGE_STATUS.TIMEOUT, { lastError: 'Bridge timed out.' });
      rejectPendingRequest(BRIDGE_CANCEL_CODES.TIMEOUT, 'Bridge timed out.');
    }
  }, REQUEST_TIMEOUT_MS);
}

/** Subscribe to bridge state changes. Returns an unsubscribe function. */
export function subscribeBridgeState(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Simulator/dev helper — resets scaffold to idle. Safe metadata only. */
export function resetBridgeState() {
  clearPendingTimeout();
  rejectPendingRequest('BRIDGE_ERROR', 'Bridge reset.');
  setStatus(BRIDGE_STATUS.IDLE);
}

/**
 * Explicitly cancel the active capture request (user Cancel/Back, screen
 * exit, or replacement scan). Settles the pending promise with
 * BRIDGE_CANCELLED, clears the timeout, returns the state machine to idle.
 * Idempotent: safe to call with nothing pending.
 */
export function cancelBridgeCapture() {
  clearPendingTimeout();
  const hadPending = rejectPendingRequest(BRIDGE_CANCEL_CODES.CANCELLED, 'Capture cancelled.');
  if (state.status === BRIDGE_STATUS.REQUESTING || state.status === BRIDGE_STATUS.CAPTURING) {
    setStatus(BRIDGE_STATUS.IDLE);
  }
  return hadPending;
}

/** True while a capture request promise is pending. */
export function hasPendingCapture() {
  return pendingRequest !== null;
}

export function requestCapture() {
  return new Promise((resolve, reject) => {
    // A replacement scan supersedes any older pending request — explicitly,
    // so the older caller never hangs.
    rejectPendingRequest(BRIDGE_CANCEL_CODES.SUPERSEDED, 'Superseded by a new capture request.');
    clearPendingTimeout();

    requestSeq += 1;
    const requestId = `capture-${requestSeq}`;
    const requestTimeoutId = setTimeout(() => {
      if (pendingRequest && pendingRequest.requestId === requestId) {
        rejectPendingRequest(BRIDGE_CANCEL_CODES.TIMEOUT, 'Bridge timed out.');
        setStatus(BRIDGE_STATUS.TIMEOUT, { lastError: 'Bridge timed out.' });
      }
    }, REQUEST_TIMEOUT_MS);

    pendingRequest = { requestId, resolve, reject, timeoutId: requestTimeoutId };

    setStatus(BRIDGE_STATUS.REQUESTING);

    try {
      // TODO: Restrict target origin to the actual phone/DAT bridge origin after hardware validation.
      window.parent.postMessage({ type: 'capture.request', source: 'kscan-glasses-webapp', requestId }, '*');
      // TODO: Replace scaffold postMessage contract with real DAT/mobile bridge call after hardware validation.
      // Optional outbound compatibility alias
      window.parent.postMessage({ type: 'capture-photo', source: 'kscan-glasses-webapp', requestId }, '*');
    } catch {
      const settled = rejectPendingRequest('BRIDGE_ERROR', 'Failed to request capture.');
      setStatus(BRIDGE_STATUS.ERROR, { lastError: 'Failed to request capture.' });
      if (!settled) reject(makeBridgeError('BRIDGE_ERROR', 'Failed to request capture.'));
    }
  });
}

// Bridge event origin policy (Phase 30, canonicalized in hardware candidate):
// the shared evaluator in src/messageTrust.js decides trust. Same-origin is
// the default; extra origins for hardware/Meta-runtime testing are allowed
// explicitly via:
//   window.__KSCAN_CONFIG__.BRIDGE_ALLOWED_ORIGINS = 'https://runtime.example'
//   or VITE_BRIDGE_ALLOWED_ORIGINS (comma-separated).
// No wildcard is honored — origins must be listed explicitly. The event
// source must additionally be the approved parent window.

const BRIDGE_MESSAGE_TYPES = new Set(Object.keys(TYPE_ALIASES));

function readExtraAllowedOrigins() {
  const collected = [];
  try {
    const runtime = typeof window !== 'undefined' ? window.__KSCAN_CONFIG__ : null;
    if (runtime && typeof runtime.BRIDGE_ALLOWED_ORIGINS === 'string') {
      collected.push(runtime.BRIDGE_ALLOWED_ORIGINS);
    }
  } catch {
    // runtime config unavailable
  }
  try {
    if (typeof import.meta.env.VITE_BRIDGE_ALLOWED_ORIGINS === 'string') {
      collected.push(import.meta.env.VITE_BRIDGE_ALLOWED_ORIGINS);
    }
  } catch {
    // env unavailable
  }
  return collected;
}

function evaluateBridgeMessageTrust(event) {
  const selfOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const allowlist = buildMessageOriginAllowlist(readExtraAllowedOrigins(), selfOrigin);
  const approvedSources = [];
  try {
    if (window.parent) approvedSources.push(window.parent);
  } catch {
    // ignore
  }
  try {
    if (typeof window !== 'undefined' && !approvedSources.includes(window)) approvedSources.push(window);
  } catch {
    // ignore
  }
  return evaluateMessageTrust(event, {
    allowlist,
    selfOrigin,
    approvedSources,
    requireSource: true,
    allowedTypes: BRIDGE_MESSAGE_TYPES,
  });
}

export function initBridgeStateListener() {
  if (typeof window === 'undefined' || listenerInstalled) return;
  listenerInstalled = true;

  window.addEventListener('message', (event) => {
    // Canonical trust: self/allowlisted origin AND approved parent source
    // AND a supported capture message type. Untrusted events are dropped.
    if (!evaluateBridgeMessageTrust(event).trusted) return;

    const data = event.data;
    const kind = TYPE_ALIASES[data.type];

    if (kind === 'request') {
      setStatus(BRIDGE_STATUS.REQUESTING);
      armTimeout();
      return;
    }
    if (kind === 'capturing') {
      setStatus(BRIDGE_STATUS.CAPTURING);
      armTimeout();
      return;
    }
    if (kind === 'success' || kind === 'photoCaptured') {
      // Stale events (requestId of an already-settled/superseded request)
      // are ignored entirely — they can never render or resolve late.
      if (!matchesActiveRequest(data)) return;
      clearPendingTimeout();
      const metadata = sanitizeMetadata(data.metadata);
      const image = data.image || data.imageData || data.base64;

      if (!validateImagePayload(image)) {
        setStatus(BRIDGE_STATUS.ERROR, { lastError: 'Invalid image payload' });
        rejectPendingRequest('CAPTURE_INVALID', 'Invalid image payload');
        return;
      }

      resolvePendingRequest({ image, metadata });
      setStatus(BRIDGE_STATUS.SUCCESS, { imageMetadata: metadata });
      return;
    }
    if (kind === 'error' || kind === 'photoCaptureError') {
      if (!matchesActiveRequest(data)) return;
      clearPendingTimeout();
      const errorText = clampErrorText(data.error || data.code || data.message);
      setStatus(BRIDGE_STATUS.ERROR, { lastError: errorText });
      rejectPendingRequest('BRIDGE_ERROR', errorText);
      return;
    }
  });
}

// Test-only hooks. Not imported by the app entry point.
export const __bridgeTestHooks = {
  matchesActiveRequest,
  getPendingRequestId: () => (pendingRequest ? pendingRequest.requestId : null),
};
