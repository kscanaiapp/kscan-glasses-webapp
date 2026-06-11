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
