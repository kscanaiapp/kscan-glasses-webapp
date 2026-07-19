# Meta Connected Runtime Phase A — Backend Integration Readiness

**Branch:** `feature/meta-connected-runtime-phase-a`  
**Scope:** Meta HUD companion protocol readiness for a real mobile companion.  
**Live QA:** Not performed (credentials pending).  
**Physical Meta hardware:** Unavailable / pending.

---

## A. Authority boundary

| Responsibility | Owner |
| --- | --- |
| Authentication, camera capture, privacy sanitization, backend access, account state, Closet / Dressing Room persistence | **Phone** |
| Scan trigger, status display, structured StyleMatch display, Save/Open/Retry/Cancel/Dismiss | **Meta HUD** |

Connected-runtime companion messages carry **structured results only** (hard payload ceiling 128 KB; result payload ≤ 100 KB). Raw camera images are rejected by the result contract. The HUD does **not** call `/api/analyze` on the companion path.

**Verdict:** READY

---

## B. Real phone replacement readiness

Adapter seam:

```text
createCompanionRuntime({ transport, ... })
  ← createParentWindowTransport(...) | createWebSocketTransport(...) [dev-only]
  ← protocol.validateMessage + resultContract.validateResultPayload
  ← runtimeState machine (transport-agnostic)
  ← main.js HUD rendering
```

Replacing the mock companion requires a transport that speaks `kscan.meta.companion.v1` with the same session/device/request correlation. No HUD or state-machine rewrite is required for a compliant phone peer.

**Verdict:** READY WITH EXTERNAL IMPLEMENTATION REQUIRED (mobile transport + pairing service)

---

## C. Pairing backend readiness (Phase B mobile/backend)

Meta client contract already requires:

- Explicit user approval (`pair.approved` with nonce match)
- Short-lived wearable session id + `sessionExpiresAt`
- Explicit capability set (no escalation)
- Device-bound correlation
- Revocation (`session.revoked` / `pair.revoked`)
- Re-pair supersedes prior nonce/session on the HUD

HUD must **not** receive Supabase refresh tokens or long-lived mobile credentials (current design: in-memory wearable session metadata only).

Future mobile/backend must implement: challenge creation, approval UX, session issuance, device identity, TTL, revocation, capability issuance, sign-out invalidation, re-pair.

**Verdict:** READY WITH EXTERNAL IMPLEMENTATION REQUIRED  
**Note:** `pair.challenge` is currently a nonce-ack stub — cryptographic mutual proof is Phase B.

---

## D. TextScan readiness

| Item | Status |
| --- | --- |
| Supabase project | `wyyuqfdxucjksghsmhry` (non-secret ref) |
| Function | `scan-identify` **ACTIVE v119** (re-verified via Supabase MCP `list_edge_functions`) |
| Gateway `verify_jwt` | **false** (JWT still enforced inside function for text mode via `auth.getUser()`) |
| Meta connected path | Phone runs TextScan / image analyze; HUD receives StyleMatch via companion protocol |
| Live QA | **Pending credentials** |

**Verdict:** READY WITH EXTERNAL IMPLEMENTATION REQUIRED (phone handoff of TextScan→StyleMatch)

---

## E. Image-analysis readiness

| Check | Status |
| --- | --- |
| Companion messages carry raw images | **Forbidden / rejected** |
| Meta companion flow calls `/api/analyze` | **No** |
| Standalone HUD analyze | Fail-closed without private QA enablement |
| Error normalization | Safe codes/messages only on HUD |

**Verdict:** READY (phone layer absorbs future auth changes)

---

## F. Request/response compatibility

Companion `resultContract` + fixtures align with structured StyleMatch fields used by the webapp (`resultId`, summary, confidence, primary/alternatives, title/brand/price/currency, retail/resale grouping, thumbnail URL policy, allowed actions, generation/expiry). Contract fixtures and adapter tests pass (25/25).

**Verdict:** READY

---

## G. Environment variable classes

| Variable class | Examples (names only) | Classification |
| --- | --- | --- |
| Public config | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Optional locally; required for live TextScan; **public** anon key only |
| Development-only | `VITE_MOCK_*`, `VITE_ENABLE_SIMULATOR`, companion simulator build | **Forbidden in production artifact** (asserted) |
| Private QA | `VITE_ENABLE_PRIVATE_LIVE_ANALYZE`, test access tokens | Required for live QA only; **secret** tokens never in repo |
| Bridge origins | `VITE_BRIDGE_TARGET_ORIGIN`, `VITE_BRIDGE_ALLOWED_ORIGINS` | Public configuration; no wildcards in production trust path |
| Companion WS | Explicit URL only; no localhost default | Dev-only; production transport factory fails closed |

No real secret values are documented here.

---

## H. Backend-readiness matrix

| Capability | Rating |
| --- | --- |
| Pairing service | READY WITH EXTERNAL IMPLEMENTATION REQUIRED |
| Wearable session issuance | READY WITH EXTERNAL IMPLEMENTATION REQUIRED |
| Real phone transport | READY WITH EXTERNAL IMPLEMENTATION REQUIRED |
| TextScan result handoff | READY WITH EXTERNAL IMPLEMENTATION REQUIRED |
| Image-analysis result handoff | READY WITH EXTERNAL IMPLEMENTATION REQUIRED |
| Save action | READY WITH EXTERNAL IMPLEMENTATION REQUIRED (phone ack + persistence) |
| Open-on-phone action | READY WITH EXTERNAL IMPLEMENTATION REQUIRED |
| Retry/cancel | READY (Meta-side complete; phone must honor) |
| Session revocation | READY (Meta-side complete; phone/backend must emit) |
| Account switching | READY WITH EXTERNAL IMPLEMENTATION REQUIRED (sign-out → revoke) |

---

## Remaining external gates

1. Phase B mobile companion implementing the protocol over a production-safe transport.  
2. Pairing service with short-lived wearable credentials (no refresh tokens on HUD).  
3. Live TextScan / analyze QA credentials.  
4. Physical Meta hardware validation.  
5. Confirm `scan-identify` gateway `verify_jwt: false` remains intentional vs stylechat pattern.
