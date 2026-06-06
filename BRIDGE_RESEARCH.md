# BRIDGE_RESEARCH.md — K Scan Phase 12 DAT Source Reconnaissance

**Created:** 2026-05-31
**Status:** Research only. No source code changes made.
**Scope:** Native bridge readiness plan based on source evidence.

---

## 1. Purpose

This document records what is known, partially known, and unknown about integrating the Meta Wearables Device Access Toolkit (DAT) native iOS/Android SDKs with the K Scan Web App running on Meta Ray-Ban Display (MRBD) glasses. It drives the staged implementation plan for replacing the dev-only capture simulator with real native capture.

---

## 2. Sources Consulted

| Source | Status | Notes |
|---|---|---|
| `docs/meta/Build.txt` (Updated May 14, 2026) | VERIFIED | Capabilities, unsupported APIs, input model, viewport |
| `docs/meta/Setup.txt` (Updated May 18, 2026) | VERIFIED | Hardware requirements, Developer Mode, HTTPS hosting |
| `docs/meta/Test.txt` (Updated May 18, 2026) | VERIFIED | Add-flow, MRBD testing, sharing |
| `src/datBridge.js` (local) | VERIFIED | Current capture boundary and simulator |
| `src/main.js`, `src/api.js`, `src/privacyImageSanitizer.js` (local) | VERIFIED | App capture chain |
| `github.com/facebook/meta-wearables-dat-ios` `.cursor/rules/camera-streaming.mdc` | VERIFIED | iOS Swift photo capture API |
| `github.com/facebook/meta-wearables-dat-ios` `.cursor/rules/dat-conventions.mdc` | VERIFIED (summary) | iOS module structure and conventions |
| `github.com/facebook/meta-wearables-dat-android` `.cursor/rules/camera-streaming.mdc` | VERIFIED | Android Kotlin photo capture API |
| `github.com/facebook/meta-wearables-dat-android` `.cursor/rules/dat-conventions.mdc` | VERIFIED (summary) | Android module structure and conventions |
| `github.com/facebookincubator/meta-wearables-webapp` README | VERIFIED (summary) | WebApp platform overview |
| `github.com/facebookincubator/meta-wearables-webapp` snake example | VERIFIED | Reference Web App structure |
| `meta-wearables-dat-ios-main.zip` (local) | UNABLE TO VERIFY — SOURCE NOT PRESENT | No local archive found |
| `meta-wearables-dat-android-main.zip` (local) | UNABLE TO VERIFY — SOURCE NOT PRESENT | No local archive found |
| `meta-wearables-webapp-main.zip` (local) | UNABLE TO VERIFY — SOURCE NOT PRESENT | No local archive found |
| iOS sample source Swift files | UNABLE TO VERIFY — 404 on GitHub | Paths not publicly accessible |
| WebApp skills source markdown | UNABLE TO VERIFY — 404 on GitHub | Skill files not at expected paths |

---

## 3. Current K Scan Bridge Boundary

### Public interface
- **Single entry point:** `capturePhoto()` in `src/datBridge.js`
- **Called by:** `src/main.js` → `startScan()` → `capturePhoto()` → `sanitizeImageBeforeUpload()` → `analyzeImage()`
- **Return value:** base64 data URL string (`data:image/jpeg;base64,...`)
- **Error type:** `DATBridgeError` with `.code` from `DAT_ERROR_CODES`

### Error codes defined
`BRIDGE_UNAVAILABLE`, `CAPTURE_TIMEOUT` (10 000 ms), `PERMISSION_DENIED`, `CAPTURE_CANCELLED`, `INVALID_CAPTURE_RESPONSE`, `CAPTURE_IN_PROGRESS`

### Adapter detection (production)
1. `postMessage` — detected when `window !== window.parent` (Meta WebView iframe model)
2. `webkit` — detected when `window.webkit?.messageHandlers?.DATBridge` exists (WKWebView iOS)
3. `unavailable` — neither detected; throws `BRIDGE_UNAVAILABLE`

### Request/response message shapes currently assumed
```
// Outbound (Web App → native host)
{ type: 'capture-photo', requestId: string }
{ type: 'REQUEST_CAPTURE', requestId: string }   // legacy compat

// Inbound (native host → Web App)
{ type: 'photo-captured', requestId: string, base64: string }
{ type: 'photo-capture-error', requestId: string, code: string, message: string }
{ type: 'CAPTURE_RESPONSE', data: { base64Image: string } }   // legacy compat
{ type: 'CAPTURE_ERROR', message: string }                    // legacy compat
```

