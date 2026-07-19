// Connected-runtime state machine tests — every permitted/forbidden
// transition plus the Phase A state-safety invariants.
import assert from 'node:assert/strict';
import { MESSAGE_TYPES, buildMessage } from '../src/companion/protocol.js';
import { createSessionManager, SESSION_TTL_MS, WEARABLE_CAPABILITIES } from '../src/companion/session.js';
import { createRuntimeMachine, RUNTIME_STATE, RUNTIME_TIMEOUTS, STATE_META } from '../src/companion/runtimeState.js';

const T = MESSAGE_TYPES;
const S = RUNTIME_STATE;
const HUD = 'hud-device-001';
const PHONE_CAPS = [...WEARABLE_CAPABILITIES];

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
    console.log(`PASS | ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL | ${name} | ${String(error.message || error).slice(0, 200)}`);
  }
}

function makeWorld(startAt = 1_800_000_000_000, capabilities = PHONE_CAPS) {
  let t = startAt;
  const sent = [];
  const transitions = [];
  const sessionManager = createSessionManager({ deviceId: HUD, now: () => t });
  const machine = createRuntimeMachine({
    sessionManager,
    now: () => t,
    onOutbound: (msg) => sent.push(msg),
    onTransition: (prev, next, detail) => transitions.push([prev, next, detail]),
  });
  const phone = (type, payload = {}, opts = {}) => {
    const msg = buildMessage(type, {
      requestId: opts.requestId !== undefined ? opts.requestId : machine.getSnapshot().requestId,
      sessionId: opts.sessionId !== undefined ? opts.sessionId : sessionManager.getSessionId(),
      deviceId: HUD,
      payload,
      now: t,
      ...opts,
    });
    if (opts.tamper) opts.tamper(msg);
    return msg;
  };
  const pairUp = () => {
    machine.userIntent('pair');
    const { pairingNonce } = sessionManager.snapshot();
    machine.dispatchInbound(phone(T.PAIR_APPROVED, {
      pairingNonce, sessionId: 'sess-1', sessionExpiresAt: t + SESSION_TTL_MS, capabilities,
    }, { requestId: null, sessionId: null }));
    machine.dispatchInbound(phone(T.SESSION_READY, {}));
  };
  const scanToResults = (resultPayload = { resultId: 'r1', title: 'Coat' }) => {
    machine.userIntent('scan');
    const rid = machine.getSnapshot().requestId;
    machine.dispatchInbound(phone(T.CAPTURE_STARTED, {}));
    machine.dispatchInbound(phone(T.SCAN_PROCESSING, { stage: 'privacy' }));
    machine.dispatchInbound(phone(T.SCAN_PROCESSING, { stage: 'analyzing' }));
    machine.dispatchInbound(phone(T.RESULT_SHOW, { result: resultPayload }));
    return rid;
  };
  return {
    machine, sessionManager, sent, transitions, phone, pairUp, scanToResults,
    tick: (ms) => { t += ms; machine.tick(); },
    advance: (ms) => { t += ms; }, // clock only — no machine.tick()
    now: () => t,
    state: () => machine.getSnapshot().state,
  };
}

// ── Metadata completeness ────────────────────────────────────────────────
check('meta:every-state-has-required-fields', () => {
  for (const state of Object.values(S)) {
    const meta = STATE_META[state];
    assert.ok(meta, `missing meta for ${state}`);
    for (const key of ['title', 'support', 'progress', 'primary', 'secondary', 'focusTarget', 'timeout', 'back', 'cancel', 'recovery', 'inbound', 'outbound']) {
      assert.ok(key in meta, `${state} missing ${key}`);
    }
    assert.ok(Array.isArray(meta.secondary) && meta.secondary.length <= 3, `${state} too many secondary actions`);
  }
});

