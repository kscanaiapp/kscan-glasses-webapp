# Meta TextScan Adapter — Phase 25

## Scope

This document confirms that Phase 25 work stayed strictly within the **Meta Ray-Ban Display webapp** path.

## What was built

- `src/services/textScan.js` — TextScan adapter for the Meta webapp
- `index.html` — TextScan preset buttons on the home screen
- `src/main.js` — TextScan flow integration, result rendering, D-pad navigation
- `style.css` — TextScan UI styles
- `simulator.html` — TextScan scenario controls for the simulator
- `.env.example` — `VITE_MOCK_TEXTSCAN` environment variable

## What was NOT touched

- Google glasses files (`kscan-google-glasses/`, `google-glasses/`, `android-xr/`, `gemini-glasses/`)
- KScan mobile app (`C:\Users\jsmit\KScan`)
- Backend contracts (`scan-identify` Edge Function in the KScan repo)
- Image scan path (`/api/analyze`)
- No new backend route created
- No shared Google/Meta abstraction

## Architecture

```
Meta Webapp ImageScan
  → existing /api/analyze path (unchanged)

Meta Webapp TextScan
  → src/services/textScan.js adapter
  → mock/simulator when VITE_MOCK_TEXTSCAN=true
  → AUTH_REQUIRED when live (no Supabase client yet)
  → StyleMatch-compatible result for HUD rendering
```

## Supabase status

`@supabase/supabase-js` is intentionally not installed in the Meta webapp.
Live TextScan calls return `AUTH_REQUIRED` until a real Supabase client is wired.
The adapter boundary is ready — the live call seam is commented and marked with TODOs.

## Meta/Google separation

Meta and Google wearable implementations are separate.
This phase modifies only the Meta webapp path.
Google glasses work is out of scope.
