# QA Results Template — K Scan Glasses Web App

Phase 11.2B — Human Manual QA Results

**Tester:** ___________________________
**Date:** ___________________________
**Browser:** ___________________________
**OS:** ___________________________
**Node version:** ___________________________

---

## Instructions

- Fill in **Actual result**, **Status**, **Severity**, **Screenshot path / note**, **Console errors**, and **Notes** for every row you test.
- Do not mark any row **PASS** unless you personally observed the expected result.
- Leave rows you have not tested as **MANUAL QA REQUIRED** or **REQUIRES DEVICE VALIDATION**.
- Copy this file to `QA-RESULTS-YYYYMMDD.md` before filling it in so the template stays blank for future runs.

Status values: `PASS` · `FAIL` · `WARN` · `MANUAL QA REQUIRED` · `REQUIRES DEVICE VALIDATION` · `DEFERRED`
Severity values: `P0 blocker` · `P1 high` · `P2 medium` · `P3 polish` · `Informational`

---

## Section 0: Automated Baseline

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Automated | npm test | (none) | Run `npm test` in terminal | `FAIL: 0 WARN: 1` exit 0 | | MANUAL QA REQUIRED | | | | |
| Automated | npm run verify:models | (none) | Run `npm run verify:models` | `[verify:models] Model and MediaPipe WASM assets verified.` | | MANUAL QA REQUIRED | | | | |
| Automated | npm run build | (none) | Run `npm run build` | vite build completes, no errors | | MANUAL QA REQUIRED | | | | |
| Automated | npm run test:static | (none) | Run `npm run test:static` | `FAIL: 0 WARN: 1` | | MANUAL QA REQUIRED | | | | |

---

## Section 1: Dev Server Startup

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Dev server | Server starts | `VITE_MOCK_DAT=true VITE_MOCK_ANALYZE=true` | Run `npm run dev`; open printed URL in Chrome | Server prints local URL; browser shows app | | MANUAL QA REQUIRED | | | | Note the actual port Vite chose |
| Dev server | Dev HUD visible | `VITE_MOCK_DAT=true` | Load app in dev; look at bottom of 600×600 canvas | HUD shows `DAT: MOCK \| ANALYZE: MOCK \| BACKEND: OK \| FLOW: IDLE` | | MANUAL QA REQUIRED | | | | |

---

## Section 2: Viewport and Layout

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| UI layout | 600×600 viewport | any dev env | DevTools → Toggle device → 600×600 | Canvas fills exactly 600×600; no scrollbars | | MANUAL QA REQUIRED | P2 medium | | | |
| UI layout | No body scrollbars | any dev env | At 600×600, scroll with mouse wheel | No scroll; content fixed | | MANUAL QA REQUIRED | P1 high | | | |
| UI layout | Safe-zone intact | any dev env | Review all screens at 600×600 | No text or buttons clipped at edges | | MANUAL QA REQUIRED | P1 high | | | |
| UI layout | High contrast on black | any dev env | Review all screens | All text and UI readable against black background | | MANUAL QA REQUIRED | P2 medium | | | |
| UI layout | Focus glow visible | any dev env | Tab or Arrow key through elements | Cyan glow/border visible on focused element | | MANUAL QA REQUIRED | P2 medium | | | |

---