Also supports legacy `window.onDATCaptureComplete(payload)` callback.

### Dev simulator gate
- Active only when `import.meta.env.DEV && VITE_MOCK_DAT === 'true'`
- Zero production code paths use simulator
- Six scenarios: success, permission-denied, cancelled, timeout, invalid-response, malformed-image
- Three image variants: standard (120×120), tiny (24×24), large (2000×1500)

### Invariants
- Sanitizer always runs before `analyzeImage` — no raw capture reaches backend
- Single active capture enforced via `pendingCapture` guard
- Production build with mocks off is fail-closed (`BRIDGE_UNAVAILABLE` on desktop)

**Verdict:** No real iOS/Android bridge object names are hard-coded or claimed as verified anywhere in the current source.
VERIFIED [Source: `src/datBridge.js`]

---

## 4. iOS DAT Findings

### SDK identity
- **Repository:** `github.com/facebook/meta-wearables-dat-ios` (public, developer preview)
- **Distribution:** Swift Package Manager
- **Modules:** `MWDATCore`, `MWDATCamera`, `MWDATDisplay`, `MWDATMockDevice`
- **Language:** Swift, async/await, `@MainActor`

VERIFIED [Source: `meta-wearables-dat-ios` `.cursor/rules/dat-conventions.mdc`]

### Photo capture API (native Swift)
```swift
// Trigger capture
stream.capturePhoto(format: .jpeg)

// Receive result
stream.photoDataPublisher.listen { photoData in
    let imageData = photoData.data   // Data (bytes)
}
```
- `PhotoData.data` is raw bytes (Swift `Data`), not a base64 string.
- Capture requires an active `Stream` on a started `DeviceSession`.
- Session lifecycle: `Wearables.shared` → `createSession(deviceSelector:)` → `deviceSession.start()` → `addStream(config:)` → `stream.start()`

VERIFIED [Source: `meta-wearables-dat-ios` `.cursor/rules/camera-streaming.mdc`]

### Native-to-Web bridge
- **NO WKWebView bridge, postMessage handler, or JavaScript injection is documented in any accessible source.**
- The SDK is designed for native iOS companion apps, not for delivering photos to an embedded Web App.
- Whether the companion iOS app can host a WKWebView and forward `photoData.data` as base64 to the Web App via `window.webkit.messageHandlers` or `evaluateJavaScript` is architecturally plausible but **not documented**.

UNKNOWN — REQUIRES DEVICE VALIDATION

### MockDeviceKit
- Available for testing without physical hardware.
- Supports simulating registration, availability, streaming, and permission scenarios.

VERIFIED [Source: `meta-wearables-dat-ios` `.cursor/rules/dat-conventions.mdc`]

---

## 5. Android DAT Findings

### SDK identity
- **Repository:** `github.com/facebook/meta-wearables-dat-android` (public, developer preview)
- **Distribution:** Maven (GitHub Package Registry), requires `read:packages` PAT
- **Modules:** `mwdat-core`, `mwdat-camera`, `mwdat-display`, `mwdat-mockdevice`
- **Version:** 0.7.0
- **Language:** Kotlin, Coroutines, `StateFlow`/`Flow`

VERIFIED [Source: `meta-wearables-dat-android` README, `.cursor/rules/dat-conventions.mdc`]

### Photo capture API (native Kotlin)
```kotlin
stream.capturePhoto()
    .onSuccess { photoData ->
        val imageBytes = photoData.data   // ByteArray
        savePhoto(imageBytes)
    }
    .onFailure { error, _ ->
        showCaptureError(error.description)
    }
```
- `PhotoData.data` is `ByteArray`, not a base64 string.
- Capture requires an active `Stream` on a running `Session`.
- Session lifecycle: `Wearables.createSession(AutoDeviceSelector())` → `session.start()` → `session.addStream(StreamConfiguration(...))` → `stream.start()`
- Error handling via `DatResult<T, E>` typed result — not exceptions.

VERIFIED [Source: `meta-wearables-dat-android` `.cursor/rules/camera-streaming.mdc`]

### Native-to-Web bridge
- **NO `WebView.addJavascriptInterface`, `evaluateJavascript`, or postMessage handler is documented in any accessible source.**
- The SDK is designed for native Android companion apps.
- Whether the companion Android app can host a WebView and forward `photoData.data` (base64-encoded) to a Web App is architecturally plausible but **not documented**.

UNKNOWN — REQUIRES DEVICE VALIDATION

### MockDeviceKit
- Available for testing without hardware.
- Enables simulated registration, streaming, and permission test scenarios.

