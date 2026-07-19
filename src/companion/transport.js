// Companion connection transport abstraction — Meta companion Phase A.
//
// The application (companionRuntime) couples ONLY to this interface:
//   connect(), disconnect(), send(message), subscribe(fn), unsubscribe(fn),
//   getConnectionState()
//
// Two transports exist:
//   1. parent-window — HUD embedded by a trusted parent page (the LOCAL QA
//      mock companion, and later the Meta runtime container). Inbound trust
//      is evaluated by the CANONICAL evaluator in src/messageTrust.js —
//      this module adds no second trust implementation. Outbound posts are
//      pinned to an explicit target origin; '*' is never used.
//   2. websocket — DEVELOPMENT ONLY, explicit URL required. No default
//      endpoint, no localhost fallback. Unavailable in production builds.
//
// Production fails closed: with no approved transport configured the
// factory returns a 'none' transport that never connects.

import { evaluateMessageTrust, buildMessageOriginAllowlist, normalizeOrigin } from '../messageTrust.js';
import { serializeMessage, validateMessage } from './protocol.js';

export const TRANSPORT_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSED: 'closed',
  ERROR: 'error',
  UNAVAILABLE: 'unavailable',
});

function makeBase() {
  const listeners = new Set();
  return {
    listeners,
    emit(message, meta) {
      for (const fn of listeners) {
        try {
          fn(message, meta);
        } catch {
          // listener failures never break transport
        }
      }
    },
  };
}

/**
 * Parent-window transport. The HUD talks to its embedding parent (or a
 * companion page talks to its embedded HUD iframe) over postMessage with
 * canonical origin+source trust.
 *
 * @param {object} options
 * @param {Window} options.peerWindow - the approved peer window.
 * @param {string} options.selfOrigin - this window's origin.
 * @param {string} [options.targetOrigin] - explicit outbound pin; defaults
 *   to selfOrigin (same-origin embedding, the LOCAL QA shape).
 * @param {Array<string>} [options.extraAllowedOrigins] - additional
 *   configured inbound origins (hardware runtime pinning).
 * @param {(reason: string) => void} [options.onFatal] - peer disappeared.
 */
export function createParentWindowTransport({
  peerWindow,
  selfOrigin,
  targetOrigin = null,
  extraAllowedOrigins = [],
  onFatal = () => {},
} = {}) {
  const base = makeBase();
  let state = TRANSPORT_STATE.IDLE;
  let listener = null;

  const pinnedTarget = normalizeOrigin(targetOrigin || selfOrigin || '');
  const allowlist = buildMessageOriginAllowlist(extraAllowedOrigins, selfOrigin || '');

  if (!peerWindow || !pinnedTarget) {
    return {
      connect() { state = TRANSPORT_STATE.UNAVAILABLE; return false; },
      disconnect() {},
      send() { return false; },
      subscribe(fn) { base.listeners.add(fn); return () => base.listeners.delete(fn); },
      unsubscribe(fn) { base.listeners.delete(fn); },
      getConnectionState: () => TRANSPORT_STATE.UNAVAILABLE,
    };
  }

  return {
    connect() {
      if (state === TRANSPORT_STATE.OPEN) return true;
      state = TRANSPORT_STATE.CONNECTING;
      listener = (event) => {
        const verdict = evaluateMessageTrust(event, {
          allowlist,
          selfOrigin,
          approvedSources: [peerWindow, typeof window !== 'undefined' ? window.parent : null].filter(Boolean),
          requireSource: true,
        });
        if (!verdict.trusted) return;
        base.emit(event.data, { origin: event.origin });
      };
      window.addEventListener('message', listener);
      state = TRANSPORT_STATE.OPEN;
      return true;
    },
    disconnect() {
      if (listener && typeof window !== 'undefined') window.removeEventListener('message', listener);
      listener = null;
      state = TRANSPORT_STATE.CLOSED;
    },
    send(message) {
      if (state !== TRANSPORT_STATE.OPEN) return false;
      try {
        peerWindow.postMessage(message, pinnedTarget);
        return true;
      } catch {
        state = TRANSPORT_STATE.ERROR;
        onFatal('post-failed');
        return false;
      }
    },
    subscribe(fn) { base.listeners.add(fn); return () => base.listeners.delete(fn); },
    unsubscribe(fn) { base.listeners.delete(fn); },
    getConnectionState: () => state,
  };
}