// ── Happy path ───────────────────────────────────────────────────────────
check('happy-path:pair→ready→scan→results→save→confirmed→dismiss', () => {
  const w = makeWorld();
  assert.equal(w.state(), S.DISCONNECTED);
  w.machine.userIntent('pair');
  assert.equal(w.state(), S.PAIRING);
  assert.equal(w.sent.at(-1).messageType, T.PAIR_REQUEST);

  const { pairingNonce } = w.sessionManager.snapshot();
  w.machine.dispatchInbound(w.phone(T.PAIR_APPROVED, {
    pairingNonce, sessionId: 'sess-1', sessionExpiresAt: w.now() + SESSION_TTL_MS, capabilities: PHONE_CAPS,
  }, { requestId: null, sessionId: null }));
  assert.equal(w.state(), S.CONNECTED);
  w.machine.dispatchInbound(w.phone(T.SESSION_READY, {}));
  assert.equal(w.state(), S.READY);

  const rid = w.scanToResults();
  assert.equal(w.state(), S.RESULTS);
  assert.equal(w.machine.getSnapshot().resultId, 'r1');

  w.machine.userIntent('save');
  assert.equal(w.state(), S.ACTION_PENDING);
  const actionMsg = w.sent.at(-1);
  assert.equal(actionMsg.messageType, T.ACTION_SAVE);
  assert.equal(actionMsg.requestId, rid);
  assert.equal(actionMsg.payload.resultId, 'r1');

  w.machine.dispatchInbound(w.phone(T.ACTION_ACCEPTED, { actionType: T.ACTION_SAVE, resultId: 'r1' }));
  assert.equal(w.state(), S.ACTION_PENDING);
  w.machine.dispatchInbound(w.phone(T.ACTION_COMPLETED, { actionType: T.ACTION_SAVE, resultId: 'r1' }));
  assert.equal(w.state(), S.ACTION_CONFIRMED);

  w.machine.userIntent('dismiss');
  assert.equal(w.state(), S.READY);
});

// ── Forbidden transitions ────────────────────────────────────────────────
check('forbidden:result-show-in-ready-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  const r = w.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: { resultId: 'rX' } }));
  assert.equal(r.accepted, false);
  assert.equal(w.state(), S.READY);
});

check('forbidden:scan-intent-when-disconnected', () => {
  const w = makeWorld();
  assert.equal(w.machine.userIntent('scan').accepted, false);
});

check('forbidden:capture-started-in-ready-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  const r = w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}, { requestId: 'req_ghost' }));
  assert.equal(r.accepted, false);
  assert.equal(w.state(), S.READY);
});

check('forbidden:save-intent-outside-results', () => {
  const w = makeWorld();
  w.pairUp();
  assert.equal(w.machine.userIntent('save').accepted, false);
});

check('forbidden:session-ready-in-disconnected-dropped', () => {
  const w = makeWorld();
  const r = w.machine.dispatchInbound(w.phone(T.SESSION_READY, {}, { sessionId: 'sess-ghost' }));
  assert.equal(r.accepted, false);
  assert.equal(w.state(), S.DISCONNECTED);
});

// ── Correlation / staleness ──────────────────────────────────────────────
check('stale:wrong-request-id-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  const r = w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}, { requestId: 'req_WRONG' }));
  assert.equal(r.accepted, false);
  assert.equal(w.state(), S.CAPTURE_REQUESTED);
});

check('stale:duplicate-terminal-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  const rid = w.machine.getSnapshot().requestId;
  w.machine.dispatchInbound(w.phone(T.SCAN_FAILED, { code: 'X' }));
  assert.equal(w.state(), S.ERROR);
  // Second terminal for same request — must be dropped, not re-applied.
  const dup = w.machine.dispatchInbound(w.phone(T.SCAN_FAILED, { code: 'Y' }, { requestId: rid }));
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate-terminal');
});

check('replay:duplicate-message-id-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  const msg = w.phone(T.CAPTURE_STARTED, {});
  assert.equal(w.machine.dispatchInbound(msg).accepted, true);
  assert.equal(w.machine.dispatchInbound(msg).accepted, false);
  assert.equal(w.state(), S.CAPTURING_ON_PHONE); // unchanged
});

check('correlation:ack-for-wrong-result-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  w.scanToResults();
  w.machine.userIntent('save');
  const r = w.machine.dispatchInbound(w.phone(T.ACTION_COMPLETED, { actionType: T.ACTION_SAVE, resultId: 'r-OTHER' }));
  assert.equal(r.accepted, false);
  assert.equal(w.state(), S.ACTION_PENDING);
});

// ── Cancel / timeout / late completion ───────────────────────────────────
check('cancel:settles-scan-late-completion-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  const rid = w.machine.getSnapshot().requestId;
  w.machine.userIntent('cancel');
  assert.equal(w.state(), S.READY);
  assert.equal(w.sent.at(-1).messageType, T.ACTION_CANCEL);
  const late = w.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: { resultId: 'r9' } }, { requestId: rid }));
  assert.equal(late.accepted, false);
  assert.equal(w.state(), S.READY);
});