VERIFIED [Source: `meta-wearables-dat-android` README]

---

## 6. WebApp Starter Kit Findings

### Platform summary
- Standard HTML/CSS/JavaScript rendered in the MRBD glasses browser.
- Viewport: fixed 600×600 px. Use `overflow: hidden` on `<body>`.
- Input: Neural Band + temple captouch → `ArrowUp/Down/Left/Right` + `Enter` key events. No mouse, no touch, no physical keyboard.
- All interactive elements require `.focusable` class.
- Back navigation: `ArrowLeft` or `Escape` → `history.back()`.

VERIFIED [Source: `docs/meta/Build.txt` (May 14, 2026)]

### Explicitly unsupported Web APIs on MRBD
Camera, Microphone, Text Input, Offline Support, Notifications, Back Navigation (via browser button), continuous cursor.

VERIFIED [Source: `docs/meta/Build.txt` (May 14, 2026)]

### Supported Web APIs
- `DeviceMotionEvent` / `DeviceOrientationEvent` (IMU — requires user permission gesture)
- `navigator.geolocation` (location via paired phone — requires user permission gesture)
- `localStorage` / `sessionStorage` (5 MB each)
- Standard `fetch`, HTTPS only

VERIFIED [Source: `docs/meta/Build.txt` (May 14, 2026)]

### Native-to-web bridge
- **No JavaScript bridge, postMessage contract, or DAT integration example is documented in the WebApp starter kit.**
- The snake example app uses only standard web APIs (keyboard events, canvas, localStorage).
- The 9 skill categories are: create-webapp, add-ui, connect-api, add-device-sensors, add-local-storage, publish-to-vercel, test-on-device, qr-code, passcode-for-testing. No DAT/camera skill listed.

UNABLE TO VERIFY — skill source files returned 404. Camera/DAT bridge: UNKNOWN.

### Testing guidance
- Test on desktop with 600×600 Chrome viewport + arrow keys before testing on device.
- Add app via Meta AI app → App Settings → App Connections → Web Apps → Add.
- Middle pinch surfaces universal Web App menu (Restart / Resume / Permissions).

VERIFIED [Source: `docs/meta/Test.txt` (May 18, 2026)]

---

## 7. Web App vs Native DAT Capability Matrix

| Capability | Standalone Web App | Native iOS DAT | Native Android DAT | K Scan Current | Mock Simulator | Evidence Status | Source | Device Validation Needed? |
|---|---|---|---|---|---|---|---|---|
| Photo capture | NO — Camera unsupported | YES — `stream.capturePhoto(format: .jpeg)` | YES — `stream.capturePhoto()` | Via bridge adapter (unverified) | YES (6 scenarios) | VERIFIED (native); UNKNOWN (web delivery) | Build.txt; iOS/Android .mdc files | YES |
| Camera video stream | NO | YES — `Stream` + `videoFramePublisher` | YES — `stream.videoStream.collect` | N/A | N/A | VERIFIED (native) | iOS/Android .mdc files | YES |
| Permission prompt | N/A | SDK-managed (native OS) | SDK-managed (native OS) | Mapped to `PERMISSION_DENIED` | YES (scenario) | UNKNOWN (web-side UX) | N/A | YES |
| Web runtime microphone | NO — unsupported | N/A | N/A | Not implemented | N/A | VERIFIED unsupported | Build.txt | N/A |
| Keyboard/D-pad input | YES — arrow + Enter events | N/A | N/A | YES — fully implemented | YES | VERIFIED | Build.txt | YES (device feel) |
| Display rendering | YES — additive 600×600 | N/A | N/A | YES — implemented | YES | VERIFIED | Build.txt | YES (waveguide) |
| Web App launch/add-flow | YES — HTTPS + Meta AI app | N/A | N/A | Ready (Vercel hosted) | N/A | VERIFIED | Test.txt | YES |
| Native-to-web message bridge | NOT DOCUMENTED | NOT DOCUMENTED | NOT DOCUMENTED | Assumed postMessage + webkit | N/A | UNKNOWN | No source found | YES — BLOCKING |
| requestId per capture | N/A | NOT DOCUMENTED | NOT DOCUMENTED | YES — implemented | YES | UNKNOWN (native side) | No source found | YES |
| Single active capture | N/A | NOT DOCUMENTED | NOT DOCUMENTED | YES — `pendingCapture` guard | YES | UNKNOWN (native side) | No source found | YES |
| Cancellation | N/A | NOT DOCUMENTED | NOT DOCUMENTED | `CAPTURE_CANCELLED` code | YES (scenario) | UNKNOWN | No source found | YES |
| Timeout | N/A | NOT DOCUMENTED | NOT DOCUMENTED | 10 000 ms client-side | YES (scenario) | UNKNOWN (native behavior) | No source found | YES |
| Error codes | N/A | `DatResult` typed errors | `DatResult` typed errors | 6 codes mapped | YES (all 6) | PARTIALLY DOCUMENTED | .mdc files | YES |
| Image payload format | N/A | Raw bytes (`Data`) | Raw bytes (`ByteArray`) | Expected base64 string | YES (generated) | UNKNOWN (native→web encoding) | .mdc files | YES — BLOCKING |
| Sanitizer before upload | YES — enforced in app | N/A | N/A | YES — always before analyze | YES | VERIFIED | `src/privacyImageSanitizer.js` | Partial (model runtime) |
| Backend analyze call | YES — POST /api/analyze | N/A | N/A | YES — after sanitizer | YES (mock) | VERIFIED | `src/api.js` | YES (live) |

