// Phase 11 — Contract/behavioral tests (Node built-ins only, no deps).
// Usage: node scripts/contract-tests.js
// Covers: backend analyze client retry policy, DAT bridge postMessage path
// (origin trust, timeout, cancel, invalid/duplicate/oversized payloads,
// listener cleanup), scan pipeline ordering invariants, guest library
// store privacy gates, auth stub session, simulator gating.

let failCount = 0;
let passCount = 0;

function pass(name, detail = '') {
  passCount += 1;
  console.log(`PASS | ${name}${detail ? ' | ' + detail : ''}`);
}
function fail(name, expected, actual) {
  failCount += 1;
  console.log(`FAIL | ${name} | expected: ${expected} | actual: ${actual}`);
}
function expectEq(name, expected, actual) {
  if (Object.is(expected, actual)) pass(name);
  else fail(name, String(expected), String(actual));
}
function expectTrue(name, actual) {
  expectEq(name, true, Boolean(actual));
}

const VALID_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';

// ═══════════════════════════════════════════════════════════════════
// Window stub (installed BEFORE importing datBridge)
// ═══════════════════════════════════════════════════════════════════
const listeners = new Map();
const parentPosts = [];
const parentStub = {
  postMessage(message) {
    parentPosts.push({ type: message?.type });
  },
};

globalThis.window = {
  parent: parentStub,
  location: { origin: 'http://localhost:5173', search: '', hash: '' },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn);
  },
};

function dispatchMessage(event) {
  for (const fn of [...(listeners.get('message') || [])]) fn(event);
}
function messageListenerCount() {
  return (listeners.get('message') || new Set()).size;
}

const api = await import('../src/api.js');
const bridge = await import('../src/datBridge.js');
const pipeline = await import('../src/scanPipeline.js');
const library = await import('../src/libraryStore.js');
const auth = await import('../src/authSession.js');
const sim = await import('../src/simulatorMode.js');

// ═══════════════════════════════════════════════════════════════════
// A. Backend analyze client (performAnalyzeRequest)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== A. Backend analyze client ===');

const FAST = { firstTimeoutMs: 60, secondTimeoutMs: 80, retryDelayMs: 5, slowHintMs: 5000 };

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
function malformedResponse(status) {
  return { ok: true, status, json: async () => { throw new Error('bad json'); } };
}
function hangingFetch() {
  return (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}
function countingFetch(impl) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, body: opts.body });
    return impl(calls.length, url, opts);
  };
  fn.calls = calls;
  return fn;
}

// A1: 200 with products
{
  const fetchImpl = countingFetch(async () => jsonResponse(200, {
    products: [{ brand: 'X', name: 'Jacket', price: '$10' }],
    style_metadata: { color: 'blue' },
  }));
  const result = await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST });
  expectEq('A1.products-length', 1, result.products.length);
  expectEq('A1.single-attempt', 1, fetchImpl.calls.length);
  expectTrue('A1.payload-shape', fetchImpl.calls[0].body === JSON.stringify({ image: VALID_JPEG }));
  expectTrue('A1.endpoint', fetchImpl.calls[0].url === 'https://b.test/api/analyze');
}

// A2: 200 with empty products
{
  const fetchImpl = countingFetch(async () => jsonResponse(200, { products: [] }));
  const result = await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST });
  expectEq('A2.empty-products', 0, result.products.length);
}

// A3: 400 → no retry
{
  const fetchImpl = countingFetch(async () => jsonResponse(400, {}));
  let caught = null;
  try { await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST }); } catch (e) { caught = e; }
  expectEq('A3.code', api.ANALYZE_ERROR_CODES.NON_2XX, caught?.code);
  expectEq('A3.status', 400, caught?.status);
  expectEq('A3.no-retry', 1, fetchImpl.calls.length);
}

// A4: 500 then 200 → retried once, succeeds
{
  const fetchImpl = countingFetch(async (n) => (n === 1 ? jsonResponse(500, {}) : jsonResponse(200, { products: [{ name: 'P' }] })));
  const result = await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST });
  expectEq('A4.retried-once', 2, fetchImpl.calls.length);
  expectEq('A4.products', 1, result.products.length);
}

