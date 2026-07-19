// Canonical Meta HUD connected-runtime state machine — companion Phase A.
//
// This machine is the ONLY place that decides how the HUD reacts to
// companion protocol messages and user intents. It is transport-agnostic:
// inbound messages arrive already protocol-validated; outbound messages are
// emitted through the onOutbound hook; time advances through tick(now),
// which the integration layer drives (heartbeat interval) so tests are
// deterministic without fake timers.
//
// Safety invariants (do not weaken):
//   - Invalid transitions are rejected (message ignored, state preserved).
//   - Late/stale messages (mismatched requestId or sessionId) are dropped.
//   - Terminal events settle once per request; duplicates are dropped.
//   - Cancel prevents any later completion from rendering.
//   - Retry always mints a NEW requestId; a second scan never inherits the
//     first scan's terminal state.
//   - Results render only against the active request.
//   - Action acknowledgements apply only to the pending action.
//   - Connection loss never silently preserves an invalid session; expired
//     sessions cannot resume; reconnection requires a valid session.
//   - Snapshots expose safe metadata only — never payloads, never tokens.

import { MESSAGE_TYPES, isTerminalType, buildMessage } from './protocol.js';
import { PAIRING_STATE } from './session.js';

export const RUNTIME_STATE = Object.freeze({
  DISCONNECTED: 'Disconnected',
  PAIRING: 'Pairing',
  PAIRING_DENIED: 'PairingDenied',
  PAIRING_EXPIRED: 'PairingExpired',
  CONNECTED: 'Connected',
  READY: 'Ready',
  CAPTURE_REQUESTED: 'CaptureRequested',
  CAPTURING_ON_PHONE: 'CapturingOnPhone',
  PRIVACY_PROCESSING: 'PrivacyProcessing',
  ANALYZING: 'Analyzing',
  RESULTS: 'Results',
  ACTION_PENDING: 'ActionPending',
  ACTION_CONFIRMED: 'ActionConfirmed',
  ERROR: 'Error',
  RECONNECTING: 'Reconnecting',
  SESSION_REVOKED: 'SessionRevoked',
});

const S = RUNTIME_STATE;
const T = MESSAGE_TYPES;

// Timeout policy (ms). The pairing window itself lives in session.js.
export const RUNTIME_TIMEOUTS = Object.freeze({
  SCAN_REQUEST: 15000, // CaptureRequested → no capture.started
  SCAN_RUN: 60000, // any active scan stage without progress terminal
  ACTION: 10000, // ActionPending → no ack
  RECONNECT: 10000, // Reconnecting window
});

// Active scan stages (cancel must outbound action.cancel from these).
const ACTIVE_SCAN_STATES = new Set([
  S.CAPTURE_REQUESTED, S.CAPTURING_ON_PHONE, S.PRIVACY_PROCESSING, S.ANALYZING,
]);

// Scan stages where connection loss is remembered for reconnect recovery.
const RESUMABLE_STATES = new Set([
  S.READY, S.CAPTURE_REQUESTED, S.CAPTURING_ON_PHONE, S.PRIVACY_PROCESSING,
  S.ANALYZING, S.RESULTS, S.ACTION_PENDING, S.ACTION_CONFIRMED,
]);

