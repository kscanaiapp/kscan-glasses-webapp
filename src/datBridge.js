export const CAPTURE_TIMEOUT_MS = 10000;
const MOCK_CAPTURE_DELAY_DEFAULT_MS = 600;
const MOCK_CAPTURE_DELAY_MAX_MS = 10000;
const CAPTURE_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export const DAT_ERROR_CODES = {
  BRIDGE_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CAPTURE_CANCELLED: 'CAPTURE_CANCELLED',
  INVALID_CAPTURE_RESPONSE: 'INVALID_CAPTURE_RESPONSE',
  CAPTURE_IN_PROGRESS: 'CAPTURE_IN_PROGRESS',
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
  return import.meta.env.DEV && String(import.meta.env.VITE_MOCK_DAT || '').toLowerCase() === 'true';
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
  return 'Capture failed.';
}

function emitBridgeRequest(adapter, requestId) {
  if (adapter === 'postMessage') {
    const canonical = { type: 'capture-photo', requestId };
    window.parent.postMessage(canonical, '*');
    // Backward-compatible request for older hosts.
    window.parent.postMessage({ type: 'REQUEST_CAPTURE', requestId }, '*');
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

export async function capturePhoto() {
  if (pendingCapture) {
    throw new DATBridgeError(DAT_ERROR_CODES.CAPTURE_IN_PROGRESS, 'Capture already in progress.');
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
    }, CAPTURE_TIMEOUT_MS);

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
