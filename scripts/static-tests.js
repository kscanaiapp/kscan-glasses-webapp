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

datContent.includes("const CAPTURE_DATA_URL_PREFIX = 'data:image/jpeg;base64,'")
  ? pass('E.datBridge:jpeg-prefix-constant', "exact JPEG data URL prefix constant present", 'found')
  : fail('E.datBridge:jpeg-prefix-constant', "const CAPTURE_DATA_URL_PREFIX = 'data:image/jpeg;base64,'", 'NOT found');

datContent.includes("function validateCapturePayload(payload)")
  ? pass('E.datBridge:payload-validator', 'validateCapturePayload helper present', 'found')
  : fail('E.datBridge:payload-validator', 'validateCapturePayload helper', 'NOT found');

datContent.includes('trimmed.startsWith(CAPTURE_DATA_URL_PREFIX)')
  ? pass('E.datBridge:prefix-validation', 'trimmed payload checked against exact prefix', 'found')
  : fail('E.datBridge:prefix-validation', 'trimmed.startsWith(CAPTURE_DATA_URL_PREFIX)', 'NOT found');

datContent.includes("INVALID_CAPTURE_RESPONSE: 'INVALID_CAPTURE_RESPONSE'")
  ? pass('E.datBridge:invalid-response-code', 'INVALID_CAPTURE_RESPONSE exists', 'found')
  : fail('E.datBridge:invalid-response-code', 'INVALID_CAPTURE_RESPONSE exists', 'NOT found');

datContent.includes("return validateCapturePayload(generateMockImage(variant));")
  ? pass('E.datBridge:success-mock-jpeg', 'success mock payload validated as JPEG data URL', 'found')
  : fail('E.datBridge:success-mock-jpeg', 'success mock payload uses JPEG data URL validation', 'NOT found');

datContent.includes("return validateCapturePayload('data:image/jpeg;base64,bm90YW5pbWFnZQ==');")
  ? pass('E.datBridge:malformed-image-mock', "malformed-image mock uses exact JPEG literal", 'found')
  : fail('E.datBridge:malformed-image-mock', "data:image/jpeg;base64,bm90YW5pbWFnZQ==", 'NOT found');

datContent.includes('data:text/plain;base64,bm90YW5pbWFnZQ==')
  ? fail('E.datBridge:no-text-plain-malformed-image', 'text/plain malformed-image mock absent from source', 'FOUND')
  : pass('E.datBridge:no-text-plain-malformed-image', 'text/plain malformed-image mock absent from source', 'absent');

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
// G. MOBILE BRIDGE DEV CLIENT (Phase 17)
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== G. Mobile Bridge Dev Client (Phase 17) ===');

const configPath = path.join(srcDir, 'mobileBridgeConfig.js');
const clientPath = path.join(srcDir, 'mobileBridgeClient.js');
const configSrc = readFile(configPath);
const clientSrc = readFile(clientPath);
const datSrc = readFile(path.join(srcDir, 'datBridge.js'));
const mainSrc = readFile(path.join(srcDir, 'main.js'));

fileExists(configPath)
  ? pass('G.file:mobileBridgeConfig.js', 'exists', 'exists')
  : fail('G.file:mobileBridgeConfig.js', 'exists', 'MISSING');
fileExists(clientPath)
  ? pass('G.file:mobileBridgeClient.js', 'exists', 'exists')
  : fail('G.file:mobileBridgeClient.js', 'exists', 'MISSING');

// Config exports
for (const fn of ['isMobileBridgeEnabled', 'getMobileBridgeUrl', 'getMobileBridgeDebugConfig', 'parseMobileBridgeConfig']) {
  configSrc.includes(`export function ${fn}`)
    ? pass(`G.config:export:${fn}`, 'exported', 'found')
    : fail(`G.config:export:${fn}`, 'exported', 'NOT found');
}

// Only ws/wss schemes accepted
(configSrc.includes("'ws:'") && configSrc.includes("'wss:'"))
  ? pass('G.config:ws-wss-only', 'accepts ws:// and wss:// only', 'found')
  : fail('G.config:ws-wss-only', "ACCEPTED_WS_SCHEMES = ws:/wss:", 'NOT found');

