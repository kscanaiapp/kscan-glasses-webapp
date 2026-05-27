# kscan-glasses-webapp

Standalone web app foundation for K Scan AI on Meta Ray-Ban Display glasses. This repository is intentionally separate from the K Scan mobile app, backend API codebase, and marketing website.

## Current Limitations

- DAT is scaffolded, not device-verified.
- Privacy sanitizer is implemented, but final production packaging still requires physical-device verification.
- Backend API client is scaffolded; production backend testing is pending.
- Supabase sync is not implemented yet.

## Overview

- Fixed `600x600` viewport
- D-pad-first navigation
- DAT bridge capture abstraction
- On-device privacy sanitizer before backend upload
- Guarded backend analyzer client for `POST /api/analyze`

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

4. Build:

```bash
npm run build
```

## Environment Variables

- `VITE_KSCAN_BACKEND_URL`
- `VITE_SUPABASE_URL` (placeholder only)
- `VITE_SUPABASE_ANON_KEY` (placeholder only)
- `VITE_META_APP_ID` (reserved)
- `VITE_META_CLIENT_TOKEN` (reserved)
- `VITE_MOCK_DAT`

## Phase 2 - DAT Bridge Verification

- Direct browser camera access is intentionally not used.
- Capture stays behind `capturePhoto()` in `src/datBridge.js`.
- Mock capture only runs when `VITE_MOCK_DAT=true` and not production.

Canonical contract:

Request:
```json
{ "type": "capture-photo", "requestId": "capture_..." }
```

Success response:
```json
{ "type": "photo-captured", "requestId": "capture_...", "base64": "..." }
```

Error response:
```json
{
  "type": "photo-capture-error",
  "requestId": "capture_...",
  "code": "PERMISSION_DENIED",
  "message": "Permission denied"
}
```

Legacy compatibility is retained for `REQUEST_CAPTURE`/`CAPTURE_RESPONSE`.

## Phase 3 - Privacy Sanitizer

Sanitizer pipeline (always before backend upload):

`capturePhoto() -> sanitizeImageBeforeUpload() -> analyzeImage()`

Inside sanitizer:

`decode -> canvas redraw -> resize -> face detect -> black mask -> JPEG re-encode`

Implementation details:

- Package: `@mediapipe/tasks-vision`
- WASM assets: `public/mediapipe/wasm/`
- Model path expected by app: `public/models/blaze_face_full_range.tflite`
- Model binary is stored at `public/models/blaze_face_full_range.tflite` and verified by `npm run verify:models`.
- Face boxes/keypoints are not returned, stored, or logged.
- Raw image/base64/face metadata must not be logged or stored.

MediaPipe output note:

- MediaPipe Face Detector provides bounding boxes/keypoints; this app uses them in-memory for masking only and does not expose them outside `privacyImageSanitizer.js`.

Additive-display note:

- Black privacy masks protect backend upload privacy. On additive displays, black regions can appear transparent.

### Model and Asset Source Notes

WASM/runtime assets:

- Source: npm package `@mediapipe/tasks-vision` (Apache-2.0)
- Copied into: `public/mediapipe/wasm/`
- Copy command: `npm run copy:wasm` (also runs on `postinstall`)

Model binary:

- Expected filename: `blaze_face_full_range.tflite`
- Expected path: `public/models/blaze_face_full_range.tflite`
- Official sample source URL:
  `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite`
- Related model card:
  `https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Full%20Range%29.pdf`
- Retrieval date: 2026-05-27
- Retrieved file size: 1,083,786 bytes
- Selection rationale: full-range is preferred for world-facing/glasses-style capture distance over short-range.
- Model verification command: `npm run verify:models`
- Distribution/license note: `@mediapipe/tasks-vision` package is Apache-2.0; model license details should be rechecked against official model documentation before production redistribution policy is finalized.

### Privacy Testing

Test with mock DAT:

1. Set `VITE_MOCK_DAT=true`
2. Ensure model exists at `public/models/blaze_face_full_range.tflite` (or run `npm run download:models`)
3. Run `npm run dev`
4. Trigger scan

Test sanitizer failure:

1. Set `VITE_MOCK_DAT=true`
2. Remove/missing `public/models/blaze_face_full_range.tflite`
3. Trigger scan
4. App should show `Privacy scan failed. Try again.` and not call backend analyze

Asset setup commands:

1. `npm run copy:wasm`
2. `npm run download:models` (uses official Google MediaPipe sample source URL)
3. `npm run verify:models`

## Phase 4 - Backend Analyze Integration

- Required env var: `VITE_KSCAN_BACKEND_URL`
- Example `.env` value:
  `VITE_KSCAN_BACKEND_URL=https://kscan-app-1.onrender.com`
- Backend URL is normalized to remove trailing slashes before calling:
  `${normalizedBackendUrl}/api/analyze`
- If backend URL is missing/empty, request is not sent and user sees:
  `Backend not configured.`

Exact request contract:

```json
{ "image": "sanitizedBase64" }
```

Headers:

```json
{ "Content-Type": "application/json" }
```

Privacy rule in scan flow:

`capturePhoto() -> sanitizeImageBeforeUpload() -> analyzeImage(sanitizedBase64) -> render results`

Only sanitized images are sent to backend.

Timeout behavior:

- At 5s while waiting for backend: `Waking up Fashion AI...`
- At 25s: request aborts and user sees `Request timed out. Please try again.`

Error behavior:

- Network/CORS failure: `Cannot reach server. Check connection.`
- Non-2xx: `Analysis failed. Please try again.`
- Invalid JSON/shape: `Unexpected server response.`

Backend CORS note:

- Backend must allow CORS from the deployed glasses web app origin.

Results behavior:

- Display limit is top 5 products.
- Empty or missing products array renders friendly state: `No items identified`.

Manual local-image test (browser only, no upload):

1. Open app in dev
2. In browser console, call sanitizer with a local image data URL
3. Keep output local unless explicitly passed into app flow

## Local Testing Checklist

- 600x600 layout is enforced
- No global body scrolling
- All interactive controls use `.focusable`
- Arrow keys + Enter navigation works
- DAT mock returns base64
- Sanitizer runs before analyze API call
- Error/retry flow works
- No secrets committed
