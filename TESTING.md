# TESTING.md — K Scan Glasses Web App

Phase 11.2A — Static Test Inventory and Manual QA Matrix.

---

## 1. Test Philosophy

- **Source-first.** Trust what the code says; verify observable behavior manually.
- **No real bridge assumptions.** `src/datBridge.js` is an adapter abstraction. The dev-only simulator is internal tooling and is not evidence of iOS or Android bridge contracts.
- **No live backend calls in automated tests.** The Render backend (`https://kscan-app-1.onrender.com`) must only be called from manual QA or from a deployed origin. Automated tests use no network.
- **Simulator is dev-only.** `VITE_MOCK_DAT=true` paths are gated by `import.meta.env.DEV`. They are not active in production builds.
- **PASS only when observed.** Do not mark a manual QA row PASS until the exact steps have been followed and the expected result confirmed.
- **Camera and Microphone are UNSUPPORTED on MRBD.** Per official Meta documentation (`docs/meta/Build.txt`), Web Apps do not support Camera, Microphone, Text Input, Offline, or Notifications. DAT capture goes through the native companion app bridge, not direct Web API.

---

## 2. Automated Tests

All commands run from the repo root.

| Command | What it does |
|---|---|
| `npm run verify:models` | Checks that `public/models/blaze_face_full_range.tflite` and all six `public/mediapipe/wasm/` files exist and are non-empty. |
| `npm run build` | Runs `vite build`. Produces `dist/`. Fails on build errors. |
| `npm run test:static` | Runs `scripts/static-tests.js` using Node built-ins only. No network. No browser. Exits non-zero on any FAIL. |
| `npm test` | Full baseline: `verify:models` → `build` → `test:static`. |

Run the full baseline before any PR or deployment:

```sh
npm test
```

Expected clean output: `FAIL: 0`. Review WARNs — one expected WARN is `data:image/jpeg;base64,` in the minified sanitizer bundle (production code, not a leak).

---

## 3. Static Test Coverage

`scripts/static-tests.js` checks the following sections. Each check prints:

```
TEST NAME | EXPECTED | ACTUAL | PASS/FAIL/WARN/MANUAL QA REQUIRED/REQUIRES DEVICE VALIDATION
```

Exit code is non-zero only on FAIL.

### A. Required Files Exist

All of the following must exist:

- `index.html`, `style.css`, `package.json`, `.env.example`, `README.md`
- `docs/meta/Setup.txt`, `docs/meta/Build.txt`, `docs/meta/Test.txt`
- `src/main.js`, `src/navigation.js`, `src/datBridge.js`, `src/api.js`, `src/privacyImageSanitizer.js`
- `scripts/verify-models.js`

Optional (presence noted, not required): `src/voice.js`, `src/flowState.js`.

### B. Dist/Build Asset Integrity

Assumes `npm run build` has already run.

- `dist/index.html` exists.
- `dist/models/blaze_face_full_range.tflite` exists and is `> 0` bytes.
- `dist/mediapipe/wasm/` directory exists with at least one `.wasm` and one `.js` file.
- `dist/assets/` contains at least one `.js` file.

### C. Env Var Inventory

- Scans all `src/*.js` files for `import.meta.env.VITE_*` references.
- FAILs if any referenced `VITE_*` key is missing from `.env.example`.
- WARNs (not FAILs) for `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` if they appear as placeholders only.

### D. Production Leak Scan

**FAIL** if any of these appear in `dist/index.html`:
- `Voice or gesture`, `Voice: available`, `DAT: unavailable`, `DAT: checking`, `Voice: checking`
- `dat-hud`, `DAT: CHECKING`, `ANALYZE: CHECKING` (dev HUD elements)

**WARN** if any of the following appear in the app JS bundle (`dist/assets/index-*.js` only, not the mediapipe vision bundle):
- `VITE_MOCK_*` env var name strings
- Dev scenario enum literals: `permission-denied`, `malformed-image`, `invalid-response`
- `data:image/jpeg;base64,` — expected in the production sanitizer code (not a real leak)
- `data:text/plain;base64,bm90YW5pbWFnZQ==` — malformed-image mock literal (should be dead code)
- `console.log(`, `console.debug(` — debug logging

`voice.js/SpeechRecognition` absent from the app bundle is also verified (PASS = not bundled).

### E. Source Contract Checks

