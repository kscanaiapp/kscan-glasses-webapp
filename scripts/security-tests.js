// Security tests — hardware-validation candidate (Node built-ins only).
// Usage: node scripts/security-tests.js
//
// Covers:
//   A. Canonical message trust evaluator (pure)
//   B. Session message listener trust (origin/source pinning, payloads)
//   C. Session replacement / duplicate injection / sign-out cleanup
//   D. URL-token intake gating (production disabled, simulator opt-in)
//   E. Session persistence policy
//   F. Production bundle structural proofs (requires `npm run build` first)

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let passCount = 0;
let failCount = 0;

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

// ── Console capture: tokens must never be logged ──────────────────────────
const consoleLines = [];
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
function captureConsole() {
  for (const [orig, name] of [[origLog, 'log'], [origWarn, 'warn'], [origError, 'error']]) {
    console[name] = (...args) => {
      consoleLines.push(args.map((a) => String(a)).join(' '));
      orig(...args); // keep test output visible while capturing
    };
  }
}
function restoreConsole() {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
}

// ── Window stub (installed BEFORE importing app modules) ──────────────────
const SELF_ORIGIN = 'http://localhost:5173';
const messageHandlers = new Set();
const parentStub = { __isParent: true };
const strangerStub = { __isStranger: true };

let replaceStateCalls = 0;
const windowStub = {
  location: {
    origin: SELF_ORIGIN,
    href: 'http://localhost:5173/',
  },
  history: {
    state: null,
    replaceState() {
      replaceStateCalls += 1;
    },
  },
  parent: parentStub,
  addEventListener(type, handler) {
    if (type === 'message') messageHandlers.add(handler);
  },
  removeEventListener(type, handler) {
    if (type === 'message') messageHandlers.delete(handler);
  },
  dispatchEvent() {
    return true;
  },
  __KSCAN_CONFIG__: {},
};
windowStub.window = windowStub;
globalThis.window = windowStub;
globalThis.document = { title: 'kscan-test' };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

function dispatchMessage(event) {
  for (const handler of messageHandlers) handler(event);
}

// Dynamic imports AFTER the window stub is in place.
const trust = await import('../src/messageTrust.js');
const supabaseModule = await import('../src/services/supabaseClient.js');

const {
  normalizeOrigin,
  buildMessageOriginAllowlist,
  evaluateMessageTrust,
  MESSAGE_TRUST_REASONS,
} = trust;

const {
  listenForSupabaseSessionMessages,
  hydrateSupabaseSessionFromRuntime,
  getSupabaseSession,
  getSupabaseRuntimeStatus,
  signOutSupabaseSession,
  computeUrlTokenIntakeEnabled,
  computePersistSessionEnabled,
  __setSupabaseTestClient,
  __testHooks,
} = supabaseModule;

const R = MESSAGE_TRUST_REASONS;
const SESSION_TYPES = new Set(['kscan:supabase-session', 'kscan:supabase-token']);

// ═══════════════════════════════════════════════════════════════════
// A. Canonical message trust evaluator (pure)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== A. Canonical message trust evaluator ===');

check('A1.normalize-origin-basic', () => {
  assert.equal(normalizeOrigin('https://runtime.meta.example'), 'https://runtime.meta.example');
  assert.equal(normalizeOrigin('https://runtime.meta.example/'), 'https://runtime.meta.example');
  assert.equal(normalizeOrigin('http://localhost:5173'), 'http://localhost:5173');
});

check('A2.normalize-origin-rejects-bad-values', () => {
  assert.equal(normalizeOrigin('*'), null);
  assert.equal(normalizeOrigin('null'), null);
  assert.equal(normalizeOrigin(''), null);
  assert.equal(normalizeOrigin(null), null);
  assert.equal(normalizeOrigin('not a url'), null);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
  assert.equal(normalizeOrigin('http://evil.example'), null); // non-localhost http
  assert.equal(normalizeOrigin('https://ok.example/path'), null); // not a bare origin
});

