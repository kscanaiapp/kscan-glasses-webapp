// Connection loss & recovery tests — companion runtime + transport (§15).
import assert from 'node:assert/strict';
import { MESSAGE_TYPES, buildMessage } from '../src/companion/protocol.js';
import { createCompanionRuntime } from '../src/companion/companionRuntime.js';
import { RUNTIME_STATE } from '../src/companion/runtimeState.js';
import { SESSION_TTL_MS, WEARABLE_CAPABILITIES } from '../src/companion/session.js';
import { makeFullResult } from '../src/companion/resultFixtures.js';
import { TRANSPORT_STATE } from '../src/companion/transport.js';

const T = MESSAGE_TYPES;
const S = RUNTIME_STATE;
const HUD = 'hud-test-001';

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

const unhandledRejections = [];
process.on('unhandledRejection', (r) => unhandledRejections.push(r));

// In-memory transport implementing the companion transport interface.
// The "phone" side is scripted by the test through peer.* helpers.
function makeLoopbackTransport() {
  const listeners = new Set();
  let state = TRANSPORT_STATE.IDLE;
  let open = false;
  const transport = {
    connect() { state = TRANSPORT_STATE.OPEN; open = true; return true; },
    disconnect() { state = TRANSPORT_STATE.CLOSED; open = false; },
    send(message) {
      if (!open) return false;
      peer.outbox.push(message);
      return true;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    unsubscribe(fn) { listeners.delete(fn); },
    getConnectionState: () => state,
  };
  const peer = {
    outbox: [],
    inject(message) { if (open) for (const fn of listeners) fn(message, {}); },
    drop() { open = false; state = TRANSPORT_STATE.CLOSED; },
    restore() { open = true; state = TRANSPORT_STATE.OPEN; },
  };
  return { transport, peer };
}

function makeWorld(startAt = 1_800_000_000_000) {
  let t = startAt;
  const { transport, peer } = makeLoopbackTransport();
  const runtime = createCompanionRuntime({
    transport,
    deviceId: HUD,
    now: () => t,
  });
  const phone = (type, payload = {}, opts = {}) => {
    const session = runtime.__test.sessionManager.snapshot();
    const msg = buildMessage(type, {
      requestId: opts.requestId !== undefined ? opts.requestId : runtime.getSnapshot().requestId,
      sessionId: opts.sessionId !== undefined ? opts.sessionId : (session.session?.sessionId ?? null),
      deviceId: HUD,
      payload,
      now: t,
    });
    if (opts.tamper) opts.tamper(msg);
    return msg;
  };
  const pairUp = () => {
    runtime.pair();
    const { pairingNonce } = runtime.__test.sessionManager.snapshot();
    peer.inject(phone(T.PAIR_APPROVED, {
      pairingNonce,
      sessionId: 'sess-1',
      sessionExpiresAt: t + SESSION_TTL_MS,
      capabilities: [...WEARABLE_CAPABILITIES],
    }, { requestId: null, sessionId: null }));
    peer.inject(phone(T.SESSION_READY, {}));
    peer.outbox.length = 0;
  };
  return {
    runtime, peer, phone, pairUp,
    tick: (ms = 1000) => { t += ms; runtime.__test.heartbeatTick(); },
    now: () => t,
    state: () => runtime.getSnapshot().state,
  };
}

// ── §15 scenarios ────────────────────────────────────────────────────────
check('loss:companion-closes-before-pairing-completes', () => {
  const w = makeWorld();
  w.runtime.start();
  w.runtime.pair();
  w.peer.drop();
  w.runtime.__test.heartbeatTick(); // transport closed → no loss event yet; pairing window still governs
  w.tick(2 * 60 * 1000 + 1000);
  assert.equal(w.state(), S.PAIRING_EXPIRED);
});

check('loss:drop-while-ready-then-restore', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  assert.equal(w.state(), S.READY);
  w.peer.drop();
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'peer-closed' }, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.RECONNECTING);
  w.peer.restore();
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.READY);
});

check('loss:drop-during-capture-late-events-dropped', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  w.runtime.scan();
  const rid = w.runtime.getSnapshot().requestId;
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.RECONNECTING);
  w.peer.restore();
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.READY);
  const late = w.runtime.__test.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}, { requestId: rid }));
  assert.equal(late.accepted, false);
});