// A5: 500 twice → fails after exactly 2 attempts
{
  const fetchImpl = countingFetch(async () => jsonResponse(500, {}));
  let caught = null;
  try { await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST }); } catch (e) { caught = e; }
  expectEq('A5.code', api.ANALYZE_ERROR_CODES.NON_2XX, caught?.code);
  expectEq('A5.status', 500, caught?.status);
  expectEq('A5.two-attempts-max', 2, fetchImpl.calls.length);
}

// A6: timeout then success → retried once
{
  let first = true;
  const inner = hangingFetch();
  const fetchImpl = countingFetch((n, url, opts) => {
    if (n === 1) return inner(url, opts);
    return Promise.resolve(jsonResponse(200, { products: [] }));
  });
  void first;
  const result = await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST });
  expectEq('A6.timeout-retried', 2, fetchImpl.calls.length);
  expectEq('A6.success-after-retry', 0, result.products.length);
}

// A7: timeout twice → TIMEOUT after 2 attempts
{
  const inner = hangingFetch();
  const fetchImpl = countingFetch((n, url, opts) => inner(url, opts));
  let caught = null;
  try { await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST }); } catch (e) { caught = e; }
  expectEq('A7.code', api.ANALYZE_ERROR_CODES.TIMEOUT, caught?.code);
  expectEq('A7.two-attempts', 2, fetchImpl.calls.length);
}

// A8: malformed JSON → INVALID_JSON, no retry
{
  const fetchImpl = countingFetch(async () => malformedResponse(200));
  let caught = null;
  try { await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST }); } catch (e) { caught = e; }
  expectEq('A8.code', api.ANALYZE_ERROR_CODES.INVALID_JSON, caught?.code);
  expectEq('A8.no-retry', 1, fetchImpl.calls.length);
}

// A9: network failure → NETWORK, no retry
{
  const fetchImpl = countingFetch(async () => { throw new TypeError('fetch failed'); });
  let caught = null;
  try { await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: 'https://b.test', fetchImpl, ...FAST }); } catch (e) { caught = e; }
  expectEq('A9.code', api.ANALYZE_ERROR_CODES.NETWORK, caught?.code);
  expectEq('A9.no-retry', 1, fetchImpl.calls.length);
}

// A10: missing backend URL
{
  let caught = null;
  try { await api.performAnalyzeRequest(VALID_JPEG, { backendUrl: '', fetchImpl: async () => {}, ...FAST }); } catch (e) { caught = e; }
  expectEq('A10.code', api.ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED, caught?.code);
}

// A11: scenario gating — production inert
{
  const prod = api.parseAnalyzeScenario({ search: '?mockAnalyze=http-500' }, { DEV: false });
  expectEq('A11.prod-inert', null, prod);
  const dev = api.parseAnalyzeScenario({ search: '?mockAnalyze=http-500' }, { DEV: true });
  expectEq('A11.dev-active', 'http-500', dev);
  const staging = api.parseAnalyzeScenario({ search: '?mockAnalyze=empty' }, { DEV: false, VITE_ENABLE_SIMULATOR: 'true' });
  expectEq('A11.staging-active', 'empty', staging);
  const unknown = api.parseAnalyzeScenario({ search: '?mockAnalyze=hack' }, { DEV: true });
  expectEq('A11.unknown-rejected', null, unknown);
}

// ═══════════════════════════════════════════════════════════════════
// B. DAT bridge — origin trust (pure)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== B. DAT bridge origin trust ===');

