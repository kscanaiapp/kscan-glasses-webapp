# Audit Metadata

Audit:
01_META_OVERVIEW

Phase:
Phase 3 — Meta Glasses Webapp

Workspace:
C:\Users\jsmit\kscan-glasses-webapp

Production / public URL:
https://kscan-glasses-demo.vercel.app (+ /simulator.html)

Branch:
feature/meta-textscan-local-qa-p27

HEAD:
e8572b8 (2026-06-24 "Phase 27: Meta TextScan local QA and pre-deployment readiness")

Audit Date:
2026-07-09

Auditor:
Claude Audit Orchestrator

Evidence Quality:
High

Prior Phase Inputs Used:
Yes (Phase 1 + Phase 2 handoff packets)

---

# Prior Phase Inputs Used

## From Phase 1

Input consumed: Supabase-JWT-only session model; StyleChat/Closet/Rooms contracts; TextScan absent on mobile; anon-key+RLS demo-safe boundary; mobile sanitizer = passthrough.
How it was used: verified the webapp's session bridge targets Supabase JWTs (it does); checked TextScan's backend target against Phase 1's Edge Function inventory; compared sanitizers.
Finding created from it: MG-01 (scan-identify function not in mobile repo — contract unverifiable), MG-05 (webapp sanitizer AHEAD of mobile — real face masking).
Open dependency: server-side auth/limits of `scan-identify` cannot be verified from any audited repo.

## From Phase 2

Input consumed: website's "browser-enabled prototypes" boundary; demo-freeze expectation; WS-01 (TextScan claimed live on website).
How it was used: checked demo copy stays inside prototype framing; verified freeze mechanics; characterized the real TextScan for the WS-01 follow-up.
Finding created from it: freeze CONFIRMED by config (vercel.json deploys only from phase-11 branch); TextScan here is a text-query → scan-identify Edge Function flow — a prototype, not a mobile beta feature, confirming WS-01's overclaim.
Open dependency: website copy fix (WS-01/02) still pending.

---

## What the Meta webapp is

A Vite + vanilla-JS HUD-style webapp simulating the K Scan experience for Meta glasses as a constrained 600×600 web surface, with a separate simulator control room (simulator.html). Only two runtime deps: @mediapipe/tasks-vision (face masking) and @supabase/supabase-js. Extensive phase-numbered development discipline (currently Phase 27) with a strong local QA harness.

## What it demonstrates

Scan capture (mock DAT bridge / phone-bridge paths) → privacy face-masking → analyze → StyleMatch result cards; TextScan (typed/preset query → backend interpretation → results); guest/local library store; investor-facing public demo.

## Current architecture

- HUD: index.html locked to 600×600 viewport (meta viewport width=600,height=600; .frame 600px CSS), pill-based status HUD (Bridge/Analyze/TextScan states surfaced as MOCK/LIVE/READY — testers can't be misled silently).
- Input/navigation: keyboard/D-pad oriented (navigation.js focus management).
- Capture: datBridge.js — origin-allowlisted postMessage adapter (trust check rejects null origins, allowlist + self-origin), mock capture gated by VITE_MOCK_DAT=true AND non-production; webkit message handler path for native shells; mobileBridgeClient (WebSocket phone bridge) gated by VITE_ENABLE_MOBILE_BRIDGE with "PRODUCTION SAFETY" comment discipline.
- Privacy sanitizer: **real implementation** — MediaPipe BlazeFace (local WASM + model under public/mediapipe, public/models), solid-masks every detected face with margin, conservative failure mode (any decode/model failure blocks upload rather than passing unmasked), no face metadata persisted/logged. This EXCEEDS the mobile app's passthrough sanitizer (Phase 1 KC-06).
- Analyze: api.js with env-gated mock scenarios (mock only in DEV via VITE_MOCK_ANALYZE).
- TextScan: services/textScan.js — query length caps, prompt-injection phrase guard (injections list), mock mode gate, live path via `invokeSupabaseFunction('scan-identify')` with retry/timeout/status mapping and `requireAuth` default TRUE (guest live calls refused).
- Session bridge: services/supabaseClient.js — accepts session from (1) runtime __KSCAN_CONFIG__, (2) URL params/hash (then scrubs them), (3) window postMessage ('kscan:supabase-session' / 'kscan:supabase-token'), plus normal supabase-js localStorage persistence (persistSession:true, detectSessionInUrl:false).
- Simulator: simulator.html control room driving scenarios incl. sanitizer face-region test hooks (dev/test-only detector injection).

## StyleMatch contract

styleMatchContract.js canonicalizes results for HUD cards; TextScan responses adapted via buildTextScanStyleMatch. Consistent with Phase 1's analyze metadata philosophy (canonical enums) but implemented independently — no shared package (drift risk shared with mobile, see Phase 1 opportunity "shared analyze-contract package").

## Mock/live separation

Explicit and disciplined: HUD pills display MOCK vs LIVE per subsystem; mock analyze DEV-only; mock DAT non-production-only; TextScan mock via isTextScanMockEnabled; beta stub mode in authSession.js stores only a signed-in flag ("no tokens exist or are stored" in stub mode). Static tests actively scan the built bundle for dev-string leakage (7 cosmetic WARNs, 0 FAILs).

## Public investor demo status

vercel.json: `deploymentEnabled { main:false, master:false, phase-11-virtual-alpha-infra:true }` — the public demo deploys ONLY from the phase-11 branch, i.e., **the demo is frozen by configuration** and predates Phases 12–27 (TextScan, session bridge work). Live URLs verified 200 (Phase 2). Built dist/ contains no Supabase URL or JWT-like strings (verified by scan) — the public demo has no backend config baked in, so live paths are inert there.

# Ecosystem Integration Checklist

- Can it authenticate with the same Supabase project as mobile? Yes by design — config via env/runtime, session via JWT injection; same-project usage confirmed nowhere in code (no hardcoded URL — correct).
- Does it share StyleDNA profile data? No. No style-memory integration.
- Can scan results be saved to mobile Closet? No — libraryStore.js is localStorage-only (guest library). No looks/inspiration_items writes.
- Can Dressing Room invites work across mobile and Meta? No — no rooms integration.
- Can StyleChat responses render safely in HUD form? Not implemented — no stylechat-generate calls (roadmap item).
- Is session bridge secure? Partially — inbound capture-bridge messages are origin-checked, but the SESSION message listener does NOT check event.origin (MG-02), and URL-token ingestion is not dev-gated (MG-03).
- Are tokens exposed in URL params, localStorage, console, or public demo state? URL params: accepted then scrubbed (MG-03); localStorage: yes via persistSession (standard supabase-js; note for shared devices); console: no token logging found; public demo: no config → no tokens possible ✓.
- Does public demo copy match website positioning? Yes — HUD labels mock states explicitly; README's own QA gate requires "UI clearly indicates mock/stub/placeholder state"; consistent with llms.txt "browser-enabled prototypes".
