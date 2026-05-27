# kscan-glasses-webapp

Standalone web app foundation for K Scan AI on Meta Ray-Ban Display glasses. This repository is intentionally separate from the K Scan mobile app, backend API codebase, and marketing website so glasses-specific UX, runtime constraints, and release cadence can evolve independently.

## ⚠️ Current Limitations

- DAT is scaffolded, not device-verified.
- Privacy sanitizer strips metadata/resizes but real face detection is pending.
- Backend API client is scaffolded; production backend testing is pending.
- Supabase sync is not implemented yet.

## Overview

This app targets a fixed `600x600` display with D-pad-only interaction and no global scrolling. It includes:

- Multi-screen UI: Home, Processing, Results, Library, Settings, Error
- State machine: `IDLE`, `CAPTURING`, `SANITIZING`, `ANALYZING`, `SUCCESS`, `ERROR`
- DAT bridge wrapper with Meta runtime mode and browser mock mode
- Privacy image sanitizer (canvas metadata strip, resize, JPEG re-encode)
- Guarded backend analyzer client for `POST /api/analyze`
- Optional voice trigger wrapper (feature-detected)

## Why Separate From Mobile App

The glasses web app has unique requirements (fixed 600x600 viewport, D-pad focus model, additive-display visual constraints, DAT capture bridge, no direct `getUserMedia` usage). Keeping this in a standalone repo reduces coupling and avoids regressions in existing mobile, backend, and website projects.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create local env file from example:

```bash
cp .env.example .env
```

3. Run development server:

```bash
npm run dev
```

4. Build for production validation:

```bash
npm run build
```

## Environment Variables

Use `.env` (see `.env.example`):

- `VITE_KSCAN_BACKEND_URL`: backend host, used as `${VITE_KSCAN_BACKEND_URL}/api/analyze`
- `VITE_SUPABASE_URL`: placeholder only in this scaffold
- `VITE_SUPABASE_ANON_KEY`: placeholder only in this scaffold
- `VITE_META_APP_ID`: reserved for future Meta auth/runtime integration
- `VITE_META_CLIENT_TOKEN`: reserved for future Meta auth/runtime integration
- `VITE_MOCK_DAT`: `true` enables browser mock capture mode in development only

## Local Testing

### 600x600 Viewport

- The app enforces `600x600` body dimensions.
- In desktop browser DevTools, verify viewport at `600 x 600` and confirm no outer scrollbars.

### D-pad Navigation

Use keyboard only:

- `ArrowUp`: move focus up
- `ArrowDown`: move focus down
- `ArrowLeft`: back behavior
- `ArrowRight`: move right in matrix or activate current item
- `Enter`: activate focused item
- `Escape`: optional desktop back behavior

All handled keys are globally intercepted and call `preventDefault()`.

### DAT Bridge Notes

- Browser mock mode (default with `VITE_MOCK_DAT=true`) returns a generated base64 JPEG test image.
- Runtime capture request message:

```json
{ "type": "REQUEST_CAPTURE" }
```

- Expected capture response message:

```json
{
  "type": "CAPTURE_RESPONSE",
  "data": {
    "base64Image": "..."
  }
}
```

- Legacy/test response also supported:

```json
{ "type": "photo-captured", "base64": "..." }
```

### Privacy Sanitizer Notes

- Captured image is always sanitized before upload.
- Canvas redraw + JPEG re-encode strips metadata.
- Longest side is resized to max `800px`.
- Face masking hook exists (`detectFaces`, `maskFaceRegions`) and deterministic masking is implemented when face boxes are provided.
- No raw image should be uploaded before sanitizer output.

## Deployment Notes

- Must be deployed to public `HTTPS` URL for device testing.
- Vercel is recommended.
- Do not push secrets, production keys, test photos, or real user data.

## Known Limitations

- Direct Web App camera access is not used (`getUserMedia` is intentionally not used).
- Voice support depends on runtime/browser support and may be unavailable.
- Production face detection library (MediaPipe/TensorFlow or equivalent) must be integrated before privacy claims are finalized.
- Supabase auth/data flows are placeholders only.

## Verification Checklist

- [ ] 600x600 layout is enforced
- [ ] No global scrollbars on body
- [ ] All interactive elements use `.focusable`
- [ ] Arrow keys + Enter control navigation/actions
- [ ] DAT mock returns base64 image
- [ ] Sanitizer returns a new base64 string
- [ ] API request payload is exactly `{ "image": "base64-string" }`
- [ ] Error and retry flow works
- [ ] No secrets committed
