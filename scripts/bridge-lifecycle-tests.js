// Bridge lifecycle tests — hardware-validation candidate (Node built-ins).
// Usage: node scripts/bridge-lifecycle-tests.js
//
// Covers WS7 requirements: explicit settle on cancel/timeout/supersede,
// stale-result immunity, request-id matching, immediate retry, no unresolved
// promises, no unhandled rejections.

import assert from 'node:assert/strict';

let passCount = 0;
let failCount = 0;
const unhandled = [];

process.on('unhandledRejection', (err) => {
  unhandled.push(err);
});

function pass(name) {
  passCount += 1;
  console.log(`PASS | ${name}`);
}
function fail(name, expected, actual) {
  failCount += 1;
  console.log(`FAIL | ${name} | expected: ${expected} | actual: ${actual}`);
}
function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, 'no throw', String(error && error.message ? error.message : error));
  }
}

// ── Timer control (installed BEFORE importing bridgeState) ────────────────
const timers = new Map();
let timerSeq = 0;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

globalThis.setTimeout = (fn, ms) => {
  timerSeq += 1;
  timers.set(timerSeq, { fn, ms });
  return timerSeq;
};
globalThis.clearTimeout = (id) => {
  timers.delete(id);
};

function fireTimersWhere(predicate) {
  let fired = 0;
  for (const [id, timer] of [...timers.entries()]) {
    if (predicate(timer)) {
      timers.delete(id);
      timer.fn();
      fired += 1;
    }
  }
  return fired;
}
function pendingTimerCount() {
  return timers.size;
}

// ── Window stub ───────────────────────────────────────────────────────────
const SELF_ORIGIN = 'http://localhost:5173';
const messageHandlers = new Set();
const outboundPosts = [];
const parentStub = {
  postMessage(message) {
    outboundPosts.push(message);
  },
};

const windowStub = {
  location: { origin: SELF_ORIGIN },
  parent: parentStub,
  addEventListener(type, handler) {
    if (type === 'message') messageHandlers.add(handler);
  },
  removeEventListener(type, handler) {
    if (type === 'message') messageHandlers.delete(handler);
  },
  __KSCAN_CONFIG__: {},
};
windowStub.window = windowStub;
globalThis.window = windowStub;

function dispatchMessage(data, overrides = {}) {
  const event = { origin: SELF_ORIGIN, source: parentStub, data, ...overrides };
  for (const handler of messageHandlers) handler(event);
}

const bridge = await import('../src/bridgeState.js');
const {
  BRIDGE_STATUS,
  BRIDGE_CANCEL_CODES,
  requestCapture,
  cancelBridgeCapture,
  resetBridgeState,
  hasPendingCapture,
  getBridgeState,
  initBridgeStateListener,
  __bridgeTestHooks,
} = bridge;

initBridgeStateListener();

const VALID_IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';

