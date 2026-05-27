# kscan-glasses-webapp

Standalone web app foundation for K Scan AI on Meta Ray-Ban Display glasses. This repository is intentionally separate from the K Scan mobile app, backend API codebase, and marketing website.

## Current Limitations

- DAT is scaffolded, not device-verified.
- Privacy sanitizer is implemented, but final production packaging still requires physical-device verification.
- Backend API client is scaffolded; production backend testing is pending.
- Supabase sync is not implemented yet.

## Overview

- Fixed `600x600` viewport
- D-pad-first navigation
- DAT bridge capture abstraction
- On-device privacy sanitizer before backend upload
- Guarded backend analyzer client for `POST /api/analyze`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create local env file from example:

```bash
cp .env.example .env
```

3. Run development server:

```bash
npm run dev
```

4. Build:

```bash
npm run build
```

## Environment Variables

- `VITE_KSCAN_BACKEND_URL`
- `VITE_SUPABASE_URL` (placeholder only)
- `VITE_SUPABASE_ANON_KEY` (placeholder only)
- `VITE_META_APP_ID` (reserved)
- `VITE_META_CLIENT_TOKEN` (reserved)
- `VITE_MOCK_DAT`

## Phase 2 - DAT Bridge Verification

- Direct browser camera access is intentionally not used.
- Capture stays behind `capturePhoto()` in `src/datBridge.js`.
- Mock capture only runs when `VITE_MOCK_DAT=true` and not production.

Canonical contract:

Request:
```json
{ "type": "capture-photo", "requestId": "capture_..." }
```

Success response:
```json
{ "type": "photo-captured", "requestId": "capture_...", "base64": "..." }
```

Error response:
```json
{
  "type": "photo-capture-error",
  "requestId": "capture_...",
  "code": "PERMISSION_DENIED",
  "message": "Permission denied"
}
```

Legacy compatibility is retained for `REQUEST_CAPTURE`/`CAPTURE_RESPONSE`.

## Phase 3 - Privacy Sanitizer

Sanitizer pipeline (always before backend upload):

`capturePhoto() -> sanitizeImageBeforeUpload() -> analyzeImage()`

Inside sanitizer:

`decode -> canvas redraw -> resize -> face detect -> black mask -> JPEG re-encode`

Implementation details:

- Package: `@mediapipe/tasks-vision`
- WASM assets: `public/mediapipe/wasm/`
- Model path expected by app: `public/models/blaze_face_full_range.tflite`
- Model binary is stored at `public/models/blaze_face_full_range.tflite` and verified by `npm run verify:models`.
- Face boxes/keypoints are not returned, stored, or logged.
- Raw image/base64/face metadata must not be logged or stored.

MediaPipe output note:

- MediaPipe Face Detector provides bounding boxes/keypoints; this app uses them in-memory for masking only and does not expose them outside `privacyImageSanitizer.js`.

Additive-display note:

- Black privacy masks protect backend upload privacy. On additive displays, black regions can appear transparent.

### Model and Asset Source Notes

WASM/runtime assets:

- Source: npm package `@mediapipe/tasks-vision` (Apache-2.0)
- Copied into: `public/mediapipe/wasm/`
- Copy command: `npm run copy:wasm` (also runs on `postinstall`)

Model binary:

- Expected filename: `blaze_face_full_range.tflite`
- Expected path: `public/models/blaze_face_full_range.tflite`
- Official sample source URL:
  `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite`
- Related model card:
  `https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Full%20Range%29.pdf`
- Retrieval date: 2026-05-27
- Retrieved file size: 1,083,786 bytes
- Selection rationale: full-range is preferred for world-facing/glasses-style capture distance over short-range.
- Model verification command: `npm run verify:models`
- Distribution/license note: `@mediapipe/tasks-vision` package is Apache-2.0; model license details should be rechecked against official model documentation before production redistribution policy is finalized.

### Privacy Testing

Test with mock DAT:

1. Set `VITE_MOCK_DAT=true`
2. Ensure model exists at `public/models/blaze_face_full_range.tflite` (or run `npm run download:models`)
3. Run `npm run dev`
4. Trigger scan

Test sanitizer failure:

1. Set `VITE_MOCK_DAT=true`
2. Remove/missing `public/models/blaze_face_full_range.tflite`
3. Trigger scan
4. App should show `Privacy scan failed. Try again.` and not call backend analyze

Asset setup commands:

1. `npm run copy:wasm`
2. `npm run download:models` (uses official Google MediaPipe sample source URL)
3. `npm run verify:models`

## Phase 4 - Backend Analyze Integration

- Required env var: `VITE_KSCAN_BACKEND_URL`
- Example `.env` value:
  `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com`
- Backend URL is normalized to remove trailing slashes before calling:
  `${normalizedBackendUrl}/api/analyze`
- If backend URL is missing/empty, request is not sent and user sees:
  `Backend not configured.`

Exact request contract:

```json
{ "image": "sanitizedBase64" }
```

Headers:

```json
{ "Content-Type": "application/json" }
```

Privacy rule in scan flow:

`capturePhoto() -> sanitizeImageBeforeUpload() -> analyzeImage(sanitizedBase64) -> render results`

Only sanitized images are sent to backend.

Timeout behavior:

- At 5s while waiting for backend: `Waking up Fashion AI...`
- At 25s: request aborts and user sees `Request timed out. Please try again.`

Error behavior:

- Network/CORS failure: `Cannot reach server. Check connection.`
- Non-2xx: `Analysis failed. Please try again.`
- Invalid JSON/shape: `Unexpected server response.`

Backend CORS note:

- Backend must allow CORS from the deployed glasses web app origin.

Results behavior:

- Display limit is top 5 products.
- Empty or missing products array renders friendly state: `No items identified`.

## Phase 5 - Browser End-to-End Test Harness

Purpose:

- Provide desktop-browser test modes for full scan flow without requiring Meta hardware or always-on backend access.
- Mock analyze is development-only and never bypasses sanitizer.

Environment variables used:

- `VITE_MOCK_DAT`
- `VITE_MOCK_ANALYZE`
- `VITE_MOCK_ANALYZE_DELAY_MS`
- `VITE_MOCK_ANALYZE_ERROR`
- `VITE_KSCAN_BACKEND_URL`

Production safety:

- Mock DAT is active only when `import.meta.env.PROD === false` and `VITE_MOCK_DAT === "true"`.
- Mock analyze is active only when `import.meta.env.DEV === true` and `VITE_MOCK_ANALYZE === "true"`.
- Production builds do not silently run mock DAT or mock analyze.

Flow guarantee:

`capturePhoto() -> sanitizeImageBeforeUpload() -> analyzeImage(sanitizedBase64) -> render results`

Mock analyze validates sanitized input but does not decode/inspect/log/persist image contents.

Run sequence:

1. `npm run copy:wasm`
2. `npm run verify:models`
3. `npm run build`
4. `npm run dev`

Keyboard/D-pad test:

- Keep viewport at 600x600.
- Use Arrow keys + Enter for navigation and activation.

Development HUD:

- In dev only, HUD displays:
  `DAT: [MOCK/READY/MISSING] | ANALYZE: [MOCK/REAL] | BACKEND: [OK/MISSING] | FLOW: [state]`
- In production, HUD is removed from the DOM.

Test matrix:

A. Full local mock path
- `VITE_MOCK_DAT=true`
- `VITE_MOCK_ANALYZE=true`
- Expected: full flow reaches results

B. Real backend path
- `VITE_MOCK_DAT=true`
- `VITE_MOCK_ANALYZE=false`
- `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com`
- Expected: sanitizer then real backend analyze
- Note: CORS for `http://localhost:5173` may be required on backend (or dev proxy if explicitly added later)

C. Backend missing
- `VITE_MOCK_DAT=true`
- `VITE_MOCK_ANALYZE=false`
- `VITE_KSCAN_BACKEND_URL=` (empty)
- Expected: `Backend not configured.`

D. DAT unavailable in desktop browser
- `VITE_MOCK_DAT=false`
- Expected: controlled camera bridge unavailable error

E. Model missing
- Remove/rename local model file
- Expected: `npm run verify:models` fails clearly and runtime sanitizer fails closed

F. Forced mock analyze error
- `VITE_MOCK_DAT=true`
- `VITE_MOCK_ANALYZE=true`
- `VITE_MOCK_ANALYZE_ERROR=true`
- Expected: friendly analysis failure path

Manual local-image test (browser only, no upload):

1. Open app in dev
2. In browser console, call sanitizer with a local image data URL
3. Keep output local unless explicitly passed into app flow

## Local Testing Checklist

- 600x600 layout is enforced
- No global body scrolling
- All interactive controls use `.focusable`
- Arrow keys + Enter navigation works
- DAT mock returns base64
- Sanitizer runs before analyze API call
- Error/retry flow works
- No secrets committed

## Phase 6 - Meta Source Alignment

### Sources consulted

1. Local project files in this repository.
2. Official Meta GitHub repositories:
   - https://github.com/facebookincubator/meta-wearables-webapp
   - https://github.com/facebook/meta-wearables-dat-ios
   - https://github.com/facebook/meta-wearables-dat-android
3. Wearables Developer Center URLs referenced by those repos.

Notes:
- Wearables Developer Center pages and `llms.txt` required login in this environment (`Not Logged In`), so details only available there are marked `UNKNOWN` until verified in an authenticated session.

### Alignment summary

