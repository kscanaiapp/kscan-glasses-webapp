# QA Report — Phase 11 Virtual-Alpha Infrastructure

Date: 2026-06-11
Branch: `phase-11-virtual-alpha-infra`
Scope: desktop-Chrome virtual prototype. **No physical Meta Ray-Ban Display
glasses were used. Nothing in this report claims physical-device readiness.**

## Test matrix

| Area | How tested | Result |
|---|---|---|
| Backend client: 200 + products | `npm run test:contract` (A1) | PASS |
| Backend client: 200 empty products | A2 | PASS |
| Backend client: 400 → no retry | A3 | PASS |
| Backend client: 500 → 1 retry → success | A4 | PASS |
| Backend client: 500×2 → fail after 2 attempts | A5 | PASS |
| Backend client: timeout → 1 retry | A6, A7 | PASS |
| Backend client: malformed JSON, no retry | A8 | PASS |
| Backend client: offline/network, no retry | A9 | PASS |
| Backend client: payload shape `{ image }` + `/api/analyze` endpoint | A1 assertions | PASS |
| Analyze scenario override inert in production | A11 | PASS |
| Bridge: origin allowlist build/eval (`null` origin, wildcard, parent fallback) | B1–B5 | PASS |
| Bridge: capture success + duplicate-message ignore + listener cleanup | C1 | PASS |
| Bridge: untrusted origins ignored | C2 | PASS |
| Bridge: invalid payload | C3 | PASS |
| Bridge: cancelled | C4 | PASS |
| Bridge: timeout | C5 | PASS |
| Bridge: oversized payload (8MB cap) | C6 | PASS |
| Pipeline: capture→sanitize→analyze ordering | D1 | PASS |
| Pipeline: analyze receives sanitized output only, never raw capture | D1 | PASS |
| Pipeline: non-JPEG sanitizer output blocks upload | D2 | PASS |
| Guest library: caps, dedupe, image-payload refusal, corrupt-storage safety | E1–E4 | PASS |
| Auth stub: session restore, sign in/out, no tokens/emails persisted | F1–F6 | PASS |
| Simulator gating: inert in production build | G1–G5 | PASS |
| Build | `npm run build` (vite 7) | PASS — app JS 41.95 kB (12.96 kB gzip) |
| Static QA suite | `npm run test:static` | PASS — 0 FAIL, 6 pre-existing WARNs (env-var names visible in minified dev-gated code; gated by `import.meta.env.DEV`) |
| `simulator.html` excluded from `dist/` | inspected build output | PASS |

## Passing commands

```
npm run build          # vite build — PASS
npm run test:static    # 0 FAIL / 6 WARN (pre-existing, warn-by-design)
npm run test:contract  # 75 PASS / 0 FAIL
npm test               # chains verify:models + build + both suites — PASS
```

Note: validation ran on a Linux sandbox against a clean `npm ci` of the
committed `package-lock.json` (the Windows-installed `node_modules` contains
Windows-only rollup/esbuild binaries). No dependencies were added or changed.
Re-run `npm test` on Windows to confirm locally.

## Manual browser QA (Chrome, 600×600) — to perform locally

1. `npm run dev` → open `http://localhost:5173/simulator.html`.
2. Scenario dropdown: success / oversized / invalid / cancel / permission /
   error / timeout — verify each ends in results, error+retry, or empty state.
3. Backend dropdown: empty / http-400 / http-500 / timeout / malformed /
   offline — verify error and empty states.
4. Keyboard only: ArrowUp/Down moves focus with wrap, Enter activates,
   Escape/ArrowLeft goes back, focus ring visible on every control.
5. Verify SIM badge (gold, top-right) on all screens during simulation.
6. Save a result card → Library shows it; sign in/out stub in Settings.

## Known limitations

- **postMessage origin pinning**: the real MRBD host origin is unknown. The
  bridge trusts (1) an env allowlist / own origin, else (2) messages whose
  `event.source` is the direct parent window, with shape validation.
  `event.origin === "null"` is always rejected. Final pinning requires
  observing the real runtime origin on hardware.
- **Face-detection QA**: MediaPipe BlazeFace runs in-browser; automated node
  tests use the `__setMaskEngineForTests` hook instead of real faces (no real
  face imagery is committed). Real-face masking accuracy needs manual QA.
- **Face-detection failure mode (conservative)**: if the detector fails to
  load or run, the upload is blocked and the user sees "We couldn't verify
  this image is safe to upload. Please try again." Raw captures are never
  uploaded as a fallback.
- **Supabase**: `@supabase/supabase-js` is not installed (dependency installs
  require approval). The app runs in offline stub mode with a visible
  "Supabase stub – virtual-alpha only." banner; the session-provider seam in
  `src/authSession.js` is where the real client plugs in.
