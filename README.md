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

## Phase 7 - Device Integration Readiness Report

### Official Meta Setup Requirements

VERIFIED
- Web Apps for MRBD are standard HTML/CSS/JS apps and Meta points to Wearables Developer Center for constraints and setup (Meta toolkit README).
- Browser testing with arrow keys is documented in toolkit README.
- Public HTTPS hosting is required for glasses deployment (toolkit README).
- App onboarding flow is documented in toolkit README:
  Meta AI app -> Devices -> Display Glasses settings -> App connections -> Web apps -> Add a web app.

UNKNOWN
- None added in this subsection.

NOT DOCUMENTED IN PUBLIC SOURCE
- Exact mandatory minimum glasses firmware version number for Web Apps.
- Exact mandatory minimum Meta AI phone app version number for Web Apps.

UNABLE TO VERIFY — ACCESS RESTRICTED
- Wearables Developer Center pages with deeper setup details were login-gated in this environment.

NEEDS DEVICE VALIDATION
- End-to-end onboarding wording/UI may differ between iOS/Android app versions.

### Meta Runtime Capability Matrix

| Capability | Status | Evidence Class | Source/Note |
|---|---|---|---|
| 600x600 fixed viewport | Expected/implemented | VERIFIED | Meta toolkit README design constraints |
| D-pad (Arrow keys) navigation | Expected/implemented | VERIFIED | Meta toolkit README browser testing + constraints |
| `.focusable` on interactive controls | Expected/implemented | VERIFIED | Meta toolkit README design constraints |
| Dark background / additive black guidance | Expected/implemented | VERIFIED | Meta toolkit README design constraints |
| Internal list scrolling only | Implemented | PARTIALLY DOCUMENTED | project implementation + MRBD constraints context |
| Safe-zone / eye-box exact px spec | Not confirmed | NOT DOCUMENTED IN PUBLIC SOURCE | no explicit numeric safe-zone found in accessible source |
| devicePixelRatio behavior in MRBD runtime | Not confirmed | REQUIRES DEVICE VALIDATION | hardware/runtime specific |
| Mouse/touch dependency requirement | Avoided | VERIFIED | D-pad-first guidance in toolkit docs |
| Camera direct access in Web App | Not used here | PARTIALLY DOCUMENTED | project constraints + DAT model; exact Web App media API policy requires authenticated docs/device test |
| Microphone/Web Speech support in Web Apps | Not confirmed | UNABLE TO VERIFY — ACCESS RESTRICTED | docs not accessible here |
| Sensor/location support details | Not fully confirmed | UNABLE TO VERIFY — ACCESS RESTRICTED | docs mention sensor testing flow, detailed support matrix gated |
| Storage support | Available in browser generally | PLAUSIBLE BUT UNSOURCED | no Meta-specific guarantee found in accessible source |
| Notification/offline support | Not confirmed | UNKNOWN | no accessible Meta source found |

### Permission UX Findings

- Camera/media permission ownership model for DAT-enabled apps: PARTIALLY DOCUMENTED.
: DAT repos mention permission flows/config simulation topics, but exact Web App prompt ownership (phone vs glasses vs browser) is not fully specified in accessible text.
- Requirement that permission prompt must be triggered by `.focusable` action: NOT DOCUMENTED IN PUBLIC SOURCE.
- D-pad interaction model for permission dialogs: REQUIRES DEVICE VALIDATION.
- Sensor/location permission UX in MRBD Web Apps: UNABLE TO VERIFY — ACCESS RESTRICTED.

### DAT iOS Findings

VERIFIED
- Official iOS DAT SDK repo exists and is active.
- SDK supports wearable app integration including video streaming and photo capture (repo README).
- Toolkit is developer preview.
- Repo references MockDevice testing topics, session lifecycle, camera/photo capture, permissions.

PARTIALLY DOCUMENTED
- Detailed iOS runtime behavior is indicated via references/API docs links, but full API semantics are not fully visible from README alone.

UNKNOWN
- Exact photo payload schema returned to web content.
- Exact bridge callback naming for native-to-web WebView transport.

NOT DOCUMENTED IN PUBLIC SOURCE
- Explicit mandatory WKWebView JS object name for DAT capture in Web Apps.
- Publicly documented DAM/DAT App Model requirement for this web bridge layer.

UNABLE TO VERIFY — ACCESS RESTRICTED
- Full Wearables Developer Center iOS reference pages in this environment.

