# QA Execution Guide — K Scan Glasses Web App

Phase 11.2B — Human Manual QA

---

## How To Use This Guide

Work through each section in order. After each test, record your observations in `QA-RESULTS-TEMPLATE.md`.

**Do not mark any row PASS unless you have personally observed the expected result by following the exact steps in this guide.**

No automated tool can substitute for your eyes, keyboard, and browser in this phase.

---

## Section 0: Prerequisites

Before starting manual QA, confirm your environment is ready.

### Required tools

- **Node.js** (v20+ recommended; the project uses v24)
- **npm** (v10+)
- **Chrome** or **Chromium** (DevTools required for viewport and network inspection)
- A text editor to edit `.env`

### Check your local `.env` file exists

```sh
ls -la .env
```

If it does not exist, create it from the example:

```sh
cp .env.example .env
```

The `.env` file is git-ignored and never committed. You will edit it to change test scenarios.

### Confirm project dependencies are installed

```sh
npm install
```

---

## Section 1: Automated Baseline

Run the automated test suite first. If this fails, **stop and report** — do not begin manual QA until it passes.

```sh
npm test
```

This runs three steps in order:
1. `npm run verify:models` — confirms model and WASM assets exist and are non-empty
2. `npm run build` — builds production bundle to `dist/`
3. `npm run test:static` — static source and dist audit (Node only, no browser, no network)

**Expected output:**

```
FAIL:  0
WARN:  1

[OK] All hard checks passed. Review WARNs and manual QA notes above.
```

The single WARN (`data:image/jpeg;base64,` in minified JS) is expected and documented. It is not a bug.

**If you see any FAIL:** Stop. Do not begin manual QA. Investigate the failing check before continuing.

Record the result in `QA-RESULTS-TEMPLATE.md` Section 0.

---

## Section 2: Starting the Dev Server

### Edit `.env` for the test session

Open `.env` in your editor. Confirm or set the following for the initial dev session:

```env
VITE_MOCK_DAT=true
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_DAT_DELAY_MS=600
VITE_MOCK_DAT_IMAGE_VARIANT=standard
VITE_MOCK_ANALYZE=true
VITE_MOCK_ANALYZE_DELAY_MS=900
VITE_MOCK_ANALYZE_ERROR=false
VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com
```

### Start the dev server

```sh
npm run dev
```

Vite will print a local URL. It is usually `http://localhost:5173/`. If port 5173 is already in use, Vite will choose the next available port (e.g. 5174). Use whatever URL Vite prints.

**Example output:**

```
VITE v7.x.x  ready in 226 ms

➜  Local:   http://localhost:5173/
```

### Open the URL in Chrome

Open the URL Vite printed in **Chrome**. Do not use the browser's default viewport.

---

## Section 3: Setting the Viewport to 600×600

The app is designed for a fixed 600×600 canvas. All manual QA must be performed at exactly 600×600.

### Steps

1. Open Chrome DevTools: press **F12** (Windows) or **Cmd+Opt+I** (Mac).
2. Click the **Toggle device toolbar** button (the phone/tablet icon in the DevTools toolbar, top-left). Keyboard shortcut: **Ctrl+Shift+M** (Windows) / **Cmd+Shift+M** (Mac).
3. In the dimensions bar at the top, set:
   - Width: **600**
   - Height: **600**
4. Press **Enter** after each field.
5. Confirm the viewport renders as a square canvas.

### Verify the viewport is correct

- The app should fill the 600×600 area.
- No horizontal or vertical scrollbars should be visible within the canvas.
- The area outside the 600×600 frame (the grey DevTools surround) is normal and expected.

---

## Section 4: Changing Test Scenarios

### How env values work

All `VITE_*` environment variables in `.env` are read at **build time / server start time** by Vite. They are **baked into the app** when the dev server starts. Changing `.env` while the dev server is running has no effect until you restart it.

### Workflow for each scenario

1. Stop the dev server: press **Ctrl+C** in the terminal where `npm run dev` is running.
2. Edit `.env` — change only the relevant line(s).
3. Save `.env`.
4. Start the dev server again: `npm run dev`.
5. Reload the browser tab (or open the URL fresh).

### Scenario reference