- **Playwright deferred**: the repo's established test stack is dependency-free
  node scripts; adding Playwright requires a dependency install (approval).
  Browser-level QA is covered by the manual checklist above plus the
  parent-frame simulator.
- **dist/ in the repo worktree is stale** (gitignored); run `npm run build`
  locally to refresh.

## Blocked until physical glasses

- Real camera capture through the DAT bridge on-device.
- Real MRBD runtime origin → strict postMessage origin pinning.
- Real Neural Band latency and D-pad/gesture tactile feel.
- Real additive-waveguide brightness/contrast/readability calibration.
- Real microphone/voice runtime support (voice remains unwired by design).
- QR/deeplink launch via Meta AI app Developer Mode.
- `devicePixelRatio` and viewport behavior on the actual display.

## Security/privacy checklist

- No secrets in code; backend URL and all flags come from env. ✔
- No base64 images, real photos, or real faces committed. ✔ (fixtures are
  canvas-generated at runtime)
- `.env` ignored by git; `.env.example` has placeholders only. ✔
- Simulator gated: production build with `VITE_ENABLE_SIMULATOR` unset is
  inert; `simulator.html` is not in the build output. ✔
- No logging of base64/face metadata/tokens/emails/scan results (generic
  one-time warning for untrusted messages only). ✔
- Guest history: schema-versioned localStorage, whitelisted scalar fields,
  hard gate refusing anything containing `base64,`. ✔
- No production deploy performed. ✔

---

# Phase 12 — Browser Demo Hardening (2026-06-11)

## What changed

- `simulator.html` is now the demo control room: header, demo instructions,
  Start Scan / Focus App buttons (same-origin), capture + backend scenario
  selectors, and a directional message log
  (`[HH:MM:SS] app → simulator: capture-photo (scenario)`).
  Log policy tightened: timestamp, direction, message type, and scenario/
  status label only — payload size classes were removed.
- Oversized scenario now exceeds the bridge's 8M-char cap, so the app
  rejects it before sanitize/analyze and shows "Image too large. Try again."
- User-facing copy aligned to spec: empty = "No matches found. Try another
  angle."; 5xx/malformed = "Something went wrong. Try again."; network =
  "Unable to connect. Try again." (labeled simulated); invalid capture =
  "Couldn't read image. Try again."; oversized = "Image too large. Try
  again."; library empty = "No saved items yet."
- Settings now shows plain-text status rows (Simulator / Backend / Supabase
  / Auth) — hostname at most, never URLs with params, keys, or tokens.
- Scan flow is single-flight: duplicate triggers ignored while processing;
  Cancel invalidates the in-flight pipeline (stale results/errors/stage
  text are discarded via a scan token).

## Manual QA checklist (keyboard-only, 600×600)

- [ ] `npm run dev`; open `/` and `/simulator.html` — both load, no console
      errors, no 404s (app JS, style.css, manifest, WASM, model).
- [ ] App shell stays 600×600; no page scrollbars; only results/library
      panels scroll.
- [ ] Home: focus starts on "K Scan"; ArrowUp/Down wraps through
      K Scan → Library → Settings; Enter activates.
- [ ] Scan (success): processing spinner + staged text; results render;
      first card focused; focused cards scroll into view.
- [ ] Enter on a card → "Saved to Library"; Enter again → "Already in
      Library". Library shows item + history, newest first.
- [ ] All 10 scenarios in the README matrix produce the listed copy; the
      app never freezes; Try Again recovers.
- [ ] Press Enter rapidly on "K Scan" — only one scan starts.
- [ ] Cancel during processing → Home; no late jump to results; next scan
      works normally.
- [ ] Settings: status rows show simulator/backend/supabase/auth; stub
      sign-in/out toggles; no secrets anywhere.
- [ ] Simulator log never shows base64/payload/size/dimensions.

## Console check

Expected clean. Known acceptable: Vite dev-mode messages; a single generic
"[datBridge] Ignored capture message from untrusted source." warning if a
non-simulator window posts messages (by design, no payload logged).

## Validation status (sandbox)

`npm test` (verify-models + build + static + contract suites) — see final
session report for exact results. Static-suite WARNs (6) are pre-existing
and warn-by-design (dev-gated strings visible in the minified bundle).

## Hardware blockers (unchanged — no physical-glasses readiness claimed)

Real MRBD display readability, real Neural Band latency, real DAT capture
on iOS/Android with paired glasses, real camera capture, real voice/
microphone runtime (not implemented), QR/deeplink launch on glasses, real
devicePixelRatio/display behavior.

