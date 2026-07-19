# Audit Metadata

Audit:
02_META_GAP_REPORT

Phase:
Phase 3 — Meta Glasses Webapp

Workspace:
C:\Users\jsmit\kscan-glasses-webapp

Production / public URL:
https://kscan-glasses-demo.vercel.app

Branch:
feature/meta-textscan-local-qa-p27

HEAD:
e8572b8

Audit Date:
2026-07-09

Auditor:
Claude Audit Orchestrator

Evidence Quality:
High

Prior Phase Inputs Used:
Yes

---

# Prior Phase Inputs Used

## From Phase 1

Input consumed: Edge Function inventory (9 functions — no scan-identify); session model; sanitizer passthrough baseline.
How it was used: contract existence check; session-bridge threat modeling; sanitizer comparison.
Finding created from it: MG-01, MG-05.
Open dependency: scan-identify server-side posture.

## From Phase 2

Input consumed: demo-freeze expectation; prototype messaging boundary; WS-01.
How it was used: freeze verification; copy boundary check.
Finding created from it: MG-06 (freeze confirmed — with a staleness caveat).
Open dependency: website TextScan copy fix.

---

## Findings

ID: MG-01
Severity: P1
Area: API contract / cross-repo drift
Finding: TextScan's live path invokes Supabase Edge Function `scan-identify` (src/services/textScan.js:26,319) — a function that does NOT exist in the mobile repo's supabase/functions (Phase 1 inventoried 9 functions; scan-identify absent). Its server-side auth enforcement, rate limits, and cost controls are therefore unverifiable from any audited repo. The mobile eas.json's unread flag EXPO_PUBLIC_SCAN_IDENTIFY_BACKEND_ENABLED suggests the function exists (or existed) in the deployed Supabase project but is untracked in source control.
Evidence: textScan.js EDGE_FUNCTION='scan-identify'; Phase 1 handoff function list.
Phase 1 dependency: Edge Function inventory.
Phase 2 dependency: WS-01 (website already claims TextScan live).
Why it matters: A live AI endpoint whose source isn't in any repo is an unauditable cost/security surface; client-side requireAuth is good but trivially bypassable — enforcement must be server-side and provable.
Recommended fix: Locate scan-identify source and commit it to the mobile repo's supabase/functions (or a shared backend repo); verify it mirrors stylechat-generate's JWT + quota pattern.
Estimated effort: recovery/verification 0.5 day.
Release blocker: Yes for any LIVE TextScan exposure; No for the frozen mock demo.
Should public demo remain frozen: Yes.
Passed to Google XR comparison: Yes (XR backend calls must target source-controlled functions only).

ID: MG-02
Severity: P1 (conditional; P2 on the config-less public demo)
Area: Session bridge / origin trust
Finding: `listenForSupabaseSessionMessages()` (supabaseClient.js:187–213) accepts `kscan:supabase-session` / `kscan:supabase-token` postMessage payloads from ANY origin — no event.origin check — unlike the capture bridge (datBridge.js origin allowlist + null-origin rejection; bridgeState.js isAllowedBridgeOrigin). Any embedding/opener page could inject a session (session fixation) or, if the webapp is iframed by a hostile page while configured, manipulate the auth context.
Evidence: source lines cited; contrast with datBridge.js:84–98.
Phase 1 dependency: Supabase JWT session model.
Why it matters: The one listener handling the most sensitive payload is the one without origin checks. Mitigated today because the public demo ships no Supabase config (verified: dist contains no supabase URL/key), but this becomes P1 the moment a configured build is deployed.
Recommended fix: Reuse the datBridge origin-allowlist for session messages; reject null origins; consider requiring the same handshake as the capture bridge.
Estimated effort: hours.
Release blocker: Yes before any configured (live) deployment.
Should public demo remain frozen: Yes.
Passed to Google XR comparison: Yes (XR phone-bridge must origin/identity-check session handoff).

ID: MG-03
Severity: P2
Area: Token leakage
Finding: URL-token session injection (`readTokenFromUrl`) accepts access/refresh tokens via query or hash params (access_token, supabaseAccessToken, AUTH_TOKEN…) on ANY build — not dev-gated — then scrubs them from the address bar. Scrubbing reduces but does not remove exposure: tokens still transit browser history pre-scrub, server/CDN logs (query variant), and any referrer emitted before cleanup.
Evidence: supabaseClient.js:114–140, 182.
Phase 1 dependency: JWT model.
Why it matters: Token-in-URL is a classic leak vector; acceptable as a dev convenience only.
Recommended fix: Gate URL ingestion behind import.meta.env.DEV (or an explicit VITE flag that production builds refuse), prefer hash-only if kept, document in BRIDGE_CONTRACT.md.
Estimated effort: hours.
Release blocker: Yes before live deployment; No for frozen demo.
Should public demo remain frozen: Yes.
Passed to Google XR comparison: Yes (never pass tokens via intent/URI extras without equivalent scrutiny).

ID: MG-04
Severity: P2
Area: Origin trust (outbound)
Finding: bridgeState.js sends parent postMessage with wildcard target origin (`window.parent.postMessage(message, '*')`, lines 192–195), while datBridge.js uses a computed targetOrigin. Wildcard outbound target means capture-request metadata could be delivered to an untrusted embedder.
Evidence: bridgeState.js:192–195 vs datBridge.js:374–379.
Why it matters: Low sensitivity payloads today (capture-photo requests), but inconsistent trust discipline invites regressions.
Recommended fix: Use the allowlisted embedder origin for all outbound parent messages.
Estimated effort: hour.
Release blocker: No.
Passed to Google XR comparison: Yes (pattern note).