REQUIRES DEVICE VALIDATION
- Permission-denied flow timing and UX.
- Real capture payload sizes/latency on supported glasses.

### DAT Android Findings

VERIFIED
- Official Android DAT SDK repo exists and is active.
- SDK supports wearable integration including video streaming and photo capture (repo README).
- Developer preview state is documented.
- Artifacts listed include `mwdat-core`, `mwdat-camera`, `mwdat-mockdevice`.

PARTIALLY DOCUMENTED
- High-level camera/mock/session capabilities are documented, but native-to-web bridge details are not fully specified in accessible README text.

UNKNOWN
- Exact photo encoding/metadata details surfaced to web content.

NOT DOCUMENTED IN PUBLIC SOURCE
- Explicit mandatory Android WebView JS interface object name for DAT capture in Web Apps.
- Publicly documented DAM/DAT App Model requirement for this web bridge layer.

UNABLE TO VERIFY — ACCESS RESTRICTED
- Full Wearables Developer Center Android reference pages in this environment.

REQUIRES DEVICE VALIDATION
- Permission UX and runtime callbacks on real phone+glasses pairing.

### DAM / DAT App Model Findings

- Term search target (`DAM`, `DAT App Model`, `app model`, `web container`, `bridge session`) was not confirmed in accessible official README materials.
- Classification: NOT DOCUMENTED IN PUBLIC SOURCE (for public accessible source set used here).

### Native-to-Web Bridge Evidence Matrix

| Platform | Claim | Source | Evidence Strength | Status | Notes / Risk |
|---|---|---|---|---|---|
| iOS | `window.webkit.messageHandlers.*` is mandatory | No explicit Meta public proof found | Low | PLAUSIBLE BUT UNSOURCED | Common WKWebView pattern, not Meta-verified for DAT Web App bridge |
| Android | `window.DATBridge` (or fixed JS interface name) is mandatory | No explicit Meta public proof found | Low | PLAUSIBLE BUT UNSOURCED | Common WebView patterns exist generally, not Meta-verified |
| iOS+Android | A JS bridge exists in some form for native capture handoff | DAT repos + toolkit architecture context | Medium | PARTIALLY DOCUMENTED | Native SDK capability is verified; web bridge envelope naming/details are not |
| iOS+Android | Same bridge contract/object name on both platforms | No Meta source confirming unification | Low | HIGH PRIORITY ARCHITECTURAL RISK | Do not force unification without verified source/device test |
| Current app | Adapter-based fail-closed bridge is appropriate interim design | project code + lack of strict Meta bridge contract evidence | Medium | VERIFIED | Keeps platform differences isolated and safe |

### Future Device Integration Plan

Current Design Strengths
- Capture->sanitize->analyze ordering is explicit.
- DAT bridge is adapter-based with timeout/requestId/fail-closed behavior.
- Desktop mock path is isolated by dev-only env gates.

Known Risks
- Native-to-web bridge envelope/object names are not Meta-verified publicly.
- iOS/Android behavior may diverge in production runtime.

Deferred Decisions
- Platform-specific adapter hardening for iOS and Android bridge object/event schemas.
- Permission UX handling decisions until verified on paired devices.

Blocked By Missing Meta Evidence
- Authoritative WebView bridge object naming/contract details.
- Full capability/permission matrix from authenticated Meta docs.

High Priority Architectural Risks
- Forcing one bridge object/contract across iOS and Android before device verification.

### Deployment Readiness

Verified
- HTTPS hosting requirement documented and implemented as assumption in current flow.
- Build-time env behavior documented (Vite embeds env at build).
- Manifest/icons now present in project.
- Production path disables mock capture/analyze by env guards.

Assumed
- Final deployed origin CORS policy will permit backend analyze endpoint.

Requires Validation
- Real deployed onboarding flow in Meta AI app with target URL.
- Real latency/cold-start UX with production backend.

Unable to Verify
- Any additional Meta policy gating for specific deployment modes from login-gated docs.

### Physical Device Testing Matrix

