import {
  isMobileBridgeEnabled,
  getMobileBridgeUrl,
  getMobileBridgeDebugConfig,
} from './mobileBridgeConfig.js';
import { MobileBridgeClient } from './mobileBridgeClient.js';

export const CAPTURE_TIMEOUT_MS = 10000;
const MOCK_CAPTURE_DELAY_DEFAULT_MS = 600;
const MOCK_CAPTURE_DELAY_MAX_MS = 10000;
const CAPTURE_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

// Hard sanity cap on incoming capture payloads (characters of the data URL).
// The privacy sanitizer downsamples before upload; this cap only rejects
// absurd payloads at the bridge boundary. Documented in BRIDGE_CONTRACT.md.
export const MAX_CAPTURE_PAYLOAD_CHARS = 8 * 1024 * 1024;

export const DAT_ERROR_CODES = {
  BRIDGE_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CAPTURE_CANCELLED: 'CAPTURE_CANCELLED',
  INVALID_CAPTURE_RESPONSE: 'INVALID_CAPTURE_RESPONSE',
  CAPTURE_IN_PROGRESS: 'CAPTURE_IN_PROGRESS',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
};

// ─── Origin validation (Phase 11) ────────────────────────────────────
// postMessage capture responses are accepted only from:
//   1. An allowlisted origin: our own origin (same-origin simulator) or
//      a comma-separated VITE_DAT_PARENT_ORIGIN env allowlist, OR
//   2. The direct parent window (event.source === window.parent) when the
//      Meta runtime's host origin is unknown. This fallback is documented
//      in BRIDGE_CONTRACT.md / QA_REPORT.md as a known MRBD limitation —
//      strict origin pinning is impossible until the real runtime origin
//      is observed on physical glasses.
// Messages with event.origin === 'null' are NEVER processed.
// Wildcard entries in the allowlist are ignored.

function readDatEnv() {
  try {
    return { VITE_DAT_PARENT_ORIGIN: import.meta.env.VITE_DAT_PARENT_ORIGIN };
  } catch {
    return {};
  }
}

export function buildOriginAllowlist(envLike = {}, selfOrigin = '') {
  const allowlist = new Set();
  if (typeof selfOrigin === 'string' && selfOrigin && selfOrigin !== 'null') {
    allowlist.add(selfOrigin);
  }
  const raw = typeof envLike.VITE_DAT_PARENT_ORIGIN === 'string' ? envLike.VITE_DAT_PARENT_ORIGIN : '';
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim().replace(/\/+$/, '');
    if (trimmed && trimmed !== 'null' && trimmed !== '*') allowlist.add(trimmed);
  }
  return allowlist;
}

export function evaluateMessageTrust(eventLike, { allowlist, parentRef } = {}) {
  const origin = eventLike?.origin;
  if (origin === 'null') return { trusted: false, reason: 'NULL_ORIGIN' };
  if (typeof origin === 'string' && allowlist instanceof Set && allowlist.has(origin)) {
    return { trusted: true, reason: 'ORIGIN_ALLOWLISTED' };
  }
  if (parentRef && eventLike?.source === parentRef) {
    return { trusted: true, reason: 'PARENT_SOURCE' };
  }
  return { trusted: false, reason: 'UNTRUSTED' };
}

let cachedAllowlist = null;
function getOriginAllowlist() {
  if (!cachedAllowlist) {
    const selfOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
    cachedAllowlist = buildOriginAllowlist(readDatEnv(), selfOrigin);
  }
  return cachedAllowlist;
}

let warnedUntrusted = false;
function warnUntrustedOnce() {
  if (warnedUntrusted) return;
  warnedUntrusted = true;
  // Generic warning only — never log origins, payloads, or message bodies.
  console.warn('[datBridge] Ignored capture message from untrusted source.');
}

// Dev-only override: `?dat=parent` forces the postMessage adapter even when
// VITE_MOCK_DAT=true, so the parent-frame simulator (simulator.html) can
// exercise the real bridge path during local dev. Parsed once.
export function parseDatModeOverride(locationLike = {}) {
  const search = typeof locationLike.search === 'string' ? locationLike.search : '';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get('dat') === 'parent' ? 'parent' : null;
}