## Section 3: Keyboard / D-pad Navigation

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Navigation | Initial focus on K Scan | `VITE_MOCK_DAT=true` | Load app; do not press any key | K Scan button has visible focus indicator | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | ArrowDown to Library | `VITE_MOCK_DAT=true` | From K Scan, press ArrowDown | Focus moves to Library button | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | ArrowDown to Settings | `VITE_MOCK_DAT=true` | From Library, press ArrowDown | Focus moves to Settings button | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | ArrowUp back to Library | `VITE_MOCK_DAT=true` | From Settings, press ArrowUp | Focus returns to Library | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | ArrowUp back to K Scan | `VITE_MOCK_DAT=true` | From Library, press ArrowUp | Focus returns to K Scan | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | Enter activates K Scan | `VITE_MOCK_DAT=true VITE_MOCK_ANALYZE=true` | Focus K Scan; press Enter | Scan starts; processing view appears | | MANUAL QA REQUIRED | P0 blocker | | | |
| Navigation | ArrowLeft returns to Home | `VITE_MOCK_DAT=true` | During processing, press ArrowLeft (or cancel) | Returns to Home view | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | Library view opens | `VITE_MOCK_DAT=true` | ArrowDown to Library; Enter | Library screen appears | | MANUAL QA REQUIRED | P2 medium | | | |
| Navigation | Library back | `VITE_MOCK_DAT=true` | In Library; ArrowLeft | Returns to Home | | MANUAL QA REQUIRED | P2 medium | | | |
| Navigation | Settings view opens | `VITE_MOCK_DAT=true` | ArrowDown×2; Enter | Settings screen appears | | MANUAL QA REQUIRED | P2 medium | | | |
| Navigation | Settings back | `VITE_MOCK_DAT=true` | In Settings; ArrowLeft | Returns to Home | | MANUAL QA REQUIRED | P2 medium | | | |
| Navigation | Hidden views excluded | any | Tab/Arrow through home | Focus does not land on elements in hidden screens | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | Error view keyboard | `VITE_MOCK_DAT_SCENARIO=permission-denied` | Trigger error; use ArrowDown | Focus moves between Try Again and Back Home | | MANUAL QA REQUIRED | P1 high | | | |
| Navigation | Results cards focusable | `success` scenario | After scan; ArrowDown from Back | Focus cycles through product cards | | MANUAL QA REQUIRED | P1 high | | | |

---

## Section 4: DAT Simulator — Capture Scenarios

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| DAT simulator | success (standard) | `VITE_MOCK_DAT=true` `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=standard` `VITE_MOCK_ANALYZE=true` | Restart dev; load; K Scan Enter | Flow: CAPTURING→SANITIZING→ANALYZING→SUCCESS; results render | | MANUAL QA REQUIRED | P0 blocker | | | |
| DAT simulator | success (tiny 24×24) | `VITE_MOCK_DAT_IMAGE_VARIANT=tiny` | Same as above | Same full flow; no crash on 24×24 image | | MANUAL QA REQUIRED | P1 high | | | |
| DAT simulator | success (large 2000×1500) | `VITE_MOCK_DAT_IMAGE_VARIANT=large` | Same as above | Same full flow; sanitizer resizes image; no crash | | MANUAL QA REQUIRED | P1 high | | | |
| DAT simulator | permission-denied | `VITE_MOCK_DAT_SCENARIO=permission-denied` | Restart dev; K Scan Enter | Error: `Camera permission denied.`; analyze NOT called | | MANUAL QA REQUIRED | P0 blocker | | | Check Network tab: no POST to analyze |
| DAT simulator | cancelled | `VITE_MOCK_DAT_SCENARIO=cancelled` | Restart dev; K Scan Enter | Error: `Capture cancelled.`; analyze NOT called | | MANUAL QA REQUIRED | P1 high | | | |
| DAT simulator | timeout | `VITE_MOCK_DAT_SCENARIO=timeout` | Restart dev; K Scan Enter; wait ~10s | Error: `Capture timed out.`; analyze NOT called | | MANUAL QA REQUIRED | P1 high | | | Scenario waits for full 10 000ms timeout |
| DAT simulator | invalid-response | `VITE_MOCK_DAT_SCENARIO=invalid-response` | Restart dev; K Scan Enter | Error: `Camera response invalid.`; analyze NOT called | | MANUAL QA REQUIRED | P1 high | | | |
| DAT simulator | malformed-image | `VITE_MOCK_DAT_SCENARIO=malformed-image` | Restart dev; K Scan Enter; watch Network | Flow reaches SANITIZING then ERROR; error: `Privacy scan failed. Try again.`; NO POST to /api/analyze | | MANUAL QA REQUIRED | P0 blocker | | | Network tab is critical — backend must not be called |
| DAT simulator | concurrent capture guard | `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_DELAY_MS=3000` | Activate K Scan; immediately press Enter again | Second activation blocked; first scan completes normally | | MANUAL QA REQUIRED | P2 medium | | | |

---