function trackPromise(promise) {
  const tracker = { settled: false, rejected: false, code: null, value: null };
  promise.then(
    (value) => {
      tracker.settled = true;
      tracker.value = value;
    },
    (err) => {
      tracker.settled = true;
      tracker.rejected = true;
      tracker.code = err && err.code;
    },
  );
  return tracker;
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function reset() {
  resetBridgeState();
  timers.clear();
  outboundPosts.length = 0;
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== Bridge lifecycle tests ===');

// 1. cancel before capturing — promise settles with BRIDGE_CANCELLED
reset();
{
  const tracker = trackPromise(requestCapture());
  check('1a.request-posts-outbound-with-requestId', () => {
    assert.equal(getBridgeState().status, BRIDGE_STATUS.REQUESTING);
    assert.ok(hasPendingCapture());
    assert.ok(outboundPosts.some((m) => m.type === 'capture.request' && typeof m.requestId === 'string'));
  });
  const hadPending = cancelBridgeCapture();
  await flush();
  check('1b.cancel-before-capturing-settles', () => {
    assert.equal(hadPending, true);
    assert.equal(tracker.settled, true);
    assert.equal(tracker.rejected, true);
    assert.equal(tracker.code, BRIDGE_CANCEL_CODES.CANCELLED);
    assert.equal(hasPendingCapture(), false);
    assert.equal(getBridgeState().status, BRIDGE_STATUS.IDLE);
    assert.equal(pendingTimerCount(), 0, 'pending timeout must be cleared');
  });
}

// 2. cancel during capturing
reset();
{
  const tracker = trackPromise(requestCapture());
  dispatchMessage({ type: 'capture.capturing' });
  assert.equal(getBridgeState().status, BRIDGE_STATUS.CAPTURING);
  cancelBridgeCapture();
  await flush();
  check('2.cancel-during-capturing-settles', () => {
    assert.equal(tracker.settled, true);
    assert.equal(tracker.code, BRIDGE_CANCEL_CODES.CANCELLED);
    assert.equal(getBridgeState().status, BRIDGE_STATUS.IDLE);
    assert.equal(pendingTimerCount(), 0);
  });
}

// 3. late success after cancel — dropped, cannot render stale state
reset();
{
  const tracker = trackPromise(requestCapture());
  const requestId = __bridgeTestHooks.getPendingRequestId();
  cancelBridgeCapture();
  await flush();
  dispatchMessage({ type: 'capture.success', requestId, image: VALID_IMAGE, metadata: { width: 640 } });
  await flush();
  check('3.late-success-after-cancel-dropped', () => {
    assert.equal(tracker.code, BRIDGE_CANCEL_CODES.CANCELLED, 'original rejection stands');
    assert.equal(getBridgeState().status, BRIDGE_STATUS.IDLE, 'late success must not flip state');
    assert.equal(getBridgeState().imageMetadata, null, 'late success must not store metadata');
  });

  // 3b. untagged late success after cancel must also be dropped (no legacy bypass)
  dispatchMessage({ type: 'capture.success', image: VALID_IMAGE, metadata: { width: 640 } });
  await flush();
  check('3b.untagged-late-success-after-cancel-dropped', () => {
    assert.equal(getBridgeState().status, BRIDGE_STATUS.IDLE);
    assert.equal(getBridgeState().imageMetadata, null);
  });
}

// 4. timeout — promise settles with BRIDGE_TIMEOUT, state TIMEOUT
reset();
{
  const tracker = trackPromise(requestCapture());
  const fired = fireTimersWhere((t) => t.ms === 10000);
  await flush();
  check('4.timeout-settles-with-code', () => {
    assert.ok(fired >= 1, 'a 10s timeout timer must fire');
    assert.equal(tracker.settled, true);
    assert.equal(tracker.rejected, true);
    assert.equal(tracker.code, BRIDGE_CANCEL_CODES.TIMEOUT);
    assert.equal(getBridgeState().status, BRIDGE_STATUS.TIMEOUT);
    assert.equal(pendingTimerCount(), 0);
  });

  // 5. late success after timeout — dropped
  const requestId = `capture-1`;
  dispatchMessage({ type: 'capture.success', requestId, image: VALID_IMAGE, metadata: {} });
  await flush();
  check('5.late-success-after-timeout-dropped', () => {
    assert.equal(getBridgeState().status, BRIDGE_STATUS.TIMEOUT, 'late success must not flip state');
    assert.equal(hasPendingCapture(), false);
  });
}

// 6. mismatched request ID — pending request stays pending, no settle
reset();
{
  const tracker = trackPromise(requestCapture());
  dispatchMessage({ type: 'capture.success', requestId: 'capture-999', image: VALID_IMAGE, metadata: {} });
  await flush();
  check('6.mismatched-request-id-ignored', () => {
    assert.equal(tracker.settled, false, 'pending request must not settle on mismatched id');
    assert.equal(hasPendingCapture(), true);
    assert.equal(getBridgeState().status, BRIDGE_STATUS.REQUESTING);
  });
}

// 7. rapid double activation — first superseded explicitly, second alive
reset();
{
  const first = trackPromise(requestCapture());
  const second = trackPromise(requestCapture());
  await flush();
  check('7.rapid-double-activation-supersedes', () => {
    assert.equal(first.settled, true);
    assert.equal(first.rejected, true);
    assert.equal(first.code, BRIDGE_CANCEL_CODES.SUPERSEDED);
    assert.equal(second.settled, false, 'second request must stay pending');
    assert.ok(hasPendingCapture());
  });
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({ type: 'capture.success', requestId, image: VALID_IMAGE, metadata: { width: 640, height: 640 } });
  await flush();
  check('7b.second-request-resolves', () => {
    assert.equal(second.settled, true);
    assert.equal(second.rejected, false);
    assert.equal(second.value.image, VALID_IMAGE);
  });
}

// 8. retry after cancel — immediate, resolves cleanly
reset();
{
  const first = trackPromise(requestCapture());
  cancelBridgeCapture();
  await flush();
  const second = trackPromise(requestCapture());
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({ type: 'capture.success', requestId, image: VALID_IMAGE, metadata: {} });
  await flush();
  check('8.retry-after-cancel-works', () => {
    assert.equal(first.code, BRIDGE_CANCEL_CODES.CANCELLED);
    assert.equal(second.settled, true);
    assert.equal(second.rejected, false);
    assert.equal(getBridgeState().status, BRIDGE_STATUS.SUCCESS);
  });
}

// 9. retry after timeout — immediate, resolves cleanly
reset();
{
  const first = trackPromise(requestCapture());
  fireTimersWhere((t) => t.ms === 10000);
  await flush();
  assert.equal(first.code, BRIDGE_CANCEL_CODES.TIMEOUT);
  const second = trackPromise(requestCapture());
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({ type: 'capture.success', requestId, image: VALID_IMAGE, metadata: {} });
  await flush();
  check('9.retry-after-timeout-works', () => {
    assert.equal(second.settled, true);
    assert.equal(second.rejected, false);
  });
}

// 10. invalid payload — explicit CAPTURE_INVALID settle
reset();
{
  const tracker = trackPromise(requestCapture());
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({ type: 'capture.success', requestId, image: 'not-a-data-url', metadata: {} });
  await flush();
  check('10.invalid-payload-settles', () => {
    assert.equal(tracker.settled, true);
    assert.equal(tracker.rejected, true);
    assert.equal(tracker.code, 'CAPTURE_INVALID');
    assert.equal(getBridgeState().status, BRIDGE_STATUS.ERROR);
  });
}

// 11. explicit capture error — settles with BRIDGE_ERROR, clamped text
reset();
{
  const tracker = trackPromise(requestCapture());
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({ type: 'capture.error', requestId, error: 'Camera unavailable'.repeat(20) });
  await flush();
  check('11.capture-error-settles-clamped', () => {
    assert.equal(tracker.settled, true);
    assert.equal(tracker.code, 'BRIDGE_ERROR');
    assert.ok(getBridgeState().lastError.length <= 60, 'error text clamped');
  });
}

// 12. external (untagged) scaffold drive still works — request/capturing/timeout
reset();
{
  dispatchMessage({ type: 'capture.request' });
  check('12a.external-request-arms-state', () => {
    assert.equal(getBridgeState().status, BRIDGE_STATUS.REQUESTING);
  });
  fireTimersWhere((t) => t.ms === 10000);
  check('12b.external-timeout-fires', () => {
    assert.equal(getBridgeState().status, BRIDGE_STATUS.TIMEOUT);
  });
}

// 13. double cancel is idempotent
reset();
{
  const tracker = trackPromise(requestCapture());
  cancelBridgeCapture();
  const second = cancelBridgeCapture();
  await flush();
  check('13.double-cancel-idempotent', () => {
    assert.equal(second, false, 'second cancel has nothing to settle');
    assert.equal(tracker.code, BRIDGE_CANCEL_CODES.CANCELLED);
  });
}

// 14. untrusted origin cannot settle or drive the bridge
reset();
{
  const tracker = trackPromise(requestCapture());
  dispatchMessage({ type: 'capture.success', image: VALID_IMAGE }, { origin: 'https://attacker.example' });
  await flush();
  check('14.untrusted-origin-dropped', () => {
    assert.equal(tracker.settled, false);
    assert.equal(getBridgeState().status, BRIDGE_STATUS.REQUESTING);
  });
}

// 15. no unresolved promises / no unhandled rejections at the end
reset();
await flush();
check('15.no-unresolved-promises', () => {
  assert.equal(hasPendingCapture(), false);
  assert.equal(pendingTimerCount(), 0);
  assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map(String).join('; ')}`);
});

console.log(`\n=== Bridge lifecycle summary: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
console.log('[OK] All bridge lifecycle tests passed.');