{
  const allowlist = bridge.buildOriginAllowlist({ VITE_DAT_PARENT_ORIGIN: 'https://host.meta.test, *' }, 'http://localhost:5173');
  expectTrue('B1.self-origin-allowed', allowlist.has('http://localhost:5173'));
  expectTrue('B1.env-origin-allowed', allowlist.has('https://host.meta.test'));
  expectTrue('B1.wildcard-ignored', !allowlist.has('*'));

  const t1 = bridge.evaluateMessageTrust({ origin: 'null', source: parentStub }, { allowlist, parentRef: parentStub });
  expectEq('B2.null-origin-rejected', false, t1.trusted);

  const t2 = bridge.evaluateMessageTrust({ origin: 'http://localhost:5173', source: {} }, { allowlist, parentRef: parentStub });
  expectEq('B3.allowlisted-trusted', true, t2.trusted);

  const t3 = bridge.evaluateMessageTrust({ origin: 'https://unknown.example', source: parentStub }, { allowlist, parentRef: parentStub });
  expectEq('B4.parent-source-fallback', true, t3.trusted);

  const t4 = bridge.evaluateMessageTrust({ origin: 'https://attacker.example', source: {} }, { allowlist, parentRef: parentStub });
  expectEq('B5.stranger-rejected', false, t4.trusted);
}

// ═══════════════════════════════════════════════════════════════════
// C. DAT bridge — capturePhoto postMessage integration (window stub)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== C. DAT bridge capture integration ===');

const SELF_ORIGIN = 'http://localhost:5173';
function trustedEvent(data) {
  return { origin: SELF_ORIGIN, source: parentStub, data };
}
function lastRequestId() {
  // requestId travels in the posted message; our stub records types only,
  // so capture it via a one-shot postMessage interceptor instead.
  return null;
}
void lastRequestId;

async function runCapture(scenario) {
  parentPosts.length = 0;
  let postedRequestId = null;
  const originalPost = parentStub.postMessage;
  parentStub.postMessage = (message) => {
    parentPosts.push({ type: message?.type });
    if (message?.type === 'capture-photo') postedRequestId = message.requestId;
  };
  try {
    const promise = bridge.capturePhoto({ timeoutMs: 200 });
    // allow emit
    await new Promise((r) => setTimeout(r, 5));
    await scenario({ promise, requestId: () => postedRequestId });
    return promise;
  } finally {
    parentStub.postMessage = originalPost;
  }
}

// C1: success path + listener cleanup + duplicate message ignored
{
  let result = null;
  let caught = null;
  try {
    result = await runCapture(async ({ promise, requestId }) => {
      dispatchMessage(trustedEvent({ type: 'photo-captured', requestId: requestId(), base64: VALID_JPEG }));
      // duplicate/stale message after settle — must be ignored, not crash
      dispatchMessage(trustedEvent({ type: 'photo-captured', requestId: requestId(), base64: VALID_JPEG }));
      await promise;
    });
  } catch (e) { caught = e; }
  expectTrue('C1.success-resolves-jpeg', !caught && typeof result === 'string' && result.startsWith('data:image/jpeg;base64,'));
  expectEq('C1.listener-cleanup', 0, messageListenerCount());
  expectTrue('C1.request-emitted', parentPosts.some((p) => p.type === 'capture-photo'));
}

// C2: untrusted origins ignored, trusted resolves
{
  let result = null;
  try {
    result = await runCapture(async ({ promise, requestId }) => {
      dispatchMessage({ origin: 'null', source: parentStub, data: { type: 'photo-captured', requestId: requestId(), base64: VALID_JPEG } });
      dispatchMessage({ origin: 'https://attacker.example', source: {}, data: { type: 'photo-captured', requestId: requestId(), base64: VALID_JPEG } });
      await new Promise((r) => setTimeout(r, 20));
      dispatchMessage(trustedEvent({ type: 'photo-captured', requestId: requestId(), base64: VALID_JPEG }));
      await promise;
    });
  } catch { /* handled below */ }
  expectTrue('C2.untrusted-ignored-trusted-resolves', typeof result === 'string');
  expectEq('C2.listener-cleanup', 0, messageListenerCount());
}

// C3: invalid payload → INVALID_CAPTURE_RESPONSE
{
  let caught = null;
  try {
    await runCapture(async ({ promise, requestId }) => {
      dispatchMessage(trustedEvent({ type: 'photo-captured', requestId: requestId(), base64: 'not-a-data-url' }));
      await promise;
    });
  } catch (e) { caught = e; }
  expectEq('C3.invalid-payload', 'INVALID_CAPTURE_RESPONSE', caught?.code);
  expectEq('C3.listener-cleanup', 0, messageListenerCount());
}