ID: MG-05
Severity: P2 (positive-delta finding, cross-cutting)
Area: Privacy pipeline consistency
Finding: The webapp's face-masking sanitizer is REAL (MediaPipe BlazeFace, local assets, conservative fail-closed behavior, no face metadata persisted) while the mobile app's sanitizer is passthrough (Phase 1 KC-06). The ecosystem thus has inconsistent privacy behavior for the same conceptual pipeline — and public messaging must track the weakest surface (mobile), which the website correctly does ("does not currently apply automatic face blurring"; llms.txt "App Native Face Blurring: In development").
Evidence: src/privacyImageSanitizer.js:1–120 vs mobile services/privacyImageSanitizer.js.
Phase 1 dependency: KC-06.
Phase 2 dependency: privacy copy boundary.
Why it matters: Divergent privacy guarantees across surfaces confuse claims and QA; the webapp implementation is a proven blueprint to port to mobile/XR.
Recommended fix: Treat the webapp sanitizer as the reference implementation; port pattern (fail-closed, local models, no metadata retention) to mobile and XR.
Estimated effort: mobile port is a mobile-repo project (medium).
Release blocker: No.
Passed to Google XR comparison: Yes — primary reuse candidate.

ID: MG-06
Severity: P2
Area: Public demo staleness / deployment gate
Finding: The public demo is frozen by config (vercel.json deploys only from `phase-11-virtual-alpha-infra`; main/master disabled). Freeze is correct per standing instruction, but the demo now lags 16 development phases behind (11 vs 27); it predates the sanitizer hardening and TextScan. Also the current branch has 16 uncommitted changes in the mounted tree.
Evidence: vercel.json; git log/status.
Phase 2 dependency: demo-freeze expectation (satisfied).
Why it matters: Freeze ✓; but investor-facing demo divergence from current capability should be a conscious, dated decision — and any future unfreeze must go through MG-01/02/03 first.
Recommended fix: Document demo version/date on the simulator page; define an unfreeze checklist referencing this report.
Estimated effort: hours.
Release blocker: No.
Should public demo remain frozen: Yes — until MG-01/02/03 resolved.
Passed to Google XR comparison: Yes (release-gate pattern worth copying).

ID: MG-07
Severity: P3
Area: Bundle hygiene
Finding: Static leak-scan WARNs (by the repo's own excellent scripts/static-tests.js): env var names (VITE_MOCK_DAT, VITE_MOCK_ANALYZE), dev scenario enums (permission-denied, malformed-image, invalid-response), console.log calls present in minified bundle. 0 FAILs.
Evidence: `node scripts/static-tests.js` output (7 WARN / 0 FAIL).
Why it matters: Cosmetic; leaks hint at dev surface but expose no secrets.
Recommended fix: Strip console.* in build; accept enum strings or tree-shake scenario tables from prod.
Estimated effort: hours.
Release blocker: No.

ID: MG-08
Severity: P3
Area: Ecosystem integration gap (documented, not a defect)
Finding: No Closet save, no Dressing Room handoff, no StyleChat rendering, no StyleDNA — the webapp is a self-contained capture/textscan prototype with a local guest library only.
Evidence: libraryStore.js localStorage-only; no stylechat/rooms references.
Why it matters: Roadmap clarity — these are Phase 5–6 roadmap items (03_META_ROADMAP), not regressions.
Release blocker: No.
Passed to Google XR comparison: Yes (same integration order applies).

## Meta-specific criteria checklist

- fixed 600×600 container: PASS (index.html viewport + .frame CSS).
- D-pad navigation: PASS (navigation.js focus model; QA guide covers key nav). Focus-ring consistency: not visually verified in this audit (no browser render) — noted for manual QA.
- simulator fidelity: PASS (simulator.html + scenario/dev hooks incl. sanitizer face-region injection).
- public demo stability: PASS (200s; frozen branch).
- public demo safety: PASS today (no backend config in dist; no tokens possible) with conditions MG-02/03 before unfreeze.
- session-token bridge handling: PARTIAL (MG-02/03).
- mock-only safety: PASS (env + production gates; HUD pills honest).
- no direct camera/mic claims unless proven: PASS (mock capture labeled; no mic surface).
- no production-readiness claims unless proven: PASS (README explicitly mock-until-validated).

# False Positives / Already Handled

- Prompt-injection guard on TextScan queries (textScan.js injections list) — proactive hardening, credit where due.
- requireAuth default TRUE on live TextScan — guests can't trigger live backend calls client-side (server-side proof still needed, MG-01).
- URL token scrubbing exists (partial mitigation of MG-03 — the gap is the ingestion gate, not negligence).
- dist bundle contains no Supabase URL/anon key/JWT-like strings — verified by direct scan.
- Mock capture is double-gated (VITE_MOCK_DAT=true AND not production).
- The repo's own static/contract test harness (125 contract PASS, 0 static FAIL) is unusually strong for a prototype and caught the same leak surface this audit checked.
