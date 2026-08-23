// Privacy boundary + backend containment tests (Node built-ins only).
// Usage: node scripts/privacy-tests.js
//
// WS8: the sanitizer stays fail-closed; raw captures never reach analyze,
// never persist, never appear in state/diagnostics/logs.
// WS9: live /api/analyze requires an explicit private-QA opt-in; default is
// fail-closed or honest mock; mock is never silent in production.

import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

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

// ── Window stub (before app module imports) ───────────────────────────────
const SELF_ORIGIN = 'http://localhost:5173';
const messageHandlers = new Set();
const parentStub = { postMessage() {} };
const windowStub = {
  location: { origin: SELF_ORIGIN, search: '' },
  parent: parentStub,
  addEventListener(type, handler) {
    if (type === 'message') messageHandlers.add(handler);
  },
  removeEventListener() {},
  __KSCAN_CONFIG__: {},
};
windowStub.window = windowStub;
globalThis.window = windowStub;

function dispatchMessage(data, overrides = {}) {
  const event = { origin: SELF_ORIGIN, source: parentStub, data, ...overrides };
  for (const handler of messageHandlers) handler(event);
}

const bridge = await import('../src/bridgeState.js');
const pipeline = await import('../src/scanPipeline.js');
const api = await import('../src/api.js');

const {
  initBridgeStateListener,
  getBridgeState,
  BRIDGE_STATUS,
  requestCapture,
  __bridgeTestHooks,
} = bridge;
const { runScanPipeline, PipelineInvariantError, PipelineCancelledError } = pipeline;
const {
  analyzeImage,
  AnalyzeError,
  ANALYZE_ERROR_CODES,
  isPrivateLiveAnalyzeEnabled,
  getAnalyzeMode,
} = api;

initBridgeStateListener();

const RAW_CAPTURE = 'data:image/png;base64,RAWCAPTUREDATA-UNSANITIZED-0123456789';
const VALID_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';

console.log('\n=== A. Bridge state never holds payload data ===');

// A1. success event: state stores metadata only, never the image string
{
  const pending = requestCapture();
  void pending.catch(() => {});
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({
    type: 'capture.success',
    requestId,
    image: RAW_CAPTURE,
    metadata: { width: 640, height: 640, size: 12345, timestamp: '2026-07-18T00:00:00Z' },
  });
  await pending;
  check('A1.bridge-state-metadata-only', () => {
    const snap = getBridgeState();
    assert.equal(snap.status, BRIDGE_STATUS.SUCCESS);
    assert.equal(JSON.stringify(snap).includes('data:image'), false, 'payload leaked into bridge state');
    assert.equal(JSON.stringify(snap).includes('RAWCAPTUREDATA'), false);
  });
}

// A2. error event: no payload in state
{
  const pending = requestCapture();
  void pending.catch(() => {});
  const requestId = __bridgeTestHooks.getPendingRequestId();
  dispatchMessage({ type: 'capture.error', requestId, error: 'Camera unavailable' });
  await pending.catch(() => {});
  check('A2.bridge-error-no-payload', () => {
    const snap = getBridgeState();
    assert.equal(JSON.stringify(snap).includes('data:image'), false);
  });
}

console.log('\n=== B. Pipeline invariant: analyze only sees sanitizer output ===');

// B1. injected steps: analyze must receive exactly the sanitizer output
{
  const seen = { capture: 0, sanitizeInput: null, analyzeInput: null };
  const { response } = await runScanPipeline({
    capture: async () => {
      seen.capture += 1;
      return RAW_CAPTURE;
    },
    sanitize: async (captured) => {
      seen.sanitizeInput = captured;
      return VALID_JPEG;
    },
    analyze: async (sanitized) => {
      seen.analyzeInput = sanitized;
      return { products: [] };
    },
  });
  check('B1.analyze-receives-sanitized-only', () => {
    assert.equal(seen.sanitizeInput, RAW_CAPTURE);
    assert.equal(seen.analyzeInput, VALID_JPEG);
    assert.equal(response.products.length, 0);
  });
}

