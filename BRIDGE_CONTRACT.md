# K Scan Bridge Message Contract

App-level bridge contract shared between the K Scan glasses web app
(`src/mobileBridgeClient.js`) and the K Scan mobile bridge alpha
(Phase 16, `services/bridge/bridgeTypes.ts`).

> This is the **K Scan app-level** contract. It is **not** a verified Meta
> platform contract. The native Meta DAT handoff contract remains UNKNOWN; no
> Meta bridge object names, UUIDs, or SDK calls are used or invented.

## Transport

- Dev transport: WebSocket (`ws://` localhost/LAN dev only, or `wss://`).
- The glasses client uses the browser's built-in `WebSocket`.
- The mobile bridge alpha uses React Native's built-in `WebSocket`.
- Dev tooling relay: `scripts/bridge-dev-server.js` with `BRIDGE_DEV_MODE=relay`.

## Messages

### `capture.request` (glasses/web → mobile)

```json
{
  "type": "capture.request",
  "requestId": "string",
  "source": "glasses-web",
  "createdAt": "ISO-8601 string",
  "timeoutMs": 10000
}
```

### `capture.success` (mobile → glasses/web)

```json
{
  "type": "capture.success",
  "requestId": "string",
  "image": "data:image/jpeg;base64,...",
  "mime": "image/jpeg",
  "encoding": "data-url",
  "createdAt": "ISO-8601 string"
}
```

### `capture.error` (mobile → glasses/web)

```json
{
  "type": "capture.error",
  "requestId": "string",
  "code": "ERROR_CODE",
  "message": "string",
  "createdAt": "ISO-8601 string"
}
```

## Error codes

| Code | Meaning |
| --- | --- |
| `BRIDGE_UNAVAILABLE` | Bridge not configured/reachable; no peer; socket closed in flight |
| `CAPTURE_TIMEOUT` | No response within the timeout (default 10s) |
| `CAPTURE_ALREADY_PENDING` | A capture is already in flight |
| `INVALID_CAPTURE_RESPONSE` | Success payload failed JPEG data-URL validation |
| `DAT_NOT_CONFIGURED` | Mobile DAT transport blocked (no official SDK) |
| `BLUETOOTH_NOT_CONFIGURED` | Mobile Bluetooth transport blocked (protocol unknown) |
| `NATIVE_CAPTURE_FAILED` | Native capture failed / unmapped error |
| `HANDOFF_FAILED` | Transfer of the captured image to the consumer failed (socket error in flight) |

The glasses client maps any unrecognized incoming `code` to
`NATIVE_CAPTURE_FAILED`.

## Payload validation (final gate)

Accepted image payloads must:

- be a string,
- trim to a non-empty value,
- start with the exact, case-sensitive prefix `data:image/jpeg;base64,`,
- contain a non-empty base64 body after the comma.

A syntactically valid JPEG data URL whose bytes are not a real JPEG passes this
**syntax** gate and may fail later in the privacy sanitizer / decode stage. No
PNG, HEIC/HEIF, blob, remote URL, or raw base64 is accepted.

On the glasses side the bridge payload is validated in
`src/mobileBridgeClient.js` and then again by the existing
`validateCapturePayload()` in `src/datBridge.js` (the canonical final gate)
before the privacy sanitizer and analyze pipeline run.

## Timeout & lifecycle

- Default request timeout: **10000 ms** (`CAPTURE_TIMEOUT`).
- One active request at a time (`CAPTURE_ALREADY_PENDING`).
- Responses are matched by `requestId`, never by arrival order; mismatched IDs
  are ignored safely.
- Timers/listeners are always cleared on success, error, timeout, and close.

## Socket close / error behavior

- `onclose` while a request is pending → reject `BRIDGE_UNAVAILABLE`, clear state.
- `onerror` while a request is pending → reject `HANDOFF_FAILED`, clear state.
- No stale timers fire after cleanup.

## Relay behavior (dev server)

- `capture.request` is broadcast to all non-sender peers.
- The first matching `capture.success`/`capture.error` is forwarded to the
  original requester; later duplicates are dropped.
- No peer connected → `capture.error BRIDGE_UNAVAILABLE`.
- No peer responds in time → `capture.error CAPTURE_TIMEOUT`.

## Message size

No maximum payload size is defined yet. Future phases must account for
WebSocket frame limits, Bluetooth MTU/chunking, Meta DAT payload limits, and
compression/chunking. Chunking is not implemented in this phase.

## Privacy

- Image payloads (full or partial), byte length, dimensions, and EXIF are
  never logged.
- Full bridge messages that may carry an `image` field are never stringified
  for logging — only `{ type, requestId, status, code }` is logged.
- No unsanitized image is sent to the backend; the existing privacy sanitizer
  always runs before analyze.

## Security

`ws://` is unencrypted — localhost / trusted-LAN development only. Never use
`ws://` over the public internet. Production transport requires `wss://`,
authentication, and official Meta DAT transport evidence.