check('A3.allowlist-ignores-wildcards-and-malformed', () => {
  const list = buildMessageOriginAllowlist(['https://ok.example, *, null, garbage', 'http://localhost:9999'], SELF_ORIGIN);
  assert.equal(list.has(SELF_ORIGIN), true);
  assert.equal(list.has('https://ok.example'), true);
  assert.equal(list.has('http://localhost:9999'), true);
  assert.equal(list.has('*'), false);
  assert.equal(list.size, 3);
});

check('A4.same-origin-parent-accepted', () => {
  const result = evaluateMessageTrust(
    { origin: SELF_ORIGIN, source: parentStub, data: { type: 'kscan:supabase-session' } },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, true);
  assert.equal(result.reason, R.OK_SELF_ORIGIN);
});

check('A5.approved-cross-origin-parent-accepted', () => {
  const allowlist = buildMessageOriginAllowlist(['https://runtime.meta.example'], SELF_ORIGIN);
  const result = evaluateMessageTrust(
    { origin: 'https://runtime.meta.example', source: parentStub, data: { type: 'kscan:supabase-session' } },
    { allowlist, selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, true);
  assert.equal(result.reason, R.OK_ALLOWLISTED_ORIGIN);
});

check('A6.wrong-origin-rejected', () => {
  const result = evaluateMessageTrust(
    { origin: 'https://attacker.example', source: parentStub, data: { type: 'kscan:supabase-session' } },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_ORIGIN_NOT_ALLOWED);
});

check('A7.wrong-source-rejected', () => {
  const result = evaluateMessageTrust(
    { origin: SELF_ORIGIN, source: strangerStub, data: { type: 'kscan:supabase-session' } },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_SOURCE_NOT_APPROVED);
});

check('A8.null-origin-rejected', () => {
  const result = evaluateMessageTrust(
    { origin: 'null', source: parentStub, data: { type: 'kscan:supabase-session' } },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_NULL_ORIGIN);
});

check('A9.malformed-origin-rejected', () => {
  const result = evaluateMessageTrust(
    { origin: 'ht!tp://bad origin with spaces', source: parentStub, data: { type: 'kscan:supabase-session' } },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_MALFORMED_ORIGIN);
});

check('A10.missing-payload-rejected', () => {
  const result = evaluateMessageTrust(
    { origin: SELF_ORIGIN, source: parentStub, data: null },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_MISSING_MESSAGE_DATA);
});

check('A11.unsupported-message-type-rejected', () => {
  const result = evaluateMessageTrust(
    { origin: SELF_ORIGIN, source: parentStub, data: { type: 'kscan:evil' } },
    { allowlist: buildMessageOriginAllowlist([], SELF_ORIGIN), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub], allowedTypes: SESSION_TYPES },
  );
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_UNSUPPORTED_MESSAGE_TYPE);
});

check('A12.missing-event-rejected', () => {
  const result = evaluateMessageTrust(null, { allowlist: new Set(), selfOrigin: SELF_ORIGIN, approvedSources: [parentStub] });
  assert.equal(result.trusted, false);
  assert.equal(result.reason, R.REJECT_MISSING_EVENT);
});

// ═══════════════════════════════════════════════════════════════════
// B. Session listener trust (mock client, dispatched message events)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== B. Session message listener trust ===');

const sdkCalls = [];
function makeMockClient({ setSessionError = null } = {}) {
  return {
    auth: {
      async setSession(tokens) {
        sdkCalls.push(`setSession:${tokens.access_token.slice(0, 12)}`);
        if (setSessionError) return { data: { session: null }, error: setSessionError };
        return { data: { session: { access_token: tokens.access_token } }, error: null };
      },
      async signOut() {
        sdkCalls.push('signOut');
        return { error: null };
      },
      async getSession() {
        return { data: { session: null } };
      },
      async refreshSession() {
        return { data: { session: null }, error: new Error('no session') };
      },
    },
    functions: {
      async invoke() {
        return { data: null, error: null };
      },
    },
  };
}

const TOKEN_A = 'token-aaa-0123456789abcdef';
const TOKEN_B = 'token-bbb-0123456789abcdef';
const REFRESH_A = 'refresh-aaa-0123456789';
const REFRESH_B = 'refresh-bbb-0123456789';