// B2. fail-closed: non-JPEG sanitizer output blocks upload
{
  let analyzeCalled = false;
  let threw = null;
  try {
    await runScanPipeline({
      capture: async () => RAW_CAPTURE,
      sanitize: async () => 'data:image/png;base64,NOTAJPEG',
      analyze: async () => {
        analyzeCalled = true;
        return {};
      },
    });
  } catch (error) {
    threw = error;
  }
  check('B2.non-jpeg-output-blocks-analyze', () => {
    assert.ok(threw instanceof PipelineInvariantError);
    assert.equal(analyzeCalled, false, 'analyze must not run on invalid sanitizer output');
  });
}

// B3. fail-closed: sanitizer throw propagates, analyze never runs
{
  let analyzeCalled = false;
  let threw = null;
  try {
    await runScanPipeline({
      capture: async () => RAW_CAPTURE,
      sanitize: async () => {
        throw new Error('detector failed');
      },
      analyze: async () => {
        analyzeCalled = true;
        return {};
      },
    });
  } catch (error) {
    threw = error;
  }
  check('B3.sanitizer-failure-blocks-analyze', () => {
    assert.ok(threw !== null);
    assert.equal(analyzeCalled, false);
  });
}

// B4. cancel between sanitize and analyze must never invoke analyze
{
  let analyzeCalled = false;
  let stage = 0;
  let threw = null;
  try {
    await runScanPipeline({
      capture: async () => RAW_CAPTURE,
      sanitize: async () => VALID_JPEG,
      analyze: async () => {
        analyzeCalled = true;
        return {};
      },
      isCancelled: () => {
        stage += 1;
        // Cancel after sanitize completes (second cancelled() check).
        return stage >= 2;
      },
    });
  } catch (error) {
    threw = error;
  }
  check('B4.cancel-before-analyze-blocks-upload', () => {
    assert.ok(threw instanceof PipelineCancelledError);
    assert.equal(analyzeCalled, false, 'cancelled scans must never reach analyze');
  });
}

console.log('\n=== C. Static privacy guards (source) ===');

const sanitizerSrc = readFileSync('src/privacyImageSanitizer.js', 'utf8');
const mainSrc = readFileSync('src/main.js', 'utf8');
const bridgeSrc = readFileSync('src/bridgeState.js', 'utf8');

// C1. bridge scan path sanitizes before analyze (ordering in main.js)
check('C1.bridge-path-sanitizes-before-analyze', () => {
  const fnStart = mainSrc.indexOf('async function handleBridgeImage');
  assert.ok(fnStart > 0, 'handleBridgeImage missing');
  const body = mainSrc.slice(fnStart, fnStart + 1200);
  const sanitizeIdx = body.indexOf('sanitizeImageBeforeUpload(imageData)');
  const analyzeIdx = body.indexOf('analyzeImage(sanitized');
  assert.ok(sanitizeIdx > 0, 'bridge path missing sanitize step');
  assert.ok(analyzeIdx > sanitizeIdx, 'bridge path analyze must come after sanitize');
});

// C2. no raw-image fallback anywhere
check('C2.no-raw-upload-fallback', () => {
  for (const src of [mainSrc, bridgeSrc, sanitizerSrc]) {
    assert.equal(/ALLOW_RAW|RAW_UPLOAD|rawFallback|bypass.?sanitiz/i.test(src), false, 'raw fallback marker found');
  }
});

// C3. no payload persistence (localStorage/sessionStorage with image data)
check('C3.no-payload-persistence', () => {
  const bad = /(localStorage|sessionStorage)\.setItem\([^)]*(image|base64|payload|dataUrl)/i;
  assert.equal(bad.test(mainSrc), false, 'main.js persists payload');
  assert.equal(bad.test(bridgeSrc), false, 'bridgeState persists payload');
  assert.equal(bad.test(sanitizerSrc), false, 'sanitizer persists payload');
});

// C4. sanitizer is structurally fail-closed (re-encode + error throws)
check('C4.sanitizer-fail-closed-structure', () => {
  assert.ok(sanitizerSrc.includes('toDataURL'), 'canvas re-encode (EXIF removal) missing');
  assert.ok((sanitizerSrc.match(/throw new SanitizerError/g) || []).length >= 3, 'fail-closed throw paths missing');
});

// C5. diagnostics surfaces show no image data fields
check('C5.diagnostics-no-image-data', () => {
  const diagStart = mainSrc.indexOf('function renderDiagnostics');
  assert.ok(diagStart > 0);
  const diagBody = mainSrc.slice(diagStart, diagStart + 4000);
  assert.equal(/image|base64|dataUrl|token/i.test(diagBody.replace(/imageMetadata|lastError|Image Scan/g, '')), false,
    'diagnostics surface references payload-like fields');
});

