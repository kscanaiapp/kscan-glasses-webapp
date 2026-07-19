// Mock phone companion — LOCAL QA / NON-PRODUCTION (simulator build only).
//
// Simulates the future K Scan mobile companion: pairing authority, scan
// lifecycle driver, structured result sender, action acknowledger. Talks to
// the HUD iframe over the SAME canonical protocol + trust evaluator the HUD
// uses — this is an interop peer, not a bypass.
//
// This module must never ship in the production artifact.

import { evaluateMessageTrust, buildMessageOriginAllowlist } from '../messageTrust.js';
import { MESSAGE_TYPES, buildMessage, validateMessage } from './protocol.js';
import { FIXTURE_BUILDERS } from './resultFixtures.js';

const T = MESSAGE_TYPES;
const PHONE_NAME = 'Mock Phone (LOCAL QA)';
const SESSION_TTL_MS = 30 * 60 * 1000;
const ALL_CAPS = ['scan.trigger', 'result.receive', 'result.dismiss', 'action.save', 'action.open_on_phone', 'action.retry', 'action.cancel'];

const els = {
  frame: document.getElementById('hud-frame'),
  log: document.getElementById('log'),
  sessionStatus: document.getElementById('session-status'),
  scanStatus: document.getElementById('scan-status'),
  actionStatus: document.getElementById('action-status'),
  fixtureSelect: document.getElementById('fixture-select'),
  autoAck: document.getElementById('chk-auto-ack'),
};

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
};

// ── Logging (metadata only — never payloads) ─────────────────────────────
function log(direction, messageType, extra = '') {
  const line = document.createElement('div');
  const pill = direction === 'drop' ? 'drop' : direction === 'in' ? 'in' : 'out';
  line.innerHTML = `<span class="pill ${pill}"></span> `;
  line.appendChild(document.createTextNode(`${messageType}${extra ? ` ${extra}` : ''}`));
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.children.length > 200) els.log.removeChild(els.log.firstChild);
}

function setSessionStatus() {
  els.sessionStatus.textContent = state.sessionId
    ? `Session: active (expires in ${Math.max(0, Math.round((state.sessionExpiresAt - Date.now()) / 1000))}s) — MOCK`
    : 'Session: none';
}

// ── Outbound ─────────────────────────────────────────────────────────────
function send(messageType, payload = {}, { requestId = null, sessionId } = {}) {
  if (state.dropped) { log('drop', messageType, '(swallowed — connection down)'); return null; }
  if (!state.hudDeviceId) return null;
  const message = buildMessage(messageType, {
    requestId,
    sessionId: sessionId !== undefined ? sessionId : state.sessionId,
    deviceId: state.hudDeviceId,
    payload,
  });
  if (!message) { log('drop', messageType, '(builder refused)'); return null; }
  els.frame.contentWindow.postMessage(message, window.location.origin);
  log('out', messageType, requestId ? `req=${String(requestId).slice(-8)}` : '');
  return message;
}

function clearDriveTimers() {
  state.driveTimers.forEach((t) => clearTimeout(t));
  state.driveTimers = [];
}

function later(ms, fn) {
  state.driveTimers.push(setTimeout(fn, ms));
}

// ── Scan drive ───────────────────────────────────────────────────────────
function driveScan(requestId) {
  if (state.cancelledRequests.has(requestId)) return;
  els.scanStatus.textContent = `Driving scan req=${String(requestId).slice(-8)}`;
  later(200, () => send(T.CAPTURE_STARTED, {}, { requestId }));
  later(600, () => send(T.SCAN_PROCESSING, { stage: 'privacy', stageLabel: 'On-device face masking' }, { requestId }));
  later(1100, () => send(T.SCAN_PROCESSING, { stage: 'analyzing', stageLabel: 'Finding matches' }, { requestId }));
  later(1600, () => {
    const builder = FIXTURE_BUILDERS[els.fixtureSelect.value] || FIXTURE_BUILDERS.full;
    const result = builder(requestId);
    send(T.RESULT_SHOW, { result }, { requestId });
    els.scanStatus.textContent = `Result sent (${els.fixtureSelect.value}) req=${String(requestId).slice(-8)}`;
  });
}

// ── Inbound ──────────────────────────────────────────────────────────────
const allowlist = buildMessageOriginAllowlist([], window.location.origin);

