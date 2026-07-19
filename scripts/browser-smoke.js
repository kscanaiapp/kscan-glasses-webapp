// Interactive browser smoke + reliability runner — hardware-validation
// candidate. Uses playwright-core with the locally installed Chromium.
// Serves the LOCAL QA simulator build (dist-simulator) and the production
// candidate build (dist) from local static servers and drives real D-pad /
// bridge interactions in a 600×600 viewport.
//
// Usage: node scripts/browser-smoke.js
// Requires: npm run build && npm run build:simulator first.
//
// Coverage:
//   - All WS14 bridge scenarios (success, missing image, invalid payload,
//     explicit error, timeout, late success, mismatched id, cancel, retry,
//     back/home, full flow) through the REAL trust + sanitizer path.
//   - Visible pipeline sequence (stepper never stuck).
//   - 600×600 containment and D-pad navigation.
//   - Production candidate truthfulness (LIVE DISABLED, URL tokens ignored).
//   - WS15 reliability loops (20 normal, 10 error/retry) + perf timings.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './resolve-chrome.js';

const SIM_PORT = 4617;
const PROD_PORT = 4618;
const HEADLESS_SHELL = resolveChromePath();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.json': 'application/json',
  '.map': 'application/json',
};

function serve(root, port) {
  const absoluteRoot = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = join(absoluteRoot, path);
      if (!file.startsWith(absoluteRoot) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('error');
    }
  });
  return new Promise((resolveServer) => {
    server.listen(port, '127.0.0.1', () => resolveServer(server));
  });
}

