// Interactive companion-runtime drive — Phase A. Serves dist-simulator,
// loads the mock phone companion page (companion.html) with the HUD in its
// 600×600 iframe, and drives the real pairing → trusted session → scan →
// structured result → action-ack flow end to end.
//
// Usage: node scripts/browser-smoke-companion.js
// Requires: npm run build:simulator first.
//
// Console strictness matches browser-smoke.js: any console error or page
// error fails the run (single XNNPACK INFO exception).

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const SIM_PORT = 4619;
const HEADLESS_SHELL = process.env.KSCAN_CHROME_PATH
  || 'C:/Users/jsmit/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync('dist-simulator/companion.html')) {
    console.error('dist-simulator/companion.html missing — run npm run build:simulator first.');
    process.exit(2);
  }

  const server = await serve('dist-simulator', SIM_PORT);
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL, headless: true });
  const consoleErrors = [];
  const pageErrors = [];

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

    const hudState = () => page.evaluate(() => {
      const frame = document.getElementById('hud-frame');
      return frame?.contentWindow?.__kscanCompanionDebug?.() ?? null;
    });

    const waitHud = async (predicate, timeout = 6000) => {
      await page.waitForFunction((src) => {
        const frame = document.getElementById('hud-frame');
        const d = frame?.contentWindow?.__kscanCompanionDebug?.();
        if (!d) return false;
        return eval(src)(d);
      }, predicate, { timeout });
    };

    console.log('\n=== C0. Load ===');
    await check('companion page + HUD iframe load, debug hook present', async () => {
      await page.waitForFunction(() => {
        const frame = document.getElementById('hud-frame');
        return Boolean(frame?.contentWindow?.__kscanCompanionDebug);
      }, { timeout: 8000 });
      const banner = await hud.locator('#alpha-banner').textContent();
      assert.match(banner, /MOCK PHONE/);
      assert.match(banner, /HW VALIDATION PENDING/);
      return banner.trim();
    });

    await check('home shows Phone: Off pill, state Disconnected', async () => {
      const pill = await hud.locator('#pill-companion span').textContent();
      assert.equal(pill.trim(), 'Phone: Off');
      const d = await hudState();
      assert.equal(d.state, 'Disconnected');
      assert.equal(d.transport, 'open');
      return `transport=${d.transport}`;
    });

    console.log('\n=== C1. Pairing ===');
    await check('Scan intent from Disconnected shows companion screen with Pair', async () => {
      await hud.locator('#scan-btn').click();
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
      const title = await hud.locator('#comp-title').textContent();
      assert.equal(title.trim(), 'Not connected');
      const primary = await hud.locator('#comp-primary-btn').textContent();
      assert.equal(primary.trim(), 'Pair Phone');
    });

    await check('Pair intent → mock phone receives pair.request', async () => {
      await hud.locator('#comp-primary-btn').click();
      await page.waitForFunction(() => document.getElementById('session-status').textContent.includes('Pairing requested'), { timeout: 3000 });
      const title = await hud.locator('#comp-title').textContent();
      assert.equal(title.trim(), 'Pairing…');
    });

    await check('Approve → Connected → Ready (session established)', async () => {
      await page.locator('#btn-approve').click();
      await waitHud('(d) => d.state === "Ready"', 6000);
      const title = await hud.locator('#comp-title').textContent();
      assert.equal(title.trim(), 'Ready');
      const pill = await hud.locator('#pill-companion span').textContent();
      assert.equal(pill.trim(), 'Phone: Ready');
      const d = await hudState();
      assert.equal(d.sessionValid, true);
      return `caps session valid, state=${d.state}`;
    });

    console.log('\n=== C2. Scan lifecycle ===');
    await check('Scan → capture.request → mock auto-drive → Results', async () => {
      await hud.locator('#comp-primary-btn').click(); // Scan
      await page.waitForFunction(() => document.getElementById('scan-status').textContent.includes('Driving scan'), { timeout: 3000 });
      // Processing screen should be visible during drive
      await hud.locator('#processing:not(.hidden)').waitFor({ timeout: 3000 });
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 8000 });
      const matchCard = await hud.locator('#results-match .style-match-card').count();
      assert.equal(matchCard, 1);
      const rows = await hud.locator('#results-list .companion-item').count();
      assert.ok(rows >= 1, 'expected at least one result row');
      const bar = await hud.locator('#companion-actions:not(.hidden)').count();
      assert.equal(bar, 1);
      const source = await hud.locator('#results-match .scan-mode-pill').allTextContents();
      assert.ok(source.some((t) => /MOCK PHONE/.test(t)), `source label missing: ${source}`);
      return `${rows} result rows`;
    });

    await check('result pipeline finished (stepper not stuck)', async () => {
      const active = await hud.locator('#pipeline-steps .pipeline-step.active').count();
      assert.equal(active, 0);
    });

    console.log('\n=== C3. Action return channel ===');
    await check('Save → action.save ack → ActionConfirmed → Done → Results', async () => {
      await hud.locator('#comp-action-save').click();
      try {
        await waitHud('(d) => d.state === "ActionPending" || d.state === "ActionConfirmed"', 5000);
        await waitHud('(d) => d.state === "ActionConfirmed"', 5000);
      } catch (err) {
        const d = await hudState();
        const actionStatus = await page.locator('#action-status').textContent();
        console.log(`  [diag] state=${JSON.stringify(d)} action-status="${actionStatus}"`);
        throw err;
      }
      const title = await hud.locator('#comp-title').textContent();
      assert.equal(title.trim(), 'Done');
      await hud.locator('#comp-primary-btn').click(); // Done = dismiss → Ready
      await waitHud('(d) => d.state === "Ready"', 3000);
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
    });

    await check('Dismiss from Results → machine returns to Ready, companion screen', async () => {
      await hud.locator('#comp-primary-btn').click(); // Scan again
      await hud.locator('#results:not(.hidden)').waitFor({ timeout: 8000 });
      await hud.locator('#comp-action-dismiss').click();
      await waitHud('(d) => d.state === "Ready"', 3000);
      await hud.locator('#companion:not(.hidden)').waitFor({ timeout: 3000 });
      const title = await hud.locator('#comp-title').textContent();
      assert.equal(title.trim(), 'Ready');
    });

    console.log('\n=== C4. Negative message handling ===');
    await check('malformed / stale / wrong-device / wrong-session all dropped', async () => {
      const before = await hudState();
      await page.locator('#btn-neg-malformed').click();
      await page.locator('#btn-neg-stale').click();
      await page.locator('#btn-neg-device').click();
      await page.locator('#btn-neg-session').click();
      await sleep(400);
      const after = await hudState();
      assert.equal(after.state, 'Ready');
      assert.ok(after.dropped > before.dropped, `expected drops to increase (${before.dropped} → ${after.dropped})`);
      return `dropped=${after.dropped}`;
    });

    console.log('\n=== C5. Connection loss + recovery ===');
    await check('drop connection → Reconnecting; restore → Ready', async () => {
      await page.locator('#btn-drop').click();
      // Worst case: ping interval (5s) + pong timeout (8s) + margin.
      await waitHud('(d) => d.state === "Reconnecting"', 17000);
      await page.locator('#btn-restore').click();
      await waitHud('(d) => d.state === "Ready"', 6000);
    });

    await check('revoke session → SessionRevoked → pair again possible', async () => {
      await page.locator('#btn-revoke').click();
      await waitHud('(d) => d.state === "SessionRevoked"', 6000);
      const title = await hud.locator('#comp-title').textContent();
      assert.equal(title.trim(), 'Session ended');
      const primary = await hud.locator('#comp-primary-btn').textContent();
      assert.equal(primary.trim(), 'Pair Again');
    });

    console.log('\n=== C6. Strict console ===');
    await check('no console errors, no page errors', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Companion drive: ${results.length - failed.length} PASS / ${failed.length} FAIL ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('DRIVE CRASHED:', err);
  process.exit(2);
});