// C4: cancelled → CAPTURE_CANCELLED
{
  let caught = null;
  try {
    await runCapture(async ({ promise, requestId }) => {
      dispatchMessage(trustedEvent({ type: 'photo-capture-error', requestId: requestId(), code: 'CAPTURE_CANCELLED' }));
      await promise;
    });
  } catch (e) { caught = e; }
  expectEq('C4.cancelled', 'CAPTURE_CANCELLED', caught?.code);
}

// C5: timeout → CAPTURE_TIMEOUT
{
  let caught = null;
  try {
    await runCapture(async ({ promise }) => { await promise; });
  } catch (e) { caught = e; }
  expectEq('C5.timeout', 'CAPTURE_TIMEOUT', caught?.code);
  expectEq('C5.listener-cleanup', 0, messageListenerCount());
}

// C6: oversized payload rejected at the bridge
{
  let caught = null;
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(bridge.MAX_CAPTURE_PAYLOAD_CHARS + 16);
  try {
    await runCapture(async ({ promise, requestId }) => {
      dispatchMessage(trustedEvent({ type: 'photo-captured', requestId: requestId(), base64: huge }));
      await promise;
    });
  } catch (e) { caught = e; }
  expectEq('C6.payload-too-large', 'PAYLOAD_TOO_LARGE', caught?.code);
}

// ═══════════════════════════════════════════════════════════════════
// D. Scan pipeline invariants
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== D. Scan pipeline ===');

// D1: ordering + sanitized payload routing
{
  const calls = [];
  const RAW = 'data:image/jpeg;base64,RAWCAPTUREDATAxxxxxxxx';
  const CLEAN = 'data:image/jpeg;base64,SANITIZEDOUTPUTyyyyyy';
  let analyzeReceived = null;

  const { response } = await pipeline.runScanPipeline({
    capture: async () => { calls.push('capture'); return RAW; },
    sanitize: async (input) => { calls.push('sanitize'); calls.push(`sanitize-got-raw:${input === RAW}`); return CLEAN; },
    analyze: async (input) => { calls.push('analyze'); analyzeReceived = input; return { products: [] }; },
  });

  expectEq('D1.order', 'capture,sanitize,sanitize-got-raw:true,analyze', calls.join(','));
  expectTrue('D1.analyze-gets-sanitized', analyzeReceived === CLEAN);
  expectTrue('D1.analyze-never-gets-raw', analyzeReceived !== RAW);
  expectTrue('D1.response-returned', Array.isArray(response.products));
}

// D2: non-JPEG sanitizer output blocks analyze
{
  let analyzeCalled = false;
  let caught = null;
  try {
    await pipeline.runScanPipeline({
      capture: async () => 'data:image/jpeg;base64,xxxxxxxxxxxxxxxx',
      sanitize: async () => 'data:image/png;base64,xxxxxxxxxxxxxxxx',
      analyze: async () => { analyzeCalled = true; return {}; },
    });
  } catch (e) { caught = e; }
  expectEq('D2.invariant-error', 'PipelineInvariantError', caught?.name);
  expectEq('D2.analyze-blocked', false, analyzeCalled);
}

// D3: missing steps rejected
{
  let caught = null;
  try { await pipeline.runScanPipeline({ capture: async () => '' }); } catch (e) { caught = e; }
  expectEq('D3.missing-steps', 'PipelineInvariantError', caught?.name);
}

// ═══════════════════════════════════════════════════════════════════
// E. Guest library store
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== E. Guest library store ===');

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

// E1: record + load round trip, newest first, cap 20
{
  const storage = makeStorage();
  for (let i = 0; i < 25; i += 1) {
    library.recordGuestScan({ productCount: i, topBrand: `Brand${i}` }, storage);
  }
  const lib = library.loadGuestLibrary(storage);
  expectEq('E1.cap-20', 20, lib.scans.length);
  expectEq('E1.newest-first', 24, lib.scans[0].productCount);
  expectEq('E1.schema', library.LIBRARY_SCHEMA_VERSION, lib.schemaVersion);
}

