# Mobile Bridge Dev Mode (Phase 17)

This document explains how to run the K Scan glasses web app in **dev bridge
mode**, where it requests capture through the K Scan mobile bridge alpha
(Phase 16) over a WebSocket instead of the built-in DAT/mock simulator.

> **Bluetooth/Wi-Fi transport in this repo is not a verified Meta glasses
> transport. It is a K Scan development bridge foundation. Production Meta DAT
> transport remains blocked until official dependency/API evidence is
> available.**

## Purpose

Establish the first end-to-end development path:

```
glasses web app  →  capture.request  →  bridge relay  →  mobile peer
mobile peer      →  capture.success (safe dev JPEG)  →  relay  →  glasses web app
glasses web app  →  existing privacy sanitizer  →  existing analyze pipeline  →  results UI
```

This lets the full glasses scan flow be exercised without glasses hardware,
while every production path and privacy guarantee stays intact.

## Required mobile bridge alpha branch

- Mobile repo: `C:\Users\jsmit\KScan`
- Branch: `feature/glasses-bridge-alpha` (Phase 16, commit `a35c392`)
- Relay tooling added in Phase 17 on the same branch:
  `BRIDGE_DEV_MODE=relay`, `scripts/simulate-mobile-client.js`,
  `npm run bridge:mobile`.

## How to enable

The mobile bridge is **OFF by default**. Enable it explicitly via one of:

### 1. Query param (recommended for local testing)

```
http://localhost:<vite-port>/?bridge=mobile&bridgeWs=ws://localhost:8787
```

### 2. LAN host

```
http://localhost:<vite-port>/?bridge=mobile&bridgeWs=ws://<LAN-IP>:8787
```

Replace `<LAN-IP>` with the mobile dev host's address. Do not commit a real IP.

### 3. Hash-appended query (SPA/router fallback)

```
http://localhost:<vite-port>/#/?bridge=mobile&bridgeWs=ws://localhost:8787
http://localhost:<vite-port>/#?bridge=mobile&bridgeWs=ws://localhost:8787
```

### 4. Vite env

```
VITE_ENABLE_MOBILE_BRIDGE=true
VITE_MOBILE_BRIDGE_WS_URL=ws://localhost:8787   # optional in env mode
```

Rules:

- Query param overrides env for the enable decision.
- **Query mode requires an explicit, valid `bridgeWs`.** A bare
  `?bridge=mobile` (no URL) fails safely with `BRIDGE_UNAVAILABLE`.
- **Env mode** may omit the URL; it then defaults to `ws://localhost:8787`.
- `bridge=mobile` must be an exact string match.
- Config is parsed once via a stable helper (`src/mobileBridgeConfig.js`),
  not on every render.

## WebSocket URL validation

Accepted schemes are **only** `ws://` and `wss://`. The following are rejected
(→ `BRIDGE_UNAVAILABLE`): `http://`, `https://`, empty, relative,
`javascript:`, `data:`, `file:`, and any unknown/malformed scheme.

`ws://` is **unencrypted** and acceptable only for `localhost` or a **trusted
LAN** during development. **Never use `ws://` over the public internet.**
Production transport would require `wss://`, authentication, and official Meta
transport evidence.

## Dev tooling commands

Three terminals (default port `8787`):

```powershell
# Terminal A — mobile repo: relay server
cd C:\Users\jsmit\KScan
$env:BRIDGE_DEV_MODE="relay"
npm run bridge:server

# Terminal B — mobile repo: mobile peer (safe dev JPEG fixture)
cd C:\Users\jsmit\KScan
npm run bridge:mobile

# Terminal C — glasses repo: web app
cd C:\Users\jsmit\kscan-glasses-webapp
npm run dev
```

Then open:

```
http://localhost:<vite-port>/?bridge=mobile&bridgeWs=ws://localhost:8787
```

If the mobile repo is configured to a different port, adjust all URLs
consistently.

## Behavior summary

- **Provider selection** is atomic and per-capture. When mobile bridge mode is
  enabled, capture goes through the bridge **only** — the DAT/mock simulator
  does not run simultaneously, and there is **no silent fallback** to DAT on
  bridge failure (a controlled bridge error is surfaced instead).
- **Timeout:** 10 seconds default; rejects with `CAPTURE_TIMEOUT`.
- **Socket close while a request is in flight:** rejects with
  `BRIDGE_UNAVAILABLE`.
- **Socket error while in flight:** rejects with `HANDOFF_FAILED`.
- **One active request at a time:** a second concurrent capture rejects with
  `CAPTURE_ALREADY_PENDING`.
- **Reconnect:** one retry after 2s on initial connect failure, then
  `BRIDGE_UNAVAILABLE`. (Production would need robust retry/auth.)
- **Final gate:** the bridge's success payload still passes through the
  existing `validateCapturePayload()` and then the existing privacy sanitizer
  before analyze — unchanged.

## Fallback (production default)

With no query params and no env flag, `isMobileBridgeEnabled()` returns
`false`; the app uses the existing DAT/mock simulator path exactly as before.
The mobile bridge never connects.

## Dev status surface

In a DEV build with the bridge enabled, a safe metadata function is exposed:

```js
window.__kscanBridgeDebug()
// → { bridgeMode, enabled, url, configError, connectionState,
//     lastMessageType, lastErrorCode, activeRequestId, updatedAt }
```

It returns **safe metadata only** — never image payloads, base64, byte
lengths, secrets, or hardcoded IPs. It is not rendered as DOM and does not
exist in production builds.

## Safety rules

- The existing privacy sanitizer always runs after capture and before analyze.
- No unsanitized image is ever sent to the backend.
- No image payload (full or partial), byte length, dimensions, or EXIF is ever
  logged. Full bridge messages that may contain an `image` field are never
  stringified for logging.
- No hardcoded private LAN IPs in source; docs use `<LAN-IP>`.

## What is NOT implemented in this phase

- Production Meta DAT transport (still blocked pending official SDK/API).
- Production Bluetooth transport (Meta protocol details unknown).
- Any phone-camera substitute for glasses capture.
- Any backend upload bypass.

## Known limitations

- `ws://` is unencrypted; localhost/trusted-LAN dev only.
- Single reconnect attempt only; no auth.
- Relay forwards the **first** matching response; multiple peers are a dev
  convenience, not a production routing model.

See `BRIDGE_CONTRACT.md` for the full message contract and error codes.
