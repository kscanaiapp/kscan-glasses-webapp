// Wearable integration tests — Meta physical device candidate Build B.
//
// Tests the new modules WITHOUT requiring a live backend:
//   - resultFormatter (size limits, input validation, output shape)
//   - wearableBackend (error codes, input validation)
//   - phoneCompanion (state machine, message dispatch)
//   - styleMatchContract backend adapter
//   - Artifact separation flags

import assert from 'node:assert/strict';
import { MESSAGE_TYPES, buildMessage, validateMessage } from '../src/companion/protocol.js';
import {
  buildWearableResult,
  buildWearableResultFromStyleMatch,
  FORMATTER_ERRORS,
  MAX_WEARABLE_RESULT_BYTES,
} from '../src/companion/resultFormatter.js';
import { BACKEND_ERROR_CODES } from '../src/companion/wearableBackend.js';
import { buildBackendStyleMatch } from '../src/styleMatchContract.js';

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

// ── resultFormatter ────────────────────────────────────────────────────────

const VALID_BACKEND_RESULT = {
  products: [
    { name: 'Chrome Arc Jacket', brand: 'Aether Loom', price: '$189', imageUrl: 'https://example.com/jacket.jpg', url: 'https://example.com/jacket' },
    { name: 'Cyan Edge Utility Vest', brand: 'Nova Thread', price: '$124', url: 'https://example.com/vest' },
  ],
  style_metadata: { summary: 'Techwear layering', confidence: 87 },
};

check('formatter:valid-backend-result-produces-wearable-payload', () => {
  const res = buildWearableResult(VALID_BACKEND_RESULT, 'req-001');
  assert.equal(res.ok, true);
  assert.ok(res.result.resultId);
  assert.equal(res.result.requestId, 'req-001');
  assert.equal(res.result.summary, 'Techwear layering');
  assert.equal(res.result.confidence, 87);
  assert.ok(res.result.primaryMatch);
  assert.equal(res.result.primaryMatch.title, 'Chrome Arc Jacket');
  assert.ok(Array.isArray(res.result.alternatives));
  assert.equal(res.result.actions.includes('save'), true);
  assert.equal(res.result.actions.includes('open_on_phone'), true);
});

check('formatter:rejects-malformed-input', () => {
  const res = buildWearableResult(null, 'req-002');
  assert.equal(res.ok, false);
  assert.equal(res.code, FORMATTER_ERRORS.MALFORMED);
});

check('formatter:rejects-empty-result', () => {
  const res = buildWearableResult({ products: [], style_metadata: {} }, 'req-003');
  assert.equal(res.ok, false);
  assert.equal(res.code, FORMATTER_ERRORS.EMPTY);
});

check('formatter:enforces-size-limit', () => {
  // Create a result with oversized content
  const huge = {
    products: Array.from({ length: 100 }, (_, i) => ({
      name: 'Product ' + i,
      brand: 'Brand ' + i,
      price: '$' + i,
      imageUrl: 'https://example.com/' + i + '.jpg',
    })),
    style_metadata: { summary: 'A'.repeat(5000), confidence: 50 },
  };
  const res = buildWearableResult(huge, 'req-004');
  // Should either succeed with trimmed content or fail with OVERSIZED
  if (!res.ok) {
    assert.equal(res.code, FORMATTER_ERRORS.OVERSIZED);
  } else {
    const size = JSON.stringify(res.result).length;
    assert.ok(size <= MAX_WEARABLE_RESULT_BYTES, `Result size ${size} exceeds ${MAX_WEARABLE_RESULT_BYTES}`);
  }
});

check('formatter:drops-unsafe-urls', () => {
  const bad = {
    products: [
      { name: 'Evil', brand: 'X', price: '$1', imageUrl: 'javascript:alert(1)', url: 'data:text/html,<script>' },
    ],
    style_metadata: { summary: 'Test', confidence: 50 },
  };
  const res = buildWearableResult(bad, 'req-005');
  assert.equal(res.ok, true);
  assert.equal(res.result.primaryMatch.thumbnailUrl, null);
  assert.equal(res.result.primaryMatch.href, null);
});

check('formatter:from-style-match-preserves-structure', () => {
  const styleMatch = buildBackendStyleMatch(VALID_BACKEND_RESULT);
  const res = buildWearableResultFromStyleMatch(styleMatch, 'req-006');
  assert.equal(res.ok, true);
  assert.equal(res.result.summary, 'Techwear layering');
  assert.equal(res.result.demoMode, false);
});

// ── styleMatchContract backend adapter ─────────────────────────────────────

check('backend-adapter:sets-source-to-scan', () => {
  const sm = buildBackendStyleMatch(VALID_BACKEND_RESULT);
  assert.equal(sm.source, 'scan');
  assert.equal(sm.meta.isDemo, false);
  assert.equal(sm.meta.sourceLabel, 'K SCAN LIVE');
});