check('timeout:scan-request-deadline-error-then-late-dropped', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  const rid = w.machine.getSnapshot().requestId;
  w.tick(RUNTIME_TIMEOUTS.SCAN_REQUEST + 1);
  assert.equal(w.state(), S.ERROR);
  assert.equal(w.machine.getSnapshot().lastError.code, 'CAPTURE_TIMEOUT');
  const late = w.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: { resultId: 'r9' } }, { requestId: rid }));
  assert.equal(late.accepted, false);
});

check('timeout:action-ack-deadline-error', () => {
  const w = makeWorld();
  w.pairUp();
  w.scanToResults();
  w.machine.userIntent('save');
  w.tick(RUNTIME_TIMEOUTS.ACTION + 1);
  assert.equal(w.state(), S.ERROR);
  assert.equal(w.machine.getSnapshot().lastError.code, 'ACTION_TIMEOUT');
});

// ── Retry / second scan isolation ────────────────────────────────────────
check('retry:mints-new-request-id', () => {
  const w = makeWorld();
  w.pairUp();
  const first = w.scanToResults();
  w.machine.userIntent('retry');
  const second = w.machine.getSnapshot().requestId;
  assert.ok(second && second !== first);
  assert.equal(w.state(), S.CAPTURE_REQUESTED);
});

check('retry:after-scan-failed-delivers-fresh-result', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  const failedRid = w.machine.getSnapshot().requestId;
  w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  w.machine.dispatchInbound(w.phone(T.SCAN_PROCESSING, { stage: 'analyzing' }));
  w.machine.dispatchInbound(w.phone(T.SCAN_FAILED, { code: 'ANALYZE_FAILED' }));
  assert.equal(w.state(), S.ERROR);
  // Late completion for the failed request must not render.
  assert.equal(
    w.machine.dispatchInbound(w.phone(
      T.RESULT_SHOW,
      { result: { resultId: 'r-late', title: 'Late' } },
      { requestId: failedRid },
    )).accepted,
    false,
  );
  assert.equal(w.machine.userIntent('retry').accepted, true);
  const retryRid = w.machine.getSnapshot().requestId;
  assert.ok(retryRid && retryRid !== failedRid);
  assert.equal(w.state(), S.CAPTURE_REQUESTED);
  w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  w.machine.dispatchInbound(w.phone(T.SCAN_PROCESSING, { stage: 'analyzing' }));
  assert.equal(
    w.machine.dispatchInbound(w.phone(
      T.RESULT_SHOW,
      { result: { resultId: 'r-retry', title: 'Retry Coat' } },
    )).accepted,
    true,
  );
  assert.equal(w.state(), S.RESULTS);
  assert.equal(w.machine.getSnapshot().requestId, retryRid);
  assert.equal(w.machine.getSnapshot().resultId, 'r-retry');
});

check('second-scan:no-inherited-terminal-state', () => {
  const w = makeWorld();
  w.pairUp();
  const first = w.scanToResults({ resultId: 'r1' });
  w.machine.userIntent('dismiss');
  w.machine.userIntent('scan');
  const second = w.machine.getSnapshot().requestId;
  assert.notEqual(second, first);
  // Old request's late result still dropped; new request flows normally.
  assert.equal(w.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: { resultId: 'r1' } }, { requestId: first })).accepted, false);
  w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  w.machine.dispatchInbound(w.phone(T.SCAN_PROCESSING, { stage: 'analyzing' }));
  assert.equal(w.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: { resultId: 'r2' } })).accepted, true);
  assert.equal(w.machine.getSnapshot().resultId, 'r2');
});

// ── Connection loss / recovery ───────────────────────────────────────────
check('connection:loss-during-capture-reconnect-restore-ready', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  w.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  w.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'transport-closed' }, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.RECONNECTING);
  w.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.READY);
});

check('connection:restore-with-expired-session-revoked', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  // Session expires while disconnected (clock advances without machine.tick,
  // so the restore path itself must refuse to resurrect the dead session).
  w.advance(SESSION_TTL_MS + 1);
  w.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.SESSION_REVOKED);
});

check('connection:duplicate-restored-events-safe', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  w.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.READY);
  const r = w.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(r.accepted, true); // no-op accept, state unchanged
  assert.equal(w.state(), S.READY);
});

