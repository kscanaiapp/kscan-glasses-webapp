// Protocol contract tests — kscan.meta.companion.v1
// Covers every valid message type plus the full rejection matrix.
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  PROTOCOL_ERRORS,
  MAX_MESSAGE_BYTES,
  MAX_RESULT_PAYLOAD_BYTES,
  CLOCK_SKEW_MS,
  MAX_MESSAGE_TTL_MS,
  buildMessage,
  validateMessage,
  serializeMessage,
  isTerminalType,
  isSessionBearingType,
  isRequestCorrelatedType,
  isSafeUrl,
  makeMessageId,
} from '../src/companion/protocol.js';

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

const NOW = 1_800_000_000_000;
const HUD = 'hud-device-001';
const SESSION = 'sess-abc-123';
const REQ = 'req-0001';

function validMessage(type, overrides = {}) {
  const msg = buildMessage(type, {
    requestId: REQ,
    sessionId: SESSION,
    deviceId: HUD,
    payload: {},
    now: NOW,
    ...overrides,
  });
  assert.ok(msg, `buildMessage returned null for ${type}`);
  return msg;
}

// Required payload content for types with required fields.
const REQUIRED_PAYLOADS = {
  [MESSAGE_TYPES.PAIR_REQUEST]: { pairingNonce: 'nonce-1' },
  [MESSAGE_TYPES.PAIR_CHALLENGE]: { challenge: 'challenge-1' },
  [MESSAGE_TYPES.PAIR_APPROVED]: { sessionId: SESSION, sessionExpiresAt: NOW + 60000, capabilities: ['scan.trigger'] },
  [MESSAGE_TYPES.SESSION_REFRESH_REQUIRED]: { reason: 'expiring' },
  [MESSAGE_TYPES.SESSION_ERROR]: { code: 'SESSION_UNKNOWN' },
  [MESSAGE_TYPES.CAPTURE_FAILED]: { code: 'CAMERA_UNAVAILABLE' },
  [MESSAGE_TYPES.SCAN_PROCESSING]: { stage: 'privacy' },
  [MESSAGE_TYPES.SCAN_PROGRESS]: { stage: 'analyzing', percent: 40 },
  [MESSAGE_TYPES.SCAN_FAILED]: { code: 'ANALYZE_FAILED' },
  [MESSAGE_TYPES.RESULT_SHOW]: { result: { resultId: 'r1' } },
  [MESSAGE_TYPES.RESULT_UPDATE]: { result: { resultId: 'r1' } },
  [MESSAGE_TYPES.ACTION_SAVE]: { resultId: 'r1' },
  [MESSAGE_TYPES.ACTION_OPEN_ON_PHONE]: { resultId: 'r1' },
  [MESSAGE_TYPES.ACTION_DISMISS]: { resultId: 'r1' },
  [MESSAGE_TYPES.ACTION_ACCEPTED]: { actionType: 'action.save' },
  [MESSAGE_TYPES.ACTION_COMPLETED]: { actionType: 'action.save' },
  [MESSAGE_TYPES.ACTION_FAILED]: { actionType: 'action.save', code: 'SAVE_FAILED' },
  [MESSAGE_TYPES.CONNECTION_PING]: { nonce: 'n-1' },
  [MESSAGE_TYPES.CONNECTION_PONG]: { nonce: 'n-1' },
  [MESSAGE_TYPES.CONNECTION_LOST]: { reason: 'transport-closed' },
};

const CTX = { deviceId: HUD, now: NOW, paired: true };

// ── 1. Every defined message type builds + validates ─────────────────────
for (const type of Object.values(MESSAGE_TYPES)) {
  check(`valid-type:${type}`, () => {
    const payload = REQUIRED_PAYLOADS[type] || {};
    const needsRequest = isRequestCorrelatedType(type);
    const needsSession = isSessionBearingType(type);
    const msg = buildMessage(type, {
      requestId: needsRequest ? REQ : null,
      sessionId: needsSession ? SESSION : null,
      deviceId: HUD,
      payload,
      now: NOW,
    });
    assert.ok(msg, 'build failed');
    const verdict = validateMessage(msg, CTX);
    assert.equal(verdict.ok, true, verdict.code);
  });
}

// ── 2. Envelope violations ────────────────────────────────────────────────
check('reject:unknown-version', () => {
  const msg = { ...validMessage(MESSAGE_TYPES.CONNECTION_RESTORED), protocolVersion: 'kscan.meta.companion.v0' };
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.UNKNOWN_VERSION);
});