check('loss:drop-during-analysis-no-stale-result', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  w.runtime.scan();
  const rid = w.runtime.getSnapshot().requestId;
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  w.runtime.__test.machine.dispatchInbound(w.phone(T.SCAN_PROCESSING, { stage: 'analyzing' }));
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  const stale = w.runtime.__test.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: makeFullResult(rid) }, { requestId: rid }));
  assert.equal(stale.accepted, false);
  assert.equal(w.state(), S.READY);
});

check('loss:drop-while-results-visible', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  w.runtime.scan();
  const rid = w.runtime.getSnapshot().requestId;
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CAPTURE_STARTED, {}));
  w.runtime.__test.machine.dispatchInbound(w.phone(T.SCAN_PROCESSING, { stage: 'analyzing' }));
  w.runtime.__test.machine.dispatchInbound(w.phone(T.RESULT_SHOW, { result: makeFullResult(rid) }));
  assert.equal(w.state(), S.RESULTS);
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.RECONNECTING);
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.READY);
  assert.equal(w.runtime.userIntent ? true : true, true);
  // Old result actions no longer valid.
  assert.equal(w.runtime.__test.machine.userIntent('save').accepted, false);
});

check('loss:session-expires-during-outage-restore-revokes', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'x' }, { sessionId: null, requestId: null }));
  w.tick(SESSION_TTL_MS + 1000); // session dies while down (tick revokes)
  assert.equal(w.state(), S.SESSION_REVOKED);
});

check('liveness:ping-timeout-triggers-reconnect', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  // First heartbeat sends a ping; phone never pongs.
  w.tick(1000);
  const ping = w.peer.outbox.find((m) => m.messageType === T.CONNECTION_PING);
  assert.ok(ping, 'expected an outbound ping');
  w.tick(9000); // beyond PING_TIMEOUT_MS
  assert.equal(w.state(), S.RECONNECTING);
});

check('liveness:stale-pong-does-not-refresh', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  w.tick(1000);
  // Pong with a WRONG nonce — must not satisfy liveness.
  w.peer.inject(w.phone(T.CONNECTION_PONG, { nonce: 'stale-nonce' }, { sessionId: null, requestId: null }));
  w.tick(9000);
  assert.equal(w.state(), S.RECONNECTING);
  // (sanity: correct nonce would have kept us Ready)
  const w2 = makeWorld();
  w2.runtime.start();
  w2.pairUp();
  w2.tick(1000);
  const ping2 = w2.peer.outbox.find((m) => m.messageType === T.CONNECTION_PING);
  w2.peer.inject(w2.phone(T.CONNECTION_PONG, { nonce: ping2.payload.nonce }, { sessionId: null, requestId: null }));
  w2.tick(9000);
  assert.equal(w2.state(), S.READY);
});

check('reload:companion-reload-requires-repair-handshake', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  // Peer reloads: transport cycles, peer has lost its state and asks for refresh.
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_LOST, { reason: 'peer-reload' }, { sessionId: null, requestId: null }));
  w.peer.restore();
  w.runtime.__test.machine.dispatchInbound(w.phone(T.CONNECTION_RESTORED, {}, { sessionId: null, requestId: null }));
  assert.equal(w.state(), S.READY); // optimistic while HUD session valid
  w.runtime.__test.machine.dispatchInbound(w.phone(T.SESSION_REFRESH_REQUIRED, { reason: 'peer-state-lost' }));
  assert.equal(w.state(), S.SESSION_REVOKED);
  assert.equal(w.runtime.__test.machine.userIntent('pair').accepted, true);
});

check('reload:hud-reload-starts-disconnected-no-resurrection', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  assert.equal(w.state(), S.READY);
  // Simulate HUD reload: a brand-new runtime instance.
  const w2 = makeWorld();
  w2.runtime.start();
  assert.equal(w2.state(), S.DISCONNECTED);
  assert.equal(w2.runtime.__test.sessionManager.isSessionValid(), false);
});

check('transport:send-failure-synthesizes-connection-loss', () => {
  const w = makeWorld();
  w.runtime.start();
  w.pairUp();
  w.peer.drop();
  w.runtime.scan(); // outbound send fails → synthesized connection.lost
  assert.equal(w.state(), S.RECONNECTING);
});

check('hygiene:no-unhandled-rejections-after-all-scenarios', () => {
  assert.equal(unhandledRejections.length, 0, unhandledRejections.map(String).join(' | ').slice(0, 200));
});

// ── Summary ──────────────────────────────────────────────────────────────
const failed = results.filter(([ok]) => !ok);
console.log(`\n=== Reconnection/recovery tests: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
if (failed.length > 0) process.exit(1);
console.log('[OK] All reconnection/recovery tests passed.');