**`src/datBridge.js`:**
- `capturePhoto` is an exported function.
- Mock gate uses both `import.meta.env.DEV` and `VITE_MOCK_DAT`.
- All six scenario strings present: `success`, `permission-denied`, `cancelled`, `timeout`, `invalid-response`, `malformed-image`.
- No hard-coded verified iOS/Android bridge claim wording.
- No `console.log` of base64.

**`src/api.js`:**
- Posts to `/api/analyze`.
- Uses `Content-Type: application/json`.
- Body is `JSON.stringify({ image: ... })`.
- Mock analyze gate uses both `import.meta.env.DEV` and `VITE_MOCK_ANALYZE`.

**`src/privacyImageSanitizer.js`:**
- References local model path (`/models/blaze_face_full_range.tflite`).
- Has fail-closed error handling (try/catch + `SanitizerError`).
- No `console.log` of base64.
- No face bounding box or keypoint data exported.

**`src/navigation.js` / `src/main.js`:**
- `.focusable` selector referenced.
- Hidden views excluded from focus (`.focusable:not(.hidden)`).
- Home subtitle is `"Use D-pad arrows and Enter"` (in `index.html`).
- Dev HUD creation is gated by `import.meta.env.DEV`.
- No HUD diagnostic content in `dist/index.html`.

**`src/voice.js` (if present):**
- Not imported in `src/main.js` (no auto mic prompt).
- No `recognition.start()` at module level.

### F. docs/meta Integrity

- `git diff --exit-code docs/meta/` — FAILs if any tracked file in `docs/meta/` has uncommitted changes.
- All three meta docs (`Setup.txt`, `Build.txt`, `Test.txt`) exist and are non-empty.

---

## 4. Manual QA Matrix

Mark **Status** as PASS only when you have personally observed the expected result by following the exact steps.

### DAT Simulator (dev-only)

Set `VITE_MOCK_DAT=true` and restart `npm run dev` for each scenario.

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| DAT simulator | success (standard image) | `VITE_MOCK_DAT_SCENARIO=success VITE_MOCK_DAT_IMAGE_VARIANT=standard`, press K Scan | Flow: IDLE → CAPTURING → SANITIZING → ANALYZING → SUCCESS; results view renders | MANUAL QA REQUIRED | |
| DAT simulator | success (tiny image) | `VITE_MOCK_DAT_IMAGE_VARIANT=tiny`, press K Scan | Same flow; sanitizer handles 24×24 image | MANUAL QA REQUIRED | |
| DAT simulator | success (large image) | `VITE_MOCK_DAT_IMAGE_VARIANT=large`, press K Scan | Same flow; sanitizer resizes 2000×1500 image | MANUAL QA REQUIRED | |
| DAT simulator | permission-denied | `VITE_MOCK_DAT_SCENARIO=permission-denied`, press K Scan | Error view shows `Camera permission denied.`; analyze NOT called | MANUAL QA REQUIRED | |
| DAT simulator | cancelled | `VITE_MOCK_DAT_SCENARIO=cancelled`, press K Scan | Error view shows `Capture cancelled.`; analyze NOT called | MANUAL QA REQUIRED | |
| DAT simulator | timeout | `VITE_MOCK_DAT_SCENARIO=timeout`, press K Scan | Error view shows `Capture timed out.`; analyze NOT called | MANUAL QA REQUIRED | |
| DAT simulator | invalid-response | `VITE_MOCK_DAT_SCENARIO=invalid-response`, press K Scan | Error view shows `Camera response invalid.`; analyze NOT called | MANUAL QA REQUIRED | |
| DAT simulator | malformed-image | `VITE_MOCK_DAT_SCENARIO=malformed-image`, press K Scan | Flow reaches SANITIZING, then fails closed; error shows `Privacy scan failed. Try again.`; analyze NOT called | MANUAL QA REQUIRED | Critical: backend must not be reached |
| DAT simulator | concurrent capture | Press K Scan twice quickly | Second press blocked; error shows `Capture already in progress.` | MANUAL QA REQUIRED | |

### Privacy Sanitizer

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| Sanitizer | Valid generated image sanitizes | `success` scenario, press K Scan | Sanitizer runs, produces valid JPEG data URL, scan completes | MANUAL QA REQUIRED | Inspect Network tab: no raw capture sent to backend |
| Sanitizer | Malformed image fails closed | `malformed-image` scenario | Sanitizer rejects input; error shown; backend not called | MANUAL QA REQUIRED | |
| Sanitizer | Large image resizes | `large` variant (2000×1500) | Sanitizer scales down to ≤800px; no crash or timeout | MANUAL QA REQUIRED | |
| Sanitizer | Tiny image no crash | `tiny` variant (24×24) | Sanitizer completes without crash | MANUAL QA REQUIRED | |
| Sanitizer | Missing model fails closed | Remove/rename `public/models/blaze_face_full_range.tflite`, press K Scan | `Privacy scan failed. Try again.`; backend not called | MANUAL QA REQUIRED | Restore model after test |
| Sanitizer | No raw image upload before sanitizer success | Observe network during success flow | No request to backend until sanitizer returns sanitized image | MANUAL QA REQUIRED | Use DevTools network tab |