check('reject:unknown-type', () => {
  const msg = { ...validMessage(MESSAGE_TYPES.CONNECTION_RESTORED), messageType: 'scan.explode' };
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.UNKNOWN_MESSAGE_TYPE);
});

check('reject:not-an-object', () => {
  assert.equal(validateMessage('nope', CTX).code, PROTOCOL_ERRORS.NOT_AN_OBJECT);
  assert.equal(validateMessage(null, CTX).code, PROTOCOL_ERRORS.NOT_AN_OBJECT);
  assert.equal(validateMessage([], CTX).code, PROTOCOL_ERRORS.NOT_AN_OBJECT);
});

check('reject:unexpected-envelope-field', () => {
  const msg = { ...validMessage(MESSAGE_TYPES.CONNECTION_RESTORED), adminToken: 'x' };
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.UNEXPECTED_FIELDS);
});

check('reject:missing-message-id', () => {
  const msg = { ...validMessage(MESSAGE_TYPES.CONNECTION_RESTORED), messageId: '' };
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MISSING_MESSAGE_ID);
});

check('reject:missing-request-id-where-required', () => {
  const msg = validMessage(MESSAGE_TYPES.CAPTURE_STARTED);
  msg.requestId = null;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MISSING_REQUEST_ID);
});

check('reject:missing-session-id-on-session-bearing', () => {
  const msg = validMessage(MESSAGE_TYPES.CAPTURE_STARTED);
  msg.sessionId = null;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MISSING_SESSION_ID);
});

check('reject:missing-device-id', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.deviceId = '';
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MISSING_DEVICE_ID);
});

check('reject:wrong-device', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  assert.equal(validateMessage(msg, { ...CTX, deviceId: 'hud-OTHER' }).code, PROTOCOL_ERRORS.WRONG_DEVICE);
});

// ── 3. Clock / expiry ────────────────────────────────────────────────────
check('reject:future-timestamp-beyond-skew', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.timestamp = NOW + CLOCK_SKEW_MS + 1000;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.FUTURE_TIMESTAMP);
});

check('accept:timestamp-within-skew', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.timestamp = NOW + CLOCK_SKEW_MS - 1000;
  msg.expiresAt = NOW + CLOCK_SKEW_MS + 5000; // keep ttl/expiry valid vs now
  assert.equal(validateMessage(msg, CTX).ok, true);
});

check('reject:expired-message', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.expiresAt = NOW - 1;
  msg.timestamp = NOW - 2000;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.EXPIRED_MESSAGE);
});

check('reject:ttl-too-long', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.expiresAt = msg.timestamp + MAX_MESSAGE_TTL_MS + 1000;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.INVALID_EXPIRY);
});

check('reject:expiry-not-after-timestamp', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.expiresAt = msg.timestamp;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.INVALID_EXPIRY);
});

// ── 4. Payload schema ────────────────────────────────────────────────────
check('reject:missing-payload', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.payload = null;
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MISSING_PAYLOAD);
});

check('reject:unknown-payload-field', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  msg.payload = { resumedRequestId: null, hack: true };
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MALFORMED_PAYLOAD);
});

check('reject:missing-required-payload-field', () => {
  const msg = validMessage(MESSAGE_TYPES.SCAN_FAILED);
  msg.payload = {};
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MALFORMED_PAYLOAD);
});

// ── 5. Size ceilings ─────────────────────────────────────────────────────
check('reject:oversized-message', () => {
  const msg = validMessage(MESSAGE_TYPES.CONNECTION_RESTORED);
  const verdict = validateMessage(msg, { ...CTX, serializedSize: MAX_MESSAGE_BYTES + 1 });
  assert.equal(verdict.code, PROTOCOL_ERRORS.OVERSIZED_MESSAGE);
});

check('reject:oversized-result-payload', () => {
  const big = 'x'.repeat(MAX_RESULT_PAYLOAD_BYTES);
  const msg = validMessage(MESSAGE_TYPES.RESULT_SHOW, {
    payload: { result: { resultId: 'r1', summary: big } },
  });
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.MALFORMED_PAYLOAD);
});

check('serialize:returns-null-when-oversized', () => {
  const msg = validMessage(MESSAGE_TYPES.RESULT_SHOW, {
    payload: { result: { resultId: 'r1', summary: 'x'.repeat(MAX_MESSAGE_BYTES) } },
  });
  assert.equal(serializeMessage(msg), null);
});

