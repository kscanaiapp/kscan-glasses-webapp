# Meta TextScan Local QA — Phase 27

## Scope

Local QA and pre-deployment readiness for the Meta Ray-Ban Display TextScan live integration path. This does not constitute staging-validated or on-device glasses-validated testing.

## Live Smoke QA

### Environment Variables

Live smoke requires these env vars (never committed):

```env
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
KSCAN_TEST_SUPABASE_ACCESS_TOKEN=<access-token>
KSCAN_TEST_SUPABASE_REFRESH_TOKEN=<refresh-token>
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are public web config values. `KSCAN_TEST_SUPABASE_ACCESS_TOKEN` and `KSCAN_TEST_SUPABASE_REFRESH_TOKEN` are local-only QA secrets.

### Running

```sh
node scripts/textscan-live-smoke.js
```

Exits 0 with `SKIPPED: missing live QA env/session` when env is absent. Exits 0 on success. Exits 1 when live invocation fails. Token values are always redacted in output.

### What It Tests

- Supabase client creation with public URL + anon key
- Session hydration with access/refresh token
- `scan-identify` invocation with `mode: 'text'`, `textQuery`, `source: 'preset'`, `clientTimestamp`
- Response shape: status, attributes, userMessage
- No stack traces, secrets, or image payloads in response
- `spokenSummary` derivable and within 120 chars

## Browser / Simulator QA

### Mock Mode

1. Open `http://localhost:5173/?sim=1&textscanMode=mock`
2. Or open simulator at `http://localhost:5173/simulator.html`
3. Click any TextScan preset (Black Blazer, Quiet Luxury, etc.)
4. Verify result card renders with:
   - `TEXTSCAN MOCK` badge
   - Summary text
   - Intent pills (Style, Color, Material, etc.)
   - `SOURCE PRESET` badge

### Live Mode — Missing Config

1. Simulator: set TextScan mode to `live: missing Supabase config`
2. Click Reload TextScan mode
3. Click any TextScan preset
4. Verify `SUPABASE MISSING` status and `CONFIG_REQUIRED` error category

### Live Mode — Config, No Session

1. Simulator: set TextScan mode to `live: config, no session`
2. Click Reload TextScan mode
3. Click any TextScan preset
4. Verify `SIGN IN REQUIRED` status and `AUTH_REQUIRED` error category

### Live Mode — Injected Session

1. Simulator: set TextScan mode to `live: injected mock session`
2. Click Reload TextScan mode
3. Verify Supabase config placeholder is injected
4. Verify mock session is posted via `kscan:supabase-session`
5. Click a TextScan preset
6. Verify no token values in logs or UI

### PostMessage Session Injection

1. Use simulator buttons: `Post mock session` / `Post mock token`
2. Verify `kscan:supabase-session-linked` event fires (visible via HUD update)
3. Verify no token values in simulator log

### URL Token Injection

1. Simulator: set TextScan mode to `live: URL token injection`
2. Click Reload TextScan mode
3. Verify `access_token` param is scrubbed from URL after load
4. Verify scrub uses `history.replaceState` (no page reload)

### Rapid Duplicate Invocation

1. Click `Rapid duplicate` in simulator
2. Verify only one TextScan invocation completes (second blocked by concurrency guard)
3. Verify `BUSY` error for duplicate

## D-Pad Preset Selection QA (600x600)

### Setup

1. Open app at `http://localhost:5173/` in a browser window sized to 600x600
2. Or use the simulator which embeds a 600x600 iframe

### Checklist

- [ ] TextScan presets are visible on the home screen
- [ ] Arrow keys navigate between presets (ArrowUp/Down/Left/Right)
- [ ] Focus ring (cyan glow) is visible on each focusable preset
- [ ] Enter activates the focused preset and triggers TextScan
- [ ] Result card displays within 600x600 without horizontal scrolling
- [ ] Result summary is glanceable (roughly 3 lines, ~40 chars wide)
- [ ] Error/status text uses ellipsis containment
- [ ] Back button (ArrowLeft / Escape) returns to home from results
- [ ] No `.focusable` elements are hidden offscreen but still reachable
- [ ] Retry button is focusable when error result is shown
- [ ] Focus is not lost after result render
- [ ] No page-level scrolling occurs
- [ ] No `<input type="text">` or `<textarea>` is present in the HUD

## HTTPS / Public URL Readiness

Phase 27 confirms local readiness. Phase 28 is required for:

- Public HTTPS tunnel or preview URL deployment
- Meta AI app connection and on-device validation
- Real Supabase staging session with live `scan-identify` edge function
- Actual glasses waveguide display QA

### Static Readiness Checks

- No hardcoded `http://` backend/Supabase URLs in app source
- App builds to static assets in `dist/`
- `dist/index.html` and `dist/simulator.html` produced by build
- Current hosting/deploy target unchanged

## Interruption / Resume Behavior

Document-level `visibilitychange` and page hide/show:

- TextScan does not auto-retry on visibility change
- In-flight requests continue through background/foreground transitions
- Cancel button invalidates in-flight tokens on manual interrupt

Simulated middle-pinch / universal-menu interruption: not testable locally. Deferred to Phase 28 on-device validation.

## Meta/Google Separation

Meta TextScan local QA stayed separate from Google glasses work. No Google, Gemini, Android XR, or shared wearable abstraction files were modified.

## Phase 28 Handoff

Phase 28 required: Public HTTPS tunnel or preview URL + Meta AI App / on-device validation. The live TextScan path is pre-deployment ready once Supabase config and an injected or existing session are supplied through a public HTTPS URL loaded in the Meta AI app.
