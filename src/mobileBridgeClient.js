// Glasses-side mobile bridge client (Phase 17).
//
// Connects to the K Scan mobile bridge alpha over a dev WebSocket, requests
// a capture, and resolves with a validated `data:image/jpeg;base64,...`
// data URL. This is a DEV-ONLY transport; see mobileBridgeConfig.js.
//
// Message contract matches Phase 16 (mobile bridge alpha):
//   capture.request : { type, requestId, source:'glasses-web', createdAt, timeoutMs }
//   capture.success : { type, requestId, image, mime:'image/jpeg', encoding:'data-url', createdAt }
//   capture.error   : { type, requestId, code, message, createdAt }
//
// PRIVACY: this module never logs image payloads (full or partial), never
// logs byte length/dimensions/EXIF, and never stringifies a full bridge
// message that may contain an `image` field. Only safe fields (type,
// requestId, status, code) are ever logged.

export const MOBILE_BRIDGE_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 2000;
const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export const MOBILE_BRIDGE_ERROR_CODES = {
  BRIDGE_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
  CAPTURE_ALREADY_PENDING: 'CAPTURE_ALREADY_PENDING',
  INVALID_CAPTURE_RESPONSE: 'INVALID_CAPTURE_RESPONSE',
  DAT_NOT_CONFIGURED: 'DAT_NOT_CONFIGURED',
  BLUETOOTH_NOT_CONFIGURED: 'BLUETOOTH_NOT_CONFIGURED',
  NATIVE_CAPTURE_FAILED: 'NATIVE_CAPTURE_FAILED',
  HANDOFF_FAILED: 'HANDOFF_FAILED',
};

export class MobileBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MobileBridgeError';
    this.code = code;
  }
}

/**
 * Same exact JPEG data URL rule as the existing capture validation:
 * string, trimmed, exact case-sensitive prefix, non-empty after the comma.
 * Returns the normalized string or throws INVALID_CAPTURE_RESPONSE.
 * Never embeds the payload in the error.
 */
function validateMobileBridgePayload(image) {
  if (typeof image !== 'string') {
    throw new MobileBridgeError(
      MOBILE_BRIDGE_ERROR_CODES.INVALID_CAPTURE_RESPONSE,
      'Invalid capture response payload.',
    );
  }
  const trimmed = image.trim();
  if (!trimmed.startsWith(JPEG_DATA_URL_PREFIX) || trimmed.length <= JPEG_DATA_URL_PREFIX.length) {
    throw new MobileBridgeError(
      MOBILE_BRIDGE_ERROR_CODES.INVALID_CAPTURE_RESPONSE,
      'Invalid capture response payload.',
    );
  }
  return trimmed;
}

const ALLOWED_ERROR_CODES = new Set(Object.values(MOBILE_BRIDGE_ERROR_CODES));

function mapErrorCode(code) {
  return ALLOWED_ERROR_CODES.has(code)
    ? code
    : MOBILE_BRIDGE_ERROR_CODES.NATIVE_CAPTURE_FAILED;
}

function safeLog(stage, fields) {
  // Dev-only, safe-fields-only logging. Build a small object that can never
  // contain an `image` field.
  if (typeof console === 'undefined' || typeof console.info !== 'function') return;
  const safe = {
    type: fields.type,
    requestId: fields.requestId,
    status: fields.status,
    code: fields.code,
  };
  console.info(`[mobile-bridge] ${stage}`, safe);
}

function createRequestId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `glasses_${Date.now()}_${rand}`;
}

/**
 * MobileBridgeClient manages a single WebSocket connection and enforces one
 * active capture request at a time. A fresh client should be created per
 * capture attempt (provider selection is atomic and per-capture).
 */
export class MobileBridgeClient {
  constructor(url, { WebSocketImpl, timeoutMs = MOBILE_BRIDGE_TIMEOUT_MS, allowReconnect = true } = {}) {
    this.url = url;
    this.WebSocketImpl =
      WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.timeoutMs = timeoutMs;
    this.allowReconnect = allowReconnect;

    this.socket = null;
    this.pending = null; // { requestId, resolve, reject, timer, settled }
    this.lastMessageType = null;
    this.lastErrorCode = null;
    this.activeRequestId = null;
    this.connectionState = 'idle'; // idle | connecting | open | closed | error
  }

  getDebugSnapshot() {
    return {
      connectionState: this.connectionState,
      lastMessageType: this.lastMessageType,
      lastErrorCode: this.lastErrorCode,
      activeRequestId: this.activeRequestId,
    };
  }