## Section 5: Mock Analyze

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Mock analyze | Success | `VITE_MOCK_ANALYZE=true` `VITE_MOCK_ANALYZE_ERROR=false` | success capture; K Scan Enter | Results view with up to 5 mock products; no network request | | MANUAL QA REQUIRED | P0 blocker | | | |
| Mock analyze | Forced error | `VITE_MOCK_ANALYZE=true` `VITE_MOCK_ANALYZE_ERROR=true` | success capture; K Scan Enter | Error: `Analysis failed. Please try again.`; no network request | | MANUAL QA REQUIRED | P1 high | | | |

---

## Section 6: Privacy Sanitizer

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Sanitizer | Sanitized payload sent (not raw) | `VITE_MOCK_ANALYZE=false` `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com` | success capture; watch Network → POST /api/analyze → Payload | Payload `{"image":"data:image/jpeg;base64,..."}` — sanitized JPEG, not raw capture | | MANUAL QA REQUIRED | P0 blocker | | | Raw base64 must NOT appear before sanitizer runs |
| Sanitizer | Missing model fails closed | model file renamed away | mv model.bak; start dev; K Scan Enter; watch Network | Error: `Privacy scan failed. Try again.`; NO POST to /api/analyze | | MANUAL QA REQUIRED | P0 blocker | | | Restore model after test |
| Sanitizer | Large image no crash | `VITE_MOCK_DAT_IMAGE_VARIANT=large` | success scenario; K Scan Enter | Scan completes; no crash; no console error | | MANUAL QA REQUIRED | P1 high | | | |
| Sanitizer | Tiny image no crash | `VITE_MOCK_DAT_IMAGE_VARIANT=tiny` | success scenario; K Scan Enter | Scan completes; no crash | | MANUAL QA REQUIRED | P2 medium | | | |
| Sanitizer | No base64 in console | any success scenario | DevTools → Console during full scan flow | No base64 strings printed to console at any point | | MANUAL QA REQUIRED | P0 blocker | | | Copy any console output here |
| Sanitizer | No face metadata in console | any success scenario with a face in image | DevTools → Console during scan | No bounding box coordinates or keypoint data printed | | MANUAL QA REQUIRED | P1 high | | | Mock image has no real face; observe console is silent |

---

## Section 7: API / Backend

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| API | Backend not configured | `VITE_MOCK_ANALYZE=false` `VITE_KSCAN_BACKEND_URL=` (empty) | success capture; K Scan Enter | Error immediately: `Backend not configured.`; no network request | | MANUAL QA REQUIRED | P1 high | | | |
| API | Real backend — cold start delay | `VITE_MOCK_ANALYZE=false` `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com` | First call after backend idle; watch processing text | After ~5s: `Waking up Fashion AI...` appears; then result or timeout | | MANUAL QA REQUIRED | P2 medium | | | Render cold start ~30-60s after inactivity |
| API | Real backend — success or CORS | same | success capture; watch Network | Either: results render (200 OK) OR: Console shows CORS error + app shows `Cannot reach server.` | | MANUAL QA REQUIRED | P1 high | | | CORS may block localhost; record exact error |
| API | Backend timeout | `VITE_KSCAN_BACKEND_URL` pointing to unreachable URL or with network blocked | success capture; wait 25s | Error: `Request timed out. Please try again.` | | MANUAL QA REQUIRED | P2 medium | | | Block the URL in DevTools Network if needed |

---