| Scenario | `.env` lines to set |
|---|---|
| success (standard image) | `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=standard` |
| success (tiny image) | `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=tiny` |
| success (large image) | `VITE_MOCK_DAT_SCENARIO=success` `VITE_MOCK_DAT_IMAGE_VARIANT=large` |
| permission-denied | `VITE_MOCK_DAT_SCENARIO=permission-denied` |
| cancelled | `VITE_MOCK_DAT_SCENARIO=cancelled` |
| timeout | `VITE_MOCK_DAT_SCENARIO=timeout` |
| invalid-response | `VITE_MOCK_DAT_SCENARIO=invalid-response` |
| malformed-image | `VITE_MOCK_DAT_SCENARIO=malformed-image` |
| mock analyze error | `VITE_MOCK_ANALYZE_ERROR=true` |
| mock analyze success | `VITE_MOCK_ANALYZE_ERROR=false` |
| production preview | set per Section 9 |

---

## Section 5: Dev HUD — What It Means

When the dev server is running (`npm run dev`), a small diagnostic overlay appears at the bottom of the 600×600 canvas. It shows:

```
DAT: MOCK | ANALYZE: MOCK | BACKEND: OK | FLOW: IDLE
```

This HUD is **development-only**. It is never visible in a production build.

| HUD field | Values and meaning |
|---|---|
| `DAT:` | `MOCK` = simulator active · `READY` = real bridge detected · `MISSING` = no bridge, no mock |
| `ANALYZE:` | `MOCK` = mock analyze active · `REAL` = live backend path |
| `BACKEND:` | `OK` = `VITE_KSCAN_BACKEND_URL` is set · `MISSING` = env var is empty |
| `FLOW:` | `IDLE` → `CAPTURING` → `SANITIZING` → `ANALYZING` → `SUCCESS` / `ERROR` |

Confirm the HUD shows the correct state for each test before activating the scan.

---

## Section 6: Keyboard / D-pad Navigation Tests

**Important:** The app is keyboard-only. There is no mouse navigation support in the Meta Ray-Ban Display runtime. Test with the keyboard only. Do not click.

### Keys

| Key | Action |
|---|---|
| `ArrowDown` | Move focus to next focusable element |
| `ArrowUp` | Move focus to previous focusable element |
| `Enter` | Activate focused element |
| `ArrowLeft` | Go back (equivalent to Back button) |
| `Escape` | Go back |

### Test sequence

1. Load the app at 600×600.
2. Confirm the **K Scan** button has initial focus (it should glow/highlight).
3. Press `ArrowDown` — focus should move to **Library**.
4. Press `ArrowDown` — focus should move to **Settings**.
5. Press `ArrowUp` — focus should move back to **Library**.
6. Press `ArrowUp` — focus should move back to **K Scan**.
7. Press `Enter` — scan starts; processing view appears.
8. Press `ArrowLeft` — should return to Home.
9. Navigate to **Library** using `ArrowDown` + `Enter` — Library screen appears.
10. Press `ArrowLeft` — should return to Home.
11. Navigate to **Settings** using `ArrowDown` × 2 + `Enter` — Settings screen appears.
12. Press `ArrowLeft` — should return to Home.

### What to observe

- Every focusable element must show a visible focus indicator (cyan glow/border) when focused.
- Pressing `Enter` on a non-focused element must not activate it.
- Hidden screens must not receive focus.
- Do not use the mouse at any point during this section.

---

## Section 7: DAT Simulator Scenarios

For each scenario below:

1. Stop dev server, set the `.env` values shown, restart dev server, reload browser.
2. Set viewport to 600×600.
3. Confirm HUD shows `DAT: MOCK`.
4. Navigate to the **K Scan** button using keyboard only.
5. Press `Enter` to activate.
6. Observe the result exactly as described.
7. Record in QA-RESULTS-TEMPLATE.md.

### 7.1 — success (standard image)

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_DAT_IMAGE_VARIANT=standard
VITE_MOCK_ANALYZE=true
VITE_MOCK_ANALYZE_ERROR=false
```

**Expected flow:**
- HUD: `FLOW: IDLE → CAPTURING → SANITIZING → ANALYZING → SUCCESS`
- Processing screen shows: `Capturing...` → `Protecting privacy...` → `Analyzing...`
- Results view appears with product cards
- Top 5 products shown (mock data: Aether Loom, Nova Thread, Glassline, Orbit Form)
- Results cards are keyboard-focusable

### 7.2 — success (tiny image, 24×24)

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_DAT_IMAGE_VARIANT=tiny
```

