// Phase 11.2A — Static Test Script
// Node built-ins only. No external dependencies.
// Usage: node scripts/static-tests.js
// Exit code: non-zero only on FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let failCount = 0;
let warnCount = 0;

function row(name, expected, actual, status) {
  console.log(`${name} | ${expected} | ${actual} | ${status}`);
}
function pass(name, expected, actual) { row(name, expected, actual, 'PASS'); }
function fail(name, expected, actual) { failCount++; row(name, expected, actual, 'FAIL'); }
function warn(name, expected, actual) { warnCount++; row(name, expected, actual, 'WARN'); }
function manual(name, expected, actual) { row(name, expected, actual, 'MANUAL QA REQUIRED'); }
function device(name, expected, actual) { row(name, expected, actual, 'REQUIRES DEVICE VALIDATION'); }

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function listDir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function statSize(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

// ═══════════════════════════════════════════════════════════════════
// A. REQUIRED FILES EXIST
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== A. Required Files ===');

const requiredFiles = [
  'index.html',
  'style.css',
  'package.json',
  '.env.example',
  'README.md',
  'docs/meta/Setup.txt',
  'docs/meta/Build.txt',
  'docs/meta/Test.txt',
  'src/main.js',
  'src/navigation.js',
  'src/datBridge.js',
  'src/api.js',
  'src/privacyImageSanitizer.js',
  'scripts/verify-models.js',
];

for (const rel of requiredFiles) {
  const full = path.join(root, rel);
  fileExists(full)
    ? pass(`A.file:${rel}`, 'exists', 'exists')
    : fail(`A.file:${rel}`, 'exists', 'MISSING');
}

// Optional src files — note presence but do not fail if absent
const optionalSrc = ['src/voice.js', 'src/flowState.js'];
for (const rel of optionalSrc) {
  const full = path.join(root, rel);
  row(
    `A.optional:${rel}`,
    'optional',
    fileExists(full) ? 'present' : 'absent',
    'PASS',
  );
}

// ═══════════════════════════════════════════════════════════════════
// B. DIST / BUILD ASSET INTEGRITY
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== B. Dist/Build Asset Integrity ===');

const distHtmlPath  = path.join(root, 'dist', 'index.html');
const distModelPath = path.join(root, 'dist', 'models', 'blaze_face_full_range.tflite');
const distWasmDir   = path.join(root, 'dist', 'mediapipe', 'wasm');
const distAssetsDir = path.join(root, 'dist', 'assets');

fileExists(distHtmlPath)
  ? pass('B.dist/index.html', 'exists', 'exists')
  : fail('B.dist/index.html', 'exists', 'MISSING — run: npm run build');

const modelSize = statSize(distModelPath);
if (modelSize > 0) {
  pass('B.dist/models/blaze_face_full_range.tflite', 'exists (>0 bytes)', `${modelSize} bytes`);
} else if (modelSize === 0) {
  fail('B.dist/models/blaze_face_full_range.tflite', '>0 bytes', 'empty');
} else {
  fail('B.dist/models/blaze_face_full_range.tflite', 'exists', 'MISSING');
}

if (fileExists(distWasmDir)) {
  const wasmFiles  = listDir(distWasmDir);
  const wasmCount  = wasmFiles.filter((f) => f.endsWith('.wasm')).length;
  const jsCount    = wasmFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).length;
  wasmCount > 0
    ? pass('B.dist/mediapipe/wasm contains .wasm', '>= 1 wasm', `${wasmCount} file(s)`)
    : fail('B.dist/mediapipe/wasm contains .wasm', '>= 1 wasm', '0 files');
  jsCount > 0
    ? pass('B.dist/mediapipe/wasm contains .js', '>= 1 js', `${jsCount} file(s)`)
    : fail('B.dist/mediapipe/wasm contains .js', '>= 1 js', '0 files');
} else {
  fail('B.dist/mediapipe/wasm directory', 'exists', 'MISSING');
}

const jsAssets = listDir(distAssetsDir).filter((f) => f.endsWith('.js'));
jsAssets.length > 0
  ? pass('B.dist/assets contains .js', '>= 1 js asset', jsAssets.join(', '))
  : fail('B.dist/assets contains .js', '>= 1 js asset', '0 files');

// ═══════════════════════════════════════════════════════════════════
// C. ENV VAR INVENTORY
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== C. Env Var Inventory ===');