### API / Analyze

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| API | Mock analyze success | `VITE_MOCK_ANALYZE=true`, press K Scan | Results view renders with mock products | MANUAL QA REQUIRED | |
| API | Mock analyze forced error | `VITE_MOCK_ANALYZE=true VITE_MOCK_ANALYZE_ERROR=true` | Error view: `Analysis failed. Please try again.` | MANUAL QA REQUIRED | |
| API | Real backend local test | `VITE_MOCK_ANALYZE=false VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com` | Results from real backend OR controlled network error | MANUAL QA REQUIRED | Backend may cold start 30-60s; CORS from localhost may fail |
| API | Render cold-start handling | Real backend, first call after inactivity | UI shows `Waking up Fashion AI...` at 5s; times out at 25s with `Request timed out.` | MANUAL QA REQUIRED | |
| API | CORS from deployed origin | From deployed HTTPS origin, trigger scan | Backend analyze call succeeds with CORS headers | MANUAL QA REQUIRED | Must test from actual deployed URL |
| API | Backend not configured | `VITE_KSCAN_BACKEND_URL=` (empty), `VITE_MOCK_ANALYZE=false` | Error: `Backend not configured.` | MANUAL QA REQUIRED | |

### Navigation / Focus

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| Navigation | Home K Scan default focus | Load app | `K Scan` button receives initial focus | MANUAL QA REQUIRED | |
| Navigation | ArrowDown movement | Press ArrowDown from K Scan | Focus moves to Library button | MANUAL QA REQUIRED | |
| Navigation | ArrowUp movement | Press ArrowUp from Library | Focus moves back to K Scan | MANUAL QA REQUIRED | |
| Navigation | Enter activation | Focus K Scan, press Enter | Scan starts (processing view shown) | MANUAL QA REQUIRED | |
| Navigation | ArrowLeft / back | From Library view, press ArrowLeft | Returns to Home view | MANUAL QA REQUIRED | |
| Navigation | Hidden views excluded | Confirm focus does not land on elements in hidden screens | Only visible screen elements receive focus | MANUAL QA REQUIRED | |
| Navigation | Results cards focusable | After successful scan, ArrowDown from Back button | Focus cycles through product cards | MANUAL QA REQUIRED | |
| Navigation | Error view keyboard navigable | After any error, ArrowDown | Focus cycles between Try Again and Back Home | MANUAL QA REQUIRED | |

### UI / CSS

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| UI | 600×600 viewport | Chrome DevTools: set viewport to 600×600, load app | Canvas fills exactly 600×600; no partial rendering | MANUAL QA REQUIRED | |
| UI | No body scrollbars | At 600×600, scroll with mouse wheel | No scroll; content stays fixed | MANUAL QA REQUIRED | |
| UI | Safe-zone intact | Review all screens at 600×600 | No text or interactive controls clipped at edges | MANUAL QA REQUIRED | |
| UI | Focus glow visible | Tab or Arrow key through elements | Cyan/bright glow visible on focused element | MANUAL QA REQUIRED | |
| UI | High contrast on black | Review all screens | All text and UI readable on black background | MANUAL QA REQUIRED | |
| UI | No production DAT/Voice diagnostics | Production build, no mocks | No HUD, no `DAT:`, no `ANALYZE:` labels visible in DOM | MANUAL QA REQUIRED | |

### Voice

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| Voice | No production mic prompt | Load production build | No microphone permission request triggered | MANUAL QA REQUIRED | `voice.js` is not imported in `main.js` — verify no prompt |
| Voice | No production voice UI | Load production build | No voice-related UI visible in production DOM | MANUAL QA REQUIRED | |
| Voice | MRBD mic unsupported | — | Microphone is officially UNSUPPORTED on MRBD (per `docs/meta/Build.txt`) | DEFERRED — MANUAL QA REQUIRED | Do not ship voice UI claims before device verification |