| Test Area | Platform | Test Case | Expected Behavior | Actual Device Result | Status | Notes |
|---|---|---|---|---|---|---|
| Desktop Browser | Desktop | Mock DAT + mock analyze | End-to-end results flow succeeds |  | Pending | Dev-only harness |
| Desktop Browser | Desktop | Mock DAT + real backend | Sanitizer runs then backend call; result or controlled network/CORS error |  | Pending | CORS dependent |
| Desktop Browser | Desktop | Mocks off production build | Controlled DAT unavailable error |  | Pending | expected on desktop |
| Phone Companion | iOS/Android | Add app via Meta AI flow | App can be added from HTTPS URL |  | Pending | verify exact UI text/version |
| Meta Glasses | MRBD | D-pad navigation in app | Arrow/Enter equivalents control focus/actions |  | Pending | device validation required |
| iOS DAT | iOS + glasses | Native capture path | Capture returns payload to app-side bridge path |  | Pending | bridge schema unknown |
| Android DAT | Android + glasses | Native capture path | Capture returns payload to app-side bridge path |  | Pending | bridge schema unknown |
| Native-Web Bridge | iOS/Android | Request/response envelope | requestId correlation + timeout + error mapping |  | Pending | platform-specific verification needed |
| Privacy/Sanitizer | All | Model missing | Fails closed before backend analyze |  | Pending | verify on deployed runtime |
| Backend/CORS | Deployed HTTPS | Analyze call | Allowed CORS origin + expected response shape |  | Pending | backend config required |
| Manifest/Icons | Deployed HTTPS + app grid | Icon/name display | K Scan name/icons appear correctly |  | Pending | platform rendering specifics |

### Known Unknowns Requiring Meta Verification

- Exact iOS bridge object/handler names.
- Exact Android bridge object/interface names.
- Exact bridge request/response payload contract for capture.
- Camera permission-denied event shape and timing.
- Real capture base64 format and size constraints.
- MRBD runtime devicePixelRatio and viewport behavior details.
- Whether permission prompts are phone-managed, glasses-managed, browser-managed, or mixed.
- D-pad interaction behavior within permission dialogs.
- Microphone/Web Speech support status for Web Apps.
- Official voice/intent handoff path for Web Apps (if any).
- App icon/manifest rendering behavior consistency in production app grid.

### devicePixelRatio / Waveguide Bloom Risk Notes

Classification: REQUIRES DEVICE VALIDATION.

Candidate mitigations (documentation-only, not implemented in this phase):
- Avoid 1px critical lines; prefer thicker outlines where readability is critical.
- Keep focus outlines sufficiently thick and inset-safe near edges.
- Tune glow radius/opacity if bloom/glare reduces clarity outdoors.
- Prefer high-contrast cyan/chrome text and avoid low-contrast greys for primary info.


## Phase 7.1 - Meta Source Reconciliation (Documentation-Only)

This section reconciles Phase 7 classifications using newly available official sources.

Sources used in this reconciliation:
- Meta Help page: https://www.meta.com/help/ai-glasses/621680547224505/ (Updated: 30 weeks ago)
- Official GitHub: `facebookincubator/meta-wearables-webapp` README
- Official GitHub: `facebook/meta-wearables-dat-ios` README
- Official GitHub: `facebook/meta-wearables-dat-android` README

### Phase 7 Baseline Reconciliation Targets

Previously targeted from Phase 7 as non-VERIFIED categories:
- `Official Meta Setup Requirements`: glasses/app version minimums, Developer Mode flow details.
- `Meta Runtime Capability Matrix`: microphone/camera/support matrix, permissions ownership model details.
- `Permission UX Findings`: prompt ownership and D-pad dialog interaction behavior.
- `DAT iOS/Android Findings`: native-to-web bridge naming/contracts.

### Official Meta Setup Requirements (Reconciled)

VERIFIED
- Meta Ray-Ban Display glasses require setup with the Meta AI mobile app. VERIFIED [Source: Meta Help Page, Updated 30 weeks ago]
- Meta AI mobile app is required, mobile-only, and used to pair/manage devices. VERIFIED [Source: Meta Help Page]
- Setup requires a paired phone workflow through the Meta AI mobile app. VERIFIED [Source: Meta Help Page]
- Web Apps for MRBD are standard HTML/CSS/JS apps. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]
- HTTPS hosting is required for Web App deployment to glasses. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]
- Meta AI app Web App add path (Devices -> Display Glasses settings -> App connections -> Web apps -> Add a web app) is documented in official toolkit guidance. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]

UNKNOWN
- Whether Developer Mode persists across app restarts/account changes.
- Whether all testers must always enable Developer Mode in all release-channel scenarios.

NOT DOCUMENTED IN PUBLIC SOURCE
- Exact mandatory minimum glasses firmware version number.
- Exact mandatory minimum Meta AI app version number.