const srcDir = path.join(root, 'src');
const srcFiles = listDir(srcDir).filter((f) => f.endsWith('.js'));
const allSrcContent = srcFiles.map((f) => readFile(path.join(srcDir, f))).join('\n');

const viteVarRx = /import\.meta\.env\.(VITE_[A-Z_]+)/g;
const foundVars = new Set();
let rxMatch;
while ((rxMatch = viteVarRx.exec(allSrcContent)) !== null) foundVars.add(rxMatch[1]);

const envExampleRaw = readFile(path.join(root, '.env.example'));
const exampleKeys = new Set(
  envExampleRaw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0].trim())
    .filter((k) => k.startsWith('VITE_')),
);

row('C.env:vars-in-source', 'non-empty', [...foundVars].join(', '), 'PASS');
row('C.env:vars-in-example', 'non-empty', [...exampleKeys].join(', '), 'PASS');

const supabasePlaceholders = new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);

for (const varName of foundVars) {
  if (exampleKeys.has(varName)) {
    pass(`C.env:${varName}`, 'in .env.example', 'present');
  } else if (supabasePlaceholders.has(varName)) {
    warn(
      `C.env:${varName}`,
      'in .env.example',
      'NOT in .env.example — Supabase placeholder: add as empty key if needed',
    );
  } else {
    fail(`C.env:${varName}`, 'in .env.example', 'NOT in .env.example — add it');
  }
}

// Verify all spec-expected keys are present in source
const specExpectedKeys = [
  'VITE_KSCAN_BACKEND_URL',
  'VITE_MOCK_DAT',
  'VITE_MOCK_DAT_SCENARIO',
  'VITE_MOCK_DAT_DELAY_MS',
  'VITE_MOCK_DAT_IMAGE_VARIANT',
  'VITE_MOCK_ANALYZE',
  'VITE_MOCK_ANALYZE_DELAY_MS',
  'VITE_MOCK_ANALYZE_ERROR',
];
for (const key of specExpectedKeys) {
  foundVars.has(key)
    ? pass(`C.env:${key}-in-src`, 'referenced in src/', 'found')
    : warn(`C.env:${key}-in-src`, 'referenced in src/', 'NOT found via regex — verify manually');
}

// ═══════════════════════════════════════════════════════════════════
// D. PRODUCTION LEAK SCAN
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== D. Production Leak Scan ===');

const distHtmlContent = readFile(distHtmlPath);

// FAIL if forbidden diagnostic strings appear in dist/index.html
const forbiddenInHtml = [
  'Voice or gesture',
  'Voice: available',
  'DAT: unavailable',
  'DAT: checking',
  'Voice: checking',
];
for (const s of forbiddenInHtml) {
  distHtmlContent.includes(s)
    ? fail(`D.html-forbidden:"${s}"`, 'absent from dist/index.html', 'FOUND')
    : pass(`D.html-forbidden:"${s}"`, 'absent from dist/index.html', 'absent');
}

// Also check for HUD/diagnostic content that should only exist in dev DOM
const devDomStrings = ['dat-hud', 'DAT: CHECKING', 'ANALYZE: CHECKING'];
for (const s of devDomStrings) {
  distHtmlContent.includes(s)
    ? fail(`D.html-dev-dom:"${s}"`, 'absent from dist/index.html', 'FOUND — HUD leaked into prod HTML')
    : pass(`D.html-dev-dom:"${s}"`, 'absent from dist/index.html', 'absent');
}

// WARN (not FAIL) if potential leak strings appear in app JS bundle
// Scope only to app JS, not the mediapipe vision_bundle which is third-party
const appJsFiles = jsAssets.filter((f) => !f.startsWith('vision_bundle'));
const appJsContent = appJsFiles.map((f) => readFile(path.join(distAssetsDir, f))).join('\n');

const potentialLeaks = [
  { s: 'VITE_MOCK_DAT',                          ctx: 'env var name' },
  { s: 'VITE_MOCK_ANALYZE',                       ctx: 'env var name' },
  { s: 'VITE_MOCK_DAT_SCENARIO',                  ctx: 'env var name' },
  { s: 'permission-denied',                        ctx: 'dev scenario enum' },
  { s: 'malformed-image',                          ctx: 'dev scenario enum' },
  { s: 'invalid-response',                         ctx: 'dev scenario enum' },
  { s: 'data:image/jpeg;base64,',                  ctx: 'sanitizer prefix (non-dev, expected in bundle)' },
  { s: 'data:text/plain;base64,bm90YW5pbWFnZQ==', ctx: 'malformed-image mock literal (dev-only path)' },
  { s: 'console.log(',                             ctx: 'debug logging' },
  { s: 'console.debug(',                           ctx: 'debug logging' },
];