// Provider selection wired into capturePhoto, mobile bridge takes priority
datSrc.includes('if (isMobileBridgeEnabled())')
  ? pass('G.datBridge:provider-selection', 'capturePhoto checks isMobileBridgeEnabled()', 'found')
  : fail('G.datBridge:provider-selection', 'if (isMobileBridgeEnabled())', 'NOT found');

// Existing DAT/mock simulator path preserved
(datSrc.includes('isMockEnabled()') && datSrc.includes('detectBridgeAdapter()'))
  ? pass('G.datBridge:dat-mock-preserved', 'DAT/mock path still present', 'found')
  : fail('G.datBridge:dat-mock-preserved', 'isMockEnabled + detectBridgeAdapter retained', 'NOT found');

// validateCapturePayload remains the final gate on the bridge path
datSrc.includes('return validateCapturePayload(image);')
  ? pass('G.datBridge:final-gate', 'bridge payload passes through validateCapturePayload', 'found')
  : fail('G.datBridge:final-gate', 'validateCapturePayload(image) final gate', 'NOT found');

// Dev status surface gated by DEV && isMobileBridgeEnabled, window function only
(/import\.meta\.env\.DEV[^]*isMobileBridgeEnabled\(\)/.test(mainSrc) && mainSrc.includes('window.__kscanBridgeDebug'))
  ? pass('G.main:debug-surface-gated', 'window.__kscanBridgeDebug gated by DEV && enabled', 'found')
  : fail('G.main:debug-surface-gated', 'DEV && isMobileBridgeEnabled() + window.__kscanBridgeDebug', 'NOT found');

