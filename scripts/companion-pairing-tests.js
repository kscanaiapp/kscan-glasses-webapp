// Pairing + wearable session tests — Meta companion Phase A.
import assert from 'node:assert/strict';
import { MESSAGE_TYPES } from '../src/companion/protocol.js';
import {
  createSessionManager,
  PAIRING_STATE,
  PAIRING_ERRORS,
  SESSION_CODES,
  WEARABLE_CAPABILITIES,
  SESSION_TTL_MS,
  PAIRING_WINDOW_MS,
} from '../src/companion/session.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
    console.log(`PASS | ${name}`);
  } catch (error) {
    results.push([false, name]);
    console.log(`FAIL | ${name} | ${String(error.message || error).slice(0, 160)}`);
  }
}

const HUD = 'hud-device-001';
const ALL_CAPS = [...WEARABLE_CAPABILITIES];

function makeManager(startAt = 1_800_000_000_000) {
  let t = startAt;
  const mgr = createSessionManager({ deviceId: HUD, now: () => t });
  return { mgr, tick: (ms) => { t += ms; }, now: () => t };
}

function approvePayload(mgr, now, overrides = {}) {
  const { pairingNonce } = mgr.snapshot();
  return {
    pairingNonce,
    sessionId: 'sess-1',
    sessionExpiresAt: now() + SESSION_TTL_MS,
    capabilities: ALL_CAPS,
    ...overrides,
  };
}

// ── Approval ─────────────────────────────────────────────────────────────
check('approval:creates-constrained-session', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now));
  assert.equal(res.ok, true);
  assert.equal(mgr.snapshot().pairingState, PAIRING_STATE.PAIRED);
  assert.equal(mgr.isSessionValid(), true);
  assert.deepEqual(res.session.capabilities, ALL_CAPS);
  assert.equal(res.session.deviceId, HUD);
});

check('approval:wrong-nonce-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { pairingNonce: 'pair_forged' }));
  assert.equal(res.code, PAIRING_ERRORS.NONCE_MISMATCH);
  assert.equal(mgr.isSessionValid(), false);
});

check('approval:no-active-pairing-rejected', () => {
  const { mgr, now } = makeManager();
  const res = mgr.handlePairApproved(approvePayload(mgr, now));
  assert.equal(res.code, PAIRING_ERRORS.NO_ACTIVE_PAIRING);
});

// ── Denial ───────────────────────────────────────────────────────────────
check('denial:returns-to-unpaired', () => {
  const { mgr } = makeManager();
  mgr.beginPairing();
  mgr.endPairingTerminal('user-denied');
  assert.equal(mgr.snapshot().pairingState, PAIRING_STATE.UNPAIRED);
  assert.equal(mgr.isPairingActive(), false);
});

// ── Pairing window timeout ───────────────────────────────────────────────
check('pairing-window:expires-after-2-minutes', () => {
  const { mgr, tick, now } = makeManager();
  mgr.beginPairing();
  tick(PAIRING_WINDOW_MS + 1);
  assert.equal(mgr.isPairingActive(), false);
  const res = mgr.handlePairApproved(approvePayload(mgr, now));
  assert.equal(res.code, PAIRING_ERRORS.PAIRING_WINDOW_EXPIRED);
});

// ── Session expiry ───────────────────────────────────────────────────────
check('session:expires-after-ttl', () => {
  const { mgr, tick, now } = makeManager();
  mgr.beginPairing();
  mgr.handlePairApproved(approvePayload(mgr, now));
  assert.equal(mgr.isSessionValid(), true);
  tick(SESSION_TTL_MS + 1);
  assert.equal(mgr.isSessionValid(), false);
  const code = mgr.validateSessionMessage({ sessionId: 'sess-1', deviceId: HUD });
  assert.equal(code, SESSION_CODES.SESSION_EXPIRED);
});

check('session:expired-cannot-resume', () => {
  const { mgr, tick, now } = makeManager();
  mgr.beginPairing();
  mgr.handlePairApproved(approvePayload(mgr, now));
  tick(SESSION_TTL_MS + 1000);
  assert.equal(mgr.hasCapability('scan.trigger'), false);
  assert.equal(mgr.isMessagePermitted(MESSAGE_TYPES.CAPTURE_REQUEST), false);
});

