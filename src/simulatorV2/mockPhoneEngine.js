// Mock phone companion engine — Simulator V2 (LOCAL QA / NON-PRODUCTION).
//
// A DOM-decoupled refactor of the pairing/scan-drive/action-ack logic in
// src/companion/mockCompanion.js, so the premium Simulator V2 shell and the
// existing engineering companion.html page can both act as "the phone" over
// the SAME canonical protocol + trust evaluator + result fixtures. No
// protocol, trust, or fixture logic is duplicated here — this module only
// sequences calls into src/companion/{protocol,resultFixtures}.js and
// src/messageTrust.js, exactly as the existing mock phone does.
//
// This module must never ship in the production artifact.

import { evaluateMessageTrust, buildMessageOriginAllowlist } from '../messageTrust.js';
import { MESSAGE_TYPES, buildMessage, validateMessage } from '../companion/protocol.js';
import { FIXTURE_BUILDERS } from '../companion/resultFixtures.js';
import { RUNTIME_TIMEOUTS } from '../companion/runtimeState.js';

const T = MESSAGE_TYPES;
const PHONE_NAME = 'K Scan AI — Mock Phone (LOCAL QA)';
const SESSION_TTL_MS = 30 * 60 * 1000;
const ALL_CAPS = ['scan.trigger', 'result.receive', 'result.dismiss', 'action.save', 'action.open_on_phone', 'action.retry', 'action.cancel'];

// Phone-side UI states — presentation semantics for the phone companion
// visualization, distinct from the wire-level pairing bookkeeping below.
export const PHONE_UI_STATE = Object.freeze({
  IDLE: 'idle',
  INCOMING_REQUEST: 'incoming_request',
  CONNECTED_READY: 'connected_ready',
  CAPTURING: 'capturing',
  PRIVACY: 'privacy',
  ANALYZING: 'analyzing',
  RESULT_READY: 'result_ready',
  ACTION_PENDING: 'action_pending',
  ACTION_DONE: 'action_done',
  DROPPED: 'dropped',
});

export function getFixtureKeys() {
  return Object.keys(FIXTURE_BUILDERS);
}

/**
 * @param {object} options
 * @param {() => (Window|null)} options.getFrameWindow - returns the HUD
 *   iframe's contentWindow, or null if not yet loaded.
 * @param {string} options.selfOrigin - window.location.origin.
 * @param {object} [options.callbacks]
 * @param {(direction: 'in'|'out'|'drop', messageType: string, extra?: string) => void} [options.callbacks.onLog]
 * @param {(uiState: string, detail?: object) => void} [options.callbacks.onPhoneState]
 * @param {(text: string) => void} [options.callbacks.onSessionStatus]
 * @param {(text: string) => void} [options.callbacks.onScanStatus]
 * @param {(text: string) => void} [options.callbacks.onActionStatus]
 * @param {(result: object) => void} [options.callbacks.onResultSent] - fixture actually sent
 */