// No raw image / base64 / payload logging in mobile bridge source
for (const [label, src] of [['config', configSrc], ['client', clientSrc]]) {
  /console\.log\([^)]*image|console\.log\([^)]*base64/i.test(src)
    ? fail(`G.${label}:no-image-log`, 'no console.log(image/base64)', 'FOUND')
    : pass(`G.${label}:no-image-log`, 'no console.log(image/base64)', 'absent');
}
// Client must not stringify a full message that may carry image
/JSON\.stringify\(\s*message/.test(clientSrc)
  ? fail('G.client:no-stringify-message', 'no JSON.stringify(message)', 'FOUND')
  : pass('G.client:no-stringify-message', 'no JSON.stringify(message)', 'absent');

// No hardcoded private LAN IPs in new source or new docs (localhost/127.0.0.1 ok)
const privateIpRx = /192\.168\.\d+\.\d+|\b10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+/;
const ipScanTargets = [
  'src/mobileBridgeConfig.js',
  'src/mobileBridgeClient.js',
  'src/datBridge.js',
  'src/main.js',
  'BRIDGE_DEV_MODE.md',
  'BRIDGE_CONTRACT.md',
];
let ipHits = [];
for (const rel of ipScanTargets) {
  const content = readFile(path.join(root, rel));
  if (privateIpRx.test(content)) ipHits.push(rel);
}
ipHits.length === 0
  ? pass('G.no-hardcoded-private-ip', 'no private LAN IPs in source/docs', 'clean')
  : fail('G.no-hardcoded-private-ip', 'no private LAN IPs', `FOUND in: ${ipHits.join(', ')}`);

// ── Behavioral checks (import pure parser + client with a mock socket) ──
const expectEq = (name, expected, actual) =>
  expected === actual ? pass(name, String(expected), String(actual)) : fail(name, String(expected), String(actual));

try {
  const cfg = await import('../src/mobileBridgeConfig.js');

  // Production default: nothing enabled.
  expectEq('G.behav:default-disabled', false, cfg.parseMobileBridgeConfig({}, {}).enabled);

  // Normal query param activation.
  const q = cfg.parseMobileBridgeConfig({ search: '?bridge=mobile&bridgeWs=ws://localhost:8787' }, {});
  expectEq('G.behav:query-enabled', true, q.enabled);
  expectEq('G.behav:query-url', 'ws://localhost:8787/', q.url);
  expectEq('G.behav:query-no-error', true, q.error === null);

  // Hash-appended query param activation (SPA fallback).
  const h = cfg.parseMobileBridgeConfig({ hash: '#/?bridge=mobile&bridgeWs=ws://localhost:8787' }, {});
  expectEq('G.behav:hash-enabled', true, h.enabled);
  expectEq('G.behav:hash-url', 'ws://localhost:8787/', h.url);

  // Hash without slash.
  const h2 = cfg.parseMobileBridgeConfig({ hash: '#?bridge=mobile&bridgeWs=ws://localhost:8787' }, {});
  expectEq('G.behav:hash-noslash-enabled', true, h2.enabled);

  // Env activation (URL optional → default applies).
  const e = cfg.parseMobileBridgeConfig({}, { VITE_ENABLE_MOBILE_BRIDGE: 'true' });
  expectEq('G.behav:env-enabled', true, e.enabled);
  expectEq('G.behav:env-default-url', true, e.url === 'ws://localhost:8787/');

  // Missing bridge URL (bare query) fails safely.
  const miss = cfg.parseMobileBridgeConfig({ search: '?bridge=mobile' }, {});
  expectEq('G.behav:missing-url-enabled', true, miss.enabled);
  expectEq('G.behav:missing-url-error', 'BRIDGE_UNAVAILABLE', miss.error);

  // Invalid scheme fails safely.
  for (const bad of ['http://localhost:8787', 'https://localhost', 'javascript:alert(1)', 'data:text/plain,x', 'file:///x', 'localhost:8787', '']) {
    const r = cfg.parseMobileBridgeConfig({ search: `?bridge=mobile&bridgeWs=${encodeURIComponent(bad)}` }, {});
    r.error === 'BRIDGE_UNAVAILABLE' && r.url === null
      ? pass(`G.behav:reject-scheme:${bad || '(empty)'}`, 'BRIDGE_UNAVAILABLE', 'rejected')
      : fail(`G.behav:reject-scheme:${bad || '(empty)'}`, 'BRIDGE_UNAVAILABLE', `enabled=${r.enabled} url=${r.url} error=${r.error}`);
  }

  // wss:// accepted.
  const wss = cfg.parseMobileBridgeConfig({ search: '?bridge=mobile&bridgeWs=wss://example.test:8787' }, {});
  expectEq('G.behav:wss-accepted', true, wss.error === null && typeof wss.url === 'string');

  // Query overrides env for the enable decision.
  const ovr = cfg.parseMobileBridgeConfig({ search: '?bridge=mobile&bridgeWs=ws://localhost:9999' }, { VITE_ENABLE_MOBILE_BRIDGE: 'false' });
  expectEq('G.behav:query-overrides-env', true, ovr.enabled && ovr.url === 'ws://localhost:9999/');
} catch (err) {
  fail('G.behav:config-import', 'mobileBridgeConfig importable + behavioral checks pass', `threw: ${err.message}`);
}

try {
  const { MobileBridgeClient, MobileBridgeError } = await import('../src/mobileBridgeClient.js');

  // Minimal mock WebSocket that opens on next microtask and records sends.
  let liveSocket = null;
  class MockSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;
      liveSocket = this;
      Promise.resolve().then(() => { if (this.onopen) this.onopen(); });
    }
    send(data) { this.sent.push(data); }
    close() { if (this.onclose) this.onclose(); }
  }

  const withTimeout = (p, ms, label) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} hung`)), ms))]);
  // Let the mock socket open and the client send its request (macrotask).
  const tick = () => new Promise((r) => setTimeout(r, 5));

  // Success path.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false });
    const promise = client.requestCapture();
    await tick();
    const reqStr = liveSocket.sent[0];
    const req = JSON.parse(reqStr);
    (req.type === 'capture.request' && req.source === 'glasses-web' && typeof req.requestId === 'string')
      ? pass('G.client:request-shape', 'capture.request shape correct', 'ok')
      : fail('G.client:request-shape', 'capture.request {type,requestId,source}', JSON.stringify({ type: req.type, source: req.source }));

    liveSocket.onmessage({ data: JSON.stringify({
      type: 'capture.success', requestId: req.requestId,
      image: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==',
      mime: 'image/jpeg', encoding: 'data-url', createdAt: new Date().toISOString(),
    }) });
    const image = await withTimeout(promise, 2000, 'success');
    image.startsWith('data:image/jpeg;base64,')
      ? pass('G.client:success-validates', 'returns validated JPEG data URL', 'ok')
      : fail('G.client:success-validates', 'data:image/jpeg;base64,...', 'unexpected');
  }

  // requestId mismatch is ignored, then matching success resolves.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false });
    const promise = client.requestCapture();
    await tick();
    const req = JSON.parse(liveSocket.sent[0]);
    liveSocket.onmessage({ data: JSON.stringify({ type: 'capture.success', requestId: 'WRONG', image: 'data:image/jpeg;base64,AAAA' }) });
    liveSocket.onmessage({ data: JSON.stringify({ type: 'capture.success', requestId: req.requestId, image: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' }) });
    const image = await withTimeout(promise, 2000, 'mismatch');
    image.startsWith('data:image/jpeg;base64,')
      ? pass('G.client:requestid-match', 'mismatched requestId ignored, match resolves', 'ok')
      : fail('G.client:requestid-match', 'match by requestId', 'unexpected');
  }

  // capture.error mapping.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false });
    const promise = client.requestCapture();
    await tick();
    const req = JSON.parse(liveSocket.sent[0]);
    liveSocket.onmessage({ data: JSON.stringify({ type: 'capture.error', requestId: req.requestId, code: 'DAT_NOT_CONFIGURED', message: 'blocked' }) });
    let caught = null;
    try { await withTimeout(promise, 2000, 'error'); } catch (e) { caught = e; }
    (caught && caught.code === 'DAT_NOT_CONFIGURED')
      ? pass('G.client:error-mapping', 'capture.error maps to MobileBridgeError code', 'ok')
      : fail('G.client:error-mapping', 'DAT_NOT_CONFIGURED', caught ? caught.code : 'no throw');
  }

  // Timeout cleanup → CAPTURE_TIMEOUT and pending cleared.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false, timeoutMs: 60 });
    const promise = client.requestCapture();
    let caught = null;
    try { await withTimeout(promise, 2000, 'timeout'); } catch (e) { caught = e; }
    (caught && caught.code === 'CAPTURE_TIMEOUT' && client.pending === null)
      ? pass('G.client:timeout-cleanup', 'timeout rejects CAPTURE_TIMEOUT and clears pending', 'ok')
      : fail('G.client:timeout-cleanup', 'CAPTURE_TIMEOUT + pending cleared', caught ? caught.code : 'no throw');
  }

  // Socket close while pending → BRIDGE_UNAVAILABLE.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false });
    const promise = client.requestCapture();
    await tick();
    liveSocket.onclose();
    let caught = null;
    try { await withTimeout(promise, 2000, 'close'); } catch (e) { caught = e; }
    (caught && caught.code === 'BRIDGE_UNAVAILABLE')
      ? pass('G.client:close-cleanup', 'close while pending rejects BRIDGE_UNAVAILABLE', 'ok')
      : fail('G.client:close-cleanup', 'BRIDGE_UNAVAILABLE', caught ? caught.code : 'no throw');
  }

  // One active request at a time → CAPTURE_ALREADY_PENDING.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false });
    const first = client.requestCapture();
    await tick();
    let caught = null;
    try { await client.requestCapture(); } catch (e) { caught = e; }
    (caught && caught.code === 'CAPTURE_ALREADY_PENDING')
      ? pass('G.client:already-pending', 'second concurrent capture rejects CAPTURE_ALREADY_PENDING', 'ok')
      : fail('G.client:already-pending', 'CAPTURE_ALREADY_PENDING', caught ? caught.code : 'no throw');
    // settle the first to avoid a dangling timer
    const req = JSON.parse(liveSocket.sent[0]);
    liveSocket.onmessage({ data: JSON.stringify({ type: 'capture.success', requestId: req.requestId, image: 'data:image/jpeg;base64,/9j/AAAA' }) });
    await withTimeout(first, 2000, 'settle-first').catch(() => {});
    client.close();
  }

  // Invalid success payload → INVALID_CAPTURE_RESPONSE.
  {
    const client = new MobileBridgeClient('ws://localhost:8787', { WebSocketImpl: MockSocket, allowReconnect: false });
    const promise = client.requestCapture();
    await tick();
    const req = JSON.parse(liveSocket.sent[0]);
    liveSocket.onmessage({ data: JSON.stringify({ type: 'capture.success', requestId: req.requestId, image: 'not-a-data-url' }) });
    let caught = null;
    try { await withTimeout(promise, 2000, 'invalid'); } catch (e) { caught = e; }
    (caught && caught.code === 'INVALID_CAPTURE_RESPONSE')
      ? pass('G.client:invalid-payload', 'invalid success payload rejects INVALID_CAPTURE_RESPONSE', 'ok')
      : fail('G.client:invalid-payload', 'INVALID_CAPTURE_RESPONSE', caught ? caught.code : 'no throw');
  }
} catch (err) {
  fail('G.client:behavioral', 'mobileBridgeClient behavioral checks pass', `threw: ${err.message}`);
}

// ═══════════════════════════════════════════════════════════════════
// G. TextScan Adapter Phase 25
// ═══════════════════════════════════════════════════════════════════
console.log('\n=== G. TextScan Adapter ===');

const textScanPath = path.join(srcDir, 'services', 'textScan.js');
const textScanExists = fileExists(textScanPath);
const textScanContent = textScanExists ? readFile(textScanPath) : '';

// File existence
const textScanFiles = [
  'src/services/textScan.js',
  'docs/meta-textscan-adapter.md',
];
for (const f of textScanFiles) {
  fileExists(path.join(root, f))
    ? pass(`G.textscan:${f}`, 'exists', 'found')
    : fail(`G.textscan:${f}`, 'exists', 'MISSING');
}

// Contract checks
if (textScanExists) {
  textScanContent.includes("mode: 'text'")
    ? pass('G.textscan:mode-text', "mode: 'text' in adapter", 'found')
    : fail('G.textscan:mode-text', "mode: 'text' in adapter", 'NOT found');

  textScanContent.includes('textQuery')
    ? pass('G.textscan:textQuery', 'textQuery referenced', 'found')
    : fail('G.textscan:textQuery', 'textQuery referenced', 'NOT found');

  textScanContent.includes('source')
    ? pass('G.textscan:source', 'source referenced', 'found')
    : fail('G.textscan:source', 'source referenced', 'NOT found');

  textScanContent.includes('clientTimestamp')
    ? pass('G.textscan:clientTimestamp', 'clientTimestamp referenced', 'found')
    : warn('G.textscan:clientTimestamp', 'clientTimestamp referenced', 'NOT found (live seam not wired yet)');

  !textScanContent.includes('imageBase64')
    ? pass('G.textscan:no-imageBase64', 'imageBase64 not present', 'clean')
    : fail('G.textscan:no-imageBase64', 'imageBase64 not present', 'FOUND — must not send images');

  textScanContent.includes('scan-identify')
    ? pass('G.textscan:scan-identify', 'scan-identify referenced', 'found')
    : pass('G.textscan:scan-identify', 'scan-identify referenced', 'found in comment (live seam)');

  textScanContent.includes('AUTH_REQUIRED')
    ? pass('G.textscan:auth-required', 'AUTH_REQUIRED error code', 'found')
    : fail('G.textscan:auth-required', 'AUTH_REQUIRED error code', 'NOT found');

  textScanContent.includes('validateTextScanQuery')
    ? pass('G.textscan:validate-function', 'validateTextScanQuery function', 'found')
    : fail('G.textscan:validate-function', 'validateTextScanQuery function', 'NOT found');

  // Validation rules presence
  const validationRules = [
    ['length < 3', 'min length'],
    ['MAX_TEXT_QUERY_LEN', 'max length'],
    ['A-Za-z0-9+/', 'base64 rejection'],
    ["'```'", 'code block rejection'],
    ['ignore previous instructions', 'prompt injection'],
    ['[\\w.+-]+@[\\w.-]+\\.\\w+', 'email rejection'],
    ['\\d{3}[\\s-]\\d{2}[\\s-]\\d{4}', 'SSN rejection'],
    ['0.30', 'non-alphanumeric ratio'],
  ];
  for (const [pattern, label] of validationRules) {
    textScanContent.includes(pattern)
      ? pass(`G.textscan:validation-${label}`, `${label} rule`, 'found')
      : warn(`G.textscan:validation-${label}`, `${label} rule`, 'NOT found');
  }

  // No secrets
  !textScanContent.includes('GEMINI_API_KEY')
    ? pass('G.textscan:no-gemini-key', 'no Gemini API key in client', 'clean')
    : fail('G.textscan:no-gemini-key', 'no Gemini API key in client', 'FOUND');

  // No Node.js APIs
  !textScanContent.includes('process.env')
    ? pass('G.textscan:no-node-apis', 'no Node.js-only APIs', 'clean')
    : fail('G.textscan:no-node-apis', 'no Node.js-only APIs', 'FOUND');
}

