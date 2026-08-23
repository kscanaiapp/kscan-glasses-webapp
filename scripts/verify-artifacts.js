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

const PROD = 'dist-production';
const SIM = 'dist-simulator';
const HW = 'dist-hardware';

// Shared scanner: returns the first file whose text contains `needle`.
function findFileContaining(textFiles, needle) {
  for (const file of textFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    if (text.includes(needle)) return file;
  }
  return null;
}

const HARDWARE_BANNER = 'PRIVATE HARDWARE CANDIDATE';

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

  // Production (public demo) must NOT carry the private-candidate banner —
  // the string is dead-code-eliminated from this bundle by construction.
  const prodBannerHit = findFileContaining(prodTextFiles, HARDWARE_BANNER);
  if (prodBannerHit) bad('prod:no-hardware-candidate-flag', `candidate banner in ${prodBannerHit}`);
  else ok('prod:no-hardware-candidate-flag');

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

  // Simulator build must NOT contain the hardware candidate banner.
  const simTextFiles = simFiles.filter((f) => /\.(html|js)$/.test(f));
  const simHardwareBannerHit = findFileContaining(simTextFiles, HARDWARE_BANNER);
  if (simHardwareBannerHit) bad('sim:no-hardware-candidate-flag', `Simulator build contains hardware candidate banner: ${simHardwareBannerHit}`);
  else ok('sim:no-hardware-candidate-flag');

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
  const hasMockMarkers = simTextFiles.some((file) => {
    const text = readTextSafe(file);
    return text && text.includes('Mock Phone (LOCAL QA)');
  });
  if (hasMockMarkers) ok('sim:companion-markers');
  else bad('sim:companion-markers', 'mock companion markers missing from simulator bundle');
}

// ── Hardware candidate artifact ────────────────────────────────────────────
if (!existsSync(join(HW, 'index.html'))) {
  bad('hw:exists', `${HW}/index.html missing — run npm run build:hardware first`);
} else {
  ok('hw:exists');

  const hwFiles = walk(HW).map((f) => f.replace(/\\/g, '/'));
  const hwTextFiles = hwFiles.filter((f) => /\.(html|js|css|json|webmanifest|map)$/.test(f));

  // Candidate banner MUST be present (compile-time flag actually took effect).
  const hwBannerHit = findFileContaining(hwTextFiles, HARDWARE_BANNER);
  if (hwBannerHit) ok('hw:hardware-candidate-flag', hwBannerHit);
  else bad('hw:hardware-candidate-flag', 'Candidate banner missing — flag may be a string or DCE failed');

  // No simulator page or simulator-only markers in the candidate artifact.
  if (hwFiles.some((f) => /simulator\.html$/.test(f))) {
    bad('hw:no-simulator-html', 'simulator.html found in hardware candidate dist');
  } else {
    ok('hw:no-simulator-html');
  }
  if (hwFiles.some((f) => /companion\.html$/.test(f))) {
    bad('hw:no-companion-html', 'mock companion.html found in hardware candidate dist');
  } else {
    ok('hw:no-companion-html');
  }
  const hwSimulatorMarkers = [
    'LOCAL QA / NON-PRODUCTION',
    'Post mock session',
    'inject-session',
    'live-url-token',
    'Mock Phone (LOCAL QA)',
    'KSCAN_COMPANION_FIXTURE_V1',
  ];
  let hwMarkerHit = null;
  for (const marker of hwSimulatorMarkers) {
    const hit = findFileContaining(hwTextFiles, marker);
    if (hit) { hwMarkerHit = `${marker} in ${hit}`; break; }
  }
  if (hwMarkerHit) bad('hw:no-simulator-markers', hwMarkerHit);
  else ok('hw:no-simulator-markers');

  // No localhost transport defaults in the candidate artifact.
  let hwWsHit = null;
  for (const marker of ['ws://localhost', 'localhost:8787']) {
    const hit = findFileContaining(hwTextFiles, marker);
    if (hit) { hwWsHit = hit; break; }
  }
  if (hwWsHit) bad('hw:no-localhost-transport', hwWsHit);
  else ok('hw:no-localhost-transport');

  // Secret scan on the candidate artifact.
  const hwSecretPatterns = [
    { name: 'jwt-like', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
    { name: 'service-role', re: /service_role/i },
    { name: 'supabase-secret', re: /sb_secret_[A-Za-z0-9]/ },
  ];
  let hwSecretHit = null;
  for (const file of hwTextFiles) {
    const text = readTextSafe(file);
    if (!text) continue;
    for (const { name, re } of hwSecretPatterns) {
      if (re.test(text)) { hwSecretHit = `${name} in ${file}`; break; }
    }
    if (hwSecretHit) break;
  }
  if (hwSecretHit) bad('hw:no-secrets', hwSecretHit);
  else ok('hw:no-secrets');
}

console.log('');
console.log(`=== Artifact assertion summary: ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) {
  process.exit(1);
}
console.log('[OK] Artifact separation verified.');