check('connection:reconnect-window-lapses-disconnects', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  w.tick(RUNTIME_TIMEOUTS.RECONNECT + 1);
  assert.equal(w.state(), S.DISCONNECTED);
  assert.equal(w.sessionManager.isSessionValid(), true); // session kept for explicit re-pair/reconnect choice
});

// ── Session revocation / expiry ──────────────────────────────────────────
check('session:revoked-mid-scan-settles-everything', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  w.machine.dispatchInbound(w.phone(T.SESSION_REVOKED, { reason: 'phone-sign-out' }));
  assert.equal(w.state(), S.SESSION_REVOKED);
  assert.equal(w.sessionManager.isSessionValid(), false);
  assert.equal(w.machine.getSnapshot().requestId, null);
  // Re-pair is the only way forward.
  assert.equal(w.machine.userIntent('pair').accepted, true);
  assert.equal(w.state(), S.PAIRING);
});

check('session:expiry-on-tick-revokes', () => {
  const w = makeWorld();
  w.pairUp();
  w.tick(SESSION_TTL_MS + 1);
  assert.equal(w.state(), S.SESSION_REVOKED);
});

// ── Pairing denial / expiry / cancel ─────────────────────────────────────
check('pairing:denied-recovery-path', () => {
  const w = makeWorld();
  w.machine.userIntent('pair');
  const { pairingNonce } = w.sessionManager.snapshot();
  w.machine.dispatchInbound(w.phone(T.PAIR_DENIED, { pairingNonce }, { requestId: null, sessionId: null }));
  assert.equal(w.state(), S.PAIRING_DENIED);
  assert.equal(w.machine.userIntent('pair').accepted, true);
  assert.equal(w.state(), S.PAIRING);
});

check('pairing:window-expiry-on-tick', () => {
  const w = makeWorld();
  w.machine.userIntent('pair');
  w.tick(2 * 60 * 1000 + 1);
  assert.equal(w.state(), S.PAIRING_EXPIRED);
});

check('pairing:cancel-returns-disconnected', () => {
  const w = makeWorld();
  w.machine.userIntent('pair');
  w.machine.userIntent('cancel');
  assert.equal(w.state(), S.DISCONNECTED);
});

// ── Capability enforcement ───────────────────────────────────────────────
check('capability:save-rejected-when-not-granted', () => {
  const w = makeWorld(1_800_000_000_000, ['scan.trigger', 'result.receive', 'action.retry']);
  w.pairUp();
  w.scanToResults();
  assert.equal(w.machine.userIntent('save').accepted, false);
  assert.equal(w.state(), S.RESULTS);
});

// ── Liveness ─────────────────────────────────────────────────────────────
check('liveness:ping-answered-with-pong', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.dispatchInbound(w.phone(T.CONNECTION_PING, { nonce: 'n7' }, { sessionId: null, requestId: null }));
  const pong = w.sent.at(-1);
  assert.equal(pong.messageType, T.CONNECTION_PONG);
  assert.equal(pong.payload.nonce, 'n7');
});

// ── Snapshot safety ──────────────────────────────────────────────────────
check('snapshot:metadata-only-no-payloads', () => {
  const w = makeWorld();
  w.pairUp();
  w.scanToResults({ resultId: 'r1', title: 'Coat', summary: 'secret-free' });
  const snap = w.machine.getSnapshot();
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('Coat'), 'snapshot leaked result fields');
  assert.ok(!text.includes('secret-free'));
  assert.equal(snap.hasResult, true);
  assert.equal(snap.resultId, 'r1');
});

// ── Settle-once audit ────────────────────────────────────────────────────
check('settle-once:error-then-retry-leaves-no-pending-deadlines', () => {
  const w = makeWorld();
  w.pairUp();
  w.machine.userIntent('scan');
  w.tick(RUNTIME_TIMEOUTS.SCAN_REQUEST + 1);
  assert.equal(w.state(), S.ERROR);
  w.machine.userIntent('retry');
  assert.equal(w.state(), S.CAPTURE_REQUESTED);
  // No double-fire: ticking far past the old deadline must not re-error.
  w.tick(1000);
  assert.equal(w.state(), S.CAPTURE_REQUESTED);
});

// ── Summary ──────────────────────────────────────────────────────────────
const failed = results.filter(([ok]) => !ok);
console.log(`\n=== Runtime state-machine tests: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
if (failed.length > 0) process.exit(1);
console.log('[OK] All runtime state-machine tests passed.');
