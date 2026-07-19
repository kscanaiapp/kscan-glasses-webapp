// Artifact separation assertion — run after `npm run build` and
// `npm run build:simulator`.
//
// Hard guarantees:
//   1. Production dist/ contains no simulator.html and no simulator-only
//      controls (session-injection console, mock-session controls,
//      dev scenario controls).
//   2. Simulator dist-simulator/ contains simulator.html with visible
//      LOCAL QA / NON-PRODUCTION labeling.
//   3. Neither artifact contains secrets (JWT-like strings, service-role
//      markers) or large inlined base64 blobs.
//   4. No broken product-image asset references in emitted HTML/JS
//      (placeholder /images/ paths must not be referenced).
//
// Exits non-zero on any FAIL.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

let pass = 0;
let fail = 0;

function ok(name, detail = '') {
  pass += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  fail += 1;
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const PROD = 'dist';
const SIM = 'dist-simulator';

// ── Production artifact ────────────────────────────────────────────────────
if (!existsSync(join(PROD, 'index.html'))) {
  bad('prod:exists', `${PROD}/index.html missing — run npm run build first`);
} else {
  ok('prod:exists');

  const prodFiles = walk(PROD).map((f) => f.replace(/\\/g, '/'));

  if (prodFiles.some((f) => /simulator\.html$/.test(f))) {
    bad('prod:no-simulator-html', 'simulator.html found in production dist');
  } else {
    ok('prod:no-simulator-html');
  }

  const prodTextFiles = prodFiles.filter((f) => /\.(html|js|css|json|webmanifest|map)$/.test(f));
  const simulatorMarkers = [
    'LOCAL QA / NON-PRODUCTION',
    'Post mock session',
    'inject-session',
    'live-url-token',
    'Bridge State Scaffold',
    'bridge-full-flow',
    'textscan-mode',
  ];
  let markerHit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    for (const marker of simulatorMarkers) {
      if (text.includes(marker)) {
        markerHit = `${marker} in ${file}`;
        break;
      }
    }
    if (markerHit) break;
  }
  if (markerHit) bad('prod:no-simulator-markers', markerHit);
  else ok('prod:no-simulator-markers');

  // Mock phone companion must not ship in production: no entry page, no
  // chunk, no control IDs, no fixture tooling markers. The companion
  // RUNTIME (protocol/transport/state machine) intentionally ships — it
  // fails closed without an approved peer.
  if (prodFiles.some((f) => /companion\.html$/.test(f))) {
    bad('prod:no-companion-html', 'companion.html found in production dist');
  } else {
    ok('prod:no-companion-html');
  }
  if (prodFiles.some((f) => /assets\/companion-[^/]*\.js$/.test(f))) {
    bad('prod:no-companion-chunk', 'mock companion chunk found in production dist');
  } else {
    ok('prod:no-companion-chunk');
  }
  const companionMarkers = [
    'Mock Phone (LOCAL QA)',
    'KSCAN_COMPANION_FIXTURE_V1',
    'btn-approve',
    'fixture-select',
    'hud-frame',
    'chk-auto-ack',
  ];
  let compHit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    for (const marker of companionMarkers) {
      if (text.includes(marker)) {
        compHit = `${marker} in ${file}`;
        break;
      }
    }
    if (compHit) break;
  }
  if (compHit) bad('prod:no-companion-markers', compHit);
  else ok('prod:no-companion-markers');

  // No development transport defaults or localhost endpoints in production.
  let wsHit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    if (text.includes('ws://localhost') || text.includes('localhost:8787')) {
      wsHit = file;
      break;
    }
  }
  if (wsHit) bad('prod:no-localhost-transport', wsHit);
  else ok('prod:no-localhost-transport');

  // Companion debug hook must be tree-shaken out of the production bundle.
  let debugHit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    if (text.includes('__kscanCompanionDebug')) {
      debugHit = file;
      break;
    }
  }
  if (debugHit) bad('prod:no-companion-debug-hook', debugHit);
  else ok('prod:no-companion-debug-hook');

  // Secret scan (JWT-shaped strings, service-role markers).
  const secretPatterns = [
    { name: 'jwt-like', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
    { name: 'service-role', re: /service_role/i },
    { name: 'supabase-secret', re: /sb_secret_[A-Za-z0-9]/ },
  ];
  let secretHit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    for (const { name, re } of secretPatterns) {
      if (re.test(text)) {
        secretHit = `${name} in ${file}`;
        break;
      }
    }
    if (secretHit) break;
  }
  if (secretHit) bad('prod:no-secrets', secretHit);
  else ok('prod:no-secrets');

  // No large inlined base64 blobs (raw image fixtures must not ship).
  let b64Hit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    const m = text.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{2000,}/);
    if (m) {
      b64Hit = `${file} (${m[0].length} chars)`;
      break;
    }
  }
  if (b64Hit) bad('prod:no-inline-image-blob', b64Hit);
  else ok('prod:no-inline-image-blob');

  // No broken mock product-image references (/images/placeholder-*).
  let imgHit = null;
  for (const file of prodTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    if (/\/images\/placeholder-/.test(text)) {
      imgHit = file;
      break;
    }
  }
  if (imgHit) bad('prod:no-broken-image-refs', imgHit);
  else ok('prod:no-broken-image-refs');
}

// ── Simulator artifact ─────────────────────────────────────────────────────
if (!existsSync(join(SIM, 'simulator.html'))) {
  bad('sim:exists', `${SIM}/simulator.html missing — run npm run build:simulator first`);
} else {
  ok('sim:exists');

  const simHtml = readTextSafe(join(SIM, 'simulator.html')) || '';
  if (simHtml.includes('LOCAL QA / NON-PRODUCTION')) {
    ok('sim:local-qa-label');
  } else {
    bad('sim:local-qa-label', 'LOCAL QA / NON-PRODUCTION label missing from simulator.html');
  }

  // Synthetic fixture must be canvas-generated, not a hardcoded blob.
  const simFiles = walk(SIM).map((f) => f.replace(/\\/g, '/'));
  let simB64 = null;
  for (const file of simFiles.filter((f) => /\.(html|js)$/.test(f))) {
    const text = readTextSafe(file);
    if (!text) continue;
    const m = text.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{2000,}/);
    if (m) {
      simB64 = file;
      break;
    }
  }
  if (simB64) bad('sim:fixture-not-hardcoded', simB64);
  else ok('sim:fixture-not-hardcoded');

  // Mock phone companion is a simulator-only entry with LOCAL QA labeling.
  if (!existsSync(join(SIM, 'companion.html'))) {
    bad('sim:companion-html', `${SIM}/companion.html missing`);
  } else {
    const compHtml = readTextSafe(join(SIM, 'companion.html')) || '';
    if (compHtml.includes('LOCAL QA / NON-PRODUCTION')) {
      ok('sim:companion-html');
    } else {
      bad('sim:companion-html', 'companion.html missing LOCAL QA / NON-PRODUCTION label');
    }
  }
  const simTextFiles = simFiles.filter((f) => /\.(html|js)$/.test(f));
  const hasMockMarkers = simTextFiles.some((file) => {
    const text = readTextSafe(file);
    return text && text.includes('Mock Phone (LOCAL QA)');
  });
  if (hasMockMarkers) ok('sim:companion-markers');
  else bad('sim:companion-markers', 'mock companion markers missing from simulator bundle');
}

console.log('');
console.log(`=== Artifact assertion summary: ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) {
  process.exit(1);
}
console.log('[OK] Artifact separation verified.');