console.log('\n=== D. Backend containment (WS9) ===');

// D1. live gate truth table
check('D1.live-gate-truth-table', () => {
  assert.equal(isPrivateLiveAnalyzeEnabled({}, {}), false);
  assert.equal(isPrivateLiveAnalyzeEnabled({ VITE_ENABLE_PRIVATE_LIVE_ANALYZE: 'false' }, {}), false);
  assert.equal(isPrivateLiveAnalyzeEnabled({ VITE_ENABLE_PRIVATE_LIVE_ANALYZE: 'true' }, {}), true);
  assert.equal(isPrivateLiveAnalyzeEnabled({}, { ENABLE_PRIVATE_LIVE_ANALYZE: true }), true);
});

// D2. analyze mode labels
check('D2.analyze-mode-labels', () => {
  assert.equal(getAnalyzeMode({}, {}), 'live-disabled');
  assert.equal(getAnalyzeMode({ VITE_ENABLE_PRIVATE_LIVE_ANALYZE: 'true' }, {}), 'private-live');
  assert.equal(getAnalyzeMode({ DEV: true, VITE_MOCK_ANALYZE: 'true' }, {}), 'mock');
  // Mock wins when both are configured — matches analyzeImage() precedence.
  assert.equal(
    getAnalyzeMode({ DEV: true, VITE_MOCK_ANALYZE: 'true', VITE_ENABLE_PRIVATE_LIVE_ANALYZE: 'true' }, {}),
    'mock',
  );
});

// D3. production-like env (no DEV, no flags): fail-closed LIVE_DISABLED
{
  windowStub.__KSCAN_CONFIG__ = {};
  let threw = null;
  try {
    await analyzeImage(VALID_JPEG + 'AAAA');
  } catch (error) {
    threw = error;
  }
  check('D3.default-fail-closed-live-disabled', () => {
    assert.ok(threw instanceof AnalyzeError);
    assert.equal(threw.code, ANALYZE_ERROR_CODES.LIVE_DISABLED);
  });
}

// D4. explicit private QA opt-in: live call proceeds against configured backend
{
  windowStub.__KSCAN_CONFIG__ = {
    ENABLE_PRIVATE_LIVE_ANALYZE: true,
    KSCAN_BACKEND_URL: 'https://backend.private-qa.test',
  };
  const calls = [];
  globalThis.fetch = async (endpoint, init) => {
    calls.push({ endpoint, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ products: [{ brand: 'QA', name: 'Item', price: '$1' }] }),
    };
  };
  const result = await analyzeImage(VALID_JPEG + 'AAAA');
  check('D4.private-live-opt-in-calls-backend', () => {
    assert.equal(calls.length >= 1, true, 'backend not called');
    assert.equal(calls[0].endpoint, 'https://backend.private-qa.test/api/analyze');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(typeof body.image, 'string');
    assert.ok(body.image.startsWith('data:image/jpeg;base64,'), 'payload must be the sanitized JPEG');
    assert.equal(result.products.length, 1);
  });
  delete globalThis.fetch;
  windowStub.__KSCAN_CONFIG__ = {};
}

// D5. short/invalid sanitized input fails closed before any network use
{
  windowStub.__KSCAN_CONFIG__ = {
    ENABLE_PRIVATE_LIVE_ANALYZE: true,
    KSCAN_BACKEND_URL: 'https://backend.private-qa.test',
  };
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  };
  let threw = null;
  try {
    await analyzeImage('tiny');
  } catch (error) {
    threw = error;
  }
  check('D5.invalid-input-blocks-network', () => {
    assert.ok(threw instanceof AnalyzeError);
    assert.equal(threw.code, ANALYZE_ERROR_CODES.INVALID_INPUT);
    assert.equal(fetchCalled, false, 'network must not be touched for invalid input');
  });
  delete globalThis.fetch;
  windowStub.__KSCAN_CONFIG__ = {};
}

console.log(`\n=== Privacy/containment summary: ${passCount} PASS / ${failCount} FAIL ===`);
if (failCount > 0) process.exit(1);
console.log('[OK] All privacy and containment tests passed.');