**Expected:** Same full flow as 7.1. Sanitizer must handle a 24×24 image without crashing. Results appear normally.

### 7.3 — success (large image, 2000×1500)

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_DAT_IMAGE_VARIANT=large
```

**Expected:** Same full flow as 7.1. Sanitizer must resize the large image. Processing may take slightly longer. Results appear normally. No crash or blank screen.

### 7.4 — permission-denied

```env
VITE_MOCK_DAT_SCENARIO=permission-denied
```

**Expected:**
- Flow: `IDLE → CAPTURING → ERROR`
- Error screen appears
- Error message reads: **`Camera permission denied.`**
- `Try Again` and `Back Home` buttons are keyboard-focusable
- `Back Home` returns to Home; `Try Again` starts another scan

### 7.5 — cancelled

```env
VITE_MOCK_DAT_SCENARIO=cancelled
```

**Expected:**
- Flow: `IDLE → CAPTURING → ERROR`
- Error message reads: **`Capture cancelled.`**

### 7.6 — timeout

```env
VITE_MOCK_DAT_SCENARIO=timeout
VITE_MOCK_DAT_DELAY_MS=600
```

**Expected:**
- Flow: `IDLE → CAPTURING → ERROR` (after ~10 seconds — timeout is enforced, not just the delay)
- Error message reads: **`Capture timed out.`**
- Note: the timeout scenario waits for at least `CAPTURE_TIMEOUT_MS` (10 000 ms). Be patient.

### 7.7 — invalid-response

```env
VITE_MOCK_DAT_SCENARIO=invalid-response
```

**Expected:**
- Flow: `IDLE → CAPTURING → ERROR`
- Error message reads: **`Camera response invalid.`**

### 7.8 — malformed-image *(privacy critical)*

```env
VITE_MOCK_DAT_SCENARIO=malformed-image
```

**Expected:**
- Flow: `IDLE → CAPTURING → SANITIZING → ERROR`
- The flow MUST enter SANITIZING (capture succeeded) before failing
- Error message reads: **`Privacy scan failed. Try again.`**
- **Critical check:** Open DevTools → Network tab. Confirm **no POST request to `/api/analyze` or to `kscan-app-1.onrender.com`** is made. The backend must not be called when the sanitizer rejects the image.

### 7.9 — concurrent capture guard

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_DAT_DELAY_MS=3000
```

**Expected:**
- Activate K Scan once. While the processing delay is running (3 seconds), press `Enter` on K Scan again (you may need to navigate back or use the cancel button to get focus — actually, test whether pressing Enter while processing is active does anything).
- If a second capture is attempted: error reads **`Capture already in progress.`**
- The original capture should complete normally.

---

## Section 8: Mock Analyze Tests

These test analyze behavior independently of the capture scenario. Use `success` capture so the flow reaches the analyze step.

### 8.1 — Mock analyze success

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_ANALYZE=true
VITE_MOCK_ANALYZE_ERROR=false
VITE_MOCK_ANALYZE_DELAY_MS=900
```

**Expected:**
- Processing screen shows `Analyzing...` for ~900ms
- Results view renders with up to 5 mock product cards
- No network request to the backend

### 8.2 — Mock analyze forced error

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_ANALYZE=true
VITE_MOCK_ANALYZE_ERROR=true
```

**Expected:**
- Processing runs to `ANALYZING`
- Error screen appears: **`Analysis failed. Please try again.`**
- No network request to the backend

---

## Section 9: Production Preview Tests

The production build disables all mock paths. `import.meta.env.DEV` is `false`. Mocks do not activate regardless of `.env` values.

### 9.1 — Set up production preview

1. Edit `.env`:
   ```env
   VITE_MOCK_DAT=false
   VITE_MOCK_ANALYZE=false
   VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com
   ```
2. Build and preview:
   ```sh
   npm run build
   npm run preview
   ```
3. Open `http://localhost:4173/` in Chrome at 600×600.

### 9.2 — DAT fail-closed on desktop

**Expected:**
- The dev HUD must NOT be present anywhere in the DOM. (DevTools → Elements → search `dat-hud` — should find nothing.)
- Press `Enter` on K Scan.
- App immediately shows: **`Camera bridge unavailable.`** (no capture attempt, instant fail)
- No blank screen, no crash, no unhandled error in the Console tab.

### 9.3 — Production DOM audit

