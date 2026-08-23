# Phase 30 — Public HTTPS Preview + Hardware-Test-Ready Build (Handoff)

## Summary

Built the runtime pieces needed to take the validated Phase 29 prototype to a
public HTTPS preview and first Meta runtime load: hardware test mode
(`?mode=hardware`), a Runtime Diagnostics screen inside Settings, an explicit
bridge-event origin allowlist, preview env/config documentation, Meta runtime
QA checklist + glasses load instructions, and a real-sized synthetic bridge
fixture so the simulator smoke flow can pass the privacy sanitizer.

Bridge expectation check: `src/bridgeState.js` still contains all Phase 29 work
(`requestCapture()`, capture.success/error handling, metadata-only state,
timeout rejection). Nothing was rebuilt.

## Files Modified

- `src/main.js` — `isHardwareTestMode()`, hardware→bridge implication in
  `shouldUseBridgeCapture()`, Runtime Diagnostics screen (render + wiring +
  focus matrix), `lastSafeErrorCode` / `lastBridgeSnapshot` diagnostics state,
  HW TEST banner label
- `src/bridgeState.js` — explicit bridge-event origin allowlist
  (`BRIDGE_ALLOWED_ORIGINS` runtime config / `VITE_BRIDGE_ALLOWED_ORIGINS`);
  same-origin remains the default; `*` is ignored by design
- `index.html` — `#diagnostics` screen, Settings → Runtime Diagnostics row
- `simulator.html` — bridge success events now use the 640×640 synthetic
  canvas fixture (lazy) instead of the 1×1 PNG that could fail the sanitizer
- `.env.example` — Phase 30 preview/hardware section, `VITE_BRIDGE_ALLOWED_ORIGINS`,
  reserved `VITE_BRIDGE_TARGET_ORIGIN`, preview-mode documentation
- `docs/meta-runtime-preview-checklist.md` — NEW
- `docs/meta-glasses-load-instructions.md` — NEW (placeholder, not device-tested)
- `docs/phase-30-public-preview-handoff.md` — this file

## Runtime / Hardware Test Mode

- Canonical: open the app with `?mode=hardware`.
- Advanced: `window.__KSCAN_CONFIG__.HARDWARE_TEST_MODE = true` (and/or
  `USE_REAL_BRIDGE = true`).
- Effect: implies bridge mode (Scan → `bridgeState.requestCapture()`), banner
  shows `ALPHA · HW TEST MODE`, bridge pill shows HW Test. All Alpha /
  hardware-pending labels, mock/live labeling, and the privacy pipeline are
  unchanged. Default (no flag) remains safe simulator/mock.

## Diagnostics

Settings → Runtime Diagnostics (`#diagnostics` screen; Back + Refresh are
`.focusable`; live-updates on bridge events). Rows: Viewport (vs 600×600),
Runtime mode, Bridge mode, Bridge status, Session, Supabase config, Backend URL
(configured/missing only), Privacy sanitizer, TextScan, Image Scan, Last error
code, Bridge error. Codes and short statuses only — never tokens, base64,
image data, or env values.

## Preview Configuration

See `.env.example` Phase 30 section. Key flags: `VITE_USE_REAL_BRIDGE`
(default false), `VITE_BRIDGE_ALLOWED_ORIGINS` (empty = same-origin only),
`?mode=hardware` (no env needed). Env values belong in the hosting dashboard,
never the repo. `vercel.json` already present and correct for a Vite static
build (dist output, simulator.html included via rollup inputs) — unchanged.

## Validation Results

Environment limitation (this session runs file edits on Windows, terminal in a
Linux sandbox): `node_modules` contains Windows-native binaries
(`@esbuild/win32-x64`, `@rollup/rollup-win32-*`), so `npm run build` cannot
execute in the sandbox, and the sandbox's mounted copies of pre-existing source
files are stale (June 24 snapshots) — running `test:static`/`test:contract`
there would test the wrong code. Package installation is out of scope.

What WAS verified this session:
- `node --check` (ESM parse) on the current `src/bridgeState.js`: PASS
- `node --check` on the Phase 30 main.js additions (extracted blocks): PASS
- Full line-by-line read-through of the final `src/main.js` (1212 lines),
  `index.html`, `simulator.html` diffs — no truncation, structure coherent
- No secrets/tokens/base64 introduced; diagnostics shows codes only

REQUIRED before deploy (run on Windows in the repo):

```powershell
npm run test:static
npm run test:contract
npm run build
```

## Preview Deployment

```text
Preview blocked: Vercel project config missing.
```

Decision tree results: (1) build not runnable in this environment (see above);
(2) `.vercel/project.json` absent (only `repo.json` exists); (3) `vercel` CLI
not installed in the sandbox. Manual step for the operator:

```powershell
cd C:\Users\jsmit\kscan-glasses-webapp
npm run build
vercel --target=preview   # after `vercel link` to (re)create .vercel/project.json
```

Never `vercel --prod`.

## What Still Needs Real Testing

- The three npm validation commands above on Windows.
- Public HTTPS preview load (app + simulator.html) and 600×600 browser pass.
- `?mode=hardware` behavior: Scan → BRIDGE REQUESTING → TIMEOUT (~10s) with
  safe retry when no runtime responds.
- Simulator "Bridge: full Image Scan flow" now with the 640×640 fixture —
  should traverse privacy sanitize → /api/analyze (or mock) → StyleMatch.
- Cross-origin bridge events with `VITE_BRIDGE_ALLOWED_ORIGINS` set.
- Meta AI app load, real glasses input mapping, MediaPipe on-device performance.

## What Was Intentionally Not Changed

`/api/analyze` contract, Supabase TextScan path + Edge Functions, privacy
sanitizer internals, real native DAT bridge, direct camera capture
(`getUserMedia` still unused), voice/audio, product matching, backend
contracts, Google/XR work, `vercel.json`, deployment/git state.

## Risks / Watch Items

- Outbound `postMessage` from `requestCapture()` still targets `'*'`
  (documented TODO) — restrict once the runtime origin is known.
- Diagnostics screen layout is unverified in a browser (uses existing
  settings-list/status-row styles; low risk, needs the 600×600 pass).
- The stale-mount issue means sandbox-side test runs in FUTURE sessions may
  silently test old code — always verify file freshness (mtime/line counts)
  before trusting sandbox npm results.
- `.vercel/project.json` must be created via `vercel link` before CLI preview
  deploys will work.

Recommended next step: Public Preview Fixes
Reason: run the three npm commands + `vercel link` + `vercel --target=preview`
on Windows, then walk `docs/meta-runtime-preview-checklist.md` against the
preview URL; that unlocks Meta Runtime Load with real feedback via the new
diagnostics screen.
