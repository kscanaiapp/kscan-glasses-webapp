# Meta Runtime Preview Checklist (Phase 30)

Practical QA checklist for testing the public HTTPS preview. Nothing here is
hardware-validated yet — this checklist is how we get there.

## 1. Open the preview

- Open `https://<preview-url>/` — expect the 600×600 HUD: `ALPHA · HW VALIDATION PENDING`
  banner (top-left), `BRIDGE:` badge (top-right), Scan button, TextScan presets,
  4 status pills, Closet/Settings.
- Open `https://<preview-url>/simulator.html` — expect the control room with the
  app in a 600×600 iframe.

## 2. 600×600 browser viewport

- DevTools → responsive mode → 600×600. Verify: no horizontal scroll, no page
  scroll on home, pills fit one row (or wrap cleanly), footnote visible.
- Diagnostics screen (Settings → Runtime Diagnostics) shows `Viewport: 600×600`.

## 3. Modes

- Mock (default): no query params. Pills: `TextScan: Mock` or `Config Required`,
  `Bridge: Mock/Pending`.
- Hardware test mode: append `?mode=hardware`. Banner switches to
  `ALPHA · HW TEST MODE`; Scan now calls `bridgeState.requestCapture()` and will
  TIMEOUT after ~10s if no runtime answers — that is correct behavior.
- Bridge mode without hardware label: set `VITE_USE_REAL_BRIDGE=true` in hosting
  env, or inject `window.__KSCAN_CONFIG__.USE_REAL_BRIDGE = true`.

## 4. D-pad navigation

Arrow keys move focus, Enter activates, ArrowLeft/Escape goes back. Focus ring
must be visible on every interactive control, including the new Settings →
Runtime Diagnostics row and the Diagnostics Back/Refresh buttons.

## 5. Status pills / diagnostics

- Settings → Runtime Diagnostics: verify all rows render (Viewport, Runtime mode,
  Bridge mode, Bridge status, Session, Supabase config, Backend URL, Privacy
  sanitizer, TextScan, Image Scan, Last error code, Bridge error).
- Confirm NO tokens, URLs (hostname at most), or base64 appear anywhere.

## 6. Image Scan flow

- Mock mode: Scan → Capture → Privacy → Analyze stepper → results (mock products).
- Simulator bridge flow: in simulator.html use "Bridge: full Image Scan flow" —
  now uses a 640×640 synthetic fixture, so the privacy sanitizer should accept it
  and the full capture → privacy → /api/analyze → StyleMatch chain can run.
- Error paths: "success (no image)", "invalid payload", "timeout" buttons must
  end in a short safe error message with Retry.

## 7. TextScan flow

- Press a preset (e.g. Black Blazer). Mock mode → labeled `TEXTSCAN MOCK`.
- Live: requires Supabase config + injected session; without them expect
  `Supabase missing.` / `Sign in required.` cards — that is correct.
- Non-Fashion preset must show the non-fashion card, not a fake match.

## 8. Not validated yet — do not claim

- Real glasses rendering, input mapping, or camera bridge.
- Cross-origin bridge events from the actual Meta runtime (requires
  `VITE_BRIDGE_ALLOWED_ORIGINS` set to the runtime origin — same-origin only by default).
- MediaPipe/WASM load performance on device.
- Live scan-identify latency from the preview host.

Do not claim: production ready, validated on glasses, real-time camera live.
