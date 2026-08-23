# META BACKEND WIRING REPORT

**Date:** 2026-07-19  
**Webapp:** `C:\Users\jsmit\kscan-glasses-webapp`  
**Authoritative TextScan function source:** `C:\Users\jsmit\KScan\supabase\functions\scan-identify\`  
**Supabase project ref (non-secret):** `wyyuqfdxucjksghsmhry`  
**Secrets:** not recorded in this document.

---

## A. Environment and project identity

| Item | Finding |
| --- | --- |
| Analyze backend hostname (CSP / example) | `kscan-app-1.onrender.com` |
| Supabase host pattern | `https://*.supabase.co` / `wss://*.supabase.co` |
| Anon/public key source | `VITE_SUPABASE_ANON_KEY` or runtime `__KSCAN_CONFIG__.SUPABASE_ANON_KEY` |
| Candidate vs public demo | Candidate builds may carry config; frozen public demo deploys only from `phase-11-virtual-alpha-infra` and ships without Supabase config in bundle |
| CI live calls | Forbidden by design (`meta-hud-ci.yml`) |
| Missing production config | Fail-closed (`LIVE_DISABLED`, `CONFIG_REQUIRED`, `AUTH_REQUIRED`) |

### Local `.env` (names only)

Set: `VITE_KSCAN_BACKEND_URL`, mock DAT/analyze flags.  
Unset: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ENABLE_PRIVATE_LIVE_ANALYZE`, smoke tokens.

---

## B. TextScan / `scan-identify`

| Topic | Evidence |
| --- | --- |
| Function exists in source | Yes — mobile repo `supabase/functions/scan-identify` |
| Deployed | ACTIVE on project `wyyuqfdxucjksghsmhry`, version **119** |
| Gateway `verify_jwt` | **false** (function still authenticates text mode via `auth.getUser()`) |
| Client invoke | `invokeSupabaseFunction('scan-identify', { body })` |
| Request (text) | `{ mode: 'text', textQuery, source, clientTimestamp }` |
| Auth (text) | JWT required server-side → 401 if missing; client defaults `requireAuth` true |
| Quotas | Auth text daily default **50** (env override); `rate_limited` status on HTTP 200 |
| CORS | `Access-Control-Allow-Origin: *` on function |
| Live QA smoke | **BLOCKED** — missing `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `KSCAN_TEST_SUPABASE_ACCESS_TOKEN` |

**Note:** Older Phase-3 finding MG-01 (“function source absent from mobile repo”) is **superseded** — source is present and deployed. Server-side live behavior still lacks a credentialed QA smoke from this audit machine.

---

## C. Image `/api/analyze`

| Topic | Evidence |
| --- | --- |
| Client URL | `POST {VITE_KSCAN_BACKEND_URL}/api/analyze` |
| Auth | **None** on client (documented containment) |
| Live gate | Fail-closed unless `VITE_ENABLE_PRIVATE_LIVE_ANALYZE=true` or runtime `ENABLE_PRIVATE_LIVE_ANALYZE === true` |
| Body | `{ image: <sanitized JPEG data URL> }` |
| Client response handling | `products[]` normalized (≤5), optional `style_metadata` |
| Public demo risk | Demo must not enable private live flag; candidate vercel branch disabled |
| Live exercise this audit | **Not run** (opt-in unset; intentional) |

Mobile Expo route `KScan/app/api/analyze+api.js` exists; mapping to the Render hostname is **UNKNOWN** from this pass.

---

## D. Session and sign-out

| Topic | Evidence |
| --- | --- |
| Same actor for TextScan + HUD | Supabase session / bearer override shared via `supabaseClient.js` |
| Sign-out | `signOut()` + `signOutSupabaseSession()` + cancel/reset bridge + clear results (`18a5f4d`) |
| Persistence | Never outside DEV; DEV only if `VITE_SUPABASE_PERSIST_SESSION=true` |
| URL tokens | Production builds DCE-disabled; ignored in browser S10b |
| Rejected-origin injection | Session listener uses canonical `messageTrust` |

---

## E. Backend wiring matrix