**Critical observation:** The DAT SDKs deliver `PhotoData.data` as raw bytes to the native companion app. The **native companion app** must base64-encode those bytes and deliver them to the Web App via an undocumented bridge. How that bridge works is the single largest blocking unknown.

---

## 8. Bridge Readiness Plan

> **ARCHITECTURAL INFERENCE — NON-BINDING**
> This section describes a plausible integration design based on documented patterns. It is NOT Meta's contract and MUST NOT be implemented until verified against actual native source or device testing.

### Current boundary (unchanged)

`capturePhoto()` in `src/datBridge.js` is the single public entry point. The app above it (`src/main.js`) is already correct and does not need to change when the native bridge is wired.

### Inferred adapter model

The most likely integration path based on known iOS/Android WebView patterns:

1. **Web App → native:** The Web App sends a capture request via `postMessage` (if hosted in an iframe/WebView within the companion app) or via `window.webkit.messageHandlers` (WKWebView direct).
2. **Native side:** Companion app receives the request, calls `stream.capturePhoto()`, base64-encodes `photoData.data`, and posts the result back.
3. **Web App receives:** A `message` event or `window.onDATCaptureComplete` callback delivers the result.

The current `datBridge.js` already implements both adapter paths and both legacy/canonical message shapes. **This boundary does not need to change** — only the native side needs to be built and verified.

### Non-binding example message contract

```javascript
// NON-BINDING EXAMPLE — DO NOT IMPLEMENT

// Web App → native host (outbound)
{ type: 'capture-photo', requestId: 'capture_1748700000_abc123' }

// Native host → Web App (inbound, success)
{ type: 'photo-captured', requestId: 'capture_1748700000_abc123', base64: 'data:image/jpeg;base64,...' }

// Native host → Web App (inbound, error)
{ type: 'photo-capture-error', requestId: 'capture_1748700000_abc123', code: 'PERMISSION_DENIED', message: 'Camera permission denied.' }
```

### Required invariants regardless of native implementation
- `requestId` must be echoed back to prevent cross-capture contamination.
- Only one active capture at a time (enforced by `pendingCapture` guard — already in place).
- Client-side 10 000 ms timeout must fire if native side does not respond (already in place).
- `photoData.data` (ByteArray/Data) must be base64-encoded by the **native side** before delivery.
- The MIME prefix (`data:image/jpeg;base64,...`) must be present or the sanitizer will reject it fail-closed.
- No raw image bytes should be logged on either side.
- Sanitizer always runs before `analyzeImage` — this invariant is in `src/main.js` and must not be bypassed.

---

## 9. Risks / Unknowns / Required Device Validation

### High-risk blocking unknowns

| Unknown | Evidence Status | Source Searched | Recommended Validation |
|---|---|---|---|
| Exact native-to-web bridge object/method on iOS | UNKNOWN | iOS repo, docs/meta — not found | iOS native sample spike; device test |
| Exact native-to-web bridge object/method on Android | UNKNOWN | Android repo, docs/meta — not found | Android native sample spike; device test |
| Whether Web App container can receive DAT results directly (no companion app hosting a WebView) | UNKNOWN | All sources | Device test + Meta developer support |
| Whether companion app must host WebView or only pair/register | UNKNOWN | All sources | Architecture clarity needed before implementation |
| Permission UX ownership (glasses OS vs phone vs Web App) | UNKNOWN | All sources — native SDK manages permissions | Device test |
| Photo payload format from native → web (raw bytes vs base64, MIME prefix present?) | PARTIALLY DOCUMENTED (native bytes known; web encoding unknown) | DAT .mdc files | Native spike |
| Capture latency over Bluetooth | UNKNOWN | All sources | Device test |
| Real MRBD viewport `devicePixelRatio` at runtime | UNKNOWN | Build.txt silent on dPR | Device test |
| Whether app can run standalone on glasses while capture comes via phone Bluetooth | UNKNOWN | All sources | Architecture validation |
| Whether phone companion must be foregrounded for capture | UNKNOWN | All sources | Device test |
| Whether the Web App is hosted inside a WebView in the companion app, or loaded separately on the glasses | UNKNOWN — BLOCKING ARCHITECTURE QUESTION | All sources | Meta developer documentation; device test |