1. Open DevTools → Elements.
2. Search (Ctrl+F) for each of the following — none should be found:
   - `dat-hud`
   - `DAT: CHECKING`
   - `DAT: mock`
   - `ANALYZE: MOCK`
   - `Voice: available`
   - `Voice: checking`

### 9.4 — Manifest and icons

1. DevTools → Application → Manifest.
2. Confirm manifest loads without errors.
3. Confirm icons (`icon-96.png`, `icon-192.png`) resolve (no 404).
4. App name is `K Scan`.

### 9.5 — Model and WASM asset paths

1. DevTools → Network tab. Clear the log.
2. Activate K Scan in the production preview (it will fail at DAT, before reaching sanitizer).
3. Also directly navigate to:
   - `http://localhost:4173/models/blaze_face_full_range.tflite`
   - `http://localhost:4173/mediapipe/wasm/vision_wasm_internal.wasm`
4. Both should return **200** (not 404).
5. Note: the sanitizer is only initialized on first scan attempt, so you may need to watch Network on a `success` flow via dev mode to see model loading.

---

## Section 10: Privacy Sanitizer Browser Tests

These tests require the dev server with mock DAT active so the flow reaches the sanitizer.

### 10.1 — Network tab check: no raw image to backend

```env
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_ANALYZE=false
VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com
```

1. Open DevTools → Network tab. Clear the log.
2. Activate K Scan.
3. Wait for flow to complete (may take up to 25s for backend call or timeout).
4. Review Network tab.
5. Find the `POST /api/analyze` request.
6. Click it → Payload tab.
7. Confirm the payload is `{"image":"<sanitized base64>"}` — it must be a data URL starting with `data:image/jpeg;base64,` (the sanitized JPEG), not `data:text/plain` or the raw capture value.

**Expected:** The payload image is a sanitized JPEG data URL. No raw mock image data was sent.

### 10.2 — Missing model fails closed

1. Stop dev server.
2. Rename the model file temporarily:
   ```sh
   mv public/models/blaze_face_full_range.tflite public/models/blaze_face_full_range.tflite.bak
   ```
3. Start dev server.
4. Activate K Scan.
5. **Expected:** Error appears: `Privacy scan failed. Try again.` Backend must not be called (check Network tab — no POST to analyze).
6. Stop dev server.
7. Restore the model:
   ```sh
   mv public/models/blaze_face_full_range.tflite.bak public/models/blaze_face_full_range.tflite
   ```
8. Re-run `npm run verify:models` to confirm restoration.

---

## Section 11: Real Backend / CORS Test

**Important:** This test calls the live Render backend. Do NOT run this from automated tests. This is manual-only.

### 11.1 — Real backend from local dev (CORS may block)

```env
VITE_MOCK_DAT=true
VITE_MOCK_DAT_SCENARIO=success
VITE_MOCK_ANALYZE=false
VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com
```