// ── Per-state HUD metadata ───────────────────────────────────────────────
// title/support: visible strings. primary/secondary: user intents offered.
// progress: 'idle' | 'indeterminate' | 'determinate'. focusTarget: which
// action slot receives focus on entry. cancel/back: behavior labels the
// integration layer honors through userIntent().
export const STATE_META = Object.freeze({
  [S.DISCONNECTED]: {
    title: 'Not connected', support: 'Pair your phone to scan.', progress: 'idle',
    primary: { intent: 'pair', label: 'Pair Phone' }, secondary: [], focusTarget: 'primary',
    timeout: 'none', back: 'home', cancel: 'none', recovery: 'pair',
    inbound: [], outbound: [T.PAIR_REQUEST],
  },
  [S.PAIRING]: {
    title: 'Pairing…', support: 'Approve this glasses device on your phone.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'cancel', label: 'Cancel' }], focusTarget: 'secondary',
    timeout: 'pairing-window', back: 'cancel', cancel: 'cancel-pairing', recovery: 'retry-pair',
    inbound: [T.PAIR_CHALLENGE, T.PAIR_APPROVED, T.PAIR_DENIED, T.PAIR_EXPIRED, T.CONNECTION_LOST],
    outbound: [],
  },
  [S.PAIRING_DENIED]: {
    title: 'Pairing denied', support: 'The phone declined this device.', progress: 'idle',
    primary: { intent: 'pair', label: 'Try Again' }, secondary: [{ intent: 'back', label: 'Back' }], focusTarget: 'primary',
    timeout: 'none', back: 'disconnect', cancel: 'disconnect', recovery: 'retry-pair',
    inbound: [], outbound: [T.PAIR_REQUEST],
  },
  [S.PAIRING_EXPIRED]: {
    title: 'Pairing expired', support: 'The approval window closed.', progress: 'idle',
    primary: { intent: 'pair', label: 'Try Again' }, secondary: [{ intent: 'back', label: 'Back' }], focusTarget: 'primary',
    timeout: 'none', back: 'disconnect', cancel: 'disconnect', recovery: 'retry-pair',
    inbound: [], outbound: [T.PAIR_REQUEST],
  },
  [S.CONNECTED]: {
    title: 'Connected', support: 'Finishing setup…', progress: 'indeterminate',
    primary: null, secondary: [], focusTarget: 'none',
    timeout: 'none', back: 'disconnect', cancel: 'disconnect', recovery: 'auto',
    inbound: [T.SESSION_READY, T.SESSION_ERROR, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.CONNECTION_PONG],
  },
  [S.READY]: {
    title: 'Ready', support: 'Point at an item and scan.', progress: 'idle',
    primary: { intent: 'scan', label: 'Scan' },
    secondary: [{ intent: 'unpair', label: 'Disconnect' }], focusTarget: 'primary',
    timeout: 'none', back: 'home', cancel: 'none', recovery: 'scan',
    inbound: [T.CONNECTION_LOST, T.SESSION_REVOKED, T.SESSION_REFRESH_REQUIRED, T.CONNECTION_PING],
    outbound: [T.CAPTURE_REQUEST, T.CONNECTION_PONG],
  },
  [S.CAPTURE_REQUESTED]: {
    title: 'Requesting capture…', support: 'Asking your phone to scan.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'cancel', label: 'Cancel' }], focusTarget: 'secondary',
    timeout: 'scan-request', back: 'cancel', cancel: 'cancel-scan', recovery: 'retry-scan',
    inbound: [T.CAPTURE_STARTED, T.CAPTURE_FAILED, T.CAPTURE_CANCELLED, T.SCAN_FAILED, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.ACTION_CANCEL, T.CONNECTION_PONG],
  },
  [S.CAPTURING_ON_PHONE]: {
    title: 'Capturing on phone', support: 'Hold steady.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'cancel', label: 'Cancel' }], focusTarget: 'secondary',
    timeout: 'scan-run', back: 'cancel', cancel: 'cancel-scan', recovery: 'retry-scan',
    inbound: [T.SCAN_PROCESSING, T.SCAN_PROGRESS, T.CAPTURE_COMPLETED, T.CAPTURE_FAILED, T.CAPTURE_CANCELLED, T.SCAN_FAILED, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.ACTION_CANCEL, T.CONNECTION_PONG],
  },
  [S.PRIVACY_PROCESSING]: {
    title: 'Protecting privacy', support: 'On-device face masking.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'cancel', label: 'Cancel' }], focusTarget: 'secondary',
    timeout: 'scan-run', back: 'cancel', cancel: 'cancel-scan', recovery: 'retry-scan',
    inbound: [T.SCAN_PROCESSING, T.SCAN_PROGRESS, T.SCAN_FAILED, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.ACTION_CANCEL, T.CONNECTION_PONG],
  },
  [S.ANALYZING]: {
    title: 'Finding matches', support: 'Fashion AI is working.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'cancel', label: 'Cancel' }], focusTarget: 'secondary',
    timeout: 'scan-run', back: 'cancel', cancel: 'cancel-scan', recovery: 'retry-scan',
    inbound: [T.SCAN_PROGRESS, T.RESULT_SHOW, T.SCAN_COMPLETED, T.SCAN_FAILED, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.ACTION_CANCEL, T.CONNECTION_PONG],
  },
  [S.RESULTS]: {
    title: 'Style Match', support: '', progress: 'idle',
    primary: { intent: 'save', label: 'Save' },
    secondary: [
      { intent: 'open_on_phone', label: 'Open on Phone' },
      { intent: 'retry', label: 'Retry' },
      { intent: 'dismiss', label: 'Dismiss' },
    ],
    focusTarget: 'primary',
    timeout: 'none', back: 'dismiss', cancel: 'dismiss', recovery: 'retry',
    inbound: [T.RESULT_UPDATE, T.RESULT_DISMISS, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.ACTION_SAVE, T.ACTION_OPEN_ON_PHONE, T.ACTION_RETRY, T.ACTION_DISMISS, T.CAPTURE_REQUEST, T.CONNECTION_PONG],
  },
  [S.ACTION_PENDING]: {
    title: 'Working…', support: 'Confirming with your phone.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'back', label: 'Back' }], focusTarget: 'secondary',
    timeout: 'action', back: 'results', cancel: 'results', recovery: 'results',
    inbound: [T.ACTION_ACCEPTED, T.ACTION_COMPLETED, T.ACTION_FAILED, T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.CONNECTION_PONG],
  },
  [S.ACTION_CONFIRMED]: {
    title: 'Done', support: '', progress: 'idle',
    primary: { intent: 'dismiss', label: 'Done' },
    secondary: [], focusTarget: 'primary',
    timeout: 'none', back: 'results', cancel: 'results', recovery: 'results',
    inbound: [T.CONNECTION_LOST, T.CONNECTION_PING],
    outbound: [T.ACTION_DISMISS, T.CONNECTION_PONG],
  },
  [S.ERROR]: {
    title: 'Something went wrong', support: '', progress: 'idle',
    primary: { intent: 'retry', label: 'Retry' },
    secondary: [{ intent: 'back', label: 'Back' }], focusTarget: 'primary',
    timeout: 'none', back: 'ready-or-disconnected', cancel: 'ready-or-disconnected', recovery: 'retry-scan',
    inbound: [T.CONNECTION_LOST],
    outbound: [T.CAPTURE_REQUEST],
  },
  [S.RECONNECTING]: {
    title: 'Reconnecting…', support: 'Connection to phone interrupted.', progress: 'indeterminate',
    primary: null, secondary: [{ intent: 'cancel', label: 'Cancel' }], focusTarget: 'secondary',
    timeout: 'reconnect', back: 'cancel', cancel: 'disconnect', recovery: 'auto',
    inbound: [T.CONNECTION_RESTORED, T.CONNECTION_PONG, T.SESSION_REVOKED, T.SESSION_REFRESH_REQUIRED],
    outbound: [T.CONNECTION_PING],
  },
  [S.SESSION_REVOKED]: {
    title: 'Session ended', support: 'Pair again to continue.', progress: 'idle',
    primary: { intent: 'pair', label: 'Pair Again' },
    secondary: [{ intent: 'back', label: 'Back' }], focusTarget: 'primary',
    timeout: 'none', back: 'disconnect', cancel: 'disconnect', recovery: 'retry-pair',
    inbound: [], outbound: [T.PAIR_REQUEST],
  },
});