let cachedModeOverride;
function getDatModeOverride() {
  if (cachedModeOverride === undefined) {
    cachedModeOverride = typeof window !== 'undefined' && window.location
      ? parseDatModeOverride(window.location)
      : null;
  }
  return cachedModeOverride;
}

// Last mobile-bridge capture metadata (safe fields only) for the dev status
// surface. Never holds image payloads.
let lastMobileBridgeMeta = {
  mode: 'inactive',
  connectionState: 'idle',
  lastMessageType: null,
  lastErrorCode: null,
  activeRequestId: null,
  updatedAt: null,
};

export class DATBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DATBridgeError';
    this.code = code;
  }
}

let pendingCapture = null;

function isMockEnabled() {
  if (getDatModeOverride() === 'parent') return false;
  try {
    return import.meta.env.DEV === true && String(import.meta.env.VITE_MOCK_DAT || '').toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function isMetaRuntime() {
  return window !== window.parent;
}

function detectBridgeAdapter() {
  if (isMetaRuntime() && window.parent && typeof window.parent.postMessage === 'function') {
    return 'postMessage';
  }

  if (window.webkit?.messageHandlers?.DATBridge) {
    return 'webkit';
  }

  return 'unavailable';
}

function createRequestId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `capture_${Date.now()}_${rand}`;
}

function parseMockDelayMs() {
  const raw = import.meta.env.VITE_MOCK_DAT_DELAY_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return MOCK_CAPTURE_DELAY_DEFAULT_MS;
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return MOCK_CAPTURE_DELAY_DEFAULT_MS;
  return Math.max(0, Math.min(MOCK_CAPTURE_DELAY_MAX_MS, value));
}

function getMockScenario() {
  const raw = String(import.meta.env.VITE_MOCK_DAT_SCENARIO || '').trim().toLowerCase();
  if (!raw) return 'success';
  const supported = new Set([
    'success',
    'permission-denied',
    'cancelled',
    'timeout',
    'invalid-response',
    'malformed-image',
  ]);
  return supported.has(raw) ? raw : 'success';
}

function getMockImageVariant() {
  const raw = String(import.meta.env.VITE_MOCK_DAT_IMAGE_VARIANT || '').trim().toLowerCase();
  if (raw === 'tiny' || raw === 'large') return raw;
  return 'standard';
}

function generateMockImage(variant = 'standard') {
  const canvas = document.createElement('canvas');
  if (variant === 'tiny') {
    canvas.width = 24;
    canvas.height = 24;
  } else if (variant === 'large') {
    canvas.width = 2000;
    canvas.height = 1500;
  } else {
    canvas.width = 120;
    canvas.height = 120;
  }
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Unable to create mock image');
  }

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#00E5FF';
  ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.04));
  const inset = Math.max(4, Math.round(Math.min(canvas.width, canvas.height) * 0.08));
  ctx.strokeRect(inset, inset, canvas.width - (inset * 2), canvas.height - (inset * 2));
  ctx.fillStyle = '#E0E0E0';
  ctx.font = `bold ${Math.max(8, Math.round(Math.min(canvas.width, canvas.height) * 0.12))}px sans-serif`;
  ctx.fillText('MOCK DAT', inset + 8, Math.round(canvas.height * 0.55));

  return canvas.toDataURL('image/jpeg', 0.8);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateCapturePayload(payload) {
  if (typeof payload !== 'string') {
    throw new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Invalid capture response payload.');
  }

  const trimmed = payload.trim();
  if (!trimmed.startsWith(CAPTURE_DATA_URL_PREFIX)) {
    throw new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Invalid capture response payload.');
  }

  const encodedPayload = trimmed.slice(CAPTURE_DATA_URL_PREFIX.length);
  if (!encodedPayload) {
    throw new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Invalid capture response payload.');
  }

  if (trimmed.length > MAX_CAPTURE_PAYLOAD_CHARS) {
    throw new DATBridgeError(DAT_ERROR_CODES.PAYLOAD_TOO_LARGE, 'Capture payload too large.');
  }

  return trimmed;
}

