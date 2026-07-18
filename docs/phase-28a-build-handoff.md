# Phase 28A — Build Handoff (Software Prototype Completion)

Build-only phase. No terminal validation, builds, tests, commits, or deploys were run.
Branch/commit state could not be verified without git (expected context: `feature/meta-textscan-local-qa-p27` @ `e8572b8`).

## What Was Built

1. **Bridge state scaffold** — new `src/bridgeState.js`. Client-side state machine
   (`idle / requesting / capturing / success / error / timeout`) driven by same-origin
   postMessage events `capture.request|capturing|success|error` (plus `kscan:capture-*`
   aliases). Stores safe metadata only (timestamp/size/width/height) — never base64,
   payloads, or tokens. DEV-only status logging. 10s scaffold timeout. Wired into
   `main.js`: scaffold events drive the BRIDGE badge and home bridge pill.
   `// TODO: Replace scaffold with real DAT/mobile bridge call after hardware validation.`

2. **Dynamic home status pills** (`index.html` + `main.js`): Privacy (on-device),
   TextScan (Mock / Live Ready / Config Required), Session (Linked / Required),
   Bridge (Mock / Pending / scaffold states). Replaces the previous hardcoded
   "Privacy gate passed" / "Bridge: mock phone handoff" static claims.

3. **Pipeline stepper** on the processing screen, wired to real flow state:
   - Image: `Capture → Privacy → Analyze → StyleMatch → Results` (driven by CAPTURING/SANITIZING/ANALYZING)
   - TextScan: `Preset → Session → scan-identify → StyleMatch → Results`

4. **Honest Alpha labeling**: `ALPHA · HW VALIDATION PENDING` banner in the HUD;
   home footnote updated to "Alpha preview · … · Not validated on glasses hardware";
   simulator header copy now describes the real architecture (privacy sanitize →
   /api/analyze; preset → session → scan-identify) and drops investor-era claims.

5. **TextScan polish**: passive `spokenSummary` display line on the result card
   (display-only; adapter already clamps to 120 chars and redacts base64-like runs).
   No audio, no `speechSynthesis`.

6. **Simulator improvements**: new "Bridge State Scaffold" fieldset (request /
   capturing / success-metadata / error / timeout buttons); live TextScan status
   strip that mirrors `kscan:textscan-live-status`; removed unreachable dead code
   in the `[data-textscan]` handler; "Closet" naming on home/library screens.

7. **600×600 containment CSS** appended to `style.css`: pill/spoken/stepper labels
   use nowrap+ellipsis; `#error-message` clamped to 3 lines.

## Files Modified

- `index.html` — alpha banner, dynamic pills, pipeline stepper node, Closet labels, honest footnote
- `src/main.js` — pipeline stepper, pill updater, bridge scaffold wiring, spokenSummary line
- `src/bridgeState.js` — NEW bridge state scaffold
- `style.css` — Phase 28A section appended (banner, stepper, pills, clamps)
- `simulator.html` — copy, bridge scaffold controls, TextScan strip, dead-code removal
- `docs/phase-28a-build-handoff.md` — this file

## What Still Needs Validation (next terminal/build model)

- `npm run test:static` — note: static tests WARN on `console.log` in bundle; the
  scaffold log is DEV-gated so production bundles should stay clean, but verify.
- `npx vite build` + 600×600 browser check of: 4-pill row fit on home, alpha banner
  vs. reticle overlap (banner is top-left; bridge badge top-right), stepper width,
  spoken-summary line, Closet labels.
- Simulator: bridge scaffold buttons → BRIDGE badge transitions incl. 10s timeout;
  confirm no interference with the existing `capture-photo`/`photo-captured` DAT sim flow
  (different message types — expected no collision).
- Live TextScan smoke still skipped (no env/session) — unchanged from Phase 27.
- Public HTTPS preview + Meta AI app load + real glasses: still pending.

## Intentionally Not Changed

Image Scan backend path (`/api/analyze`), Supabase contract & Edge Functions,
privacy sanitizer internals and MediaPipe load order (verified lazy-loaded via
dynamic `import('@mediapipe/tasks-vision')` inside the sanitize call — does NOT
block initial HUD render; no change needed), `datBridge.js` internals, voice,
product matching, deployment config, Google/XR repos, main KScan repo.

## Preview-Readiness Sweep Result (code inspection only)

No hardcoded `http://` URLs in app source (only `ws://localhost` dev bridge in
`.env.example`, documented dev-only). No JWT-like strings, service-role keys, or
Gemini keys in client code. Simulator uses obviously-fake placeholder tokens and
never prints token values. `source: 'preset'` enforced; `'manual'` normalized away.

## Layout Validation Debt

Layout changes made without browser verification — requires 600×600 viewport
validation in next phase.

## Risks / Watch Items

- 4 status pills + banner on the home screen may crowd 600×600 — needs visual check.
- Bridge scaffold accepts same-origin messages only; the accepted-origin policy must
  be revisited for the real Meta runtime (see `VITE_DAT_PARENT_ORIGIN` pattern).
- Windows↔sandbox mount lag was observed during this phase (bash view of files
  trails file-tool writes); files verified complete via direct reads.

Recommended next step: Terminal Validation
Reason: static tests + build + 600×600 browser pass are required before public
HTTPS preview; all Phase 28A changes are UI/scaffold-level and cheaply verifiable there.