for (const { s, ctx } of potentialLeaks) {
  if (distHtmlContent.includes(s)) {
    fail(`D.leak-html:"${s}"`, 'absent from dist/index.html', `FOUND in HTML — ${ctx}`);
  } else if (appJsContent.includes(s)) {
    warn(`D.leak-js:"${s}"`, 'absent from app bundle', `found in minified JS — ${ctx}`);
  } else {
    pass(`D.leak:"${s}"`, 'absent from dist', 'absent');
  }
}

// Check voice.js is NOT bundled (SpeechRecognition should not be in prod app JS)
if (appJsContent.includes('SpeechRecognition') || appJsContent.includes('initVoice')) {
  warn(
    'D.voice-not-bundled',
    'voice.js/SpeechRecognition absent from app bundle',
    'FOUND in app bundle — voice.js appears to be bundled; verify no auto-mic-prompt',
  );
} else {
  pass('D.voice-not-bundled', 'voice.js/SpeechRecognition absent from app bundle', 'absent');
}

// ═══════════════════════════════════════════════════════════════════
// E. SOURCE CONTRACT STATIC CHECKS
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== E. Source Contract Checks ===');

// ── datBridge.js ──────────────────────────────────────────────────
const datContent  = readFile(path.join(srcDir, 'datBridge.js'));
const apiContent  = readFile(path.join(srcDir, 'api.js'));
const sanitizerContent = readFile(path.join(srcDir, 'privacyImageSanitizer.js'));
const navContent  = readFile(path.join(srcDir, 'navigation.js'));
const mainContent = readFile(path.join(srcDir, 'main.js'));

/export\s+(async\s+)?function\s+capturePhoto/.test(datContent)
  ? pass('E.datBridge:capturePhoto-exported', 'export async function capturePhoto', 'found')
  : fail('E.datBridge:capturePhoto-exported', 'export async function capturePhoto', 'NOT found');

(datContent.includes('import.meta.env.DEV') && datContent.includes('VITE_MOCK_DAT'))
  ? pass('E.datBridge:mock-gate', 'DEV && VITE_MOCK_DAT gate', 'found')
  : fail('E.datBridge:mock-gate', 'import.meta.env.DEV + VITE_MOCK_DAT', 'NOT found');

const requiredScenarios = ['success', 'permission-denied', 'cancelled', 'timeout', 'invalid-response', 'malformed-image'];
const missingScenarios  = requiredScenarios.filter((s) => !datContent.includes(`'${s}'`));
missingScenarios.length === 0
  ? pass('E.datBridge:all-6-scenarios', 'all scenario strings present', 'found')
  : fail('E.datBridge:all-6-scenarios', 'all 6 scenarios', `missing: ${missingScenarios.join(', ')}`);

// No explicit claim of verified iOS/Android bridge object names
const verifiedClaims = ['verified iOS bridge', 'verified Android bridge', 'mandatory bridge object', 'confirmed bridge'];
const foundClaims = verifiedClaims.filter((c) => datContent.toLowerCase().includes(c.toLowerCase()));
foundClaims.length === 0
  ? pass('E.datBridge:no-verified-bridge-claim', 'no hard-coded verified bridge claim', 'clean')
  : warn('E.datBridge:no-verified-bridge-claim', 'no verified bridge claim wording', `found: ${foundClaims.join(', ')}`);

/console\.log.*base64/i.test(datContent)
  ? fail('E.datBridge:no-base64-log', 'no console.log(base64)', 'FOUND — remove before production')
  : pass('E.datBridge:no-base64-log', 'no console.log(base64)', 'absent');

// ── api.js ────────────────────────────────────────────────────────
apiContent.includes('/api/analyze')
  ? pass('E.api:endpoint', 'POST to /api/analyze', 'found')
  : fail('E.api:endpoint', '/api/analyze', 'NOT found');