function handleCaptureRequest(message) {
  if (state.cancelledRequests.has(message.requestId)) state.cancelledRequests.delete(message.requestId);
  state.activeRequestId = message.requestId;
  clearDriveTimers();
  driveScan(message.requestId);
}

function handleAction(message) {
  const label = `${message.messageType} result=${message.payload.resultId || '-'}`;
  els.actionStatus.textContent = `Received ${label}`;
  if (!els.autoAck.checked) return;
  const { requestId } = message;
  later(150, () => send(T.ACTION_ACCEPTED, { actionType: message.messageType, resultId: message.payload.resultId ?? undefined }, { requestId }));
  later(450, () => {
    const done = send(T.ACTION_COMPLETED, { actionType: message.messageType, resultId: message.payload.resultId ?? undefined, safeMessage: 'Done' }, { requestId });
    if (done) state.lastTerminalMessage = done;
  });
}

function handleProtocolMessage(message) {
  switch (message.messageType) {
    case T.PAIR_REQUEST:
      state.hudDeviceId = message.deviceId;
      state.pairingNonce = message.payload.pairingNonce;
      els.sessionStatus.textContent = `Pairing requested by ${message.deviceId.slice(0, 18)}… — approve or deny`;
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
      els.scanStatus.textContent = `Scan cancelled req=${String(message.requestId).slice(-8)}`;
      break;
    case T.ACTION_SAVE:
    case T.ACTION_OPEN_ON_PHONE:
    case T.ACTION_RETRY:
    case T.ACTION_DISMISS:
      handleAction(message);
      break;
    default:
      break;
  }
}

window.addEventListener('message', (event) => {
  if (state.dropped) return; // connection down: phone hears nothing
  const verdict = evaluateMessageTrust(event, {
    allowlist,
    selfOrigin: window.location.origin,
    approvedSources: [els.frame.contentWindow],
    requireSource: true,
  });
  if (!verdict.trusted) return;

  // Protocol validation with phone-side context. Pairing handshake is
  // accepted pre-session; everything else requires the active session.
  const paired = Boolean(state.sessionId) && state.sessionExpiresAt > Date.now();
  const protocolVerdict = validateMessage(event.data, {
    deviceId: state.hudDeviceId || event.data?.deviceId || '',
    paired,
  });
  if (!protocolVerdict.ok) {
    log('drop', event.data?.messageType || 'unparseable', `rejected:${protocolVerdict.code}`);
    return;
  }
  const message = protocolVerdict.message;
  log('in', message.messageType, message.requestId ? `req=${String(message.requestId).slice(-8)}` : '');

  // Session correlation for session-bearing traffic.
  if (message.sessionId !== null && message.sessionId !== state.sessionId) {
    log('drop', message.messageType, 'wrong-session');
    return;
  }
  handleProtocolMessage(message);
});

// ── Controls ─────────────────────────────────────────────────────────────
function wire(id, fn) {
  document.getElementById(id).addEventListener('click', fn);
}

wire('btn-approve', () => {
  if (!state.pairingNonce) { els.sessionStatus.textContent = 'No pairing request pending.'; return; }
  state.sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  state.sessionExpiresAt = Date.now() + SESSION_TTL_MS;
  send(T.PAIR_APPROVED, {
    pairingNonce: state.pairingNonce,
    sessionId: state.sessionId,
    sessionExpiresAt: state.sessionExpiresAt,
    capabilities: ALL_CAPS,
    phoneDeviceName: PHONE_NAME,
  }, { requestId: null, sessionId: null });
  setSessionStatus();
  setTimeout(() => send(T.SESSION_READY, { phoneDeviceName: PHONE_NAME }, { requestId: null }), 150);
});

wire('btn-deny', () => {
  send(T.PAIR_DENIED, { pairingNonce: state.pairingNonce, reason: 'user-denied' }, { requestId: null, sessionId: null });
  state.pairingNonce = null;
  els.sessionStatus.textContent = 'Pairing denied.';
});

wire('btn-expire-pair', () => {
  send(T.PAIR_EXPIRED, { pairingNonce: state.pairingNonce, reason: 'window-closed' }, { requestId: null, sessionId: null });
  state.pairingNonce = null;
});

wire('btn-revoke', () => {
  send(T.SESSION_REVOKED, { reason: 'revoked-by-phone' }, { requestId: null });
  state.sessionId = null;
  state.sessionExpiresAt = 0;
  setSessionStatus();
});