const MAX_SEEN_MESSAGES = 256;
const MAX_TERMINAL_REQUESTS = 64;

let requestCounter = 0;
function mintRequestId() {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}_${requestCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * @param {object} options
 * @param {object} options.sessionManager - createSessionManager() instance.
 * @param {() => number} [options.now]
 * @param {(prev: string, next: string, detail: object) => void} [options.onTransition]
 * @param {(message: object) => void} [options.onOutbound] - protocol message to send.
 */
export function createRuntimeMachine({ sessionManager, now = () => Date.now(), onTransition = () => {}, onOutbound = () => {} } = {}) {
  if (!sessionManager) throw new Error('runtime machine requires a sessionManager');

  let state = S.DISCONNECTED;
  let activeRequestId = null;
  let currentResult = null; // validated result payload (structured metadata only)
  let pendingAction = null; // { actionType, resultId, requestId }
  let lastError = null; // safe short code/label only
  let resumeState = null; // state held when connection dropped
  let scanDeadline = null;
  let actionDeadline = null;
  let reconnectDeadline = null;
  const seenMessageIds = new Set();
  const terminalRequestIds = new Set();

  function rememberSeen(messageId) {
    if (seenMessageIds.size >= MAX_SEEN_MESSAGES) {
      const oldest = seenMessageIds.values().next().value;
      seenMessageIds.delete(oldest);
    }
    seenMessageIds.add(messageId);
  }

  function rememberTerminal(requestId) {
    if (terminalRequestIds.size >= MAX_TERMINAL_REQUESTS) {
      const oldest = terminalRequestIds.values().next().value;
      terminalRequestIds.delete(oldest);
    }
    terminalRequestIds.add(requestId);
  }

  function send(messageType, payload = {}, { requestId = activeRequestId, ttlMs } = {}) {
    const message = buildMessage(messageType, {
      requestId,
      sessionId: sessionManager.getSessionId(),
      deviceId: sessionManager.getDeviceId(),
      payload,
      now: now(),
      ttlMs,
    });
    if (message) onOutbound(message);
    return message;
  }

  function transition(next, detail = {}) {
    if (state === next) return;
    const prev = state;
    state = next;
    onTransition(prev, next, detail);
  }

  function settleScan() {
    scanDeadline = null;
    activeRequestId = null;
  }

  function settleAction() {
    actionDeadline = null;
    pendingAction = null;
  }

  function armScanDeadline(ms) {
    scanDeadline = now() + ms;
  }

  function failWith(code, support = '') {
    settleScan();
    settleAction();
    lastError = { code: String(code).slice(0, 60), support: String(support || '').slice(0, 80) };
    transition(S.ERROR, { error: lastError });
  }

  function toSessionRevoked(reason) {
    settleScan();
    settleAction();
    currentResult = null;
    sessionManager.clearSession(reason);
    transition(S.SESSION_REVOKED, { reason });
  }

  function beginPairing() {
    const { pairingNonce } = sessionManager.beginPairing();
    transition(S.PAIRING, {});
    send(T.PAIR_REQUEST, { pairingNonce }, { requestId: null });
  }

  function startScan() {
    if (!sessionManager.isMessagePermitted(T.CAPTURE_REQUEST)) {
      failWith('NOT_PERMITTED', 'Scan is not allowed on this session.');
      return;
    }
    // Every scan mints a new requestId — no inherited terminal state.
    activeRequestId = mintRequestId();
    currentResult = null;
    settleAction();
    lastError = null;
    transition(S.CAPTURE_REQUESTED, { requestId: activeRequestId });
    send(T.CAPTURE_REQUEST, { scanIntent: 'style-match' });
    armScanDeadline(RUNTIME_TIMEOUTS.SCAN_REQUEST);
  }

  function cancelActiveScan(reason = 'user-cancel') {
    if (!ACTIVE_SCAN_STATES.has(state)) return;
    const cancelledRequest = activeRequestId;
    if (cancelledRequest) {
      rememberTerminal(cancelledRequest); // late completions for it drop
      send(T.ACTION_CANCEL, { reason }, { requestId: cancelledRequest });
    }
    settleScan();
    transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, { cancelled: true });
  }

  function dismissResult() {
    if (currentResult) {
      send(T.ACTION_DISMISS, { resultId: currentResult.resultId });
    }
    currentResult = null;
    settleScan(); // drops the request correlation anchor for this result
    settleAction();
    transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, { dismissed: true });
  }

  function onConnectionLost(reason) {
    if (state === S.DISCONNECTED || state === S.PAIRING_DENIED || state === S.PAIRING_EXPIRED || state === S.SESSION_REVOKED) return;
    resumeState = RESUMABLE_STATES.has(state) ? state : null;
    reconnectDeadline = now() + RUNTIME_TIMEOUTS.RECONNECT;
    transition(S.RECONNECTING, { reason: String(reason || 'transport-lost').slice(0, 60) });
  }

  function onConnectionRestored() {
    if (state !== S.RECONNECTING) return; // stale restore — ignore
    reconnectDeadline = null;
    if (!sessionManager.isSessionValid()) {
      toSessionRevoked('session-expired-during-reconnect');
      return;
    }
    settleScan();
    settleAction();
    currentResult = null;
    resumeState = null;
    transition(S.READY, { restored: true });
  }

  // ── Inbound message handlers (post protocol-validation) ────────────────
  const HANDLERS = {
    [T.PAIR_CHALLENGE](msg) {
      if (state !== S.PAIRING || !sessionManager.nonceMatches(msg.payload)) return false;
      return true; // defined behavior: nonce confirmed; approval may follow
    },
    [T.PAIR_APPROVED](msg) {
      if (state !== S.PAIRING) return false;
      const res = sessionManager.handlePairApproved(msg.payload);
      if (!res.ok) {
        transition(S.PAIRING_DENIED, { reason: res.code });
        return true;
      }
      transition(S.CONNECTED, { sessionId: res.session.sessionId });
      return true;
    },
    [T.PAIR_DENIED](msg) {
      if (state !== S.PAIRING) return false;
      sessionManager.endPairingTerminal(msg.payload.reason || 'denied');
      transition(S.PAIRING_DENIED, {});
      return true;
    },
    [T.PAIR_EXPIRED](msg) {
      if (state !== S.PAIRING) return false;
      sessionManager.endPairingTerminal(msg.payload.reason || 'expired');
      transition(S.PAIRING_EXPIRED, {});
      return true;
    },
    [T.PAIR_REVOKED]() {
      toSessionRevoked('pairing-revoked');
      return true;
    },
    [T.SESSION_READY]() {
      if (state !== S.CONNECTED) return false;
      transition(S.READY, {});
      return true;
    },
    [T.SESSION_REFRESH_REQUIRED]() {
      toSessionRevoked('refresh-required');
      return true;
    },
    [T.SESSION_REVOKED]() {
      toSessionRevoked('revoked-by-phone');
      return true;
    },
    [T.SESSION_ERROR](msg) {
      toSessionRevoked(msg.payload.code || 'session-error');
      return true;
    },
    [T.CAPTURE_STARTED]() {
      if (state !== S.CAPTURE_REQUESTED) return false;
      transition(S.CAPTURING_ON_PHONE, {});
      armScanDeadline(RUNTIME_TIMEOUTS.SCAN_RUN);
      return true;
    },
    [T.CAPTURE_COMPLETED]() {
      // Metadata-only acknowledgement; analysis continues via scan.* events.
      return ACTIVE_SCAN_STATES.has(state);
    },
    [T.SCAN_PROCESSING](msg) {
      if (!ACTIVE_SCAN_STATES.has(state)) return false;
      const stage = msg.payload.stage;
      if (stage === 'privacy' && (state === S.CAPTURING_ON_PHONE || state === S.PRIVACY_PROCESSING)) {
        transition(S.PRIVACY_PROCESSING, {});
      } else if (stage === 'analyzing' && state !== S.CAPTURE_REQUESTED) {
        transition(S.ANALYZING, {});
      }
      armScanDeadline(RUNTIME_TIMEOUTS.SCAN_RUN);
      return true;
    },
    [T.SCAN_PROGRESS](msg) {
      if (!ACTIVE_SCAN_STATES.has(state)) return false;
      if (msg.payload.stage === 'analyzing') transition(S.ANALYZING, { percent: msg.payload.percent ?? null });
      armScanDeadline(RUNTIME_TIMEOUTS.SCAN_RUN);
      return true;
    },
    [T.SCAN_COMPLETED]() {
      // Result-bearing completion is delivered by result.show; a bare
      // scan.completed without result is accepted but holds the state.
      return ACTIVE_SCAN_STATES.has(state);
    },
    [T.RESULT_SHOW](msg) {
      if (state !== S.ANALYZING && state !== S.CAPTURING_ON_PHONE && state !== S.PRIVACY_PROCESSING) return false;
      if (!sessionManager.isMessagePermitted(T.RESULT_SHOW)) return false;
      currentResult = msg.payload.result;
      // Clear the scan deadline but KEEP activeRequestId — it remains the
      // correlation anchor for the action return channel (save/open/retry).
      scanDeadline = null;
      transition(S.RESULTS, { result: currentResult });
      return true;
    },
    [T.RESULT_UPDATE](msg) {
      if (state !== S.RESULTS || !currentResult) return false;
      if (msg.payload.result?.resultId !== currentResult.resultId) return false;
      currentResult = msg.payload.result;
      transition(S.RESULTS, { result: currentResult, updated: true });
      return true;
    },
    [T.RESULT_DISMISS]() {
      if (state !== S.RESULTS && state !== S.ACTION_CONFIRMED) return false;
      currentResult = null;
      settleScan();
      settleAction();
      transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, { dismissed: true });
      return true;
    },
    [T.CAPTURE_FAILED](msg) {
      if (!ACTIVE_SCAN_STATES.has(state)) return false;
      failWith(msg.payload.code || 'CAPTURE_FAILED', 'Capture failed on phone.');
      return true;
    },
    [T.CAPTURE_CANCELLED]() {
      if (!ACTIVE_SCAN_STATES.has(state)) return false;
      settleScan();
      transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, { cancelled: true });
      return true;
    },
    [T.SCAN_FAILED](msg) {
      if (!ACTIVE_SCAN_STATES.has(state)) return false;
      failWith(msg.payload.code || 'SCAN_FAILED', 'Scan failed.');
      return true;
    },
    [T.SCAN_CANCELLED]() {
      if (!ACTIVE_SCAN_STATES.has(state)) return false;
      settleScan();
      transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, { cancelled: true });
      return true;
    },
    [T.ACTION_ACCEPTED](msg) {
      if (state !== S.ACTION_PENDING || !pendingAction) return false;
      if (msg.payload.actionType !== pendingAction.actionType) return false;
      if (msg.payload.resultId && msg.payload.resultId !== pendingAction.resultId) return false;
      return true; // still pending completion
    },
    [T.ACTION_COMPLETED](msg) {
      if (state !== S.ACTION_PENDING || !pendingAction) return false;
      if (msg.payload.actionType !== pendingAction.actionType) return false;
      if (msg.payload.resultId && msg.payload.resultId !== pendingAction.resultId) return false;
      const confirmed = pendingAction.actionType;
      settleAction();
      transition(S.ACTION_CONFIRMED, { actionType: confirmed, safeMessage: msg.payload.safeMessage || '' });
      return true;
    },
    [T.ACTION_FAILED](msg) {
      if (state !== S.ACTION_PENDING || !pendingAction) return false;
      if (msg.payload.actionType !== pendingAction.actionType) return false;
      if (msg.payload.resultId && msg.payload.resultId !== pendingAction.resultId) return false;
      settleAction();
      failWith(msg.payload.code || 'ACTION_FAILED', 'The phone could not complete that action.');
      return true;
    },
    [T.CONNECTION_PING](msg) {
      send(T.CONNECTION_PONG, { nonce: msg.payload.nonce }, { requestId: null });
      return true;
    },
    [T.CONNECTION_PONG]() {
      return true; // liveness bookkeeping is runtime-level; accepted anywhere
    },
    [T.CONNECTION_LOST](msg) {
      onConnectionLost(msg.payload.reason);
      return true;
    },
    [T.CONNECTION_RESTORED]() {
      onConnectionRestored();
      return true;
    },
  };

  /**
   * Dispatch a protocol-validated inbound message.
   * Returns { accepted, reason } — dropped messages never mutate state.
   */
  function dispatchInbound(msg) {
    if (!msg || typeof msg !== 'object') return { accepted: false, reason: 'not-a-message' };

    // Replay/duplicate suppression: seen messageIds never re-process.
    if (seenMessageIds.has(msg.messageId)) return { accepted: false, reason: 'duplicate-message' };

    // Session correlation for session-bearing traffic.
    if (msg.sessionId !== null) {
      const code = sessionManager.validateSessionMessage(msg);
      if (code !== 'OK') return { accepted: false, reason: `session-${code}` };
    }

    // Duplicate terminal events for an already-settled request are dropped
    // BEFORE generic request correlation — the terminal classification is
    // the more specific (and more useful) reason.
    if (isTerminalType(msg.messageType) && msg.requestId && terminalRequestIds.has(msg.requestId)) {
      return { accepted: false, reason: 'duplicate-terminal' };
    }

    // Request correlation: request-bearing traffic must target the active
    // request (actions target the request that produced the result).
    if (msg.requestId !== null && msg.requestId !== activeRequestId && !isActionForCurrentResult(msg)) {
      return { accepted: false, reason: 'stale-request' };
    }

    const handler = HANDLERS[msg.messageType];
    if (!handler) return { accepted: false, reason: 'no-handler' };
    const handled = handler(msg);
    if (!handled) return { accepted: false, reason: 'invalid-transition' };

    rememberSeen(msg.messageId);
    if (isTerminalType(msg.messageType) && msg.requestId) rememberTerminal(msg.requestId);
    return { accepted: true };
  }

  function isActionForCurrentResult(msg) {
    if (!currentResult || !msg.payload || typeof msg.payload !== 'object') return false;
    return msg.payload.resultId === currentResult.resultId;
  }

  /**
   * User intents (D-pad). Intent names match STATE_META primary/secondary.
   */
  function userIntent(intent, data = {}) {
    switch (intent) {
      case 'pair':
        if (![S.DISCONNECTED, S.PAIRING_DENIED, S.PAIRING_EXPIRED, S.SESSION_REVOKED].includes(state)) return { accepted: false, reason: 'invalid-transition' };
        beginPairing();
        return { accepted: true };
      case 'scan':
        if (state !== S.READY) return { accepted: false, reason: 'invalid-transition' };
        startScan();
        return { accepted: true };
      case 'cancel':
        if (state === S.PAIRING) {
          sessionManager.endPairingTerminal('cancelled');
          transition(S.DISCONNECTED, { cancelled: true });
          return { accepted: true };
        }
        if (ACTIVE_SCAN_STATES.has(state)) {
          cancelActiveScan('user-cancel');
          return { accepted: true };
        }
        if (state === S.RECONNECTING) {
          reconnectDeadline = null;
          resumeState = null;
          transition(S.DISCONNECTED, { cancelled: true });
          return { accepted: true };
        }
        if (state === S.ACTION_PENDING) {
          settleAction();
          transition(S.RESULTS, { result: currentResult });
          return { accepted: true };
        }
        if (state === S.RESULTS || state === S.ACTION_CONFIRMED) {
          dismissResult();
          return { accepted: true };
        }
        if (state === S.ERROR) {
          transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, {});
          return { accepted: true };
        }
        return { accepted: false, reason: 'invalid-transition' };
      case 'back': {
        const meta = STATE_META[state];
        if (!meta) return { accepted: false, reason: 'invalid-transition' };
        const behavior = meta.back;
        if (behavior === 'cancel') return userIntent('cancel', data);
        if (behavior === 'dismiss') { dismissResult(); return { accepted: true }; }
        if (behavior === 'results') { settleAction(); transition(S.RESULTS, { result: currentResult }); return { accepted: true }; }
        if (behavior === 'disconnect') {
          settleScan(); settleAction(); currentResult = null;
          sessionManager.clearSession('user-back');
          transition(S.DISCONNECTED, {});
          return { accepted: true };
        }
        if (behavior === 'ready-or-disconnected') {
          transition(sessionManager.isSessionValid() ? S.READY : S.DISCONNECTED, {});
          return { accepted: true };
        }
        // 'home' — navigation-level concern, integration layer handles it
        return { accepted: false, reason: 'navigation-home' };
      }
      case 'save':
      case 'open_on_phone': {
        if (state !== S.RESULTS || !currentResult) return { accepted: false, reason: 'invalid-transition' };
        const actionType = intent === 'save' ? T.ACTION_SAVE : T.ACTION_OPEN_ON_PHONE;
        if (!sessionManager.isMessagePermitted(actionType)) return { accepted: false, reason: 'not-permitted' };
        pendingAction = { actionType, resultId: currentResult.resultId, requestId: activeRequestId };
        actionDeadline = now() + RUNTIME_TIMEOUTS.ACTION;
        transition(S.ACTION_PENDING, { actionType });
        send(actionType, { resultId: currentResult.resultId });
        return { accepted: true };
      }
      case 'retry':
        if (state === S.RESULTS || state === S.ERROR) {
          if (!sessionManager.isSessionValid()) return { accepted: false, reason: 'no-session' };
          startScan(); // mints NEW requestId
          return { accepted: true };
        }
        return { accepted: false, reason: 'invalid-transition' };
      case 'dismiss':
        if (state === S.RESULTS || state === S.ACTION_CONFIRMED) {
          dismissResult();
          return { accepted: true };
        }
        return { accepted: false, reason: 'invalid-transition' };
      case 'unpair':
        if (state !== S.READY) return { accepted: false, reason: 'invalid-transition' };
        sessionManager.clearSession('user-unpair');
        transition(S.DISCONNECTED, {});
        return { accepted: true };
      default:
        return { accepted: false, reason: 'unknown-intent' };
    }
  }

  /** Evaluate deadlines. The integration layer calls this on a heartbeat. */
  function tick(nowOverride) {
    const t = typeof nowOverride === 'number' ? nowOverride : now();

    if (state === S.PAIRING && !sessionManager.isPairingActive()) {
      sessionManager.endPairingTerminal('window-expired');
      transition(S.PAIRING_EXPIRED, {});
    }

    if (sessionManager.snapshot().pairingState === PAIRING_STATE.PAIRED && !sessionManager.isSessionValid()) {
      toSessionRevoked('session-expired');
      return;
    }

    if (scanDeadline !== null && t >= scanDeadline) {
      const timedOutRequest = activeRequestId;
      if (timedOutRequest) rememberTerminal(timedOutRequest);
      settleScan();
      failWith(state === S.CAPTURE_REQUESTED ? 'CAPTURE_TIMEOUT' : 'SCAN_TIMEOUT', 'The phone did not respond in time.');
    }

    if (actionDeadline !== null && t >= actionDeadline) {
      settleAction();
      failWith('ACTION_TIMEOUT', 'The phone did not confirm that action.');
    }

    if (reconnectDeadline !== null && t >= reconnectDeadline) {
      reconnectDeadline = null;
      resumeState = null;
      if (sessionManager.isSessionValid()) {
        transition(S.DISCONNECTED, { reconnectFailed: true });
      } else {
        toSessionRevoked('reconnect-window-expired');
      }
    }
  }

  /** Diagnostics-safe snapshot: metadata only, never payloads/tokens. */
  function getSnapshot() {
    return {
      state,
      requestId: activeRequestId,
      hasResult: currentResult !== null,
      resultId: currentResult?.resultId ?? null,
      pendingActionType: pendingAction?.actionType ?? null,
      lastError,
      session: sessionManager.snapshot().pairingState,
      sessionValid: sessionManager.isSessionValid(),
      resumeState,
    };
  }

  return { dispatchInbound, userIntent, tick, getSnapshot };
}
