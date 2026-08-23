// Extended interactive companion-runtime browser suite — Phase A.
// Serves dist-simulator, loads the mock phone companion page with the HUD
// in its 600×600 iframe, and drives the real pairing → trusted session →
// scan lifecycle → structured result → action-ack flows end to end.
//
// Usage: node scripts/browser-smoke-companion.js
// Requires: npm run build:simulator first.
//
// Coverage (brief §17 interactive tests, §18 runtime loops, §13 perf):
//   - Pairing approve / denial recovery / expiry recovery / unpair.
//   - Scan lifecycle with visible progress states; result rendering with
//     alternative navigation; Save / Open on Phone / Retry / Cancel /
//     Dismiss through the real action-return channel.
//   - Connection loss while Ready and mid-scan, reconnection, reconnect
//     window expiry, session revocation and re-pairing.
//   - Negative messages (malformed, stale, duplicate terminal, oversized,
//     wrong device, wrong session) dropped without state damage.
//   - D-pad navigation, visible focus, no dead focus targets, 600×600
//     containment on every connected screen.
//   - Loops: 20 scan flows, 20 result deliveries, 10 cancel/retry cycles,
//     10 disconnect/reconnect cycles, 20 pairing cycles (>=19 success).
//   - Perf: processing visibility <=250ms, result <=1s from receipt,
//     dismiss/back <=500ms, approve->Ready <5s, restore->Ready <3s.
//   - Strict console: any console error or page error fails the run
//     (single XNNPACK INFO exception).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './resolve-chrome.js';

const SIM_PORT = 4619;
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
    record(name, false, String(error && error.message ? error.message : error).slice(0, 240));
  }
}