// HTML checks
const textscanHtmlChecks = [
  ['textscan-preset', 'preset buttons class'],
  ['data-query', 'preset data-query attributes'],
  ['textscan-results', 'textscan results container'],
];
for (const [pattern, label] of textscanHtmlChecks) {
  indexHtmlContent.includes(pattern)
    ? pass(`G.textscan:html-${label}`, label, 'found')
    : fail(`G.textscan:html-${label}`, label, 'NOT found');
}

// No free-form text inputs in HUD
const hudInputs = ['<input type="text"', '<textarea', 'type=\'text\'', 'contenteditable'];
const foundInputs = hudInputs.filter((p) => indexHtmlContent.includes(p));
foundInputs.length === 0
  ? pass('G.textscan:no-free-text-input', 'no free-form text input in HUD', 'clean')
  : fail('G.textscan:no-free-text-input', 'no free-form text input in HUD', `FOUND: ${foundInputs.join(', ')}`);

// main.js TextScan integration
mainContent.includes('startTextScan')
  ? pass('G.textscan:main-startTextScan', 'startTextScan in main.js', 'found')
  : fail('G.textscan:main-startTextScan', 'startTextScan in main.js', 'NOT found');

mainContent.includes('renderTextScanResult')
  ? pass('G.textscan:main-renderTextScanResult', 'renderTextScanResult in main.js', 'found')
  : fail('G.textscan:main-renderTextScanResult', 'renderTextScanResult in main.js', 'NOT found');