function normalizeCapturePayload(payload, requestId) {
  if (!payload || typeof payload !== 'object') return { matched: false };

  if (payload.type === 'photo-captured') {
    if (payload.requestId && payload.requestId !== requestId) return { matched: false };

    try {
      return { matched: true, ok: true, base64: validateCapturePayload(payload.base64) };
    } catch (error) {
      return {
        matched: true,
        ok: false,
        error: error instanceof DATBridgeError
          ? error
          : new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Invalid capture response payload.'),
      };
    }
  }

  if (payload.type === 'photo-capture-error') {
    if (payload.requestId && payload.requestId !== requestId) return { matched: false };

    const code = payload.code || DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE;
    if (code === DAT_ERROR_CODES.PERMISSION_DENIED) {
      return {
        matched: true,
        ok: false,
        error: new DATBridgeError(DAT_ERROR_CODES.PERMISSION_DENIED, 'Camera permission denied.'),
      };
    }

    if (code === DAT_ERROR_CODES.CAPTURE_CANCELLED) {
      return {
        matched: true,
        ok: false,
        error: new DATBridgeError(DAT_ERROR_CODES.CAPTURE_CANCELLED, 'Capture cancelled.'),
      };
    }

    return {
      matched: true,
      ok: false,
      error: new DATBridgeError(code, payload.message || 'Capture failed.'),
    };
  }

  // Legacy compatibility contract.
  if (payload.type === 'CAPTURE_RESPONSE') {
    const image = payload?.data?.base64Image;
    try {
      return { matched: true, ok: true, base64: validateCapturePayload(image) };
    } catch (error) {
      return {
        matched: true,
        ok: false,
        error: error instanceof DATBridgeError
          ? error
          : new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Invalid CAPTURE_RESPONSE payload.'),
      };
    }
  }

  if (payload.type === 'CAPTURE_ERROR') {
    const message = String(payload?.message || '').toLowerCase();
    if (message.includes('permission')) {
      return {
        matched: true,
        ok: false,
        error: new DATBridgeError(DAT_ERROR_CODES.PERMISSION_DENIED, 'Camera permission denied.'),
      };
    }

    return {
      matched: true,
      ok: false,
      error: new DATBridgeError(DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE, 'Capture failed.'),
    };
  }

  return { matched: false };
}

function mapUserFriendlyError(error) {
  if (!(error instanceof DATBridgeError)) return 'Capture failed.';
  if (error.code === DAT_ERROR_CODES.BRIDGE_UNAVAILABLE) return 'Camera bridge unavailable.';
  if (error.code === DAT_ERROR_CODES.PERMISSION_DENIED) return 'Camera permission denied.';
  if (error.code === DAT_ERROR_CODES.CAPTURE_TIMEOUT) return 'Capture timed out.';
  if (error.code === DAT_ERROR_CODES.CAPTURE_CANCELLED) return 'Capture cancelled.';
  if (error.code === DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE) return 'Camera response invalid.';
  if (error.code === DAT_ERROR_CODES.CAPTURE_IN_PROGRESS) return 'Capture already in progress.';
  if (error.code === DAT_ERROR_CODES.PAYLOAD_TOO_LARGE) return 'Camera response invalid.';
  return 'Capture failed.';
}

function getRequestTargetOrigin() {
  // If exactly one parent origin is configured via env, pin outbound requests
  // to it. Otherwise '*' — acceptable because the request carries only
  // {type, requestId}, never image data or secrets. The MRBD host origin is
  // unknown until physical-device testing (documented limitation).
  const raw = typeof readDatEnv().VITE_DAT_PARENT_ORIGIN === 'string' ? readDatEnv().VITE_DAT_PARENT_ORIGIN : '';
  const entries = raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter((s) => s && s !== '*' && s !== 'null');
  return entries.length === 1 ? entries[0] : '*';
}

function emitBridgeRequest(adapter, requestId) {
  if (adapter === 'postMessage') {
    const targetOrigin = getRequestTargetOrigin();
    const canonical = { type: 'capture-photo', requestId };
    window.parent.postMessage(canonical, targetOrigin);
    // Backward-compatible request for older hosts.
    window.parent.postMessage({ type: 'REQUEST_CAPTURE', requestId }, targetOrigin);
    return;
  }

  if (adapter === 'webkit') {
    window.webkit.messageHandlers.DATBridge.postMessage({ type: 'capture-photo', requestId });
    return;
  }

  throw new DATBridgeError(DAT_ERROR_CODES.BRIDGE_UNAVAILABLE, 'Camera bridge unavailable.');
}