(apiContent.includes("'Content-Type': 'application/json'") || apiContent.includes('"Content-Type": "application/json"'))
  ? pass('E.api:content-type', 'Content-Type: application/json', 'found')
  : fail('E.api:content-type', 'Content-Type: application/json', 'NOT found');

/JSON\.stringify\(\s*\{[^}]*image/.test(apiContent)
  ? pass('E.api:body-shape', 'JSON.stringify({image:...})', 'found')
  : fail('E.api:body-shape', 'JSON.stringify({image:...})', 'NOT found');

(apiContent.includes('import.meta.env.DEV') && apiContent.includes('VITE_MOCK_ANALYZE'))
  ? pass('E.api:mock-analyze-gate', 'DEV && VITE_MOCK_ANALYZE gate', 'found')
  : fail('E.api:mock-analyze-gate', 'import.meta.env.DEV + VITE_MOCK_ANALYZE', 'NOT found');

// ── privacyImageSanitizer.js ──────────────────────────────────────
(sanitizerContent.includes('/models/blaze_face_full_range.tflite') || sanitizerContent.includes('FACE_MODEL_PATH'))
  ? pass('E.sanitizer:local-model-path', 'local model path referenced', 'found')
  : fail('E.sanitizer:local-model-path', '/models/blaze_face_full_range.tflite', 'NOT found');

(sanitizerContent.includes('SanitizerError') && /try\s*\{/.test(sanitizerContent))
  ? pass('E.sanitizer:fail-closed', 'fail-closed with SanitizerError', 'found')
  : fail('E.sanitizer:fail-closed', 'SanitizerError + try/catch fail-closed', 'NOT found');

/console\.log.*base64/i.test(sanitizerContent)
  ? fail('E.sanitizer:no-base64-log', 'no console.log(base64)', 'FOUND')
  : pass('E.sanitizer:no-base64-log', 'no console.log(base64)', 'absent');

// Face metadata must not be exported (no bounding box / keypoint export)
const sanitizerExports = [...sanitizerContent.matchAll(/export\s+(async\s+)?(function|const|class)\s+(\w+)/g)].map((m) => m[3]);
const faceMetaExports  = sanitizerExports.filter((n) => /box|bound|keypoint|landmark|detect/i.test(n));
faceMetaExports.length === 0
  ? pass('E.sanitizer:no-face-metadata-export', 'no face bbox/keypoint exports', `exports: ${sanitizerExports.join(', ')}`)
  : fail('E.sanitizer:no-face-metadata-export', 'no face metadata export', `suspicious: ${faceMetaExports.join(', ')}`);

// ── navigation.js / main.js ───────────────────────────────────────
(navContent.includes('.focusable') || mainContent.includes('.focusable'))
  ? pass('E.nav:focusable-referenced', '.focusable in nav/main', 'found')
  : fail('E.nav:focusable-referenced', '.focusable selector', 'NOT found');

navContent.includes('.focusable:not([disabled]):not(.hidden)') || navContent.includes('.focusable:not(.hidden)')
  ? pass('E.nav:hidden-exclusion', 'hidden elements excluded from focus', 'found')
  : warn('E.nav:hidden-exclusion', '.focusable:not(.hidden) exclusion', 'NOT found — verify hidden views are excluded');

const indexHtmlContent = readFile(path.join(root, 'index.html'));
indexHtmlContent.includes('Use D-pad arrows and Enter')
  ? pass('E.nav:home-subtitle', 'subtitle = "Use D-pad arrows and Enter"', 'found')
  : fail('E.nav:home-subtitle', '"Use D-pad arrows and Enter"', 'NOT found');

// HUD must be gated by import.meta.env.DEV in main.js
/import\.meta\.env\.DEV[^\n]*hud|hud[^\n]*import\.meta\.env\.DEV/.test(mainContent)
  ? pass('E.main:hud-dev-gated', 'HUD gated by import.meta.env.DEV', 'found')
  : fail('E.main:hud-dev-gated', 'HUD only in import.meta.env.DEV block', 'NOT found');

// No production diagnostic labels in dist HTML
const prodDiagnostics = ['dat-hud', 'DAT: mock', 'DAT: ready', 'ANALYZE: MOCK', 'ANALYZE: REAL', 'BACKEND: OK'];
const diagInHtml = prodDiagnostics.filter((d) => distHtmlContent.includes(d));
diagInHtml.length === 0
  ? pass('E.main:no-prod-diagnostics-html', 'no HUD diagnostic in dist/index.html', 'clean')
  : fail('E.main:no-prod-diagnostics-html', 'no HUD/diagnostic in dist/index.html', `FOUND: ${diagInHtml.join(', ')}`);

// ── voice.js (if present) ─────────────────────────────────────────
const voicePath = path.join(srcDir, 'voice.js');
if (fileExists(voicePath)) {
  const voiceContent = readFile(voicePath);

  // Must NOT be imported in main.js (no auto-mic-prompt)
  const voiceImportedInMain = /from\s+['"]\.\/voice(?:\.js)?['"]/.test(mainContent);
  voiceImportedInMain
    ? warn('E.voice:not-imported-in-main', 'voice.js not imported in main.js', 'IMPORTED — verify no auto mic prompt')
    : pass('E.voice:not-imported-in-main', 'voice.js not imported in main.js', 'confirmed not imported');

  // recognition.start() must not be at module level (would auto-trigger mic)
  const autoStart = /^\s*recognition\.start\(\)/m.test(voiceContent);
  autoStart
    ? fail('E.voice:no-auto-mic-start', 'no auto recognition.start() at module level', 'FOUND — auto mic prompt risk')
    : pass('E.voice:no-auto-mic-start', 'no auto recognition.start() at module level', 'absent');
}

// ═══════════════════════════════════════════════════════════════════
// F. docs/meta INTEGRITY
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== F. docs/meta Integrity ===');

try {
  execSync('git diff --exit-code docs/meta/', { cwd: root, stdio: 'pipe' });
  pass('F.docs-meta:git-diff', 'docs/meta/ unchanged', 'clean');
} catch {
  fail('F.docs-meta:git-diff', 'docs/meta/ unchanged', 'HAS UNCOMMITTED CHANGES — run: git diff docs/meta/');
}

const metaDir = path.join(root, 'docs', 'meta');
for (const doc of ['Setup.txt', 'Build.txt', 'Test.txt']) {
  const docPath = path.join(metaDir, doc);
  if (!fileExists(docPath)) {
    fail(`F.docs-meta:${doc}`, 'exists', 'MISSING');
  } else {
    const sz = statSize(docPath);
    sz > 0
      ? pass(`F.docs-meta:${doc}`, 'exists and non-empty', `${sz} bytes`)
      : fail(`F.docs-meta:${doc}`, 'non-empty', 'exists but empty');
  }
}

// ═══════════════════════════════════════════════════════════════════
// MANUAL QA / DEVICE VALIDATION NOTES
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== Manual QA / Device Validation Notes ===');
manual('QA.sanitizer:real-mediapipe',  'MediaPipe WASM runs in browser',         'browser runtime required — not testable in Node');
manual('QA.api:live-backend',          'POST /api/analyze from deployed origin',  'manual test only — no automated live backend calls');
manual('QA.nav:d-pad-feel',            'D-pad navigation responds correctly',     'requires 600x600 browser QA');
manual('QA.ui:600x600-layout',         '600x600 canvas, no scrollbars',           'requires browser QA');
manual('QA.ui:focus-glow',             'focus glow visible on focusable elements','requires browser + keyboard');
manual('QA.ui:additive-contrast',      'UI visible on black/additive background', 'requires browser QA');
device('QA.mrbd:d-pad-neural-band',    'D-pad/Neural Band controls app on MRBD',  'requires physical Meta Ray-Ban Display glasses');
device('QA.mrbd:waveguide-visibility', 'UI visible on additive waveguide display', 'requires physical MRBD device');
device('QA.dat:ios-bridge',            'iOS native bridge captures real photo',    'requires iOS + paired MRBD glasses');
device('QA.dat:android-bridge',        'Android native bridge captures real photo','requires Android + paired MRBD glasses');
device('QA.mrbd:devpixelratio',        'devicePixelRatio matches MRBD runtime',    'requires physical device');

// ═══════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== Summary ===');
console.log(`FAIL:  ${failCount}`);
console.log(`WARN:  ${warnCount}`);

if (failCount > 0) {
  console.error(`\n[FAIL] ${failCount} check(s) failed. See above.`);
  process.exit(1);
} else {
  console.log('\n[OK] All hard checks passed. Review WARNs and manual QA notes above.');
  process.exit(0);
}