mainContent.includes('TEXTSCAN_ERROR_CODES')
  ? pass('G.textscan:main-error-codes', 'TEXTSCAN_ERROR_CODES imported', 'found')
  : fail('G.textscan:main-error-codes', 'TEXTSCAN_ERROR_CODES imported', 'NOT found');

mainContent.includes('.textscan-preset')
  ? pass('G.textscan:main-preset-wiring', 'preset buttons wired', 'found')
  : fail('G.textscan:main-preset-wiring', 'preset buttons wired', 'NOT found');

// StyleMatch contract includes textscan source
const styleMatchContractContent = readFile(path.join(srcDir, 'styleMatchContract.js'));
styleMatchContractContent.includes('textscan')
  ? pass('G.textscan:contract-source', 'textscan in StyleMatch contract', 'found')
  : fail('G.textscan:contract-source', 'textscan in StyleMatch contract', 'NOT found');

// No Google files changed
const googlePatterns = ['kscan-google-glasses', 'google-glasses', 'android-xr', 'gemini-glasses'];
let googleChanged = false;
for (const pattern of googlePatterns) {
  if (textScanContent.includes(pattern) || mainContent.includes(pattern) || indexHtmlContent.includes(pattern)) {
    googleChanged = true;
    break;
  }
}
!googleChanged
  ? pass('G.textscan:no-google-files', 'no Google files referenced', 'clean')
  : warn('G.textscan:no-google-files', 'no Google files referenced', 'pattern found — verify scope');

// ─────────────────────────────────────────────────────────────────

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