1. Start dev server. Activate K Scan.
2. DevTools → Network tab. Watch for the POST to `kscan-app-1.onrender.com/api/analyze`.
3. **Expected outcomes:**
   - If backend responds 200 with valid JSON → results view renders (PASS)
   - If backend responds with CORS error → Console shows CORS error, app shows `Cannot reach server. Check connection.` (expected if backend doesn't allow localhost origin)
   - If backend cold-starts → `Waking up Fashion AI...` appears at 5s; request times out at 25s with `Request timed out. Please try again.`
4. Record the actual network response and app UI state.

### 11.2 — Backend not configured

```env
VITE_MOCK_ANALYZE=false
VITE_KSCAN_BACKEND_URL=
```

1. Start dev server. Activate K Scan.
2. **Expected:** Error screen immediately (no network request): **`Backend not configured.`**

---

## Section 12: Results View Tests

Use `success` scenario + mock analyze to reliably reach the results view.

### 12.1 — Product cards rendered

**Expected:** Up to 5 product cards visible, each with brand name, product name, and price.

### 12.2 — Empty results

*Requires backend returning empty products array — cannot test with mock in current build without source change. Mark DEFERRED.*

### 12.3 — Results keyboard navigation

1. After scan completes, focus should be on first product card (or Back button if no cards).
2. Press `ArrowDown` to move through cards.
3. Press `ArrowLeft` to return to Home.

---

## Section 13: Voice / Mic Tests

### 13.1 — No automatic mic prompt

1. Load the production preview (`npm run preview`) at 600×600.
2. Wait 10 seconds without pressing anything.
3. **Expected:** No browser microphone permission dialog appears.
4. DevTools → Console — confirm no errors related to SpeechRecognition.

### 13.2 — No voice UI in production DOM

1. DevTools → Elements → search for `SpeechRecognition`, `initVoice`, `voice`, `recognition`.
2. **Expected:** None of these are in the rendered DOM as active functionality. A "Voice" settings button (placeholder) is acceptable.

---

## Section 14: Deployed Vercel Tests

Run these against the live deployed URL (replace `YOUR_VERCEL_URL` with the actual deployment).

### 14.1 — HTTPS loads

```
https://YOUR_VERCEL_URL/
```

**Expected:** App loads, no mixed content warnings, no certificate errors.

### 14.2 — No mock leaks in production

1. Open the deployed URL in Chrome.
2. DevTools → Elements → search for `dat-hud`, `DAT: CHECKING`, `MOCK`.
3. DevTools → Network → confirm no WASM 404 errors on first scan attempt.

### 14.3 — CORS from deployed origin

1. Activate K Scan on the deployed URL with `VITE_MOCK_DAT=false` (production build).
2. Wait for DAT fail-closed error (expected on desktop).
3. **OR** — if a production deploy with `VITE_MOCK_DAT=true` is configured for QA:
   - Activate K Scan → flow reaches backend analyze
   - Confirm `POST /api/analyze` to Render gets 200 (no CORS error)
   - Confirm results render

---

## Section 15: MRBD Hardware Tests

**Requires:** Meta Ray-Ban Display glasses (MRBD), companion iPhone or Android phone with Meta AI app, Developer Mode enabled (Settings → App Info → tap version 5×).

### Pre-requisites (from `docs/meta/Setup.txt`)

- Glasses firmware v125+
- Meta AI app v272+
- Developer Mode enabled (Settings > App Info > tap version 5 times > Enable)
- App hosted at a public HTTPS URL

### 15.1 — App add flow

1. Meta AI app → Devices → Display Glasses settings → App connections → Web Apps → Add a web app
2. Enter app name: `K Scan`
3. Enter deployed HTTPS URL
4. Tap Connect
5. **Expected:** App appears in MRBD app grid

### 15.2 — Launch on glasses

1. Select K Scan from MRBD app grid
2. **Expected:** App loads and renders in the waveguide display

### 15.3 — D-pad / Neural Band navigation

1. Use Neural Band swipe or glasses captouch
2. **Expected:** Arrow key events received; K Scan button focused; navigation works

### 15.4 — Real native bridge capture

1. Navigate to K Scan, activate
2. **Expected:** Camera capture triggers through native bridge; photo returned to app; sanitizer runs; results appear (or backend error if backend not reachable from glasses network)

### 15.5 — Waveguide clipping

1. Review all screens on glasses
2. **Expected:** No critical UI (button labels, error text) clipped at waveguide edges; safe-zone margins are adequate

---

## Section 16: Recording Results

For every test in this guide:

1. Open `QA-RESULTS-TEMPLATE.md`
2. Find the matching row
3. Fill in:
   - **Actual result** — exactly what you observed (text on screen, error message, flow state, network status)
   - **Status** — PASS / FAIL / WARN / DEFERRED / REQUIRES DEVICE VALIDATION
   - **Severity** — P0 blocker / P1 high / P2 medium / P3 polish / Informational
   - **Screenshot path** — path to screenshot file, or a short note
   - **Console errors** — copy any relevant browser console errors verbatim
   - **Notes** — anything unexpected or worth flagging

### Screenshot naming convention

```
qa-screenshots/QA-{area}-{scenario}-{YYYYMMDD}.png
```

Example: `qa-screenshots/QA-DAT-malformed-20260527.png`

Create the `qa-screenshots/` folder as needed. It is git-ignored.

---

## Section 17: When to Stop and Report a Bug

Stop the current test run and report if you observe:

- A blank screen at any point (no error message, no content)
- An unhandled JavaScript exception visible in the Console (stack trace shown in UI or console)
- The analyze backend called after sanitizer failure
- Raw base64 image data visible in the Console logs
- A microphone permission dialog triggered without user action
- The dev HUD (`dat-hud`) visible in a production build
- Any of the forbidden diagnostic strings (`DAT: unavailable`, `Voice: available`, etc.) visible in production DOM

Report by describing: the exact scenario, `.env` values, steps taken, what you observed, and any console output.