### Medium-risk unknowns

| Unknown | Evidence Status | Recommended Validation |
|---|---|---|
| Minimum glasses firmware for DAT photo capture (v125+ for Web Apps, may differ for DAT) | UNKNOWN | Device + Meta docs |
| Whether MockDeviceKit simulates the full base64 payload format accurately | UNKNOWN | iOS/Android native spike |
| CORS behavior when Web App on glasses POSTs to Render backend | UNKNOWN | Test from deployed HTTPS origin |
| Sanitizer performance on real capture resolution (up to 720×1280) | UNKNOWN | Device test |

---

## 10. Recommended Next Phases

### Phase 13 validation note
- Phase 13 hardens K Scan's inbound capture payload validation as an app-level defensive contract.
- This is not a verified Meta native bridge contract and does not validate any real iOS or Android bridge object names.

### Phase 13 — Bridge Adapter Dry Run *(no native code)*
- Review `datBridge.js` message shapes against any newly surfaced Meta documentation.
- Add stricter input validation for the inbound base64 payload (MIME prefix check).
- Add unit-level static tests for edge cases in `normalizeCapturePayload`.
- No source changes until bridge contract is verified.

### Phase 14 — iOS DAT Companion Spike *(native code, separate repo)*
- Create a minimal native iOS companion app using `MWDATCamera`.
- Pair and register physical MRBD glasses.
- Call `stream.capturePhoto(format: .jpeg)`, receive `photoData.data`.
- Document exact payload: JPEG bytes, typical size, encoding.
- Determine whether app can host a WKWebView and forward photo via `messageHandlers` or `evaluateJavaScript`.
- Document exact bridge object/event name if any exists.
- Deliverable: verified native capture payload schema.

### Phase 15 — Android DAT Companion Spike *(native code, separate repo)*
- Same as Phase 14 but for Android using `mwdat-camera` v0.7.0.
- Verify `stream.capturePhoto()` payload: `photoData.data` (ByteArray), encoding, MIME.
- Determine WebView bridge mechanism for Android (`addJavascriptInterface`, `evaluateJavascript`, or postMessage).
- Deliverable: verified Android payload schema.

### Phase 16 — Native-to-Web Handoff Prototype *(only after bridge contract verified)*
- Wire verified native capture to the existing `datBridge.js` postMessage boundary.
- Compare real payload against simulator contract.
- Run sanitizer on real JPEG capture.
- Confirm CORS from deployed HTTPS origin.
- Deliverable: end-to-end capture → sanitize → analyze on device.

### Phase 17 — MRBD Physical QA
- App add-flow (Meta AI app → App Connections).
- 600×600 viewport and waveguide rendering.
- D-pad / Neural Band navigation.
- Real photo capture → sanitizer → backend.
- Concurrent capture guard, timeout, error paths on device.
- Deliverable: full simulator QA matrix replicated on hardware.

---

## 11. Claims Not Verified

The following are explicitly NOT verified and must not be treated as implementation facts:

- Bridge object name `DATBridge` (used in `datBridge.js` as a speculative name for `webkit.messageHandlers.DATBridge`).
- Message type strings `capture-photo`, `photo-captured`, `photo-capture-error` as the canonical Meta bridge protocol.
- Message type strings `REQUEST_CAPTURE`, `CAPTURE_RESPONSE`, `CAPTURE_ERROR` as the canonical legacy protocol.
- That `window.onDATCaptureComplete` is a real callback the native side calls.
- That the Web App runs inside a WebView hosted by the companion app (vs. running as a standalone glasses browser).
- That `photoData.data` from the native SDK arrives at the Web App as a base64 JPEG data URL.
- Any specific photo size, format, or latency from real capture.

All of the above will be resolved in Phase 14–16 after native spikes and device testing.
