# Security Header Policy — Meta Hardware-Validation Candidate

Date: 2026-07-18 · Branch: `feature/meta-hardware-validation-candidate`

## Scope

`vercel.json` now carries the preview/production header policy for any future
**private** preview of this candidate. The frozen public demo deploys from
`phase-11-virtual-alpha-infra` with its own branch state and is **unchanged**;
these headers take effect only when a build from this branch family is
deployed (which still requires explicit authorization).

Deployment is additionally guarded: `git.deploymentEnabled` explicitly
disables `feature/meta-hardware-validation-candidate` so an accidental push
cannot publish a preview URL.

## Headers

| Header | Value (summary) | Rationale |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://kscan-app-1.onrender.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` | Only resources the app actually uses: self-hosted JS/CSS/assets, local MediaPipe WASM (`wasm-unsafe-eval` required for WASM compilation), canvas/data-URL images, the configured Supabase project, and the configured analyze backend. No wildcard sources. |
| `frame-ancestors 'self'` (in CSP) + `X-Frame-Options: SAMEORIGIN` | Same-origin framing only | The LOCAL QA simulator iframes the app **same-origin**, which stays allowed. Cross-origin embedding (the P3-SEC-01 attack surface) is blocked. |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing hardening. |
| `Referrer-Policy` | `no-referrer` | No URL leakage to third parties. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()` | The webapp uses no device APIs (capture arrives via bridge postMessage). |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Preserved/strengthened. |

## UNRESOLVED: Meta runtime parent origin

The real Meta Ray-Ban Display runtime parent origin is **unknown** until
first physical-device load. Policy until hardware evidence exists:

- Framing defaults to the narrowest viable model: `frame-ancestors 'self'`.
- If device testing proves the runtime embeds the HUD from a specific
  cross-origin parent, that exact origin must be pinned explicitly in
  `frame-ancestors` (e.g. `frame-ancestors 'self' https://runtime.example`).
- Do NOT add wildcard framing, broad `https:` framing, or guessed Meta
  domains. Absence of the correct parent origin is a hardware-discovery
  item, not a reason to weaken the default.

The same evidence will pin `VITE_BRIDGE_ALLOWED_ORIGINS` /
`VITE_SESSION_ALLOWED_ORIGINS` (inbound message trust) and
`VITE_BRIDGE_TARGET_ORIGIN` (outbound postMessage target).

## Simulator note

`simulator.html` (LOCAL QA / NON-PRODUCTION) is never part of the production
artifact, so no simulator-specific header relaxation exists here. Local QA
runs through `npm run dev`, which does not apply this file.