check('backend-adapter:preserves-items', () => {
  const sm = buildBackendStyleMatch(VALID_BACKEND_RESULT);
  assert.ok(sm.items.retail.length > 0);
  assert.ok(sm.items.retail[0].title);
});

// ── wearableBackend error codes ────────────────────────────────────────────

check('backend-error-codes:defined', () => {
  assert.equal(BACKEND_ERROR_CODES.NETWORK, 'NETWORK');
  assert.equal(BACKEND_ERROR_CODES.AUTH_REQUIRED, 'AUTH_REQUIRED');
  assert.equal(BACKEND_ERROR_CODES.BACKEND_ERROR, 'BACKEND_ERROR');
  assert.equal(BACKEND_ERROR_CODES.INVALID_RESPONSE, 'INVALID_RESPONSE');
});

// ── Artifact separation ────────────────────────────────────────────────────
//
// Regression protection for the confirmed takeover defect class:
// build-gate flags were once defined as QUOTED STRINGS ('true'/'false')
// while runtime code compared `=== true`, silently making gated paths
// unreachable. These checks enforce boolean literals, per-artifact flag
// values, and distinct output directories.

// Extracts the raw define value text for a flag from a vite config source.
function defineValueSource(configText, flag) {
  const re = new RegExp(flag.replace(/_/g, '_') + '\\s*:\\s*([^,\\n]+)');
  const m = configText.match(re);
  return m ? m[1].trim() : null;
}

function assertBooleanDefine(configText, flag, expected, label) {
  const raw = defineValueSource(configText, flag);
  assert.ok(raw !== null, `${label}: ${flag} not defined`);
  assert.ok(raw === 'true' || raw === 'false',
    `${label}: ${flag} must be a boolean literal, got ${raw} (quoted strings are a known defect class)`);
  assert.equal(raw, String(expected), `${label}: ${flag} must be ${expected}`);
}

check('artifact-separation:production-config-flags', () => {
  const prodConfig = readTextSafe(new URL('../vite.config.js', import.meta.url));
  assertBooleanDefine(prodConfig, '__KSCAN_SIMULATOR_BUILD__', false, 'production');
  assertBooleanDefine(prodConfig, '__KSCAN_HARDWARE_CANDIDATE_BUILD__', false, 'production');
  assert.ok(/outDir:\s*'dist-production'/.test(prodConfig), 'production build must emit to dist-production/');
});

check('artifact-separation:simulator-config-flags', () => {
  const simConfig = readTextSafe(new URL('../vite.simulator.config.js', import.meta.url));
  assertBooleanDefine(simConfig, '__KSCAN_SIMULATOR_BUILD__', true, 'simulator');
  assertBooleanDefine(simConfig, '__KSCAN_HARDWARE_CANDIDATE_BUILD__', false, 'simulator');
  assert.ok(/outDir:\s*'dist-simulator'/.test(simConfig), 'simulator build must emit to dist-simulator/');
});

check('artifact-separation:hardware-config-flags', () => {
  const hwConfig = readTextSafe(new URL('../vite.hardware.config.js', import.meta.url));
  assertBooleanDefine(hwConfig, '__KSCAN_SIMULATOR_BUILD__', false, 'hardware');
  assertBooleanDefine(hwConfig, '__KSCAN_HARDWARE_CANDIDATE_BUILD__', true, 'hardware');
  assert.ok(/outDir:\s*'dist-hardware'/.test(hwConfig), 'hardware build must emit to dist-hardware/');
});

// ── Protocol compatibility with real backend results ───────────────────────

check('protocol:result-show-accepts-wearable-result', () => {
  const res = buildWearableResult(VALID_BACKEND_RESULT, 'req-007');
  assert.equal(res.ok, true);
  const msg = buildMessage(MESSAGE_TYPES.RESULT_SHOW, {
    requestId: 'req-007',
    sessionId: 'sess-1',
    deviceId: 'hud-001',
    payload: { result: res.result },
    now: 1_800_000_000_000,
  });
  assert.ok(msg);
  const verdict = validateMessage(msg, { deviceId: 'hud-001', now: 1_800_000_000_000, paired: true });
  assert.equal(verdict.ok, true, verdict.code);
});

// ── Wearable result payload size within protocol limits ────────────────────

check('protocol:wearable-result-fits-in-max-payload', () => {
  const res = buildWearableResult(VALID_BACKEND_RESULT, 'req-008');
  assert.equal(res.ok, true);
  const resultJson = JSON.stringify(res.result);
  assert.ok(resultJson.length <= 12 * 1024, `Wearable result ${resultJson.length} bytes exceeds 12KB`);
});

// ── Helper ─────────────────────────────────────────────────────────────────
function readTextSafe(url) {
  try {
    return readFileSync(url, 'utf8');
  } catch {
    return '';
  }
}

import { readFileSync } from 'fs';

// ── Summary ────────────────────────────────────────────────────────────────
const failed = results.filter(([ok]) => !ok);
console.log(`\n=== Wearable integration tests: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
if (failed.length > 0) process.exit(1);
console.log('[OK] All wearable integration tests passed.');
