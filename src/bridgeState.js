// Bridge state scaffold — Phase 28A.
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
// Origin note: events are accepted from the same origin only (simulator
// parent frame). The accepted-origin policy must be revisited during real
// Meta runtime / hardware validation (see VITE_DAT_PARENT_ORIGIN pattern in
// datBridge.js).

export const BRIDGE_STATUS = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  CAPTURING: 'capturing',
  SUCCESS: 'success',
  ERROR: 'error',
  TIMEOUT: 'timeout',
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

function clearPendingRequest() {
  if (pendingRequest) {
    if (pendingRequest.timeoutId) clearTimeout(pendingRequest.timeoutId);
    pendingRequest = null;
  }
}

function armTimeout() {
  clearPendingTimeout();
  timeoutId = setTimeout(() => {
    if (state.status === BRIDGE_STATUS.REQUESTING || state.status === BRIDGE_STATUS.CAPTURING) {
      setStatus(BRIDGE_STATUS.TIMEOUT, { lastError: 'Bridge timed out.' });
      if (pendingRequest) {
        const err = new Error('Bridge timed out.');
        err.code = 'BRIDGE_TIMEOUT';
        pendingRequest.reject(err);
        pendingRequest = null;
      }
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
  if (pendingRequest) {
    const err = new Error('Bridge reset.');
    err.code = 'BRIDGE_ERROR';
    pendingRequest.reject(err);
    pendingRequest = null;
  }
  setStatus(BRIDGE_STATUS.IDLE);
}

export function requestCapture(options = {}) {
  return new Promise((resolve, reject) => {
    clearPendingRequest();
    clearPendingTimeout();

    pendingRequest = {
      resolve: (value) => {
        clearPendingRequest();
        resolve(value);
      },
      reject: (error) => {
        clearPendingRequest();
        reject(error);
      },
      startedAt: Date.now(),
    };

    setStatus(BRIDGE_STATUS.REQUESTING);
    armTimeout();

    try {
      const message = { type: 'capture.request', source: 'kscan-glasses-webapp' };
      // TODO: Restrict target origin to the actual phone/DAT bridge origin after hardware validation.
      window.parent.postMessage(message, '*');
      // TODO: Replace scaffold postMessage contract with real DAT/mobile bridge call after hardware validation.
      // Optional outbound compatibility alias
      window.parent.postMessage({ type: 'capture-photo', source: 'kscan-glasses-webapp' }, '*');
    } catch (error) {
      clearPendingTimeout();
      setStatus(BRIDGE_STATUS.ERROR, { lastError: 'Failed to request capture.' });
      clearPendingRequest();
      const err = new Error('Failed to request capture.');
      err.code = 'BRIDGE_ERROR';
      reject(err);
    }
  });
}

// Bridge event origin policy (Phase 30):
// Default remains same-origin only (simulator parent frame). For hardware /
// Meta runtime testing, extra origins can be allowed explicitly via:
//   window.__KSCAN_CONFIG__.BRIDGE_ALLOWED_ORIGINS = 'https://runtime.example'
//   or VITE_BRIDGE_ALLOWED_ORIGINS (comma-separated).
// No wildcard is honored here — origins must be listed explicitly.
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
  return collected
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*' && (s.startsWith('https://') || s.startsWith('http://localhost')));
}

function isAllowedBridgeOrigin(origin) {
  if (typeof window !== 'undefined' && origin === window.location.origin) return true;
  return readExtraAllowedOrigins().includes(origin);
}

export function initBridgeStateListener() {
  if (typeof window === 'undefined' || listenerInstalled) return;
  listenerInstalled = true;

  window.addEventListener('message', (event) => {
    // Same-origin by default; explicit allowlist for hardware/runtime testing.
    if (!isAllowedBridgeOrigin(event.origin)) return;

    const data = event?.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    const kind = TYPE_ALIASES[data.type];
    if (!kind) return;

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
      clearPendingTimeout();
      const metadata = sanitizeMetadata(data.metadata);
      const image = data.image || data.imageData || data.base64;

      if (!validateImagePayload(image)) {
        setStatus(BRIDGE_STATUS.ERROR, { lastError: 'Invalid image payload' });
        if (pendingRequest) {
          const err = new Error('Invalid image payload');
          err.code = 'CAPTURE_INVALID';
          pendingRequest.reject(err);
          pendingRequest = null;
        }
        return;
      }

      if (pendingRequest) {
        pendingRequest.resolve({ image, metadata });
        pendingRequest = null;
      }
      setStatus(BRIDGE_STATUS.SUCCESS, { imageMetadata: metadata });
      return;
    }
    if (kind === 'error' || kind === 'photoCaptureError') {
      clearPendingTimeout();
      const errorText = clampErrorText(data.error || data.code || data.message);
      setStatus(BRIDGE_STATUS.ERROR, { lastError: errorText });
      if (pendingRequest) {
        const err = new Error(errorText);
        err.code = 'BRIDGE_ERROR';
        pendingRequest.reject(err);
        pendingRequest = null;
      }
      return;
    }
  });
}
