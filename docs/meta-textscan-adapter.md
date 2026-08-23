# Meta TextScan Adapter - Phases 25-26

## Scope

This document confirms that TextScan work stayed strictly within the Meta Ray-Ban Display webapp path.

## What Was Built

- `src/services/textScan.js` - TextScan adapter for the Meta webapp.
- `src/services/supabaseClient.js` - centralized Supabase client and passive session receiver.
- `index.html` - TextScan preset buttons on the home screen.
- `src/main.js` - TextScan flow integration, result rendering, status badges, and D-pad navigation.
- `style.css` - TextScan UI/status containment styles.
- `simulator.html` - TextScan mock/live scenario controls.
- `.env.example` - Supabase placeholders and `VITE_MOCK_TEXTSCAN=false`.

## What Was Not Touched

- Google glasses files (`kscan-google-glasses/`, `google-glasses/`, `android-xr/`, `gemini-glasses/`).
- KScan mobile app implementation.
- Backend contracts or Supabase Edge Function code.
- Image scan path (`/api/analyze`).
- Production deployment settings.
- Public investor demo deployment.

## Architecture

```text
Meta Webapp ImageScan
  -> existing /api/analyze path (unchanged)

Meta Webapp TextScan
  -> src/services/textScan.js adapter
  -> mock/simulator when VITE_MOCK_TEXTSCAN=true or simulator mode=mock
  -> scan-identify mode:text when Supabase config and a session/token are injected
  -> CONFIG_REQUIRED or AUTH_REQUIRED when live prerequisites are missing
  -> StyleMatch-compatible result for HUD rendering
```

## Passive Session Injection

The Meta HUD cannot create an auth session and does not render login fields. It is a passive receiver for an existing session or temporary token from the phone companion app, simulator parent, runtime config, URL deep-link test, or existing Supabase SDK session.

Runtime config priority:

1. `window.__KSCAN_CONFIG__.SUPABASE_URL`
2. `window.__KSCAN_CONFIG__.SUPABASE_ANON_KEY`
3. `import.meta.env.VITE_SUPABASE_URL`
4. `import.meta.env.VITE_SUPABASE_ANON_KEY`

Session sources:

- `window.__KSCAN_CONFIG__.supabaseSession`
- `window.__KSCAN_CONFIG__.SUPABASE_SESSION`
- `window.__KSCAN_CONFIG__.supabaseAccessToken`
- `window.__KSCAN_CONFIG__.AUTH_TOKEN`
- URL query/fragment `access_token` for local deep-link tests, scrubbed after read
- `postMessage` `{ type: 'kscan:supabase-session', session: { access_token, refresh_token } }`
- `postMessage` `{ type: 'kscan:supabase-token', accessToken }`
- Existing Supabase SDK session

Tokens are never displayed, logged, or echoed over postMessage. Full sessions are hydrated through `supabase.auth.setSession`. Access-token-only injection is used as a temporary centralized function-invoke bearer override and is not written to app localStorage.

## Live Call Contract

Live TextScan calls invoke:

```js
supabase.functions.invoke('scan-identify', {
  body: {
    mode: 'text',
    textQuery,
    source,
    clientTimestamp
  }
});
```

Meta source policy:

- D-pad presets use `source: 'preset'`.
- Future voice transcripts should use `source: 'voice'`.
- Future Neural Band intents should use `source: 'neural'`.
- Future OCR-derived text should use `source: 'ocr'`.
- Camera-derived text context should use `source: 'camera'`.
- The Meta HUD does not use the manual source label.

Text queries are trimmed and capped at 500 characters before live invocation. Every StyleMatch-compatible result includes `spokenSummary` for future audio readout. Live duplicate invokes are blocked by an adapter-level concurrency latch. 401/auth responses trigger one refresh or rehydration retry. Retryable network/5xx errors retry at most twice within an 8 second total budget.

## Simulator

`simulator.html` preserves the Phase 25 mock scenarios and adds controls for:

- Mock TextScan success, non-fashion, network failure, and malformed response.
- Live mode with missing Supabase config.
- Live mode with placeholder Supabase config but no session.
- Live mode with injected mock session.
- PostMessage token/session injection.
- URL token injection for local testing.
- Rapid duplicate preset invocation.

The simulator uses placeholder config and placeholder mock tokens only. It logs event types and status labels, never token values.

## Meta/Google Separation

Meta and Google wearable implementations remain separate. This work modifies only the Meta webapp path. Google, Gemini, Android XR, and shared wearable abstractions are out of scope.