check('approval:session-expiry-beyond-max-ttl-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { sessionExpiresAt: now() + SESSION_TTL_MS + 1000 }));
  assert.equal(res.code, PAIRING_ERRORS.INVALID_SESSION_EXPIRY);
});

check('approval:past-session-expiry-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { sessionExpiresAt: now() - 1 }));
  assert.equal(res.code, PAIRING_ERRORS.INVALID_SESSION_EXPIRY);
});

// ── Revocation / re-pairing ──────────────────────────────────────────────
check('revocation:clears-session-requires-repair', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  mgr.handlePairApproved(approvePayload(mgr, now));
  mgr.clearSession('revoked-by-phone');
  assert.equal(mgr.isSessionValid(), false);
  assert.equal(mgr.snapshot().pairingState, PAIRING_STATE.UNPAIRED);
  // Re-pairing works
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { sessionId: 'sess-2' }));
  assert.equal(res.ok, true);
  assert.equal(mgr.getSessionId(), 'sess-2');
});

// ── Sign-out invalidation ────────────────────────────────────────────────
check('sign-out:invalidates-session-immediately', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  mgr.handlePairApproved(approvePayload(mgr, now));
  mgr.clearSession('user-sign-out');
  assert.equal(mgr.isSessionValid(), false);
  assert.equal(mgr.validateSessionMessage({ sessionId: 'sess-1', deviceId: HUD }), SESSION_CODES.NO_SESSION);
});

// ── Device identity change ───────────────────────────────────────────────
check('device-change:message-correlation-fails', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  mgr.handlePairApproved(approvePayload(mgr, now));
  assert.equal(mgr.validateSessionMessage({ sessionId: 'sess-1', deviceId: 'hud-OTHER' }), SESSION_CODES.DEVICE_MISMATCH);
});

check('session-mismatch:wrong-session-id-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  mgr.handlePairApproved(approvePayload(mgr, now));
  assert.equal(mgr.validateSessionMessage({ sessionId: 'sess-WRONG', deviceId: HUD }), SESSION_CODES.SESSION_MISMATCH);
});

// ── Capability model ─────────────────────────────────────────────────────
check('capabilities:unknown-capability-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { capabilities: ['scan.trigger', 'admin.full'] }));
  assert.equal(res.code, PAIRING_ERRORS.INVALID_CAPABILITIES);
});

check('capabilities:empty-set-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { capabilities: [] }));
  assert.equal(res.code, PAIRING_ERRORS.INVALID_CAPABILITIES);
});

check('capabilities:duplicates-rejected', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { capabilities: ['scan.trigger', 'scan.trigger'] }));
  assert.equal(res.code, PAIRING_ERRORS.INVALID_CAPABILITIES);
});

check('capabilities:subset-enforced-per-action', () => {
  const { mgr, now } = makeManager();
  mgr.beginPairing();
  const res = mgr.handlePairApproved(approvePayload(mgr, now, {
    capabilities: ['scan.trigger', 'result.receive', 'action.retry'],
  }));
  assert.equal(res.ok, true);
  assert.equal(mgr.hasCapability('scan.trigger'), true);
  assert.equal(mgr.hasCapability('action.save'), false);
  assert.equal(mgr.isMessagePermitted(MESSAGE_TYPES.ACTION_SAVE), false);
  assert.equal(mgr.isMessagePermitted(MESSAGE_TYPES.ACTION_RETRY), true);
  assert.equal(mgr.isMessagePermitted(MESSAGE_TYPES.SCAN_PROGRESS), true); // uncapped progress ok
});

// ── Supersede ────────────────────────────────────────────────────────────
check('re-pairing:supersedes-pending-nonce', () => {
  const { mgr, now } = makeManager();
  const first = mgr.beginPairing();
  const second = mgr.beginPairing();
  assert.notEqual(first.pairingNonce, second.pairingNonce);
  const res = mgr.handlePairApproved(approvePayload(mgr, now, { pairingNonce: first.pairingNonce }));
  assert.equal(res.code, PAIRING_ERRORS.NONCE_MISMATCH);
});

// ── Summary ──────────────────────────────────────────────────────────────
const failed = results.filter(([ok]) => !ok);
console.log(`\n=== Pairing/session tests: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
if (failed.length > 0) process.exit(1);
console.log('[OK] All pairing/session tests passed.');