## Section 8: Production Preview

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Production | Server starts and serves HTML | `VITE_MOCK_DAT=false` `VITE_MOCK_ANALYZE=false` | `npm run build && npm run preview`; open localhost:4173 | App loads; no blank screen | | MANUAL QA REQUIRED | P0 blocker | | | |
| Production | DAT fail-closed on desktop | `VITE_MOCK_DAT=false` | Load preview; K Scan Enter | Error: `Camera bridge unavailable.`; no crash | | MANUAL QA REQUIRED | P0 blocker | | | |
| Production | No dev HUD in DOM | `VITE_MOCK_DAT=false` | DevTools → Elements → search `dat-hud` | Not found | | MANUAL QA REQUIRED | P0 blocker | | | |
| Production | No diagnostic strings in DOM | `VITE_MOCK_DAT=false` | DevTools → Elements → search `DAT: CHECKING`, `ANALYZE: MOCK`, `Voice: available` | None found | | MANUAL QA REQUIRED | P0 blocker | | | |
| Production | No dev HUD ever appears | mocks off | Load, wait 5s, press K Scan | HUD never appears in DOM at any point | | MANUAL QA REQUIRED | P0 blocker | | | |
| Production | Manifest loads | production | DevTools → Application → Manifest | Manifest parses; app name = `K Scan` | | MANUAL QA REQUIRED | P3 polish | | | |
| Production | Icons load (no 404) | production | DevTools → Network on load | `icon-96.png`, `icon-192.png`, `apple-touch-icon-180.png` all 200 | | MANUAL QA REQUIRED | P3 polish | | | |
| Production | Model file accessible | production | Navigate to `/models/blaze_face_full_range.tflite` | 200 response (browser may download or show binary) | | MANUAL QA REQUIRED | P2 medium | | | |
| Production | WASM file accessible | production | Navigate to `/mediapipe/wasm/vision_wasm_internal.wasm` | 200 response | | MANUAL QA REQUIRED | P2 medium | | | |

---

## Section 9: Voice / Mic

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Voice | No automatic mic prompt | `VITE_MOCK_DAT=false VITE_MOCK_ANALYZE=false` (production build) | Load production preview; wait 10s without pressing anything | No browser microphone permission dialog appears | | MANUAL QA REQUIRED | P0 blocker | | | |
| Voice | No SpeechRecognition in DOM | production build | DevTools → Elements → search for `recognition`, `SpeechRecognition`, `initVoice` | None found as active DOM element or active listener | | MANUAL QA REQUIRED | P1 high | | | |
| Voice | Voice button is placeholder only | any | Navigate to Settings; focus Voice button; press Enter | Nothing happens (no mic prompt, no voice UI appears) | | MANUAL QA REQUIRED | P2 medium | | | Placeholder behavior is expected |
| Voice | MRBD microphone unsupported | device QA | (device required) | Microphone is officially unsupported per Meta Build.txt | | DEFERRED | Informational | | | Requires MRBD device; mic is officially unsupported |

---

## Section 10: Results View

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Results | Product cards render | `success` + mock analyze | Full scan flow; reach results | Up to 5 product cards; brand, name, price visible | | MANUAL QA REQUIRED | P0 blocker | | | |
| Results | At most 5 products | `success` + mock analyze | Inspect results view | Exactly 4 mock products shown (mock data has 4; limit is 5) | | MANUAL QA REQUIRED | P2 medium | | | |
| Results | Empty state | (requires backend returning empty array) | — | `No items identified` message with Retry button | | DEFERRED | P2 medium | | | Cannot test with mock without source change |
| Results | Back navigation | `success` + mock analyze | After scan; results view; ArrowLeft | Returns to Home | | MANUAL QA REQUIRED | P1 high | | | |
| Results | Retry from results | `success` + mock analyze | After scan; press ArrowLeft to Home; K Scan again | Second scan completes normally | | MANUAL QA REQUIRED | P2 medium | | | |

---

## Section 11: Error Recovery

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Error | Try Again from error | `permission-denied` scenario | Error screen; focus Try Again; Enter | New scan starts | | MANUAL QA REQUIRED | P1 high | | | |
| Error | Back Home from error | `permission-denied` scenario | Error screen; ArrowDown; focus Back Home; Enter | Returns to Home; HUD shows IDLE | | MANUAL QA REQUIRED | P1 high | | | |
| Error | No blank screen on any error | all error scenarios | Cycle through all 6 error scenarios | Always shows error screen with message; never blank | | MANUAL QA REQUIRED | P0 blocker | | | |
| Error | No stack trace in UI | any error | Trigger each error type | No raw JavaScript stack trace text visible in the UI | | MANUAL QA REQUIRED | P0 blocker | | | |

---