// ── 6. URL safety ────────────────────────────────────────────────────────
check('reject:unsafe-url-in-result', () => {
  const msg = validMessage(MESSAGE_TYPES.RESULT_SHOW, {
    payload: { result: { resultId: 'r1', thumbnailUrl: 'javascript:alert(1)' } },
  });
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.UNSAFE_URL);
});

check('reject:unsafe-url-nested-in-alternatives', () => {
  const msg = validMessage(MESSAGE_TYPES.RESULT_SHOW, {
    payload: { result: { resultId: 'r1', alternatives: [{ href: 'data:text/html,<script>' }] } },
  });
  assert.equal(validateMessage(msg, CTX).code, PROTOCOL_ERRORS.UNSAFE_URL);
});

check('url-policy:https-ok-localhost-http-ok-other-http-rejected', () => {
  assert.equal(isSafeUrl('https://cdn.example.com/t.jpg'), true);
  assert.equal(isSafeUrl('http://localhost:4617/t.jpg'), true);
  assert.equal(isSafeUrl('http://169.254.169.254/latest'), false);
  assert.equal(isSafeUrl('file:///etc/passwd'), false);
  assert.equal(isSafeUrl('//evil.example/x'), false);
});

// ── 7. Pairing gate ──────────────────────────────────────────────────────
check('reject:session-bearing-message-when-unpaired', () => {
  const msg = validMessage(MESSAGE_TYPES.CAPTURE_STARTED);
  assert.equal(validateMessage(msg, { ...CTX, paired: false }).code, PROTOCOL_ERRORS.UNPAIRED_SENDER);
});

check('accept:pair-handshake-when-unpaired', () => {
  const msg = buildMessage(MESSAGE_TYPES.PAIR_CHALLENGE, {
    deviceId: HUD, payload: { challenge: 'c' }, now: NOW,
  });
  assert.equal(validateMessage(msg, { ...CTX, paired: false }).ok, true);
});

// ── 8. Classification helpers ────────────────────────────────────────────
check('classification:terminal-types', () => {
  assert.equal(isTerminalType(MESSAGE_TYPES.SCAN_COMPLETED), true);
  assert.equal(isTerminalType(MESSAGE_TYPES.CAPTURE_FAILED), true);
  assert.equal(isTerminalType(MESSAGE_TYPES.SCAN_PROGRESS), false);
  assert.equal(isTerminalType(MESSAGE_TYPES.CONNECTION_PING), false);
});

check('classification:session-bearing', () => {
  assert.equal(isSessionBearingType(MESSAGE_TYPES.RESULT_SHOW), true);
  assert.equal(isSessionBearingType(MESSAGE_TYPES.PAIR_REQUEST), false);
  assert.equal(isSessionBearingType(MESSAGE_TYPES.CONNECTION_PONG), false);
});

check('classification:request-correlated', () => {
  assert.equal(isRequestCorrelatedType(MESSAGE_TYPES.RESULT_SHOW), true);
  assert.equal(isRequestCorrelatedType(MESSAGE_TYPES.ACTION_SAVE), true);
  assert.equal(isRequestCorrelatedType(MESSAGE_TYPES.SESSION_READY), false);
});

// ── 9. Builder guards ────────────────────────────────────────────────────
check('builder:rejects-session-bearing-without-session', () => {
  assert.equal(buildMessage(MESSAGE_TYPES.CAPTURE_STARTED, { deviceId: HUD, sessionId: null, requestId: REQ }), null);
});

check('builder:rejects-request-correlated-without-request', () => {
  assert.equal(buildMessage(MESSAGE_TYPES.CAPTURE_STARTED, { deviceId: HUD, sessionId: SESSION, requestId: null }), null);
});

check('builder:clamps-ttl-to-max', () => {
  const msg = buildMessage(MESSAGE_TYPES.CONNECTION_RESTORED, { deviceId: HUD, now: NOW, ttlMs: 10 * 60 * 1000 });
  assert.equal(msg.expiresAt - msg.timestamp, MAX_MESSAGE_TTL_MS);
});

check('message-ids:unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => makeMessageId('t')));
  assert.equal(ids.size, 500);
});

// ── Summary ──────────────────────────────────────────────────────────────
const failed = results.filter(([ok]) => !ok);
console.log(`\n=== Companion protocol tests: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
if (failed.length > 0) process.exit(1);
console.log('[OK] All companion protocol tests passed.');