---

# Phase 13 — Browser QA + Staging Readiness (2026-06-18)

## Scope

Prove the pushed virtual alpha works as a demonstrable 600×600 browser
prototype before staging deployment or physical glasses testing. No new
architecture or features added. One surgical bug fix applied.

## Preflight status

- Branch: `phase-11-virtual-alpha-infra` ✅
- Latest commit: `a6014a6 feat(mrbd): harden virtual-alpha demo` ✅
- Working tree: clean at start; one file changed after Phase 13 fix ✅
- Tests: `npm test` — 75 PASS / 0 FAIL, 6 pre-existing WARNs ✅
- Build: `npm run build` — PASS (app JS 42.68 kB / 13.26 kB gzip) ✅

## Files changed in Phase 13

| File | Change | Reason |
|---|---|---|
| `src/main.js` | +5 lines | Escape/ArrowLeft during processing now cancels the in-flight scan (same behavior as Cancel button) |

## Dev server launch (Task 1)

- `npm run dev` started successfully on `http://localhost:5173/` ✅
- Both `/` and `/simulator.html` return HTTP 200 ✅

## Asset + 404 check (Task 2)

All assets verified via `curl` (HTTP 200, no 404s):

- `/` ✅
- `/simulator.html` ✅
- `/style.css` ✅
- `/src/main.js` ✅
- `/manifest.webmanifest` ✅
- `/models/blaze_face_full_range.tflite` ✅
- `/mediapipe/wasm/vision_wasm_internal.js` ✅
- `/icons/icon-96.png` ✅
- `/icons/icon-192.png` ✅
- All other `src/*.js` modules load ✅
- `simulator.html` is **not** present in `dist/` — PASS ✅

No console errors detected in source (no `console.log`, `console.debug`, or
base64 logging found in `src/`). One controlled `console.warn` exists for
untrusted postMessage sources (by design, no payload logged).

## 600×600 HUD layout QA (Task 3) — code review

- `index.html`: viewport is `width=600, height=600, initial-scale=1.0, user-scalable=no` ✅
- `style.css`: `html/body` are `width:600px; height:600px; overflow:hidden` ✅
- `#app` is `600×600` with `overflow:hidden` ✅
- `.screen` is `absolute; inset:0` with `flex-direction:column` ✅
- `.scroll-panel` has `overflow-y:auto` with `scrollbar-width:none` ✅
- Focus ring is clearly defined: `outline:3px solid #00FFFF` + `box-shadow` glow ✅
- SIM badge is `position:absolute; top:8px; right:8px; z-index:30` ✅
- Settings status rows show hostname only — no secrets, no full URLs, no keys ✅
- Dark background (`#000`), high-contrast text (`#F5F7FA`), large readable type ✅
- Product cards fit within grid (`80px thumb + 1fr meta`) ✅

## D-pad/keyboard walkthrough (Task 4) — code review

- `navigation.js` handles `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Enter`, `Escape` ✅
- `ArrowLeft`/`Escape` calls `onBack` ✅
- `ArrowUp`/`Down` moves focus with wrap (`moveByList`) ✅
- `Enter`/`ArrowRight` activates focused element (`activateFocused`) ✅
- All interactive elements use `.focusable` class ✅
- `focusin` event updates focus index and applies `.focused` class ✅
- `scrollIntoView({block:'nearest'})` for scrollable panels ✅
- `main.js`: duplicate scan prevention via `scanInFlight` guard ✅
- **Fix applied**: `Escape`/`ArrowLeft` during processing now cancels the
  in-flight scan (increments `scanToken`, sets `scanInFlight=false`, returns
  to `STATE.IDLE`) before navigating back. This matches the Cancel button
  behavior and prevents the app from getting stuck in a non-scannable state. ✅

## Scenario matrix QA (Task 5) — code review

Capture scenarios (simulator.html dropdown):

| Scenario | Expected behavior | Code verified |
|---|---|---|
| success | Synthetic fixture → results | ✅ |
| oversized | Rejected at bridge boundary (8MB cap) before sanitize/analyze | ✅ |
| invalid | `validateCapturePayload` rejects non-JPEG prefix | ✅ |
| cancel | Emits `photo-capture-error` with `CAPTURE_CANCELLED` | ✅ |
| error | Generic error with retry path | ✅ |
| permission | `PERMISSION_DENIED` with user-friendly copy | ✅ |
| timeout | No response; app times out after 10s | ✅ |

Backend scenarios (simulator.html dropdown):