// E2: saved item dedupe
{
  const storage = makeStorage();
  const r1 = library.saveGuestItem({ brand: 'B', name: 'N', price: '$1' }, storage);
  const r2 = library.saveGuestItem({ brand: 'B', name: 'N', price: '$1' }, storage);
  expectEq('E2.first-saved', true, r1.saved);
  expectEq('E2.duplicate-rejected', 'duplicate', r2.reason);
}

// E3: image payloads refused (privacy gate)
{
  const storage = makeStorage();
  const r = library.saveGuestItem({ brand: 'data:image/jpeg;base64,AAAA', name: 'sneaky', price: '$1' }, storage);
  expectEq('E3.image-payload-refused', false, r.saved);
  const lib = library.loadGuestLibrary(storage);
  expectEq('E3.nothing-persisted', 0, lib.savedItems.length);
}

// E4: corrupt/unknown schema → safe empty
{
  const storage = makeStorage();
  storage.setItem(library.LIBRARY_STORAGE_KEY, '{"schemaVersion":99,"scans":"bad"}');
  const lib = library.loadGuestLibrary(storage);
  expectEq('E4.unknown-schema-empty', 0, lib.scans.length);
  storage.setItem(library.LIBRARY_STORAGE_KEY, 'not-json{{{');
  const lib2 = library.loadGuestLibrary(storage);
  expectEq('E4.corrupt-json-empty', 0, lib2.scans.length);
}

// ═══════════════════════════════════════════════════════════════════
// F. Auth stub session
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== F. Auth stub session ===');

{
  expectEq('F1.unconfigured-is-stub', true, auth.parseSupabaseEnv({}).configured === false);
  expectEq('F1.configured-detected', true, auth.parseSupabaseEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' }).configured);

  const storage = makeStorage();
  expectEq('F2.default-guest', null, auth.getSession({ storageLike: storage, envLike: {} }));

  const session = auth.signInStub({ storageLike: storage });
  expectEq('F3.stub-email', auth.STUB_USER_EMAIL, session?.user?.email);
  expectTrue('F3.marked-stub', session?.isStub === true);

  const restored = auth.getSession({ storageLike: storage, envLike: {} });
  expectEq('F4.session-restored', auth.STUB_USER_EMAIL, restored?.user?.email);

  const stored = storage.getItem('kscan.session.v1') || '';
  expectTrue('F5.no-token-stored', !/token|jwt|bearer/i.test(stored));
  expectTrue('F5.no-email-stored', !stored.includes('@'));

  auth.signOut({ storageLike: storage });
  expectEq('F6.signed-out', null, auth.getSession({ storageLike: storage, envLike: {} }));
}

// ═══════════════════════════════════════════════════════════════════
// G. Simulator gating
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== G. Simulator gating ===');

{
  const prod = sim.parseSimulatorState({ search: '?sim=1&mockAnalyze=http-500' }, { DEV: false });
  expectEq('G1.production-inert', false, prod.allowed);
  expectEq('G1.production-inactive', false, prod.active);

  const dev = sim.parseSimulatorState({ search: '?sim=1' }, { DEV: true });
  expectEq('G2.dev-active', true, dev.active);

  const devIdle = sim.parseSimulatorState({ search: '' }, { DEV: true });
  expectEq('G3.dev-without-flags-inactive', false, devIdle.active);

  const staging = sim.parseSimulatorState({ search: '?dat=parent' }, { DEV: false, VITE_ENABLE_SIMULATOR: 'true' });
  expectEq('G4.staging-flag-active', true, staging.active);

  const mockDat = sim.parseSimulatorState({ search: '' }, { DEV: true, VITE_MOCK_DAT: 'true' });
  expectEq('G5.mock-dat-shows-badge', true, mockDat.active);
}

// ═══════════════════════════════════════════════════════════════════
console.log('\n=== Summary ===');
console.log(`PASS: ${passCount}`);
console.log(`FAIL: ${failCount}`);

if (failCount > 0) {
  console.error(`\n[FAIL] ${failCount} contract test(s) failed.`);
  process.exit(1);
} else {
  console.log('\n[OK] All contract tests passed.');
  process.exit(0);
}