### Production / Vercel

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| Production | HTTPS loads | Navigate to deployed URL | App loads over HTTPS; no mixed content warnings | MANUAL QA REQUIRED | |
| Production | Manifest/icons load | DevTools Application tab | Manifest parses; icons resolve; no 404s | MANUAL QA REQUIRED | |
| Production | Model/WASM asset paths | DevTools Network during scan | `/models/blaze_face_full_range.tflite` and `/mediapipe/wasm/*.{js,wasm}` load with 200 | MANUAL QA REQUIRED | |
| Production | No mock DAT/analyze in production | Deploy with `VITE_MOCK_DAT=false VITE_MOCK_ANALYZE=false` | Mock paths do not activate; DAT unavailable on desktop shows controlled error | MANUAL QA REQUIRED | |
| Production | Desktop production fail-closed DAT | Load production build on desktop browser, press K Scan | Error: `Camera bridge unavailable.`; no crash | MANUAL QA REQUIRED | Expected — no DAT bridge on desktop |

### MRBD Hardware (Requires Device)

| Area | Scenario | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| MRBD | App add flow | Meta AI app → Devices → App Connections → Web Apps → Add | App added successfully from HTTPS URL | REQUIRES DEVICE VALIDATION | |
| MRBD | Launch on glasses | Select app from MRBD app grid | App loads and renders | REQUIRES DEVICE VALIDATION | |
| MRBD | Waveguide clipping | Review all screens on glasses | No critical UI clipped at waveguide edge | REQUIRES DEVICE VALIDATION | |
| MRBD | devicePixelRatio | Observe rendering scale on glasses | UI renders at correct scale for MRBD viewport | REQUIRES DEVICE VALIDATION | Exact dPR unknown |
| MRBD | D-pad / Neural Band behavior | Swipe/pinch on Neural Band | Arrow key / Enter events received; navigation works | REQUIRES DEVICE VALIDATION | |
| MRBD | Real native bridge | Press K Scan on glasses | Native bridge captures photo; base64 returned to app | REQUIRES DEVICE VALIDATION | Bridge object names unverified |

---

## 5. Scenario Env Reference

Env changes require restarting `npm run dev` (or rebuilding).

| Scenario | `.env` values |
|---|---|
| success (standard) | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=standard` |
| success (tiny) | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=tiny` |
| success (large) | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=large` |
| permission-denied | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=permission-denied` |
| cancelled | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=cancelled` |
| timeout | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=timeout` |
| invalid-response | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=invalid-response` |
| malformed-image | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=malformed-image` |
| mock analyze success | `VITE_MOCK_ANALYZE=true` `VITE_MOCK_ANALYZE_ERROR=false` |
| mock analyze error | `VITE_MOCK_ANALYZE=true` `VITE_MOCK_ANALYZE_ERROR=true` |
| real backend | `VITE_MOCK_ANALYZE=false` `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com` |
| production preview | `VITE_MOCK_DAT=false` `VITE_MOCK_ANALYZE=false` `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com` |

---

## 6. Known Untestable Areas Without Hardware

The following cannot be verified by automated tests or desktop browser QA:

- Real iOS native bridge object name and photo payload schema.
- Real Android native bridge object name and photo payload schema.
- Real camera capture: base64 format, size, and encoding from physical glasses.
- Real camera permission UX: who owns the dialog (phone vs glasses vs browser).
- Real MRBD viewport dimensions and `devicePixelRatio` at runtime.
- True waveguide bloom and additive display color accuracy indoors/outdoors.
- Neural Band swipe/pinch → Arrow/Enter translation at native OS level.
- Whether Developer Mode persists across paired device restarts.
- Minimum firmware (v125+) and Meta AI app version (v272+) enforcement.

These remain **REQUIRES DEVICE VALIDATION** until physical MRBD + companion phone testing is available.

---

## 7. API / Network Testing Rules

Automated tests in this project must not call:

```
https://kscan-app-1.onrender.com
```

- Any future automated API tests must stub `fetch` entirely.
- Live backend and CORS correctness are manual QA only.
- Render cold starts (30-60 second warm-up after inactivity) can mimic network failures; retry once before concluding CORS/network failure.

---

## 8. MediaPipe / Sanitizer Testing Rules

- MediaPipe WASM execution requires a browser-like runtime (Canvas, ImageBitmap, WebAssembly).
- Node.js automated tests may only statically audit sanitizer source code.
- Real sanitizer pipeline validation (face detection, masking, JPEG re-encode) is manual browser QA only.
- Do not add real user images or external image assets to the repo.
- Future browser-automation testing (Playwright) would require explicit approval.
