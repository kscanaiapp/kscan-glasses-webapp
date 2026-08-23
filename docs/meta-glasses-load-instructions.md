# Meta Glasses Load Instructions (Placeholder — Not Yet Device-Tested)

These steps have NOT been executed on real hardware. They are the prepared
procedure for first device load.

## Prerequisites

- Public HTTPS preview URL: `https://<preview-url>/` (fill in after deployment).
- Meta AI app installed and paired with the Ray-Ban Display glasses.
- Developer mode enabled on the glasses/companion app (see Meta developer docs —
  exact toggle location may change between app versions).

## Load steps (placeholder)

1. Deploy or locate the current preview URL (Vercel preview).
2. Optional QR: generate one externally (any offline QR tool) pointing to
   `https://<preview-url>/?mode=hardware` — no QR dependency is bundled in this repo.
3. In the Meta AI app / developer surface, open the preview URL in the glasses
   runtime (mechanism TBD pending Meta developer access).
4. Expected first screen: K Scan home HUD — `ALPHA · HW TEST MODE` banner (when
   using `?mode=hardware`), Scan button, TextScan presets, status pills.

## Hardware test mode URL pattern

```text
https://<preview-url>/?mode=hardware
```

Implies USE_REAL_BRIDGE: the Scan button posts `capture.request` via postMessage
and waits ~10s for `capture.success` / `capture.error`.

## If the bridge does not respond

Expected on first load — the runtime bridge contract is unvalidated. The app
will show `BRIDGE: TIMEOUT` and a safe retry message. Fallback: test everything
else (TextScan, navigation, layout, diagnostics) which does not need the bridge.
Note: bridge events from a cross-origin runtime are ignored until that origin
is added to `VITE_BRIDGE_ALLOWED_ORIGINS` (or runtime config `BRIDGE_ALLOWED_ORIGINS`).

## What to collect on first device test

- Photo/screenshot of the first rendered screen (layout, clipping, brightness).
- Settings → Runtime Diagnostics screen contents.
- Whether D-pad/Neural Band input maps to Arrow/Enter/Back as assumed.
- Time to first render (MediaPipe assets are lazy — home should render fast).
- Bridge badge state after pressing Scan in `?mode=hardware`.
- Any console/runtime errors if a debug surface exists.

Do not claim any of this is validated until it has actually run on glasses.