function installGlobalCompatibilityCallback(requestId, settle) {
  const previous = window.onDATCaptureComplete;
  const nextHandler = function onDATCaptureComplete(payload) {
    const normalized = normalizeCapturePayload(payload, requestId);
    if (!normalized.matched) {
      if (typeof previous === 'function') previous(payload);
      return;
    }

    settle(normalized);
    if (typeof previous === 'function') previous(payload);
  };

  window.onDATCaptureComplete = nextHandler;

  return () => {
    if (window.onDATCaptureComplete === nextHandler) {
      window.onDATCaptureComplete = previous;
    }
  };
}

export function getDatDiagnostics() {
  const adapter = detectBridgeAdapter();
  return {
    mock: isMockEnabled(),
    adapter,
    bridgeReady: adapter !== 'unavailable',
  };
}

export function getDatStatus() {
  const diagnostics = getDatDiagnostics();
  if (diagnostics.mock) return 'DAT: mock';
  if (diagnostics.bridgeReady) return 'DAT: ready';
  return 'DAT: unavailable';
}

export function toUserFriendlyCaptureError(error) {
  return mapUserFriendlyError(error);
}

// Safe metadata snapshot of the most recent mobile-bridge capture attempt.
export function getMobileBridgeStatus() {
  const config = getMobileBridgeDebugConfig();
  return {
    bridgeMode: config.enabled ? 'mobile' : (isMockEnabled() ? 'simulator' : 'dat'),
    enabled: config.enabled,
    url: config.url,
    configError: config.error,
    connectionState: lastMobileBridgeMeta.connectionState,
    lastMessageType: lastMobileBridgeMeta.lastMessageType,
    lastErrorCode: lastMobileBridgeMeta.lastErrorCode,
    activeRequestId: lastMobileBridgeMeta.activeRequestId,
    updatedAt: lastMobileBridgeMeta.updatedAt,
  };
}

// Mobile bridge capture provider (dev-only). Selected atomically per capture
// when mobile bridge mode is enabled; never runs alongside the DAT/mock path.
// On any failure it returns a controlled bridge error — it does NOT silently
// fall back to the DAT/mock provider.
async function captureViaMobileBridgeProvider() {
  const url = getMobileBridgeUrl();
  const requestId = createRequestId();
  pendingCapture = { requestId, mode: 'mobile' };
  lastMobileBridgeMeta = {
    mode: 'mobile',
    connectionState: 'connecting',
    lastMessageType: 'capture.request',
    lastErrorCode: null,
    activeRequestId: requestId,
    updatedAt: new Date().toISOString(),
  };

  if (!url) {
    pendingCapture = null;
    lastMobileBridgeMeta = {
      ...lastMobileBridgeMeta,
      connectionState: 'error',
      lastErrorCode: DAT_ERROR_CODES.BRIDGE_UNAVAILABLE,
      updatedAt: new Date().toISOString(),
    };
    throw new DATBridgeError(DAT_ERROR_CODES.BRIDGE_UNAVAILABLE, 'Mobile bridge URL is not configured.');
  }

  const client = new MobileBridgeClient(url, { timeoutMs: CAPTURE_TIMEOUT_MS });
  try {
    const image = await client.requestCapture();
    const snapshot = client.getDebugSnapshot();
    lastMobileBridgeMeta = {
      mode: 'mobile',
      connectionState: snapshot.connectionState,
      lastMessageType: snapshot.lastMessageType,
      lastErrorCode: snapshot.lastErrorCode,
      activeRequestId: snapshot.activeRequestId,
      updatedAt: new Date().toISOString(),
    };
    // validateCapturePayload remains the final gate (whitespace-normalized).
    return validateCapturePayload(image);
  } catch (error) {
    const snapshot = client.getDebugSnapshot();
    const code = error?.code || DAT_ERROR_CODES.BRIDGE_UNAVAILABLE;
    lastMobileBridgeMeta = {
      mode: 'mobile',
      connectionState: snapshot.connectionState,
      lastMessageType: snapshot.lastMessageType,
      lastErrorCode: code,
      activeRequestId: snapshot.activeRequestId,
      updatedAt: new Date().toISOString(),
    };
    // Surface a controlled bridge error through the existing DAT error path.
    if (error instanceof DATBridgeError) throw error;
    throw new DATBridgeError(code, 'Capture failed.');
  } finally {
    client.close();
    pendingCapture = null;
  }
}