- `meta-wearables-webapp` confirms Web Apps are standard HTML/CSS/JS experiences for MRBD and calls out design constraints including 600x600, D-pad navigation, dark background, and `.focusable` usage.
- DAT iOS repo confirms native iOS SDK availability for hands-free experiences with video streaming/photo capture and includes references to permissions, session lifecycle, and MockDevice testing topics.
- DAT Android repo confirms native Android SDK availability for hands-free experiences with video streaming/photo capture and includes camera/session/MockDevice modules.
- Exact native-to-web bridge object names/events for WebView integration remain `UNKNOWN` from accessible source text and require device/native integration verification.

### Bridge readiness note

- `src/datBridge.js` stays adapter-based and fail-closed.
- Current `window.webkit.messageHandlers` path is compatibility support only, not treated as mandatory.
- iOS/Android platform differences remain isolated to `src/datBridge.js`.

## Deployment Readiness

### Manifest and icons

- Added `public/manifest.webmanifest`.
- Added PNG icons:
  - `public/icons/icon-96.png`
  - `public/icons/icon-192.png`
  - `public/icons/apple-touch-icon-180.png`
- Added corresponding links in `index.html`.
- App short name/name set to `K Scan`.

### Environment and hosting

Required env vars:
- `VITE_MOCK_DAT`
- `VITE_MOCK_ANALYZE`
- `VITE_MOCK_ANALYZE_DELAY_MS`
- `VITE_MOCK_ANALYZE_ERROR`
- `VITE_KSCAN_BACKEND_URL`

Recommended values:

Production:
- `VITE_MOCK_DAT=false`
- `VITE_MOCK_ANALYZE=false`
- `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com`

Local browser E2E:
- `VITE_MOCK_DAT=true`
- `VITE_MOCK_ANALYZE=true`

Local browser with real backend:
- `VITE_MOCK_DAT=true`
- `VITE_MOCK_ANALYZE=false`
- `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com`

Important:
- Vite env vars are baked into build artifacts; env changes require rebuild/redeploy.
- `.env` must never be committed.
- Backend CORS must allow exact deployed HTTPS origin (and localhost only if local real-backend testing is needed).

### Meta setup/testing notes

- HTTPS URL is required for device-side web app installation/testing.
- Browser QA should use 600x600 viewport and Arrow keys + Enter only.
- Production build QA should run with `VITE_MOCK_DAT=false` and `VITE_MOCK_ANALYZE=false`; desktop browser should show controlled DAT-unavailable behavior.
- Meta AI app installation flow for Web Apps should follow current Meta docs (`Devices -> Display Glasses settings -> App connections -> Web apps`).

Version requirements:
- `glasses v125+`: `UNKNOWN` (not verified from accessible official source in this environment).
- `Meta AI app v272+`: `UNKNOWN` (not verified from accessible official source in this environment).

Developer Mode steps:
- "Meta AI app -> Settings/App Info -> tap app version 5x": `UNKNOWN` from accessible source in this environment; verify against authenticated official docs before release testing.

## Manual QA Checklist

Browser/Desktop:
- [ ] Viewport exactly 600x600.
- [ ] Keyboard-only navigation (Arrow keys + Enter).
- [ ] No body scrollbars.
- [ ] Focus ring visible on all `.focusable` controls.
- [ ] Mock DAT + mock analyze reaches results.
- [ ] Mock DAT + real analyze reaches results or controlled network/CORS error.
- [ ] No backend configured shows `Backend not configured.`
- [ ] DAT unavailable shows controlled bridge-unavailable error.
- [ ] Missing model fails closed.
- [ ] Forced mock analyze error shows friendly failure.
- [ ] Results limited to top 5.
- [ ] No blank screens.
- [ ] No raw stack traces shown.
- [ ] Production build served locally with mocks off shows controlled DAT unavailable.

Privacy:
- [ ] Raw image is never sent before sanitizer.
- [ ] No base64 logging.
- [ ] No face metadata returned outside sanitizer.
- [ ] Sanitizer failure blocks backend analyze.

Glasses readiness:
- [ ] Public HTTPS URL prepared.
- [ ] Developer Mode requirements validated from current official docs.
- [ ] App add flow validated in Meta AI app.
- [ ] D-pad/Neural Band navigation validated on device.
- [ ] Processing status text visible.
- [ ] Diagnostic HUD absent from production DOM.
- [ ] Manifest/icons render correctly where supported.

## Known Unknowns Requiring Device Testing

- Exact DAT native-to-web bridge event/object shape on iOS and Android.
- Whether `window.webkit.messageHandlers.DATBridge` is required on iOS (`UNKNOWN`).
- Whether `window.DATBridge.postMessage` or another Android bridge object is required (`UNKNOWN`).
- Camera permission-denied behavior on paired real devices.
- Real capture base64 format/size from device bridge.
- MediaPipe detection performance in actual glasses web runtime.
- Backend CORS/latency from deployed HTTPS origin.
- Additive-display legibility indoors/outdoors.
- Real glasses web view dimensions/devicePixelRatio vs fixed 600x600 CSS.
- Voice path should be source-verified later; do not rely on generic web speech assumptions for production platform behavior.