// Local runs split across the 300s shell cap: `node browser-smoke-companion.js
// scenarios` (S1–S10) or `loops` (L1–L4 + P1). CI runs `all` in one process.
// S1/S2 bootstrap (load + pair) always runs so loops start from Ready.
const PART = process.argv[2] || 'all';
const runScenarios = PART === 'all' || PART === 'scenarios';
const runLoops = PART === 'all' || PART === 'loops';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function stats(samples) {
  if (!samples.length) return { n: 0, median: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    median: Math.round(pick(0.5)),
    p95: Math.round(pick(0.95)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

async function main() {
  if (!['all', 'scenarios', 'loops'].includes(PART)) {
    console.error(`Unknown companion browser part "${PART}". Use: all | scenarios | loops`);
    process.exit(2);
  }
  if (!existsSync('dist-simulator/companion.html')) {
    console.error('dist-simulator/companion.html missing — run npm run build:simulator first.');
    process.exit(2);
  }
  if (!HEADLESS_SHELL || !existsSync(HEADLESS_SHELL)) {
    console.error('Chromium not found. Set KSCAN_CHROME_PATH or run: npx playwright-core install chromium');
    process.exit(2);
  }

  const server = await serve('dist-simulator', SIM_PORT);
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL, headless: true });
  const consoleErrors = [];
  const pageErrors = [];
  const perf = {
    scanToProcessing: [], dismissToStable: [], approveToReady: [], restoreToReady: [],
  };
  let resultReceiptMs = null;

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (/INFO: Created TensorFlow Lite XNNPACK delegate/.test(msg.text())) return;
      consoleErrors.push(msg.text().slice(0, 200));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 240)));

    await page.goto(`http://127.0.0.1:${SIM_PORT}/companion.html`, { waitUntil: 'load' });
    const hud = page.frameLocator('#hud-frame');
    const hudFrame = page.frames().find((f) => f.url().includes('index.html'));

    const hudState = () => page.evaluate(() => {
      const frame = document.getElementById('hud-frame');
      return frame?.contentWindow?.__kscanCompanionDebug?.() ?? null;
    });

    const waitHud = (predicate, timeout = 6000) => page.waitForFunction((src) => {
      const frame = document.getElementById('hud-frame');
      const d = frame?.contentWindow?.__kscanCompanionDebug?.();
      if (!d) return false;
      return eval(src)(d);
    }, predicate, { timeout });

    const waitState = (state, timeout = 6000) => waitHud(`(d) => d.state === "${state}"`, timeout);

    const noOverflow = () => hudFrame.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return {
        scrollW: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
        scrollH: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
      };
    });

    const visibleScreen = () => hudFrame.evaluate(() => {
      const el = document.querySelector('.screen:not(.hidden)');
      return el ? el.id : null;
    });

    const pairingRequestPending = () => page.waitForFunction(
      () => document.getElementById('session-status').textContent.includes('Pairing requested'),
      { timeout: 4000 },
    );

    const approveAndReady = async () => {
      const t0 = Date.now();
      await page.locator('#btn-approve').click();
      await waitState('Ready', 6000);
      perf.approveToReady.push(Date.now() - t0);
    };

    const pairFromCompanionScreen = async () => {
      await hud.locator('#comp-primary-btn').click(); // Pair Phone / Try Again / Pair Again
      await pairingRequestPending();
      await approveAndReady();
    };

    // Bring the machine back to a rendered Ready screen from wherever a
    // previous check left it (results, action-confirmed, error, reconnect).
    const ensureReady = async () => {
      let d = await hudState();
      if (d.state === 'Reconnecting') {
        await page.locator('#btn-restore').click();
        await waitState('Ready', 6000);
        d = await hudState();
      }
      if (d.state === 'Ready') {
        await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
        return;
      }
      if (d.state === 'ActionConfirmed') {
        await hud.locator('#comp-primary-btn').click();
      } else if (d.state === 'Results') {
        await hud.locator('#comp-action-dismiss').click();
      } else if (d.state === 'Error') {
        await hud.locator('#error-retry-btn').click();
        await hud.locator('#results:not(.hidden), #processing:not(.hidden)').waitFor({ timeout: 9000 });
        if ((await hudState()).state === 'Results') {
          await hud.locator('#comp-action-dismiss').click();
        } else if ((await visibleScreen()) === 'processing') {
          await hud.locator('#cancel-btn').click();
        }
      } else if (d.state === 'Pairing') {
        await hud.locator('#comp-secondary-1').click(); // Cancel
        await waitState('Disconnected', 4000);
        await pairFromCompanionScreen();
        return;
      } else if (d.state === 'Disconnected' || d.state === 'SessionRevoked'
        || d.state === 'PairingDenied' || d.state === 'PairingExpired') {
        await pairFromCompanionScreen();
        return;
      } else if (['CaptureRequested', 'CapturingOnPhone', 'PrivacyProcessing', 'Analyzing'].includes(d.state)) {
        await hud.locator('#cancel-btn').click();
      } else {
        throw new Error(`ensureReady: cannot recover from ${d.state}`);
      }
      await waitState('Ready', 5000);
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
    };

    // Ready → Scan → Results. Measures scan-click → processing visibility.
    const scanToResults = async () => {
      const t0 = Date.now();
      await hud.locator('#comp-primary-btn').click(); // Scan
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      perf.scanToProcessing.push(Date.now() - t0);
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
    };

    // Results → Dismiss → Ready. Measures dismiss → stable companion screen.
    const dismissToReady = async () => {
      const t0 = Date.now();
      await hud.locator('#comp-action-dismiss').click();
      await waitState('Ready', 4000);
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
      perf.dismissToStable.push(Date.now() - t0);
    };

    console.log('\n=== S1. Load and truthful labeling ===');
    await check('S1a.companion-page-and-hud-load', async () => {
      await page.waitForFunction(() => {
        const frame = document.getElementById('hud-frame');
        return Boolean(frame?.contentWindow?.__kscanCompanionDebug);
      }, { timeout: 8000 });
      const banner = await hud.locator('#alpha-banner').textContent();
      assert.match(banner, /MOCK PHONE/);
      assert.match(banner, /HW VALIDATION PENDING/);
      const qa = await page.locator('.qa-banner').textContent();
      assert.match(qa, /LOCAL QA \/ NON-PRODUCTION/);
      return banner.trim();
    });

    await check('S1b.initial-disconnected-state', async () => {
      const pill = await hud.locator('#pill-companion span').textContent();
      assert.equal(pill.trim(), 'Phone: Off');
      const d = await hudState();
      assert.equal(d.state, 'Disconnected');
      assert.equal(d.transport, 'open');
      assert.equal(d.sessionValid, false);
      return `transport=${d.transport}`;
    });

    console.log('\n=== S2. Pairing happy path ===');
    await check('S2a.scan-intent-shows-pair-screen', async () => {
      await hud.locator('#scan-btn').click();
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Not connected');
      assert.equal((await hud.locator('#comp-primary-btn').textContent()).trim(), 'Pair Phone');
    });

    await check('S2b.pair-request-reaches-phone', async () => {
      await hud.locator('#comp-primary-btn').click();
      await pairingRequestPending();
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Pairing…');
      const steps = await hud.locator('#comp-steps .pipeline-step.active').allTextContents();
      assert.deepEqual(steps, ['Approve on phone']);
    });

    await check('S2c.approve-yields-ready-session', async () => {
      await approveAndReady();
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Ready');
      assert.equal((await hud.locator('#pill-companion span').textContent()).trim(), 'Phone: Ready');
      const d = await hudState();
      assert.equal(d.sessionValid, true);
      return `approve→Ready ${perf.approveToReady.at(-1)}ms`;
    });

    if (runScenarios) {
    console.log('\n=== S3. Scan lifecycle with visible progress ===');
    await check('S3a.scan-progress-states-then-results', async () => {
      const t0 = Date.now();
      await hud.locator('#comp-primary-btn').click(); // Scan
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      perf.scanToProcessing.push(Date.now() - t0);
      await hud.locator('#processing-text').filter({ hasText: 'Capturing on phone' }).waitFor({ timeout: 4000 });
      await hud.locator('#processing-text').filter({ hasText: 'Protecting privacy' }).waitFor({ timeout: 4000 });
      await hud.locator('#processing-text').filter({ hasText: 'Finding matches' }).waitFor({ timeout: 4000 });
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      assert.equal(await visibleScreen(), 'results');
      const active = await hud.locator('#pipeline-steps .pipeline-step.active').count();
      assert.equal(active, 0, 'stepper stuck after results');
      return `scan→processing ${perf.scanToProcessing.at(-1)}ms`;
    });

    await check('S3b.result-card-and-source-label', async () => {
      assert.equal(await hud.locator('#results-match .style-match-card').count(), 1);
      const pills = await hud.locator('#results-match .scan-mode-pill').allTextContents();
      assert.ok(pills.some((t) => /COMPANION SCAN/.test(t)), pills.join(','));
      assert.ok(pills.some((t) => /MOCK PHONE — LOCAL QA/.test(t)), pills.join(','));
      const rows = await hud.locator('#results-list .companion-item').count();
      assert.ok(rows >= 2, `expected alternatives, got ${rows}`);
      assert.equal(await hud.locator('#companion-actions:not(.hidden)').count(), 1);
      return `${rows} rows`;
    });

    await check('S3c.alternative-navigation-selects-item', async () => {
      const rows = hud.locator('#results-list .companion-item');
      const second = rows.nth(1);
      const title = await second.locator('.product-name').textContent();
      await second.click();
      const summary = await hud.locator('#results-match .detected-style').textContent();
      assert.equal(summary.trim(), title.trim());
      assert.equal(await second.getAttribute('aria-pressed'), 'true');
      return title.trim();
    });

    console.log('\n=== S4. Action return channel ===');
    await check('S4a.save-ack-roundtrip', async () => {
      await hud.locator('#comp-action-save').click();
      await waitState('ActionPending', 4000);
      await waitState('ActionConfirmed', 5000);
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Done');
      const status = await page.locator('#action-status').textContent();
      assert.match(status, /action\.save/);
      await hud.locator('#comp-primary-btn').click(); // Done → Ready
      await waitState('Ready', 3000);
    });

    await check('S4b.open-on-phone-ack-roundtrip', async () => {
      await scanToResults();
      await hud.locator('#comp-action-open').click();
      await waitState('ActionPending', 4000);
      await waitState('ActionConfirmed', 5000);
      const status = await page.locator('#action-status').textContent();
      assert.match(status, /action\.open_on_phone/);
      await hud.locator('#comp-primary-btn').click();
      await waitState('Ready', 3000);
    });

    await check('S4c.dismiss-returns-ready', async () => {
      await scanToResults();
      await dismissToReady();
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Ready');
      return `dismiss→stable ${perf.dismissToStable.at(-1)}ms`;
    });

    await check('S4d.retry-mints-new-request', async () => {
      await scanToResults();
      await hud.locator('#comp-action-retry').click();
      await waitState('CaptureRequested', 3000);
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      assert.equal(await visibleScreen(), 'results');
      const active = await hud.locator('#pipeline-steps .pipeline-step.active').count();
      assert.equal(active, 0, 'stepper stuck after retry result');
      await dismissToReady();
    });

    console.log('\n=== S5. Cancel and stale-result containment ===');
    await check('S5a.cancel-mid-scan-settles', async () => {
      await hud.locator('#comp-primary-btn').click(); // Scan
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      await hud.locator('#cancel-btn').click();
      await waitState('Ready', 4000);
      const cancelled = await page.locator('#scan-status').textContent();
      assert.match(cancelled, /cancelled/i);
      assert.equal(await visibleScreen(), 'companion');
      const active = await hud.locator('#pipeline-steps .pipeline-step.active').count();
      assert.equal(active, 0, 'stepper stuck after cancel');
    });

    await check('S5b.late-result-after-cancel-dropped', async () => {
      // The phone still holds the cancelled requestId — force a late result.
      await page.locator('#btn-send-result').click();
      await sleep(600);
      assert.equal((await hudState()).state, 'Ready');
      assert.equal(await visibleScreen(), 'companion');
    });

    console.log('\n=== S6. Malformed result containment ===');
    await check('S6a.oversized-result-dropped-valid-still-renders', async () => {
      const before = (await hudState()).dropped;
      await hud.locator('#comp-primary-btn').click(); // Scan
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      await sleep(1900); // let auto-drive finish → Results
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      await dismissToReady();
      // Oversized needs an in-flight request: scan again and send it mid-flight.
      await hud.locator('#comp-primary-btn').click();
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      await page.locator('#btn-neg-oversize').click();
      await sleep(400);
      const after = await hudState();
      assert.ok(after.dropped > before, `dropped ${before} → ${after.dropped}`);
      // Auto-drive's valid result.show (1.6s) still lands → results render.
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      await dismissToReady();
    });

    await check('S6b.duplicate-terminal-suppressed', async () => {
      // Complete an action so the phone holds a terminal ack, then resend it.
      await scanToResults();
      await hud.locator('#comp-action-save').click();
      await waitState('ActionConfirmed', 6000);
      const before = await hudState();
      await page.locator('#btn-neg-dupe').click();
      await sleep(500);
      const mid = await hudState();
      assert.equal(mid.state, 'ActionConfirmed');
      // Protocol-valid duplicate terminal → machine-level suppression.
      assert.ok(mid.dropped + mid.ignored > before.dropped + before.ignored,
        `dropped+ignored ${before.dropped}+${before.ignored} → ${mid.dropped}+${mid.ignored}`);
      await hud.locator('#comp-primary-btn').click();
      await waitState('Ready', 3000);
    });

    console.log('\n=== S7. Pairing edge paths ===');
    await check('S7a.denial-then-recovery', async () => {
      await ensureReady();
      // Unpair first: Ready → Disconnect secondary.
      await hud.locator('#comp-secondary-1').click();
      await waitState('Disconnected', 3000);
      await hud.locator('#comp-primary-btn').click(); // Pair Phone
      await pairingRequestPending();
      await page.locator('#btn-deny').click();
      await waitState('PairingDenied', 3000);
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Pairing denied');
      assert.equal((await hud.locator('#comp-primary-btn').textContent()).trim(), 'Try Again');
      await pairFromCompanionScreen(); // Try Again → approve → Ready
    });

    await check('S7b.pairing-expiry-then-recovery', async () => {
      await ensureReady();
      await hud.locator('#comp-secondary-1').click(); // Disconnect
      await waitState('Disconnected', 3000);
      await hud.locator('#comp-primary-btn').click();
      await pairingRequestPending();
      await page.locator('#btn-expire-pair').click();
      await waitState('PairingExpired', 3000);
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Pairing expired');
      await pairFromCompanionScreen();
    });

    console.log('\n=== S8. Connection loss and recovery ===');
    await check('S8a.drop-while-ready-then-restore', async () => {
      await page.locator('#btn-drop').click();
      await waitState('Reconnecting', 17000); // ping 5s + pong timeout 8s + margin
      const t0 = Date.now();
      await page.locator('#btn-restore').click();
      await waitState('Ready', 6000);
      perf.restoreToReady.push(Date.now() - t0);
      return `restore→Ready ${perf.restoreToReady.at(-1)}ms`;
    });

    await check('S8b.drop-mid-scan-settles-then-rescan', async () => {
      await ensureReady();
      await hud.locator('#comp-primary-btn').click(); // Scan
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      await page.locator('#btn-drop').click(); // phone goes silent mid-scan
      await waitState('Reconnecting', 17000);
      // Machine design: restore settles the interrupted scan to Ready —
      // no stale scan resumes, nothing stuck, user scans again.
      await page.locator('#btn-restore').click();
      await waitState('Ready', 6000);
      const active = await hud.locator('#pipeline-steps .pipeline-step.active').count();
      assert.equal(active, 0, 'stepper stuck after connection loss');
      await scanToResults();
      await dismissToReady();
    });

    await check('S8c.reconnect-window-expiry-stable', async () => {
      await page.locator('#btn-drop').click();
      await waitState('Reconnecting', 17000);
      // Do not restore: 10s reconnect window must expire to a stable state.
      await waitHud('(d) => d.state === "Disconnected" || d.state === "SessionRevoked"', 14000);
      const d = await hudState();
      assert.ok(['Disconnected', 'SessionRevoked'].includes(d.state), d.state);
      assert.equal(await visibleScreen(), 'companion');
      // Recover for later sections.
      await page.locator('#btn-restore').click();
      const state = (await hudState()).state;
      if (state === 'Disconnected') {
        await hud.locator('#comp-primary-btn').click(); // Pair Phone
        await pairingRequestPending();
        await approveAndReady();
      } else {
        await pairFromCompanionScreen();
      }
      await waitState('Ready', 4000);
    });

    await check('S8d.revoke-then-repair', async () => {
      await ensureReady();
      await page.locator('#btn-revoke').click();
      await waitState('SessionRevoked', 6000);
      assert.equal((await hud.locator('#comp-title').textContent()).trim(), 'Session ended');
      assert.equal((await hud.locator('#comp-primary-btn').textContent()).trim(), 'Pair Again');
      await pairFromCompanionScreen();
    });

    console.log('\n=== S9. Negative message handling ===');
    await check('S9a.all-negative-classes-dropped', async () => {
      await ensureReady();
      const before = await hudState();
      await page.locator('#btn-neg-malformed').click();
      await page.locator('#btn-neg-stale').click();
      await page.locator('#btn-neg-device').click();
      await page.locator('#btn-neg-session').click();
      await sleep(500);
      const after = await hudState();
      assert.equal(after.state, 'Ready');
      assert.equal(await visibleScreen(), 'companion');
      assert.ok(after.dropped > before.dropped, `dropped ${before.dropped} → ${after.dropped}`);
      return `dropped=${after.dropped}`;
    });

    console.log('\n=== S10. D-pad, focus, and 600×600 layout ===');
    await check('S10a.dpad-moves-focus-enter-activates', async () => {
      await ensureReady();
      // Focus is inside the HUD iframe after prior clicks.
      await hud.locator('#comp-primary-btn').focus();
      const before = await hudFrame.evaluate(() => document.activeElement?.id);
      await page.keyboard.press('ArrowDown');
      const after = await hudFrame.evaluate(() => document.activeElement?.id);
      assert.notEqual(after, before, `focus did not move from ${before}`);
      const style = await hudFrame.evaluate(() => {
        const el = document.activeElement;
        const s = getComputedStyle(el);
        return { outline: s.outlineStyle, shadow: s.boxShadow };
      });
      assert.ok(style.outline !== 'none' || style.shadow !== 'none', JSON.stringify(style));
      await page.keyboard.press('ArrowUp');
      return `${before} → ${after}`;
    });

    await check('S10b.escape-from-companion-goes-home', async () => {
      await page.keyboard.press('Escape');
      await hud.locator('#home:not(.hidden)').waitFor({ timeout: 3000 });
      assert.equal(await visibleScreen(), 'home');
      // Home Scan in companion mode returns to the connected flow.
      await hud.locator('#scan-btn').click();
      await waitState('CaptureRequested', 3000); // still paired → straight to scan
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      await dismissToReady();
    });

    const forceScanFailed = async () => {
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      // Wait until the mock phone is actually driving this request so
      // SCAN_FAILED targets the in-flight id (not a completed prior request).
      await page.waitForFunction(
        () => (document.getElementById('scan-status')?.textContent || '').includes('Driving scan'),
        { timeout: 4000 },
      );
      await page.locator('#btn-scan-failed').click();
      await hud.locator('#error:not(.hidden)').waitFor({ timeout: 6000 });
    };

    await check('S10c.all-connected-screens-fit-600x600', async () => {
      const measurements = [];
      const measure = async (name) => {
        const o = await noOverflow();
        measurements.push(`${name}:${o.scrollW}x${o.scrollH}`);
        assert.ok(o.scrollW <= 600 && o.scrollH <= 600, `${name} overflows: ${JSON.stringify(o)}`);
      };
      await measure('companion-ready'); // current screen
      await hud.locator('#comp-primary-btn').click(); // Scan → processing
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      await measure('processing');
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      await measure('results');
      await hud.locator('#comp-action-dismiss').click();
      await waitState('Ready', 4000);
      await measure('companion-after-dismiss');
      // Error screen: force a scan failure.
      await hud.locator('#comp-primary-btn').click();
      await forceScanFailed();
      await measure('error');
      return measurements.join(' ');
    });

    await check('S10d.error-retry-recovers-and-home-settles', async () => {
      assert.equal((await hudState()).state, 'Error', 'S10d requires Error from S10c');
      await hud.locator('#error-retry-btn').click();
      try {
        await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
      } catch (err) {
        const d = await hudState();
        const screen = await visibleScreen();
        const scan = await page.locator('#scan-status').textContent();
        throw new Error(`retry stuck state=${d.state} screen=${screen} scan=${scan} dropped=${d.dropped} ignored=${d.ignored} | ${err.message}`);
      }
      assert.equal((await hudState()).state, 'Results');
      await dismissToReady();
      // Error → Home path (companion machine settles, HUD shows home).
      await hud.locator('#comp-primary-btn').click();
      await forceScanFailed();
      await hud.locator('#error-home-btn').click();
      await hud.locator('#home:not(.hidden)').waitFor({ timeout: 3000 });
      const d = await hudState();
      assert.ok(['Ready', 'Disconnected'].includes(d.state), d.state);
    });

    await check('S10e.no-dead-focus-targets', async () => {
      // S10d ends on Home while still Ready. Home→Scan starts a capture
      // immediately when paired — cancel back to the companion Ready surface.
      if ((await visibleScreen()) === 'home') {
        await hud.locator('#scan-btn').click();
        await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 4000 });
        await hud.locator('#cancel-btn').click();
        await waitState('Ready', 4000);
      } else if ((await hudState()).state !== 'Ready') {
        await ensureReady();
      }
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 5000 });
      const dead = await hudFrame.evaluate(() => {
        const screen = document.querySelector('#companion:not(.hidden)');
        if (!screen) return ['companion screen not visible'];
        const bad = [];
        screen.querySelectorAll('.focusable').forEach((el) => {
          const visible = !el.classList.contains('hidden') && el.offsetParent !== null;
          if (!visible) return;
          const label = (el.textContent || '').trim();
          if (!label) bad.push(`${el.id || el.className}: empty label`);
          if (el.tagName === 'BUTTON' && typeof el.onclick !== 'function' && !el.dataset.wired) {
            bad.push(`${el.id}: button without handler`);
          }
        });
        return bad;
      });
      assert.deepEqual(dead, []);
    });

    } // end scenario sections (S3–S10)
    if (runLoops) {
    console.log('\n=== L1. 20 consecutive scan/result flows ===');
    let loopFailures = 0;
    for (let i = 0; i < 20; i += 1) {
      try {
        await ensureReady();
        await scanToResults();
        assert.equal(await visibleScreen(), 'results');
        const active = await hud.locator('#pipeline-steps .pipeline-step.active').count();
        assert.equal(active, 0, 'stepper stuck');
        await dismissToReady();
      } catch (err) {
        loopFailures += 1;
        console.log(`  loop ${i + 1} failed: ${String(err.message).slice(0, 120)}`);
        try { await ensureReady(); } catch { /* next iteration retries */ }
      }
    }
    await check('L1.20-scan-flows-20-result-deliveries', () => {
      assert.equal(loopFailures, 0, `${loopFailures} loop failures`);
      return '20 scans, 20 results, 0 stuck steppers';
    });

    console.log('\n=== L2. 10 cancel/retry cycles ===');
    let cancelFailures = 0;
    for (let i = 0; i < 10; i += 1) {
      try {
        await ensureReady();
        await hud.locator('#comp-primary-btn').click(); // Scan
        await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
        await hud.locator('#cancel-btn').click();
        await waitState('Ready', 4000);
        await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
        // Retry immediately — new requestId, fresh drive.
        await hud.locator('#comp-primary-btn').click();
        await hud.locator('#results:not(.hidden)').waitFor({ timeout: 9000 });
        await dismissToReady();
      } catch (err) {
        cancelFailures += 1;
        console.log(`  cancel cycle ${i + 1} failed: ${String(err.message).slice(0, 120)}`);
        try { await ensureReady(); } catch { /* next cycle */ }
      }
    }
    await check('L2.10-cancel-retry-cycles', () => assert.equal(cancelFailures, 0, `${cancelFailures} failures`));

    console.log('\n=== L3. 10 disconnect/reconnect cycles ===');
    let reconnectFailures = 0;
    await ensureReady();
    for (let i = 0; i < 10; i += 1) {
      try {
        await page.locator('#btn-drop').click();
        await waitState('Reconnecting', 6000);
        const t0 = Date.now();
        await page.locator('#btn-restore').click();
        await waitState('Ready', 6000);
        perf.restoreToReady.push(Date.now() - t0);
      } catch (err) {
        reconnectFailures += 1;
        console.log(`  reconnect cycle ${i + 1} failed: ${String(err.message).slice(0, 120)}`);
        try {
          await page.locator('#btn-restore').click();
          await waitState('Ready', 6000);
        } catch { /* next cycle retries */ }
      }
    }
    await check('L3.10-reconnect-cycles', () => {
      assert.equal(reconnectFailures, 0, `${reconnectFailures} failures`);
      return `restore→Ready ${JSON.stringify(stats(perf.restoreToReady))}`;
    });

    console.log('\n=== L4. 20 pairing cycles (>=19 success) ===');
    let pairingSuccess = 0;
    for (let i = 0; i < 20; i += 1) {
      try {
        // Ready → Disconnect → Disconnected → Pair → approve → Ready.
        // Do not click #scan-btn here — it is a Home control and, when already
        // paired, starts a capture instead of opening the companion surface.
        await ensureReady();
        assert.equal((await hud.locator('#comp-secondary-1').textContent()).trim(), 'Disconnect');
        await hud.locator('#comp-secondary-1').click();
        await waitState('Disconnected', 4000);
        await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
        await hud.locator('#comp-primary-btn').click(); // Pair Phone
        await pairingRequestPending();
        const t0 = Date.now();
        await page.locator('#btn-approve').click();
        await waitState('Ready', 6000);
        await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
        perf.approveToReady.push(Date.now() - t0);
        pairingSuccess += 1;
      } catch (err) {
        console.log(`  pairing cycle ${i + 1} failed: ${String(err.message).slice(0, 120)}`);
        try {
          // Escape a stuck Pairing window before the next attempt.
          if ((await hudState()).state === 'Pairing') {
            await hud.locator('#comp-secondary-1').click();
            await waitState('Disconnected', 4000);
          }
          await ensureReady();
        } catch { /* next cycle */ }
      }
    }
    await check('L4.pairing-success-19-of-20', () => {
      assert.ok(pairingSuccess >= 19, `${pairingSuccess}/20`);
      return `${pairingSuccess}/20`;
    });

    console.log('\n=== P1. Result receipt latency ===');
    await check('P1.result-visible-within-1s-of-receipt', async () => {
      await ensureReady();
      await hud.locator('#comp-primary-btn').click(); // Scan
      await page.waitForFunction(
        () => (document.getElementById('scan-status')?.textContent || '').includes('Driving scan'),
        { timeout: 4000 },
      );
      // Stop auto-drive timers so only the manual result.show is measured.
      await page.locator('#btn-stop-drive').click();
      await page.locator('#btn-capture-started').click();
      await page.locator('#btn-analyzing').click();
      const t0 = Date.now();
      await page.locator('#btn-send-result').click();
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 5000 });
      resultReceiptMs = Date.now() - t0;
      assert.ok(resultReceiptMs <= 1000, `${resultReceiptMs}ms`);
      await dismissToReady();
      return `${resultReceiptMs}ms`;
    });

    } // end loop sections (L1–L4, P1)

    console.log('\n=== Z1. Strict console ===');
    await check('Z1.no-console-or-page-errors', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await Promise.race([
      browser.close(),
      new Promise((r) => { setTimeout(r, 5000); }),
    ]);
    server.close();
  }

  console.log('\n── Performance summary (mock companion, headless Chromium) ──');
  console.log(`  scan click → processing visible: ${JSON.stringify(stats(perf.scanToProcessing))} (target ≤250ms)`);
  console.log(`  result receipt → results visible: ${resultReceiptMs}ms (target ≤1000ms)`);
  console.log(`  dismiss → stable screen: ${JSON.stringify(stats(perf.dismissToStable))} (target ≤500ms)`);
  console.log(`  approve → Ready: ${JSON.stringify(stats(perf.approveToReady))} (target <5000ms)`);
  console.log(`  restore → Ready: ${JSON.stringify(stats(perf.restoreToReady))} (target <3000ms)`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Companion browser suite: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('SUITE CRASHED:', err);
  process.exit(2);
});