| Integration | Endpoint/project | Auth | Request contract | Response contract | Quotas | CORS | Verification status | Blocker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TextScan / scan-identify | Supabase fn `scan-identify` @ `wyyuqfdxucjksghsmhry` (v119 ACTIVE) | JWT for text (`getUser`); gateway `verify_jwt=false` | `{ mode:'text', textQuery, source, clientTimestamp }` | `status`, `attributes`, `identification`, products/shopping fields; client→StyleMatch | Text ~50/day auth | `*` on function | SOURCE VERIFIED · BACKEND CONTRACT VERIFIED · LIVE QA **BLOCKED** | Smoke credentials |
| Image scan / api/analyze | `POST {backend}/api/analyze` (CSP host `kscan-app-1.onrender.com`) | None | `{ image: JPEG data URL }` | Client: `{ products[], style_metadata? }` | UNKNOWN (server) | Server CORS UNKNOWN; CSP allows host | SOURCE VERIFIED · AUTOMATED TEST VERIFIED · LIVE QA **BLOCKED** | Private QA opt-in + auth gap |
| Supabase session | SDK + postMessage bridge | Session / bearer | `kscan:supabase-session` / `kscan:supabase-token` | linked session state | N/A | N/A | SOURCE VERIFIED · AUTOMATED TEST VERIFIED | Meta parent origin pin (HW) |
| Capture bridge | parent `postMessage` scaffold / DAT | Origin+source trust | `capture.request` + `requestId` | `capture.success/error` + matching `requestId` | N/A | N/A | SOURCE VERIFIED · AUTOMATED TEST VERIFIED · INTERACTIVE BROWSER VERIFIED | Physical Meta parent origin |

---

## Environment matrix (variables)

| Variable | Local dev | Simulator QA | Browser candidate | Hardware candidate | Public investor demo | CI |
| --- | --- | --- | --- | --- | --- | --- |
| `VITE_KSCAN_BACKEND_URL` | Optional (mock) | Optional | Required for private live | Required for private live | Forbidden / unset | Unset |
| `VITE_ENABLE_PRIVATE_LIVE_ANALYZE` | Optional | Optional | Forbidden unless private QA | Optional private QA | **Forbidden** | Unset |
| `VITE_SUPABASE_URL` | Optional | Optional | Required for live TextScan | Required for live TextScan | Unset | Unset |
| `VITE_SUPABASE_ANON_KEY` | Optional (public config) | Optional | Required for live TextScan | Required for live TextScan | Unset | Unset |
| `VITE_MOCK_*` | Dev-only OK | OK | Forbidden in prod claims | Prefer false for HW truth | Forbidden | Unset |
| `VITE_ENABLE_SIMULATOR` | Staging only | N/A (simulator build flag) | Forbidden | Forbidden | Forbidden | Unset |
| `VITE_ENABLE_MOBILE_BRIDGE` / WS URL | Dev-only | Dev-only | **Forbidden** | Dev-only until secured | **Forbidden** | Unset |
| `VITE_BRIDGE_ALLOWED_ORIGINS` | Optional | Optional | Optional | **Required once runtime origin known** | Unset | Unset |
| `VITE_SESSION_ALLOWED_ORIGINS` | Optional | Optional | Optional | **Required once runtime origin known** | Unset | Unset |
| `VITE_BRIDGE_TARGET_ORIGIN` | Optional | Optional | Optional | Preferred pin | Unset | Unset |
| `VITE_SUPABASE_PERSIST_SESSION` | Dev-only | Ignored outside DEV | Forbidden effect | Forbidden effect | Forbidden | Unset |
| `KSCAN_TEST_SUPABASE_*` | Smoke secret | Smoke secret | N/A | N/A | Forbidden | Forbidden |
| Service-role keys | **Forbidden** | **Forbidden** | **Forbidden** | **Forbidden** | **Forbidden** | **Forbidden** |

---

## Backend blockers (integration)

1. **Credential blocker:** Live TextScan smoke cannot run without QA Supabase URL/anon + test access token.  
2. **Backend product decision:** `/api/analyze` remains unauthenticated; live path must stay behind private opt-in until server auth lands.  
3. **Gateway note:** `scan-identify` deployed with `verify_jwt: false`; text mode still enforces JWT inside the function — confirm this remains intentional.  
4. **No backend deploy** performed in this audit (per assignment).