UNABLE TO VERIFY — ACCESS RESTRICTED
- Developer Center pages referenced by GitHub READMEs that may contain detailed versioning/Developer Mode nuance.

REQUIRES DEVICE VALIDATION
- End-to-end app onboarding UI wording variance between iOS and Android app builds.

### Web App Add/Connect Flow (Reconciled)

VERIFIED
- Setup and pairing start from Meta AI mobile app and QR/app-store onboarding path. VERIFIED [Source: Meta Help Page]
- Web App add/connect flow exists via App connections -> Web apps in official toolkit docs. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]

PARTIALLY DOCUMENTED
- In-app sharing flow details and recipient requirements are referenced in broader DAT ecosystem but not fully specified in accessible public source text.

NOT DOCUMENTED IN PUBLIC SOURCE
- Universal Web App menu item-level semantics (Restart/Resume/Permissions) in authoritative public docs from accessible sources.
- Pinning behavior details for every runtime state.

### Meta Runtime Capability Matrix (Reconciled)

VERIFIED
- 600x600 viewport assumption and D-pad-first interaction are official toolkit constraints. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]
- Dark background guidance for additive display is official toolkit guidance. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]
- `.focusable` convention is explicitly part of toolkit constraints. VERIFIED [Source: facebookincubator/meta-wearables-webapp README]

PARTIALLY DOCUMENTED
- DAT repos verify native camera/stream capabilities at SDK level, but this does not directly confirm Web App-native camera support.

NOT DOCUMENTED IN PUBLIC SOURCE
- Public, explicit Web App runtime statement in accessible sources confirming exact support/unsupported status for microphone, notifications, offline, and text input.

UNABLE TO VERIFY — ACCESS RESTRICTED
- Developer Center capability matrix details referenced by READMEs but not accessible here.

REQUIRES DEVICE VALIDATION
- devicePixelRatio behavior, waveguide bloom impacts, and permission prompt interaction mechanics.

### Permission UX (Reconciled)

VERIFIED
- DAT SDK ecosystem includes permission/registration topics in official repos. VERIFIED [Source: facebook/meta-wearables-dat-ios README; facebook/meta-wearables-dat-android README]

PARTIALLY DOCUMENTED
- Permission architecture exists at native SDK layer, but ownership of prompts for Web App runtime (phone vs glasses vs browser) remains unspecified publicly.

UNKNOWN
- Whether permission dialogs are directly D-pad navigable in all contexts.

NOT DOCUMENTED IN PUBLIC SOURCE
- Mandatory `.focusable`-triggered permission request rule text for each permission class.

### DAT iOS / DAT Android Bridge Unknowns (Reconciled)

VERIFIED
- iOS DAT SDK exists and supports wearable integrations with video streaming and photo capture. VERIFIED [Source: facebook/meta-wearables-dat-ios README]
- Android DAT SDK exists and supports wearable integrations with video streaming and photo capture. VERIFIED [Source: facebook/meta-wearables-dat-android README]

NOT DOCUMENTED IN PUBLIC SOURCE
- Mandatory native-to-web bridge object names (`window.webkit.messageHandlers.DATBridge`, `window.DATBridge`, etc.).
- Canonical cross-platform JS bridge envelope names/fields for WebView injection.

HIGH PRIORITY ARCHITECTURAL RISK
- Assuming one identical JS bridge object/contract for iOS and Android without Meta-verified source or device proof.

### Voice / Microphone Reconciliation

VERIFIED
- Product vision can include hands-free experiences at the native DAT/mobile integration level. VERIFIED [Source: DAT iOS/Android READMEs]

PARTIALLY DOCUMENTED
- Native DAT capability does not automatically imply equivalent Web App microphone support.

UNABLE TO VERIFY — ACCESS RESTRICTED
- Definitive current MRBD Web App microphone support statement from Developer Center capability docs in this environment.

### Source Conflicts

SOURCE CONFLICT — NEEDS META CONFIRMATION
- No direct contradiction found between the accessible Meta Help setup article and accessible official GitHub READMEs for setup flow at high level.
- Potential conflict candidates (version minimums, Developer Mode specifics, capability exclusions) remain unresolved due restricted access to deeper official docs.

### Bridge Policy Guardrail Confirmation

- Current adapter-based `src/datBridge.js` remains appropriate interim architecture pending source/device verification.
- This phase does not treat `window.webkit.messageHandlers.*` or `window.DATBridge.*` as mandatory without direct Meta evidence.