captureConsole();
__setSupabaseTestClient(makeMockClient());
listenForSupabaseSessionMessages();

function sessionMessage(overrides = {}) {
  return {
    origin: SELF_ORIGIN,
    source: parentStub,
    data: { type: 'kscan:supabase-session', session: { access_token: TOKEN_A, refresh_token: REFRESH_A } },
    ...overrides,
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

// B1. trusted same-origin parent session message links the session
sdkCalls.length = 0;
dispatchMessage(sessionMessage());
await flushMicrotasks();
check('B1.same-origin-parent-session-accepted', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, true);
  assert.equal(getSupabaseRuntimeStatus().source, 'postMessage-session');
});

// B2. wrong origin rejected
__setSupabaseTestClient(makeMockClient());
sdkCalls.length = 0;
dispatchMessage(sessionMessage({ origin: 'https://attacker.example' }));
await flushMicrotasks();
check('B2.wrong-origin-message-ignored', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(sdkCalls.length, 0);
});

// B3. wrong source rejected
dispatchMessage(sessionMessage({ source: strangerStub }));
await flushMicrotasks();
check('B3.wrong-source-message-ignored', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(sdkCalls.length, 0);
});

// B4. null origin rejected
dispatchMessage(sessionMessage({ origin: 'null' }));
await flushMicrotasks();
check('B4.null-origin-message-ignored', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(sdkCalls.length, 0);
});

// B5. wildcard allowlist entry does not rescue attacker origin
windowStub.__KSCAN_CONFIG__ = { SESSION_ALLOWED_ORIGINS: '*' };
dispatchMessage(sessionMessage({ origin: 'https://attacker.example' }));
await flushMicrotasks();
check('B5.wildcard-allowlist-ignored', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(sdkCalls.length, 0);
});

// B6. explicitly configured cross-origin parent accepted
windowStub.__KSCAN_CONFIG__ = { SESSION_ALLOWED_ORIGINS: 'https://runtime.meta.example' };
dispatchMessage(sessionMessage({ origin: 'https://runtime.meta.example' }));
await flushMicrotasks();
check('B6.configured-cross-origin-accepted', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, true);
});
windowStub.__KSCAN_CONFIG__ = {};

// B7. unsupported message type ignored
__setSupabaseTestClient(makeMockClient());
sdkCalls.length = 0;
dispatchMessage(sessionMessage({ data: { type: 'kscan:not-a-session', session: { access_token: TOKEN_A, refresh_token: REFRESH_A } } }));
await flushMicrotasks();
check('B7.unsupported-type-ignored', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(sdkCalls.length, 0);
});

// B8. missing payload ignored
dispatchMessage(sessionMessage({ data: null }));
dispatchMessage(sessionMessage({ data: { type: 'kscan:supabase-session' } }));
await flushMicrotasks();
check('B8.missing-payload-ignored', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(sdkCalls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// C. Replacement / duplicates / sign-out cleanup
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== C. Session replacement, duplicates, sign-out ===');

// C1. session replacement clears previous auth state first
__setSupabaseTestClient(makeMockClient());
sdkCalls.length = 0;
dispatchMessage(sessionMessage());
await flushMicrotasks();
assert.equal(getSupabaseRuntimeStatus().linked, true);
dispatchMessage(sessionMessage({ data: { type: 'kscan:supabase-session', session: { access_token: TOKEN_B, refresh_token: REFRESH_B } } }));
await flushMicrotasks();
check('C1.session-replacement-clears-first', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, true);
  const signOutIdx = sdkCalls.indexOf('signOut');
  const secondSetIdx = sdkCalls.indexOf(`setSession:${TOKEN_B.slice(0, 12)}`);
  assert.ok(signOutIdx !== -1, 'expected local signOut during replacement');
  assert.ok(secondSetIdx !== -1, 'expected second setSession');
  assert.ok(signOutIdx < secondSetIdx, 'signOut must precede replacement setSession');
});

// C2. duplicate session message handled safely
sdkCalls.length = 0;
dispatchMessage(sessionMessage());
await flushMicrotasks();
check('C2.duplicate-session-safe', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, true);
});