## Section 12: Deployed Vercel

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Vercel | HTTPS loads | production | Navigate to deployed URL | App loads over HTTPS; no cert warning | | MANUAL QA REQUIRED | P0 blocker | | | Record the deployed URL |
| Vercel | No mixed content | production | DevTools → Console on load | No mixed content warnings | | MANUAL QA REQUIRED | P1 high | | | |
| Vercel | Model/WASM paths load | production | DevTools → Network on first scan attempt | `blaze_face_full_range.tflite` and `vision_wasm_internal.wasm` are 200 | | MANUAL QA REQUIRED | P1 high | | | |
| Vercel | No mock leaks | production | DevTools → Elements → search for `dat-hud`, `MOCK`, `DAT: CHECKING` | Nothing found | | MANUAL QA REQUIRED | P0 blocker | | | |
| Vercel | Desktop fail-closed DAT | production | K Scan Enter on deployed URL | `Camera bridge unavailable.` — no crash | | MANUAL QA REQUIRED | P0 blocker | | | |
| Vercel | CORS from deployed origin | production with `VITE_MOCK_DAT=true` QA build | Scan flow reaches backend; Network tab | POST /api/analyze returns 200 with no CORS error | | MANUAL QA REQUIRED | P0 blocker | | | Only possible with QA build or from glasses |

---

## Section 13: MRBD Hardware

All rows require physical Meta Ray-Ban Display glasses and companion device. Mark as REQUIRES DEVICE VALIDATION until tested on hardware.

| Area | Scenario | Env values | Steps | Expected result | Actual result | Status | Severity | Screenshot / note | Console errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| MRBD | App add flow | production HTTPS | Meta AI app → Devices → App connections → Web Apps → Add | App appears in MRBD grid | | REQUIRES DEVICE VALIDATION | P0 blocker | | | Record firmware + app version |
| MRBD | App launch on glasses | production HTTPS | Select app from grid | App loads and renders in waveguide | | REQUIRES DEVICE VALIDATION | P0 blocker | | | |
| MRBD | D-pad / Neural Band navigation | production on device | Swipe on Neural Band / glasses captouch | Arrow events received; navigation works | | REQUIRES DEVICE VALIDATION | P0 blocker | | | |
| MRBD | K Scan button activates | production on device | Navigate to K Scan; pinch or tap to select | Scan flow starts | | REQUIRES DEVICE VALIDATION | P0 blocker | | | |
| MRBD | Real native bridge capture | production on device | Activate K Scan | Native bridge captures photo; base64 returned; sanitizer runs | | REQUIRES DEVICE VALIDATION | P0 blocker | | | Bridge schema unknown; record response shape |
| MRBD | Permission-denied handling | production on device | Deny camera permission; activate K Scan | Friendly error shown; no crash | | REQUIRES DEVICE VALIDATION | P0 blocker | | | |
| MRBD | Waveguide clipping | production on device | Review all screens | No critical UI clipped at display edges | | REQUIRES DEVICE VALIDATION | P1 high | | | |
| MRBD | Additive display readability | production on device | Review all screens in normal lighting | Text and UI readable in waveguide overlay | | REQUIRES DEVICE VALIDATION | P1 high | | | |
| MRBD | devicePixelRatio | production on device | Observe rendering scale | UI renders at correct scale (confirm CSS px vs display px) | | REQUIRES DEVICE VALIDATION | P2 medium | | | |
| MRBD | Universal Web App menu | production on device | Middle pinch gesture | Restart / Resume / Permissions menu appears | | REQUIRES DEVICE VALIDATION | P2 medium | | | Per Test.txt documentation |

---

## Summary

Fill in after completing available tests.

| Status | Count |
|---|---|
| PASS | |
| FAIL | |
| WARN | |
| DEFERRED | |
| REQUIRES DEVICE VALIDATION | |
| MANUAL QA REQUIRED (not yet tested) | |

### P0 Blockers Found

_(list any FAIL rows with P0 severity here)_

### P1 Issues Found

_(list any FAIL rows with P1 severity here)_

### Outstanding Manual QA

_(list sections not yet tested and reason)_

### Device Validation Pending

_(confirm which device tests remain)_

### Tester Sign-off

I confirm all rows marked PASS were personally observed by following the steps in QA-EXECUTION-GUIDE.md.

Signature: ___________________________ Date: ___________________________