| Scenario | Expected behavior | Code verified |
|---|---|---|
| success | Products rendered | ✅ |
| empty | Empty state with retry | ✅ |
| http-400 | No retry; error screen | ✅ |
| http-500 | 1 retry then error screen | ✅ |
| timeout | 1 retry then error screen | ✅ |
| malformed | No retry; error screen | ✅ |
| offline | No retry; network error copy | ✅ |

Additional checks:
- App does not crash on any scenario ✅
- User-facing copy is short and readable at 600×600 ✅
- Simulator log shows only timestamp, direction, type, and status label ✅
- No base64, dimensions, payload details, face metadata, or tokens in logs ✅
- Analyze is not called for invalid/oversized capture scenarios ✅

## Pipeline and contract spot check (Task 6)

- `scanPipeline.js`: `capture → sanitize → analyze` order is structurally enforced ✅
- `api.js`: `POST /api/analyze` with `Content-Type: application/json` and body
  `JSON.stringify({ image: sanitizedBase64 })` ✅
- Raw capture is never sent directly to analyze — only sanitizer output ✅
- Sanitizer failure blocks upload (fail-closed) ✅
- Oversized image blocks upload at bridge boundary (`validateCapturePayload`) ✅
- Retry policy intact: 1 retry on timeout/5xx, 2s delay, 15s second timeout ✅
- Mock analyze/simulator paths are gated by `DEV` or `VITE_ENABLE_SIMULATOR` ✅
- Production build is safe (no dev diagnostics in `dist/index.html`) ✅

## Voice and HUD handling (Task 7)

HUD:
- `dat-hud` is gated by `import.meta.env.DEV` — absent in production build ✅
- No verbose diagnostics in the glasses UI ✅
- No raw backend payloads or debug internals shown ✅
- Scan, processing, results, save, library, and settings screens are clear ✅

Voice:
- `src/voice.js` exists but is **not** imported in `main.js` ✅
- No microphone permission requested anywhere ✅
- No auto-started voice recognition ✅
- Primary demo trigger is D-pad/Enter and simulator controls ✅
- Future voice path is documented as a plan: wake phrase → scan/save/next/previous
  → audio feedback, pending Meta runtime/native bridge validation ✅

## Staging readiness checklist

- [ ] HTTPS host with publicly accessible URL (required for MRBD Web Apps)
- [ ] CORS configured on backend `https://kscan-app-1.onrender.com/api/analyze`
- [ ] Environment variables set for staging (no secrets in repo)
- [ ] `VITE_ENABLE_SIMULATOR=true` for staging demo if needed
- [ ] `dist/` built and verified (`npm run build`)
- [ ] `simulator.html` intentionally excluded from production deploy
- [ ] MediaPipe model + WASM assets copied to `dist/`
- [ ] No base64 images, real photos, or face metadata in deploy bundle
- [ ] Physical glasses validation scheduled (not a blocker for staging)

## Known limitations (unchanged)

- No physical Meta Ray-Ban Display glasses validation yet.
- Camera capture is via DAT/companion bridge abstraction only; no direct Web App camera.
- Voice activation is not directly verified in MRBD Web App runtime; remains future.
- No production deployment without explicit approval.
- postMessage origin pinning requires observing the real MRBD runtime origin.
- MediaPipe face-detection accuracy on real faces needs manual QA.
- Supabase client is not installed; app runs in stub mode with visible banner.

## Validation summary

| Check | Result |
|---|---|
| `npm test` | PASS (75 contract, 0 fail, 6 pre-existing WARNs) |
| `npm run build` | PASS (42.68 kB / 13.26 kB gzip) |
| `git diff --check` | LF/CRLF warning only (Windows normal) |
| `git diff --stat` | `src/main.js` +5 lines |
| Working tree | 1 file changed (the Escape-during-processing fix) |
| Safe to commit? | Yes — one surgical fix, all tests pass |
| Safe to stage deploy? | Yes — for browser/demo staging only; not production |
| Hardware blockers | Physical glasses, real DAT, real voice runtime, real waveguide |

## Suggested next step

1. **Commit the Phase 13 fix** (`src/main.js`) with message:
   `fix(mrbd): cancel in-flight scan on Escape/ArrowLeft during processing`
2. **Push** to `phase-11-virtual-alpha-infra`.
3. **Manual browser walkthrough** on a local machine with Chrome DevTools at 600×600
   to confirm the interactive feel (focus ring visibility, D-pad wrap, card scroll,
   rapid-Enter dedupe, Cancel/Escape recovery). This step cannot be automated in the
   current environment because the Kimi WebBridge browser extension is not connected.
4. **Staging deploy** once manual walkthrough is confirmed.
5. **Physical glasses validation** as a separate Phase 14/15 effort when hardware
   and Meta Developer Mode access are available.