// C3. failed hydration leaves no partial session
__setSupabaseTestClient(makeMockClient({ setSessionError: new Error('bad token') }));
sdkCalls.length = 0;
dispatchMessage(sessionMessage());
await flushMicrotasks();
check('C3.failed-hydration-clears-state', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.ok(sdkCalls.includes('signOut'), 'expected local signOut after failed hydration');
});

// C4. sign-out clears SDK session state and app markers
__setSupabaseTestClient(makeMockClient());
sdkCalls.length = 0;
dispatchMessage(sessionMessage());
await flushMicrotasks();
assert.equal(getSupabaseRuntimeStatus().linked, true);
await signOutSupabaseSession();
const afterSignOut = await getSupabaseSession();
check('C4.sign-out-clears-session-state', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.ok(sdkCalls.includes('signOut'), 'expected local signOut');
  assert.equal(afterSignOut.linked, false);
});

// C5. token-only override cleanup on sign-out
__setSupabaseTestClient(makeMockClient());
sdkCalls.length = 0;
dispatchMessage(sessionMessage({ data: { type: 'kscan:supabase-token', accessToken: TOKEN_A } }));
await flushMicrotasks();
check('C5a.token-only-override-links', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, true);
});
await signOutSupabaseSession();
const afterTokenClear = await getSupabaseSession();
check('C5b.token-only-override-cleared', () => {
  assert.equal(getSupabaseRuntimeStatus().linked, false);
  assert.equal(afterTokenClear.linked, false);
  assert.equal(afterTokenClear.accessToken, null);
});

restoreConsole();