/**
 * Development-only WebSocket transport. Requires an explicit URL; refuses
 * production use. Inbound frames are JSON-parsed and size-checked before
 * listeners see them; protocol validation happens downstream.
 */
export function createWebSocketTransport({ url, onFatal = () => {}, normalize = null } = {}) {
  const base = makeBase();
  let state = TRANSPORT_STATE.IDLE;
  let socket = null;

  const isProd = typeof __KSCAN_SIMULATOR_BUILD__ !== 'undefined'
    ? __KSCAN_SIMULATOR_BUILD__ === false
    : false;

  const normalized = typeof normalize === 'function' ? normalize(url) : url;
  const allowed = !isProd && typeof normalized === 'string' && normalized.length > 0;

  return {
    connect() {
      if (!allowed || typeof WebSocket === 'undefined') {
        state = TRANSPORT_STATE.UNAVAILABLE;
        return false;
      }
      if (state === TRANSPORT_STATE.OPEN) return true;
      state = TRANSPORT_STATE.CONNECTING;
      try {
        socket = new WebSocket(normalized);
      } catch {
        state = TRANSPORT_STATE.ERROR;
        onFatal('connect-failed');
        return false;
      }
      socket.onopen = () => { state = TRANSPORT_STATE.OPEN; };
      socket.onclose = () => {
        if (state === TRANSPORT_STATE.OPEN || state === TRANSPORT_STATE.CONNECTING) {
          state = TRANSPORT_STATE.CLOSED;
          onFatal('transport-closed');
        }
      };
      socket.onerror = () => { state = TRANSPORT_STATE.ERROR; };
      socket.onmessage = (event) => {
        let parsed = null;
        try {
          if (typeof event.data === 'string' && event.data.length <= 140 * 1024) {
            parsed = JSON.parse(event.data);
          }
        } catch {
          parsed = null;
        }
        if (parsed) base.emit(parsed, { origin: null });
      };
      return true;
    },
    disconnect() {
      try {
        socket?.close();
      } catch {
        // already closed
      }
      socket = null;
      state = TRANSPORT_STATE.CLOSED;
    },
    send(message) {
      if (state !== TRANSPORT_STATE.OPEN || !socket) return false;
      const text = serializeMessage(message);
      if (!text) return false;
      try {
        socket.send(text);
        return true;
      } catch {
        onFatal('send-failed');
        return false;
      }
    },
    subscribe(fn) { base.listeners.add(fn); return () => base.listeners.delete(fn); },
    unsubscribe(fn) { base.listeners.delete(fn); },
    getConnectionState: () => state,
  };
}

/**
 * Resolve the companion transport for this runtime. Explicit, fail-closed:
 *   - embedded in a parent page → parent-window transport (canonical trust)
 *   - explicit dev WS config → websocket transport (dev/simulator only)
 *   - otherwise → unavailable transport (production default)
 */
export function resolveCompanionTransport({
  peerWindow = null,
  selfOrigin = '',
  targetOrigin = null,
  extraAllowedOrigins = [],
  wsUrl = null,
  normalizeWsUrl = null,
  onFatal = () => {},
} = {}) {
  if (typeof wsUrl === 'string' && wsUrl.trim()) {
    return createWebSocketTransport({ url: wsUrl, onFatal, normalize: normalizeWsUrl });
  }
  if (peerWindow) {
    return createParentWindowTransport({
      peerWindow, selfOrigin, targetOrigin, extraAllowedOrigins, onFatal,
    });
  }
  return createParentWindowTransport({ peerWindow: null, selfOrigin, onFatal });
}