export async function capturePhoto(options = {}) {
  if (pendingCapture) {
    throw new DATBridgeError(DAT_ERROR_CODES.CAPTURE_IN_PROGRESS, 'Capture already in progress.');
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : CAPTURE_TIMEOUT_MS;

  // Provider selection is atomic and per-capture. Mobile bridge dev mode,
  // when explicitly enabled, takes priority and never coexists with DAT/mock.
  if (isMobileBridgeEnabled()) {
    return captureViaMobileBridgeProvider();
  }

  if (isMockEnabled()) {
    const scenario = getMockScenario();
    const delayMs = parseMockDelayMs();
    const requestId = createRequestId();
    pendingCapture = { requestId, mode: 'mock', scenario };

    try {
      if (scenario === 'timeout') {
        await waitMs(Math.max(delayMs, CAPTURE_TIMEOUT_MS + 100));
        throw new DATBridgeError(DAT_ERROR_CODES.CAPTURE_TIMEOUT, 'Capture timed out.');
      }

      await waitMs(delayMs);

      if (scenario === 'permission-denied') {
        throw new DATBridgeError(DAT_ERROR_CODES.PERMISSION_DENIED, 'Camera permission denied.');
      }

      if (scenario === 'cancelled') {
        throw new DATBridgeError(DAT_ERROR_CODES.CAPTURE_CANCELLED, 'Capture cancelled.');
      }

      if (scenario === 'invalid-response') {
        return validateCapturePayload('invalid-response');
      }

      if (scenario === 'malformed-image') {
        return validateCapturePayload('data:image/jpeg;base64,bm90YW5pbWFnZQ==');
      }

      const variant = getMockImageVariant();
      return validateCapturePayload(generateMockImage(variant));
    } finally {
      pendingCapture = null;
    }
  }

  const adapter = detectBridgeAdapter();
  if (adapter === 'unavailable') {
    throw new DATBridgeError(DAT_ERROR_CODES.BRIDGE_UNAVAILABLE, 'Camera bridge unavailable.');
  }

  const requestId = createRequestId();

  return new Promise((resolve, reject) => {
    let finished = false;
    let timeoutId = null;
    let removeCallback = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      if (typeof removeCallback === 'function') removeCallback();
      pendingCapture = null;
    };

    const settle = (normalized) => {
      if (finished) return;
      finished = true;
      cleanup();

      if (!normalized.ok) {
        reject(normalized.error);
        return;
      }

      resolve(normalized.base64);
    };

    const onMessage = (event) => {
      const trust = evaluateMessageTrust(event, {
        allowlist: getOriginAllowlist(),
        parentRef: window.parent !== window ? window.parent : null,
      });
      if (!trust.trusted) {
        warnUntrustedOnce();
        return;
      }

      const normalized = normalizeCapturePayload(event.data, requestId);
      if (!normalized.matched) return;
      settle(normalized);
    };

    pendingCapture = { requestId };
    removeCallback = installGlobalCompatibilityCallback(requestId, settle);

    timeoutId = setTimeout(() => {
      settle({
        matched: true,
        ok: false,
        error: new DATBridgeError(DAT_ERROR_CODES.CAPTURE_TIMEOUT, 'Capture timed out.'),
      });
    }, timeoutMs);

    window.addEventListener('message', onMessage);

    try {
      emitBridgeRequest(adapter, requestId);
    } catch (error) {
      settle({
        matched: true,
        ok: false,
        error: error instanceof DATBridgeError
          ? error
          : new DATBridgeError(DAT_ERROR_CODES.BRIDGE_UNAVAILABLE, 'Camera bridge unavailable.'),
      });
    }
  });
}