// C6. token/session data never logged
check('C6.tokens-never-logged', () => {
  for (const line of consoleLines) {
    assert.ok(!line.includes(TOKEN_A), `token A leaked to console: ${line}`);
    assert.ok(!line.includes(TOKEN_B), `token B leaked to console: ${line}`);
    assert.ok(!line.includes(REFRESH_A), `refresh A leaked to console: ${line}`);
    assert.ok(!line.includes(REFRESH_B), `refresh B leaked to console: ${line}`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// D. URL-token intake gating
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== D. URL-token intake gating ===');

check('D1.gate-truth-table', () => {
  assert.equal(computeUrlTokenIntakeEnabled({}), false);
  assert.equal(computeUrlTokenIntakeEnabled({ dev: false, simulatorBuild: false }), false);
  assert.equal(computeUrlTokenIntakeEnabled({ dev: true }), true);
  assert.equal(computeUrlTokenIntakeEnabled({ simulatorBuild: true }), true);
});

// D2-D4. In this Node context there is no DEV flag and no simulator build
// constant — the same compile-time-false state as a production bundle.
// URL tokens in query and hash must be ignored entirely.
__setSupabaseTestClient(makeMockClient());
sdkCalls.length = 0;
replaceStateCalls = 0;
windowStub.location.href = 'http://localhost:5173/?access_token=url-access-token&refresh_token=url-refresh-token';
const hydrateQuery = await hydrateSupabaseSessionFromRuntime();
check('D2.production-ignores-query-access-token', () => {
  assert.equal(hydrateQuery.linked, false);
  assert.equal(hydrateQuery.source, 'none');
  assert.equal(replaceStateCalls, 0);
  assert.equal(sdkCalls.length, 0);
});

windowStub.location.href = 'http://localhost:5173/#access_token=url-access-token&refresh_token=url-refresh-token';
const hydrateHash = await hydrateSupabaseSessionFromRuntime();
check('D3.production-ignores-hash-access-token', () => {
  assert.equal(hydrateHash.linked, false);
  assert.equal(hydrateHash.source, 'none');
  assert.equal(replaceStateCalls, 0);
});

windowStub.location.href = 'http://localhost:5173/?supabaseAccessToken=url-access-token&supabaseRefreshToken=url-refresh-token&AUTH_TOKEN=url-auth-token';
const hydrateNamed = await hydrateSupabaseSessionFromRuntime();
check('D4.production-ignores-refresh-and-named-tokens', () => {
  assert.equal(hydrateNamed.linked, false);
  assert.equal(hydrateNamed.source, 'none');
  assert.equal(replaceStateCalls, 0);
});
windowStub.location.href = 'http://localhost:5173/';

// D5. parser itself (simulator/dev builds only) still behaves correctly
check('D5.simulator-parser-behavior', () => {
  const params = new URLSearchParams('access_token=dev-access&refresh_token=dev-refresh');
  const parsed = __testHooks.readTokenFromSearchParams(params);
  assert.equal(parsed.session.access_token, 'dev-access');
  assert.equal(parsed.session.refresh_token, 'dev-refresh');
  assert.equal(parsed.source, 'url-session');
  const tokenOnly = __testHooks.readTokenFromSearchParams(new URLSearchParams('AUTH_TOKEN=dev-token'));
  assert.equal(tokenOnly.accessToken, 'dev-token');
  assert.equal(tokenOnly.source, 'url-token');
  assert.equal(__testHooks.readTokenFromSearchParams(new URLSearchParams('')), null);
});

// ═══════════════════════════════════════════════════════════════════
// E. Session persistence policy
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== E. Session persistence policy ===');

check('E1.persistence-truth-table', () => {
  // production / preview / hardware QA: never persist
  assert.equal(computePersistSessionEnabled({ dev: false, envFlag: 'true' }), false);
  assert.equal(computePersistSessionEnabled({ dev: false, envFlag: 'false' }), false);
  assert.equal(computePersistSessionEnabled({ dev: false, envFlag: '' }), false);
  // dev default: off unless explicitly enabled
  assert.equal(computePersistSessionEnabled({ dev: true, envFlag: '' }), false);
  assert.equal(computePersistSessionEnabled({ dev: true, envFlag: 'false' }), false);
  // trusted local developer mode: explicit opt-in only
  assert.equal(computePersistSessionEnabled({ dev: true, envFlag: 'true' }), true);
});

check('E2.shared-device-reload-does-not-revive', async () => {
  // With persistence disabled and no injected payload, a fresh session
  // lookup (as after a reload on a shared device) must not find a session.
  __setSupabaseTestClient(makeMockClient());
  const session = await getSupabaseSession();
  assert.equal(session.linked, false);
  assert.equal(session.session, null);
  assert.equal(session.accessToken, null);
});

// ═══════════════════════════════════════════════════════════════════
// F. Production bundle structural proofs (requires npm run build first)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== F. Production bundle structural proofs ===');

function findMainBundle(dir) {
  const assets = join(dir, 'assets');
  if (!existsSync(assets)) return null;
  const file = readdirSync(assets).find((f) => /^main-.*\.js$/.test(f));
  return file ? join(assets, file) : null;
}

const prodBundlePath = findMainBundle('dist');
check('F0.production-bundle-exists', () => {
  assert.ok(prodBundlePath, 'dist/assets/main-*.js missing — run npm run build first');
});

if (prodBundlePath) {
  const prodBundle = readFileSync(prodBundlePath, 'utf8');

  check('F1.production-has-no-url-token-path', () => {
    // 'supabaseRefreshToken' exists ONLY in the URL-token intake path
    // (query/hash param parsing + scrub). Its absence proves the intake
    // path was tree-shaken from the production bundle. ('replaceState' and
    // 'access_token' cannot be used: @supabase/supabase-js legitimately
    // contains both.)
    assert.ok(!prodBundle.includes('supabaseRefreshToken'), 'URL-token intake path reachable in production bundle');
  });

  check('F2.production-has-no-simulator-gate-flag', () => {
    assert.ok(!prodBundle.includes('__KSCAN_SIMULATOR_BUILD__'), 'unreplaced build gate identifier in bundle');
  });

  const simBundlePath = findMainBundle('dist-simulator');
  check('F3.simulator-bundle-retains-url-token-path', () => {
    assert.ok(simBundlePath, 'dist-simulator/assets/main-*.js missing — run npm run build:simulator first');
    const simBundle = readFileSync(simBundlePath, 'utf8');
    assert.ok(simBundle.includes('supabaseRefreshToken'), 'URL-token intake missing from LOCAL QA simulator bundle');
  });
}

// ═══════════════════════════════════════════════════════════════════
console.log(`\n=== Security tests summary: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
console.log('[OK] All security tests passed.');