// ── Result accounting ─────────────────────────────────────────────────────
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ` | ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    record(name, false, String(error && error.message ? error.message : error).slice(0, 200));
  }
}

const perf = {
  coldInputToProcessingMs: null,
  inputToProcessingMs: [],
  requestToCapturingMs: [],
  warmScanToResultsMs: [],
  firstScanMs: null,
  errorToRetryMs: [],
  cancelToHomeMs: [],
};

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { n: values.length, median: Math.round(median), p95: Math.round(p95), min: Math.round(sorted[0]), max: Math.round(sorted[sorted.length - 1]) };
}

// ── Browser helpers ───────────────────────────────────────────────────────
async function activeScreen(page) {
  return page.evaluate(() => {
    const el = document.querySelector('section.screen:not(.hidden)');
    return el ? el.id : 'none';
  });
}

async function stepperState(page) {
  return page.evaluate(() => {
    const steps = Array.from(document.querySelectorAll('#pipeline-steps .pipeline-step'));
    return steps.map((li) => `${li.textContent}${li.classList.contains('active') ? '*' : li.classList.contains('done') ? '✓' : ''}`);
  });
}

async function bridgeBadge(page) {
  return page.evaluate(() => document.getElementById('bridge-status')?.textContent || '');
}

async function installBridgeDriver(page) {
  await page.evaluate(() => {
    const drive = {
      lastRequestId: null,
      fixture: null,
    };
    window.__kscanDrive = drive;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.type === 'capture.request' && typeof data.requestId === 'string') {
        drive.lastRequestId = data.requestId;
      }
    });
  });
}

async function drive(page, kind, options = {}) {
  return page.evaluate(({ kind: k, opts }) => {
    const drive = window.__kscanDrive;
    if (!drive.fixture) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 640;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 640, 640);
      gradient.addColorStop(0, '#1B2430');
      gradient.addColorStop(1, '#3A4B5C');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 640, 640);
      ctx.fillStyle = '#0E141B';
      for (let i = 0; i < 12; i += 1) ctx.fillRect(i * 54, 100 + (i % 3) * 120, 30, 90);
      ctx.fillStyle = '#8FA7BC';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('SYNTHETIC FIXTURE', 150, 80);
      drive.fixture = canvas.toDataURL('image/jpeg', 0.85);
    }
    const rid = drive.lastRequestId;
    const metadata = { timestamp: new Date().toISOString(), size: 123456, width: 640, height: 640 };
    const post = (message) => window.postMessage(message, window.location.origin);
    switch (k) {
      case 'capturing':
        post({ type: 'capture.capturing' });
        return { posted: 'capturing', rid };
      case 'success':
        post({ type: 'capture.success', requestId: rid, image: drive.fixture, metadata });
        return { posted: 'success', rid };
      case 'success-no-image':
        post({ type: 'capture.success', requestId: rid, metadata });
        return { posted: 'success-no-image', rid };
      case 'invalid':
        post({ type: 'capture.success', requestId: rid, image: 'not-a-data-url', metadata });
        return { posted: 'invalid', rid };
      case 'error':
        post({ type: 'capture.error', requestId: rid, error: 'Camera unavailable' });
        return { posted: 'error', rid };
      case 'stale-id':
        post({ type: 'capture.success', requestId: 'capture-stale-999', image: drive.fixture, metadata });
        return { posted: 'stale-id', rid };
      case 'late-success':
        post({ type: 'capture.success', requestId: opts.requestId, image: drive.fixture, metadata });
        return { posted: 'late-success', rid: opts.requestId };
      default:
        throw new Error(`unknown drive kind ${k}`);
    }
  }, { kind, opts: options });
}

// Wait until the app has posted a NEW capture.request (fresh requestId) —
// the processing screen appears before requestCapture() posts, so driving
// against the previous rid races and gets correctly dropped as stale.
async function waitFreshRid(page, prevRid, timeout = 5000) {
  await page.waitForFunction((prev) => {
    const d = window.__kscanDrive;
    return d && typeof d.lastRequestId === 'string' && d.lastRequestId.length > 0 && d.lastRequestId !== prev;
  }, prevRid, { timeout });
}

async function currentRid(page) {
  return page.evaluate(() => (window.__kscanDrive ? window.__kscanDrive.lastRequestId : null));
}

async function clickScan(page) {
  const prevRid = await currentRid(page);
  const t0 = Date.now();
  await page.click('#scan-btn');
  await page.waitForFunction(() => {
    const el = document.querySelector('section.screen:not(.hidden)');
    return el && el.id === 'processing';
  }, { timeout: 3000 });
  const inputMs = Date.now() - t0;
  await waitFreshRid(page, prevRid);
  return inputMs;
}

async function clickRetryScan(page) {
  const prevRid = await currentRid(page);
  await page.click('#error-retry-btn');
  await waitScreen(page, 'processing', 3000);
  await waitFreshRid(page, prevRid);
}

async function waitScreen(page, id, timeout = 15000) {
  await page.waitForFunction((screenId) => {
    const el = document.querySelector('section.screen:not(.hidden)');
    return el && el.id === screenId;
  }, id, { timeout });
}

async function noOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollW: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
      scrollH: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
    };
  });
}

async function brokenImages(page) {
  return page.evaluate(() => Array.from(document.images).filter((img) => img.complete && img.naturalWidth === 0).length);
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  if (!HEADLESS_SHELL || !existsSync(HEADLESS_SHELL)) {
    console.error('Chromium not found. Set KSCAN_CHROME_PATH or run: npx playwright-core install chromium');
    process.exit(2);
  }
  if (!existsSync('dist-simulator/index.html') || !existsSync('dist/index.html')) {
    console.error('dist/ and dist-simulator/ must exist — run builds first.');
    process.exit(1);
  }

  const simServer = await serve('dist-simulator', SIM_PORT);
  const prodServer = await serve('dist', PROD_PORT);

  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL });

  const consoleErrors = [];
  const pageErrors = [];

  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      // Benign infrastructure noise: headless Chromium routes TF Lite's
      // informational XNNPACK delegate log to the console error channel.
      if (/INFO: Created TensorFlow Lite XNNPACK delegate/.test(msg.text())) return;
      consoleErrors.push(msg.text().slice(0, 160));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)));
    return page;
  }

  const SIM_URL = `http://127.0.0.1:${SIM_PORT}/index.html?mode=hardware`;
  const PROD_URL = `http://127.0.0.1:${PROD_PORT}/index.html?mode=hardware`;

  // ── Scenario 1: full bridge → privacy → analyze(mock) → Results ─────────
  console.log('\n=== S1. Full bridge flow (first scan, includes model load) ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);

    const firstT0 = Date.now();
    const inputMs = await clickScan(page);
    perf.coldInputToProcessingMs = inputMs; // cold single sample — reported, gated in L1 warm loop

    const reqT0 = Date.now();
    await drive(page, 'capturing');
    perf.requestToCapturingMs.push(Date.now() - reqT0);
    const capturingSteps = await stepperState(page);

    await drive(page, 'success');
    // Privacy step should activate next
    let sawPrivacy = false;
    let sawAnalyze = false;
    try {
      await page.waitForFunction(() => {
        const steps = Array.from(document.querySelectorAll('#pipeline-steps .pipeline-step'));
        return steps[1] && steps[1].classList.contains('active');
      }, { timeout: 15000 });
      sawPrivacy = true;
    } catch { /* model may be slow */ }
    try {
      await page.waitForFunction(() => {
        const steps = Array.from(document.querySelectorAll('#pipeline-steps .pipeline-step'));
        return (steps[1] && steps[1].classList.contains('done')) || (steps[2] && steps[2].classList.contains('active'));
      }, { timeout: 15000 });
      sawAnalyze = true;
    } catch { /* record below */ }

    await waitScreen(page, 'results', 20000);
    perf.firstScanMs = Date.now() - firstT0;

    const resultCards = await page.locator('#results-list .product-card').count();
    const steps = await stepperState(page);
    const broken = await brokenImages(page);
    const overflow = await noOverflow(page);

    // Cold includes first MediaPipe model load. Authoritative warm gate is L1b
    // (p95 ≤250ms). Fail only on catastrophic cold stalls, not host noise.
    await check('S1a.input-to-processing-cold<=5000ms', () => assert.ok(inputMs <= 5000, `${inputMs}ms (cold sanity; warm gate is L1b)`));
    await check('S1b.bridge-request-to-capturing<=1s', () => assert.ok(perf.requestToCapturingMs[0] <= 1000, `${perf.requestToCapturingMs[0]}ms`));
    await check('S1c.capture-step-visible', () => assert.ok(capturingSteps[0] && capturingSteps[0].startsWith('Capture'), capturingSteps.join(',')));
    await check('S1d.privacy-step-reached', () => assert.ok(sawPrivacy, 'privacy step never activated'));
    await check('S1e.analyze-step-reached', () => assert.ok(sawAnalyze, 'analyze step never activated'));
    await check('S1f.results-rendered', () => assert.ok(resultCards > 0, `${resultCards} cards`));
    await check('S1g.first-scan<=12s', () => assert.ok(perf.firstScanMs <= 12000, `${perf.firstScanMs}ms`));
    await check('S1h.no-broken-images', () => assert.equal(broken, 0));
    await check('S1i.600x600-no-overflow', () => assert.ok(overflow.scrollW <= 600 && overflow.scrollH <= 600, JSON.stringify(overflow)));
    await check('S1j.stepper-not-stuck', () => assert.ok(steps.length === 0 || steps.every((s) => !s.includes('*')), steps.join(',')));
    await page.close();
  }

  // ── Scenario 2: success with missing image payload ──────────────────────
  console.log('\n=== S2. Success missing image ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    await drive(page, 'capturing');
    await drive(page, 'success-no-image');
    await waitScreen(page, 'error', 8000);
    const msg = await page.locator('#error-message').textContent();
    const t0 = Date.now();
    await page.focus('#error-retry-btn');
    const retryFocusable = await page.evaluate(() => document.activeElement && document.activeElement.id === 'error-retry-btn');
    perf.errorToRetryMs.push(Date.now() - t0);
    await check('S2a.missing-image-fails-closed', () => assert.ok(/read image|Couldn't read/i.test(msg || ''), msg));
    await check('S2b.retry-reachable<=1s', () => assert.ok(retryFocusable && perf.errorToRetryMs.at(-1) <= 1000));
    await page.close();
  }

  // ── Scenario 3: invalid payload ─────────────────────────────────────────
  console.log('\n=== S3. Invalid payload ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    await drive(page, 'invalid');
    await waitScreen(page, 'error', 8000);
    const msg = await page.locator('#error-message').textContent();
    await check('S3.invalid-payload-error', () => assert.ok(/read image|Couldn't read/i.test(msg || ''), msg));
    await page.close();
  }

  // ── Scenario 4: explicit capture error + retry recovery ─────────────────
  console.log('\n=== S4. Explicit capture error → retry → success ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    await drive(page, 'error');
    await waitScreen(page, 'error', 8000);
    const msg = await page.locator('#error-message').textContent();
    await check('S4a.capture-error-shown', () => assert.ok(/Capture failed/i.test(msg || ''), msg));
    // retry
    await clickRetryScan(page);
    await drive(page, 'capturing');
    await drive(page, 'success');
    await waitScreen(page, 'results', 20000);
    await check('S4b.retry-after-error-works', () => assert.ok(true));
    // back home — measure until #home is visible (not Playwright poll slack)
    const backMs = await page.evaluate(async () => {
      const t0 = performance.now();
      document.getElementById('results-back-btn')?.click();
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 3000;
        const tick = () => {
          const el = document.getElementById('home');
          if (el && !el.classList.contains('hidden')) { resolve(); return; }
          if (performance.now() > deadline) { reject(new Error('home not visible')); return; }
          requestAnimationFrame(tick);
        };
        tick();
      });
      return Math.round(performance.now() - t0);
    });
    perf.cancelToHomeMs.push(backMs);
    await waitScreen(page, 'home', 3000);
    await check('S4c.back-to-home<=500ms', () => assert.ok(backMs <= 500, `${backMs}ms`));
    await page.close();
  }

  // ── Scenario 5: timeout (real 10s) + late success after timeout ─────────
  console.log('\n=== S5. Timeout + late success ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    const pendingRid = (await drive(page, 'capturing')).rid;
    await waitScreen(page, 'error', 15000); // 10s scaffold timeout
    const msg = await page.locator('#error-message').textContent();
    await check('S5a.timeout-error', () => assert.ok(/Unable to capture/i.test(msg || ''), msg));
    // late success for the dead request — must be dropped
    await drive(page, 'late-success', { requestId: pendingRid });
    await page.waitForTimeout(500);
    const screen = await activeScreen(page);
    await check('S5b.late-success-after-timeout-dropped', () => assert.equal(screen, 'error'));
    // retry works after timeout
    await clickRetryScan(page);
    await drive(page, 'capturing');
    await drive(page, 'success');
    await waitScreen(page, 'results', 20000);
    await check('S5c.retry-after-timeout-works', () => assert.ok(true));
    await page.close();
  }

  // ── Scenario 6: mismatched request id ───────────────────────────────────
  console.log('\n=== S6. Mismatched request id ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    await drive(page, 'capturing');
    await drive(page, 'stale-id');
    await page.waitForTimeout(600);
    const screenAfterStale = await activeScreen(page);
    const badge = await bridgeBadge(page);
    await check('S6a.mismatched-id-ignored', () => {
      assert.equal(screenAfterStale, 'processing');
      assert.ok(!/SUCCESS/.test(badge), badge);
    });
    await drive(page, 'success');
    await waitScreen(page, 'results', 20000);
    await check('S6b.correct-id-completes', () => assert.ok(true));
    await page.close();
  }

  // ── Scenario 7: cancel while pending + late success after cancel ────────
  console.log('\n=== S7. Cancel while pending ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    const pendingRid = (await drive(page, 'capturing')).rid;
    const t0 = Date.now();
    await page.click('#cancel-btn');
    await waitScreen(page, 'home', 3000);
    perf.cancelToHomeMs.push(Date.now() - t0);
    await check('S7a.cancel-settles-to-home<=500ms', () => assert.ok(perf.cancelToHomeMs.at(-1) <= 500, `${perf.cancelToHomeMs.at(-1)}ms`));
    await drive(page, 'late-success', { requestId: pendingRid });
    await page.waitForTimeout(500);
    const screen = await activeScreen(page);
    const badgeAfter = await bridgeBadge(page);
    await check('S7b.late-success-after-cancel-dropped', () => {
      assert.equal(screen, 'home');
      assert.ok(!/SUCCESS/.test(badgeAfter), badgeAfter);
    });
    // immediate retry after cancel
    await clickScan(page);
    await drive(page, 'capturing');
    await drive(page, 'success');
    await waitScreen(page, 'results', 20000);
    await check('S7c.retry-after-cancel-works', () => assert.ok(true));
    await page.close();
  }

  // ── Scenario 8: Back (ArrowLeft) while pending ──────────────────────────
  console.log('\n=== S8. ArrowLeft back while pending ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    await drive(page, 'capturing');
    const t0 = Date.now();
    await page.keyboard.press('ArrowLeft');
    await waitScreen(page, 'home', 3000);
    perf.cancelToHomeMs.push(Date.now() - t0);
    await check('S8.back-while-pending<=500ms', () => assert.ok(perf.cancelToHomeMs.at(-1) <= 500, `${perf.cancelToHomeMs.at(-1)}ms`));
    await page.close();
  }

  // ── Scenario 9: D-pad navigation + focus visibility ─────────────────────
  console.log('\n=== S9. D-pad navigation ===');
  {
    const page = await newPage();
    // Hardware mode keeps the scan pending in processing (bridge waits for a
    // capture response), so Enter→processing and Escape→cancel are testable.
    await page.goto(SIM_URL, { waitUntil: 'load' });
    // initial focus on scan button
    const initialFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
    const focusVisible = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    });
    await check('S9a.dpad-moves-focus', () => {
      assert.ok(initialFocus, 'no initial focus');
      assert.notEqual(afterDown, initialFocus, `${initialFocus} → ${afterDown}`);
    });
    await check('S9b.focus-visible', () => assert.ok(focusVisible));
    // Enter activates focused control → navigate somewhere and come back
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await waitScreen(page, 'processing', 3000);
    await page.keyboard.press('Escape');
    await waitScreen(page, 'home', 3000);
    await check('S9c.enter-activates-escape-returns', () => assert.ok(true));
    // Settings reachable by keyboard — walk the D-pad until settings-btn is
    // focused (preset count varies; do not hardcode a fixed number of presses)
    for (let i = 0; i < 12; i += 1) {
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      if (focused === 'settings-btn') break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    const screen = await activeScreen(page);
    await check('S9d.settings-reachable-by-dpad', () => assert.equal(screen, 'settings'));
    const overflow = await noOverflow(page);
    await check('S9e.settings-fits-600x600', () => assert.ok(overflow.scrollW <= 600 && overflow.scrollH <= 600, JSON.stringify(overflow)));
    await page.close();
  }

  // ── Scenario 10: production candidate truthfulness ──────────────────────
  console.log('\n=== S10. Production candidate (dist/) truthfulness ===');
  {
    const page = await newPage();
    await page.goto(PROD_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    await clickScan(page);
    await drive(page, 'capturing');
    await drive(page, 'success');
    await waitScreen(page, 'error', 20000);
    const msg = await page.locator('#error-message').textContent();
    await check('S10a.prod-live-disabled-honest', () => assert.ok(/Live analysis disabled/i.test(msg || ''), msg));
    await page.close();
  }
  {
    const page = await newPage();
    await page.goto(`http://127.0.0.1:${PROD_PORT}/index.html?access_token=fake-token&refresh_token=fake-refresh`, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    const pill = await page.locator('#pill-session span').textContent();
    const urlAfter = page.url();
    await check('S10b.prod-url-tokens-ignored', () => {
      assert.ok(/Required/.test(pill || ''), pill);
      assert.ok(urlAfter.includes('access_token'), 'production must not even read+scrub URL tokens');
    });
    await page.close();
  }

  // ── Reliability loops (WS15) ────────────────────────────────────────────
  console.log('\n=== L1. 20 consecutive normal scan flows ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    let failures = 0;
    for (let i = 0; i < 20; i += 1) {
      try {
        const t0 = Date.now();
        const inputMs = await clickScan(page);
        perf.inputToProcessingMs.push(inputMs);
        await drive(page, 'capturing');
        await drive(page, 'success');
        await waitScreen(page, 'results', 20000);
        perf.warmScanToResultsMs.push(Date.now() - t0);
        const cards = await page.locator('#results-list .product-card').count();
        if (cards === 0) throw new Error('no result cards');
        const steps = await stepperState(page);
        if (steps.some((s) => s.includes('*'))) throw new Error(`stepper stuck: ${steps.join(',')}`);
        await page.click('#results-back-btn');
        await waitScreen(page, 'home', 3000);
      } catch (error) {
        failures += 1;
        console.log(`loop ${i + 1} failed: ${String(error && error.message ? error.message : error).slice(0, 120)}`);
        await page.goto(SIM_URL, { waitUntil: 'load' });
        await installBridgeDriver(page);
      }
    }
    await check('L1.20-normal-flows-zero-failures', () => assert.equal(failures, 0));
    await check('L1b.warm-input-to-processing-p95<=250ms', () => {
      const s = stats(perf.inputToProcessingMs);
      assert.ok(s && s.p95 <= 250, JSON.stringify(s));
    });
    await page.close();
  }

  console.log('\n=== L2. 10 consecutive error/retry cycles ===');
  {
    const page = await newPage();
    await page.goto(SIM_URL, { waitUntil: 'load' });
    await installBridgeDriver(page);
    let failures = 0;
    for (let i = 0; i < 10; i += 1) {
      try {
        await clickScan(page);
        await drive(page, 'error');
        await waitScreen(page, 'error', 8000);
        const t0 = Date.now();
        await page.focus('#error-retry-btn');
        perf.errorToRetryMs.push(Date.now() - t0);
        await clickRetryScan(page);
        await drive(page, 'capturing');
        await drive(page, 'success');
        await waitScreen(page, 'results', 20000);
        await page.click('#results-back-btn');
        await waitScreen(page, 'home', 3000);
      } catch (error) {
        failures += 1;
        console.log(`error loop ${i + 1} failed: ${String(error && error.message ? error.message : error).slice(0, 120)}`);
        await page.goto(SIM_URL, { waitUntil: 'load' });
        await installBridgeDriver(page);
      }
    }
    await check('L2.10-error-retry-cycles-zero-failures', () => assert.equal(failures, 0));
    await page.close();
  }

  // ── Hygiene: console/page errors ────────────────────────────────────────
  await check('H1.no-page-errors', () => assert.equal(pageErrors.length, 0, pageErrors.join(' | ')));
  await check('H2.no-console-errors', () => assert.equal(consoleErrors.length, 0, consoleErrors.slice(0, 3).join(' | ')));

  await Promise.race([
    browser.close(),
    new Promise((r) => { setTimeout(r, 5000); }),
  ]);
  simServer.close();
  prodServer.close();

  // ── Summary ─────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════════════════');
  console.log(`Browser scenarios: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
  console.log('\nPerformance (local QA, mock analyze, headless Chromium):');
  console.log(`  input→processing:    cold=${perf.coldInputToProcessingMs}ms; warm=${JSON.stringify(stats(perf.inputToProcessingMs))} (target p95 ≤250ms)`);
  console.log(`  request→capturing:   ${JSON.stringify(stats(perf.requestToCapturingMs))} (target ≤1000ms)`);
  console.log(`  first scan (models): ${perf.firstScanMs}ms (target ≤12000ms)`);
  console.log(`  warm scan→results:   ${JSON.stringify(stats(perf.warmScanToResultsMs))} (targets median ≤5000ms, p95 ≤8000ms)`);
  console.log(`  error→retry usable:  ${JSON.stringify(stats(perf.errorToRetryMs))} (target ≤1000ms)`);
  console.log(`  cancel/back→stable:  ${JSON.stringify(stats(perf.cancelToHomeMs))} (target ≤500ms)`);

  if (failed.length > 0) process.exit(1);
  console.log('\n[OK] All interactive browser scenarios passed.');
}

main().catch((error) => {
  console.error('browser-smoke fatal:', error);
  process.exit(1);
});
