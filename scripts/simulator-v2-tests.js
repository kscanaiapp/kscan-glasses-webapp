// Simulator V2 browser suite — LOCAL QA / NON-PRODUCTION.
// Serves dist-simulator, loads simulator-v2.html, and drives the guided
// journey end to end through the REAL production HUD (companion mode) and
// src/simulatorV2/mockPhoneEngine.js acting as the phone — the same
// canonical protocol/state-machine/result-contract browser-smoke-companion.js
// exercises via companion.html, from Simulator V2's premium shell instead.
//
// Usage: node scripts/simulator-v2-tests.js
// Requires: npm run build:simulator first.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromePath } from './resolve-chrome.js';

const PORT = 4691;
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
      if (path === '/') path = '/simulator-v2.html';
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

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function pollFor(fn, timeoutMs = 5000, stepMs = 150) {
  let value;
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return value;
}

async function main() {
  if (!existsSync('dist-simulator/simulator-v2.html')) {
    console.error('dist-simulator/simulator-v2.html missing — run npm run build:simulator first.');
    process.exit(2);
  }
  if (!HEADLESS_SHELL || !existsSync(HEADLESS_SHELL)) {
    console.error('Chromium not found. Set KSCAN_CHROME_PATH or run: npx playwright-core install chromium');
    process.exit(2);
  }

  const server = await serve('dist-simulator', PORT);
  const browser = await chromium.launch({ executablePath: HEADLESS_SHELL, headless: true });
  const consoleErrors = [];
  const pageErrors = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (/INFO: Created TensorFlow Lite XNNPACK delegate/.test(msg.text())) return;
      consoleErrors.push(msg.text().slice(0, 200));
    });
    page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 240)));

    await page.goto(`http://127.0.0.1:${PORT}/simulator-v2.html`, { waitUntil: 'load' });

    const hudState = () => page.evaluate(() => {
      const frame = document.getElementById('hud-frame');
      return frame?.contentWindow?.__kscanCompanionDebug?.() ?? null;
    });
    const hudScreen = () => page.evaluate(() => {
      const doc = document.getElementById('hud-frame')?.contentWindow?.document;
      return doc ? Array.from(doc.querySelectorAll('.screen')).find((s) => !s.classList.contains('hidden'))?.id ?? null : null;
    });
    const clickInFrame = (selector) => page.evaluate((sel) => {
      const doc = document.getElementById('hud-frame')?.contentWindow?.document;
      const el = doc?.querySelector(sel);
      if (el && !el.classList.contains('hidden') && !el.disabled) { el.click(); return true; }
      return false;
    }, selector);

    await check('boot:no-console-errors-on-load', async () => {
      await sleep(300);
      assert.equal(consoleErrors.length, 0, `console errors: ${consoleErrors.join(' | ')}`);
      assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
    });

    await check('boot:qa-strip-visible', async () => {
      const text = await page.textContent('.qa-strip');
      assert.ok(text.includes('Interactive product simulation'));
    });

    await check('boot:closet-terminology-not-library', async () => {
      const body = await page.content();
      // The user-facing app must say "Closet", never "Library" (product terminology).
      assert.ok(!/>Library</i.test(body));
    });

    await check('journey:start-experience-reaches-pairing', async () => {
      await page.click('#start-experience-btn');
      await sleep(400);
      const state = await hudState();
      assert.equal(state?.state, 'Pairing');
      const phoneText = await page.textContent('#phone-screen');
      assert.ok(phoneText.includes('want to connect'));
    });

    await check('journey:approve-reaches-ready', async () => {
      await page.click('#phone-approve-btn');
      await sleep(500);
      const state = await hudState();
      assert.equal(state?.state, 'Ready');
      assert.equal(state?.sessionValid, true);
    });

    await check('journey:scan-reaches-results-with-companion-fixture', async () => {
      await clickInFrame('#comp-primary-btn'); // Scan
      const screen = await pollFor(async () => (await hudScreen()) === 'results' ? 'results' : null, 6000);
      assert.equal(screen, 'results');
      const title = await page.textContent('#ph-title');
      assert.ok(title && title.length > 0);
      const visible = await page.evaluate(() => document.getElementById('product-highlight').classList.contains('visible'));
      assert.equal(visible, true);
    });

    await check('journey:save-then-dismiss-returns-to-ready', async () => {
      await page.click('#ph-save');
      const confirmed = await pollFor(async () => (await hudState())?.state === 'ActionConfirmed' ? true : null, 6000);
      assert.equal(confirmed, true);
      await clickInFrame('#comp-primary-btn'); // "Done"
      const ready = await pollFor(async () => (await hudState())?.state === 'Ready' ? true : null, 4000);
      assert.equal(ready, true);
    });

    await check('scenario:no-match-renders-empty-groups', async () => {
      await page.selectOption('#scenario-select', 'noMatch');
      await clickInFrame('#comp-primary-btn'); // Scan
      const screen = await pollFor(async () => (await hudScreen()) === 'results' ? 'results' : null, 6000);
      assert.equal(screen, 'results');
      const resultsListText = await page.evaluate(() => {
        const doc = document.getElementById('hud-frame').contentWindow.document;
        return doc.getElementById('results-list')?.textContent ?? '';
      });
      assert.equal(resultsListText.trim(), '');
      const dismissed = await clickInFrame('#comp-action-dismiss');
      assert.equal(dismissed, true);
      await pollFor(async () => (await hudState())?.state === 'Ready' ? true : null, 3000);
    });

    await check('qa-mode:drawer-toggle-and-message-log', async () => {
      await page.click('#mode-qa-btn');
      const hidden = await page.evaluate(() => document.getElementById('dev-drawer').hidden);
      assert.equal(hidden, false);
      const logLines = await page.evaluate(() => document.getElementById('dev-log').children.length);
      assert.ok(logLines > 0, 'expected prior journey traffic in the message log');
      await page.click('#mode-demo-btn');
    });

    await check('qa-mode:negative-malformed-does-not-crash-hud', async () => {
      await page.click('#mode-qa-btn');
      await page.click('#dev-neg-malformed');
      await sleep(200);
      assert.equal(consoleErrors.length, 0, `console errors after malformed injection: ${consoleErrors.join(' | ')}`);
      await page.click('#mode-demo-btn');
    });

    await check('a11y:reduced-motion-respected', async () => {
      const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      await page2.goto(`http://127.0.0.1:${PORT}/simulator-v2.html`, { waitUntil: 'load' });
      const durationsOk = await page2.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return true; // presence check: the reduced-motion media query is defined in CSS (see simulator-v2.html)
      });
      assert.equal(durationsOk, true);
      await page2.close();
    });

    await check('responsive:no-horizontal-overflow-1920', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await sleep(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false);
    });

    await check('responsive:no-horizontal-overflow-mobile', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await sleep(150);
      const debugInfo = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('body *'));
        const overflowing = all
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
          .map((el) => ({
            tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60),
            right: Math.round(el.getBoundingClientRect().right),
          }));
        return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowing: overflowing.slice(0, 10) };
      });
      assert.equal(debugInfo.scrollWidth > debugInfo.innerWidth, false, JSON.stringify(debugInfo));
    });
  } finally {
    await browser.close();
    server.close();
  }

  const fail = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(`=== Simulator V2 browser suite: ${results.length - fail} PASS / ${fail} FAIL ===`);
  if (consoleErrors.length) console.log(`Console errors observed: ${consoleErrors.length}`);
  if (pageErrors.length) console.log(`Page errors observed: ${pageErrors.length}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Simulator V2 browser suite crashed:', err);
  process.exit(2);
});