wire('btn-drop', () => {
  state.dropped = true;
  clearDriveTimers();
  log('drop', 'connection', 'connection dropped — phone silent');
});

wire('btn-restore', () => {
  state.dropped = false;
  send(T.CONNECTION_RESTORED, {}, { requestId: null, sessionId: null });
  log('out', 'connection.restored', '');
});

wire('btn-refresh-required', () => {
  send(T.SESSION_REFRESH_REQUIRED, { reason: 'peer-state-lost' }, { requestId: null });
});

wire('btn-drive-auto', () => {
  if (state.activeRequestId) { clearDriveTimers(); driveScan(state.activeRequestId); }
});

wire('btn-capture-started', () => state.activeRequestId && send(T.CAPTURE_STARTED, {}, { requestId: state.activeRequestId }));
wire('btn-privacy', () => state.activeRequestId && send(T.SCAN_PROCESSING, { stage: 'privacy' }, { requestId: state.activeRequestId }));
wire('btn-analyzing', () => state.activeRequestId && send(T.SCAN_PROCESSING, { stage: 'analyzing' }, { requestId: state.activeRequestId }));
wire('btn-scan-failed', () => state.activeRequestId && send(T.SCAN_FAILED, { code: 'ANALYZE_FAILED', safeMessage: 'Mock failure' }, { requestId: state.activeRequestId }));

wire('btn-send-result', () => {
  if (!state.activeRequestId) { els.scanStatus.textContent = 'No active request.'; return; }
  const builder = FIXTURE_BUILDERS[els.fixtureSelect.value] || FIXTURE_BUILDERS.full;
  send(T.RESULT_SHOW, { result: builder(state.activeRequestId) }, { requestId: state.activeRequestId });
});

wire('btn-ack-accept', () => state.activeRequestId && send(T.ACTION_ACCEPTED, { actionType: T.ACTION_SAVE }, { requestId: state.activeRequestId }));
wire('btn-ack-complete', () => state.activeRequestId && send(T.ACTION_COMPLETED, { actionType: T.ACTION_SAVE, safeMessage: 'Done' }, { requestId: state.activeRequestId }));
wire('btn-ack-fail', () => state.activeRequestId && send(T.ACTION_FAILED, { actionType: T.ACTION_SAVE, code: 'SAVE_FAILED', safeMessage: 'Mock save failure' }, { requestId: state.activeRequestId }));

// ── Negative tests ───────────────────────────────────────────────────────
wire('btn-neg-malformed', () => {
  if (!state.dropped) els.frame.contentWindow.postMessage({ bogus: true, notAProtocolMessage: 1 }, window.location.origin);
  log('out', 'MALFORMED(raw)', '');
});

wire('btn-neg-stale', () => {
  send(T.SCAN_FAILED, { code: 'STALE', safeMessage: 'stale' }, { requestId: 'req_stale_999' });
});

wire('btn-neg-dupe', () => {
  if (state.lastTerminalMessage) {
    els.frame.contentWindow.postMessage(state.lastTerminalMessage, window.location.origin);
    log('out', 'DUPLICATE(verbatim resend)', state.lastTerminalMessage.messageType);
  }
});

wire('btn-neg-oversize', () => {
  if (!state.activeRequestId) { els.scanStatus.textContent = 'No active request.'; return; }
  send(T.RESULT_SHOW, { result: FIXTURE_BUILDERS.oversized(state.activeRequestId) }, { requestId: state.activeRequestId });
});

wire('btn-neg-device', () => {
  const saved = state.hudDeviceId;
  state.hudDeviceId = 'hud_WRONG_DEVICE';
  send(T.SESSION_READY, {}, { requestId: null });
  state.hudDeviceId = saved;
  log('out', 'session.ready(wrong-device)', '');
});

wire('btn-neg-session', () => {
  send(T.SCAN_FAILED, { code: 'X' }, { requestId: state.activeRequestId, sessionId: 'sess_WRONG' });
});

// ── Init ─────────────────────────────────────────────────────────────────
for (const key of Object.keys(FIXTURE_BUILDERS)) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = key;
  els.fixtureSelect.appendChild(option);
}
els.fixtureSelect.value = 'full';
setSessionStatus();
setInterval(setSessionStatus, 5000);