export function createMockPhoneEngine({ getFrameWindow, selfOrigin, callbacks = {} } = {}) {
  const {
    onLog = () => {},
    onPhoneState = () => {},
    onSessionStatus = () => {},
    onScanStatus = () => {},
    onActionStatus = () => {},
    onResultSent = () => {},
    onHandoff = () => {}, // (direction: 'glasses-to-phone'|'phone-to-glasses', label: string) — relationship animation cue
  } = callbacks;

  const allowlist = buildMessageOriginAllowlist([], selfOrigin);

  const state = {
    hudDeviceId: null,
    pairingNonce: null,
    sessionId: null,
    sessionExpiresAt: 0,
    dropped: false,
    activeRequestId: null,
    cancelledRequests: new Set(),
    lastTerminalMessage: null,
    driveTimers: [],
    isDriving: false,
    failArmToken: 0,
    fixtureKey: 'full',
    demoBuilder: null,
    uiState: PHONE_UI_STATE.IDLE,
    dropAt: null, // Date.now() at drop() — used to judge whether a later
    // restore() lands inside the HUD's real reconnect window (see restore()).
  };

  function resolveBuilder() {
    return state.demoBuilder || FIXTURE_BUILDERS[state.fixtureKey] || FIXTURE_BUILDERS.full;
  }

  // Demo fixtures carry a presentation-only __icon hint for the outer chrome
  // (see src/simulatorV2/demoFixtures.js). The wire result contract
  // (src/companion/resultContract.js RESULT_FIELDS) is a strict allowlist —
  // any unrecognized top-level key fails validation on the HUD side. Strip
  // it before sending; callers still get the full object for presentation.
  function forWire(result) {
    if (!result || typeof result !== 'object' || !('__icon' in result)) return result;
    const { __icon, ...rest } = result;
    return rest;
  }

  function setUiState(next, detail) {
    if (state.uiState === next) return;
    state.uiState = next;
    onPhoneState(next, detail || {});
  }

  function frameWindow() {
    try {
      return getFrameWindow ? getFrameWindow() : null;
    } catch {
      return null;
    }
  }

  function send(messageType, payload = {}, { requestId = null, sessionId } = {}) {
    if (state.dropped) { onLog('drop', messageType, '(swallowed — connection down)'); return null; }
    if (!state.hudDeviceId) return null;
    const win = frameWindow();
    if (!win) return null;
    const message = buildMessage(messageType, {
      requestId,
      sessionId: sessionId !== undefined ? sessionId : state.sessionId,
      deviceId: state.hudDeviceId,
      payload,
    });
    if (!message) { onLog('drop', messageType, '(builder refused)'); return null; }
    win.postMessage(message, selfOrigin);
    onLog('out', messageType, requestId ? `req=${String(requestId).slice(-8)}` : '');
    return message;
  }

  function clearDriveTimers() {
    state.driveTimers.forEach((t) => clearTimeout(t));
    state.driveTimers = [];
    state.isDriving = false;
  }

  function later(ms, fn) {
    state.driveTimers.push(setTimeout(fn, ms));
  }

  function driveScan(requestId) {
    if (state.cancelledRequests.has(requestId)) return;
    state.isDriving = true;
    onScanStatus(`Driving scan req=${String(requestId).slice(-8)}`);
    setUiState(PHONE_UI_STATE.CAPTURING, { requestId });
    later(200, () => { send(T.CAPTURE_STARTED, {}, { requestId }); });
    later(600, () => {
      send(T.SCAN_PROCESSING, { stage: 'privacy', stageLabel: 'On-device face masking' }, { requestId });
      setUiState(PHONE_UI_STATE.PRIVACY, { requestId });
    });
    later(1100, () => {
      send(T.SCAN_PROCESSING, { stage: 'analyzing', stageLabel: 'Finding matches' }, { requestId });
      setUiState(PHONE_UI_STATE.ANALYZING, { requestId });
    });
    later(1600, () => {
      const result = resolveBuilder()(requestId);
      send(T.RESULT_SHOW, { result: forWire(result) }, { requestId });
      state.isDriving = false;
      onScanStatus(`Result sent req=${String(requestId).slice(-8)}`);
      setUiState(PHONE_UI_STATE.RESULT_READY, { requestId, result });
      onHandoff('phone-to-glasses', 'Result ready');
      onResultSent(result);
    });
  }

  function handleCaptureRequest(message) {
    if (state.cancelledRequests.has(message.requestId)) state.cancelledRequests.delete(message.requestId);
    state.activeRequestId = message.requestId;
    clearDriveTimers();
    onHandoff('glasses-to-phone', 'Scan request');
    if (state.failArmToken > 0) {
      state.failArmToken = 0;
      later(80, () => {
        send(T.SCAN_FAILED, { code: 'ANALYZE_FAILED', safeMessage: 'Mock failure' }, { requestId: message.requestId });
        onScanStatus(`Scan failed (queued) req=${String(message.requestId).slice(-8)}`);
        setUiState(PHONE_UI_STATE.CONNECTED_READY);
      });
      return;
    }
    driveScan(message.requestId);
  }

  function handleAction(message, autoAck) {
    const label = `${message.messageType} result=${message.payload.resultId || '-'}`;
    onActionStatus(`Received ${label}`);
    setUiState(PHONE_UI_STATE.ACTION_PENDING, { actionType: message.messageType });
    onHandoff('glasses-to-phone', message.messageType === T.ACTION_OPEN_ON_PHONE ? 'Open on phone' : 'Save');
    if (!autoAck) return;
    const { requestId } = message;
    later(150, () => send(T.ACTION_ACCEPTED, { actionType: message.messageType, resultId: message.payload.resultId ?? undefined }, { requestId }));
    later(450, () => {
      const done = send(T.ACTION_COMPLETED, { actionType: message.messageType, resultId: message.payload.resultId ?? undefined, safeMessage: 'Done' }, { requestId });
      if (done) state.lastTerminalMessage = done;
      setUiState(PHONE_UI_STATE.ACTION_DONE, { actionType: message.messageType });
      onHandoff('phone-to-glasses', message.messageType === T.ACTION_OPEN_ON_PHONE ? 'Opened' : 'Saved');
      // The HUD now shows its own "Done" screen and waits for the user to
      // dismiss it — it does not auto-return to Ready. Stay at ACTION_DONE
      // until the real ACTION_DISMISS arrives (handled below), so the
      // phone mirror never claims "Ready" while the glasses still show Done.
    });
  }

  let autoAckActions = true;

  function handleProtocolMessage(message) {
    switch (message.messageType) {
      case T.PAIR_REQUEST:
        state.sessionId = null;
        state.sessionExpiresAt = 0;
        state.hudDeviceId = message.deviceId;
        state.pairingNonce = message.payload.pairingNonce;
        onSessionStatus(`Pairing requested by ${message.deviceId.slice(0, 18)}…`);
        setUiState(PHONE_UI_STATE.INCOMING_REQUEST, { deviceId: message.deviceId });
        onHandoff('glasses-to-phone', 'Pairing request');
        break;
      case T.CONNECTION_PING:
        send(T.CONNECTION_PONG, { nonce: message.payload.nonce }, { requestId: null, sessionId: null });
        break;
      case T.CAPTURE_REQUEST:
        handleCaptureRequest(message);
        break;
      case T.ACTION_CANCEL:
        state.cancelledRequests.add(message.requestId);
        clearDriveTimers();
        onScanStatus(`Scan cancelled req=${String(message.requestId).slice(-8)}`);
        setUiState(PHONE_UI_STATE.CONNECTED_READY);
        break;
      case T.ACTION_SAVE:
      case T.ACTION_OPEN_ON_PHONE:
        handleAction(message, autoAckActions);
        break;
      case T.ACTION_DISMISS:
        // dismissResult() on the HUD does not wait for an ack — it settles
        // to Ready immediately. Mirror that: no ActionPending theater here.
        onActionStatus('Result dismissed.');
        setUiState(PHONE_UI_STATE.CONNECTED_READY);
        onHandoff('glasses-to-phone', 'Dismissed');
        break;
      case T.ACTION_RETRY:
        // The HUD's retry intent mints a fresh capture.request directly
        // (handled by CAPTURE_REQUEST below) rather than sending this type.
        onActionStatus('Retry requested.');
        break;
      default:
        break;
    }
  }

  function onWindowMessage(event) {
    if (state.dropped) return;
    const verdict = evaluateMessageTrust(event, {
      allowlist,
      selfOrigin,
      approvedSources: [frameWindow()].filter(Boolean),
      requireSource: true,
    });
    if (!verdict.trusted) return;

    const paired = Boolean(state.sessionId) && state.sessionExpiresAt > Date.now();
    const protocolVerdict = validateMessage(event.data, {
      deviceId: state.hudDeviceId || event.data?.deviceId || '',
      paired,
    });
    if (!protocolVerdict.ok) {
      onLog('drop', event.data?.messageType || 'unparseable', `rejected:${protocolVerdict.code}`);
      return;
    }
    const message = protocolVerdict.message;
    onLog('in', message.messageType, message.requestId ? `req=${String(message.requestId).slice(-8)}` : '');

    if (message.sessionId !== null && message.sessionId !== state.sessionId) {
      onLog('drop', message.messageType, 'wrong-session');
      return;
    }
    handleProtocolMessage(message);
  }

  window.addEventListener('message', onWindowMessage);

  return {
    // ── Pairing & session ──
    approve() {
      if (!state.pairingNonce) { onSessionStatus('No pairing request pending.'); return; }
      state.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      state.sessionExpiresAt = Date.now() + SESSION_TTL_MS;
      send(T.PAIR_APPROVED, {
        pairingNonce: state.pairingNonce,
        sessionId: state.sessionId,
        sessionExpiresAt: state.sessionExpiresAt,
        capabilities: ALL_CAPS,
        phoneDeviceName: PHONE_NAME,
      }, { requestId: null, sessionId: null });
      onSessionStatus('Session active — MOCK');
      setTimeout(() => {
        send(T.SESSION_READY, { phoneDeviceName: PHONE_NAME }, { requestId: null });
        setUiState(PHONE_UI_STATE.CONNECTED_READY);
      }, 150);
    },
    deny() {
      send(T.PAIR_DENIED, { pairingNonce: state.pairingNonce, reason: 'user-denied' }, { requestId: null, sessionId: null });
      state.pairingNonce = null;
      onSessionStatus('Pairing denied.');
      setUiState(PHONE_UI_STATE.IDLE);
    },
    expirePairing() {
      send(T.PAIR_EXPIRED, { pairingNonce: state.pairingNonce, reason: 'window-closed' }, { requestId: null, sessionId: null });
      state.pairingNonce = null;
      setUiState(PHONE_UI_STATE.IDLE);
    },
    revokeSession() {
      send(T.SESSION_REVOKED, { reason: 'revoked-by-phone' }, { requestId: null });
      state.sessionId = null;
      state.sessionExpiresAt = 0;
      onSessionStatus('Session: none');
      setUiState(PHONE_UI_STATE.IDLE);
    },
    refreshRequired() {
      send(T.SESSION_REFRESH_REQUIRED, { reason: 'peer-state-lost' }, { requestId: null });
    },
    drop() {
      clearDriveTimers();
      if (state.hudDeviceId) {
        const win = frameWindow();
        const lost = buildMessage(T.CONNECTION_LOST, {
          requestId: null, sessionId: null, deviceId: state.hudDeviceId, payload: { reason: 'mock-drop' },
        });
        if (lost && win) {
          win.postMessage(lost, selfOrigin);
          onLog('out', T.CONNECTION_LOST, 'mock-drop');
        }
      }
      state.dropped = true;
      state.dropAt = Date.now();
      onLog('drop', 'connection', 'connection dropped — phone silent');
      setUiState(PHONE_UI_STATE.DROPPED);
    },
    restore() {
      state.dropped = false;
      send(T.CONNECTION_RESTORED, {}, { requestId: null, sessionId: null });
      onLog('out', 'connection.restored', '');
      // The HUD's own reconnect window (src/companion/runtimeState.js
      // RUNTIME_TIMEOUTS.RECONNECT) has no ack message on a late restore —
      // there is no protocol-legal way to know for certain whether the HUD
      // accepted this CONNECTION_RESTORED or already fell back to
      // Disconnected on its own timeout. Mirror the HUD's own timing rule
      // instead of guessing: only claim reconnection succeeded when this
      // restore() landed inside that same window (with a small safety
      // margin for message-delivery latency); otherwise show the honest
      // "link down" state the HUD itself would show.
      const withinReconnectWindow = state.dropAt !== null
        && (Date.now() - state.dropAt) < (RUNTIME_TIMEOUTS.RECONNECT - 500);
      state.dropAt = null;
      if (!withinReconnectWindow) {
        setUiState(PHONE_UI_STATE.IDLE);
        return;
      }
      setUiState(state.sessionId ? PHONE_UI_STATE.CONNECTED_READY : PHONE_UI_STATE.IDLE);
    },
    // ── Scan drive ──
    setFixture(key) { if (FIXTURE_BUILDERS[key]) state.fixtureKey = key; },
    setDemoScenario(builderFn) { state.demoBuilder = typeof builderFn === 'function' ? builderFn : null; },
    clearDemoScenario() { state.demoBuilder = null; },
    setAutoAck(value) { autoAckActions = Boolean(value); },
    driveAuto() { if (state.activeRequestId) { clearDriveTimers(); driveScan(state.activeRequestId); } },
    stopDrive() {
      clearDriveTimers();
      onScanStatus(state.activeRequestId ? `Drive stopped — active req=${String(state.activeRequestId).slice(-8)}` : 'Drive stopped — no active request');
    },
    sendCaptureStarted() { state.activeRequestId && send(T.CAPTURE_STARTED, {}, { requestId: state.activeRequestId }); },
    sendPrivacy() { state.activeRequestId && send(T.SCAN_PROCESSING, { stage: 'privacy' }, { requestId: state.activeRequestId }); },
    sendAnalyzing() { state.activeRequestId && send(T.SCAN_PROCESSING, { stage: 'analyzing' }, { requestId: state.activeRequestId }); },
    sendScanFailed() {
      const rid = state.activeRequestId;
      const inFlight = state.isDriving && rid;
      clearDriveTimers();
      if (inFlight) {
        state.failArmToken = 0;
        send(T.SCAN_FAILED, { code: 'ANALYZE_FAILED', safeMessage: 'Mock failure' }, { requestId: rid });
        onScanStatus(`Scan failed req=${String(rid).slice(-8)} — Retry for a new request`);
        setUiState(PHONE_UI_STATE.CONNECTED_READY);
        return;
      }
      state.failArmToken += 1;
      onScanStatus('Fail armed — next capture will SCAN_FAILED');
    },
    sendResult() {
      if (!state.activeRequestId) { onScanStatus('No active request.'); return; }
      const result = resolveBuilder()(state.activeRequestId);
      send(T.RESULT_SHOW, { result: forWire(result) }, { requestId: state.activeRequestId });
      setUiState(PHONE_UI_STATE.RESULT_READY, { result });
      onHandoff('phone-to-glasses', 'Result ready');
      onResultSent(result);
    },
    // ── Action acks (manual) ──
    ackAccept() { state.activeRequestId && send(T.ACTION_ACCEPTED, { actionType: T.ACTION_SAVE }, { requestId: state.activeRequestId }); },
    ackComplete() { state.activeRequestId && send(T.ACTION_COMPLETED, { actionType: T.ACTION_SAVE, safeMessage: 'Done' }, { requestId: state.activeRequestId }); },
    ackFail() { state.activeRequestId && send(T.ACTION_FAILED, { actionType: T.ACTION_SAVE, code: 'SAVE_FAILED', safeMessage: 'Mock save failure' }, { requestId: state.activeRequestId }); },
    // ── Negative / hostile tests ──
    negMalformed() {
      const win = frameWindow();
      if (!state.dropped && win) win.postMessage({ bogus: true, notAProtocolMessage: 1 }, selfOrigin);
      onLog('out', 'MALFORMED(raw)', '');
    },
    negStale() { send(T.SCAN_FAILED, { code: 'STALE', safeMessage: 'stale' }, { requestId: 'req_stale_999' }); },
    negDupe() {
      const win = frameWindow();
      if (state.lastTerminalMessage && win) {
        win.postMessage(state.lastTerminalMessage, selfOrigin);
        onLog('out', 'DUPLICATE(verbatim resend)', state.lastTerminalMessage.messageType);
      }
    },
    negOversize() {
      if (!state.activeRequestId) { onScanStatus('No active request.'); return; }
      send(T.RESULT_SHOW, { result: FIXTURE_BUILDERS.oversized(state.activeRequestId) }, { requestId: state.activeRequestId });
    },
    negWrongDevice() {
      const saved = state.hudDeviceId;
      state.hudDeviceId = 'hud_WRONG_DEVICE';
      send(T.SESSION_READY, {}, { requestId: null });
      state.hudDeviceId = saved;
      onLog('out', 'session.ready(wrong-device)', '');
    },
    negWrongSession() {
      send(T.SCAN_FAILED, { code: 'X' }, { requestId: state.activeRequestId, sessionId: 'sess_WRONG' });
    },
    // ── Reset (fresh HUD reload) ──
    resetPhoneState() {
      clearDriveTimers();
      state.hudDeviceId = null;
      state.pairingNonce = null;
      state.sessionId = null;
      state.sessionExpiresAt = 0;
      state.dropped = false;
      state.activeRequestId = null;
      state.cancelledRequests = new Set();
      state.lastTerminalMessage = null;
      state.failArmToken = 0;
      state.dropAt = null;
      setUiState(PHONE_UI_STATE.IDLE);
    },
    // ── Introspection ──
    getUiState: () => state.uiState,
    getDiagnostics: () => ({
      uiState: state.uiState,
      hudDeviceId: state.hudDeviceId,
      sessionActive: Boolean(state.sessionId) && state.sessionExpiresAt > Date.now(),
      activeRequestId: state.activeRequestId,
      dropped: state.dropped,
    }),
    destroy() {
      clearDriveTimers();
      window.removeEventListener('message', onWindowMessage);
    },
  };
}