  /**
   * Request a single capture. Resolves with a validated JPEG data URL or
   * rejects with a MobileBridgeError.
   */
  async requestCapture() {
    if (!this.url) {
      throw new MobileBridgeError(
        MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE,
        'Mobile bridge URL is not configured.',
      );
    }
    if (!this.WebSocketImpl) {
      throw new MobileBridgeError(
        MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE,
        'WebSocket is unavailable in this environment.',
      );
    }
    if (this.pending) {
      throw new MobileBridgeError(
        MOBILE_BRIDGE_ERROR_CODES.CAPTURE_ALREADY_PENDING,
        'A capture request is already pending.',
      );
    }

    try {
      await this._ensureConnected();
    } catch {
      if (this.allowReconnect) {
        await this._delay(RECONNECT_DELAY_MS);
        try {
          await this._ensureConnected();
        } catch {
          this.lastErrorCode = MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE;
          throw new MobileBridgeError(
            MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE,
            'Unable to connect to mobile bridge.',
          );
        }
      } else {
        this.lastErrorCode = MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE;
        throw new MobileBridgeError(
          MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE,
          'Unable to connect to mobile bridge.',
        );
      }
    }

    return this._sendCaptureRequest();
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _ensureConnected() {
    if (this.socket && this.connectionState === 'open') return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      this.connectionState = 'connecting';

      let socket;
      try {
        socket = new this.WebSocketImpl(this.url);
      } catch {
        this.connectionState = 'error';
        reject(new Error('socket-construct-failed'));
        return;
      }

      const onOpen = () => {
        if (settled) return;
        settled = true;
        this.socket = socket;
        this.connectionState = 'open';
        resolve();
      };

      const onOpenError = () => {
        if (settled) return;
        settled = true;
        this.connectionState = 'error';
        reject(new Error('socket-open-failed'));
      };

      socket.onopen = onOpen;
      socket.onerror = onOpenError;
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          this.connectionState = 'closed';
          reject(new Error('socket-closed-before-open'));
        }
      };
      socket.onmessage = (event) => this._handleMessage(event);
    });
  }

  _sendCaptureRequest() {
    const requestId = createRequestId();
    this.activeRequestId = requestId;

    return new Promise((resolve, reject) => {
      const pending = { requestId, resolve, reject, timer: null, settled: false };
      this.pending = pending;

      // Rewire socket lifecycle handlers so an in-flight request is rejected
      // cleanly on close/error (and stale timers can never fire post-cleanup).
      this.socket.onclose = () => {
        this.connectionState = 'closed';
        this._settleError(MOBILE_BRIDGE_ERROR_CODES.BRIDGE_UNAVAILABLE, 'Bridge connection closed.');
      };
      this.socket.onerror = () => {
        this.connectionState = 'error';
        this._settleError(MOBILE_BRIDGE_ERROR_CODES.HANDOFF_FAILED, 'Bridge connection error.');
      };
      this.socket.onmessage = (event) => this._handleMessage(event);

      pending.timer = setTimeout(() => {
        this._settleError(MOBILE_BRIDGE_ERROR_CODES.CAPTURE_TIMEOUT, 'Capture timed out.');
      }, this.timeoutMs);

      const request = {
        type: 'capture.request',
        requestId,
        source: 'glasses-web',
        createdAt: new Date().toISOString(),
        timeoutMs: this.timeoutMs,
      };

      try {
        this.socket.send(JSON.stringify(request));
        this.lastMessageType = 'capture.request';
        safeLog('send', { type: 'capture.request', requestId, status: 'sent' });
      } catch {
        this._settleError(MOBILE_BRIDGE_ERROR_CODES.HANDOFF_FAILED, 'Failed to send capture request.');
      }
    });
  }

  _handleMessage(event) {
    const pending = this.pending;
    if (!pending || pending.settled) return;

    let message;
    try {
      message = JSON.parse(typeof event?.data === 'string' ? event.data : '');
    } catch {
      // Never log frame contents — they may contain image data.
      safeLog('recv', { type: 'unknown', status: 'invalid-json' });
      return;
    }

    if (!message || typeof message !== 'object') return;
    if (message.requestId !== pending.requestId) {
      // Mismatched / stale response — ignore safely.
      return;
    }

    this.lastMessageType = message.type;

    if (message.type === 'capture.success') {
      try {
        const image = validateMobileBridgePayload(message.image);
        safeLog('recv', { type: 'capture.success', requestId: message.requestId, status: 'ok' });
        this._settleSuccess(image);
      } catch (error) {
        const code = error instanceof MobileBridgeError
          ? error.code
          : MOBILE_BRIDGE_ERROR_CODES.INVALID_CAPTURE_RESPONSE;
        this._settleError(code, 'Invalid capture response payload.');
      }
      return;
    }

    if (message.type === 'capture.error') {
      const code = mapErrorCode(message.code);
      safeLog('recv', { type: 'capture.error', requestId: message.requestId, status: 'error', code });
      this._settleError(code, 'Capture failed.');
      return;
    }

    // Any other message type for our requestId is ignored.
  }

  _cleanup() {
    const pending = this.pending;
    if (pending && pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.pending = null;
    this.activeRequestId = null;
  }

  _settleSuccess(image) {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this._cleanup();
    pending.resolve(image);
  }

  _settleError(code, message) {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.lastErrorCode = code;
    this._cleanup();
    pending.reject(new MobileBridgeError(code, message));
  }

  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore teardown errors
      }
      this.socket = null;
    }
    this.connectionState = 'closed';
  }
}

/**
 * Convenience: perform one capture against `url` and tear the socket down.
 * Returns a validated JPEG data URL or throws MobileBridgeError.
 */
export async function captureViaMobileBridge(url, options = {}) {
  const client = new MobileBridgeClient(url, options);
  try {
    return await client.requestCapture();
  } finally {
    client.close();
  }
}
