# Audit Metadata

Audit:
03_META_ROADMAP

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

Input consumed: StyleChat/Closet contracts, JWT session model, /api/analyze anti-pattern, KC-01 rate-limiting gap.
How it was used: sequencing — live phases gated on server-side enforcement proof.
Finding created from it: "Do not build until" entries below.
Open dependency: scan-identify source recovery (MG-01).

## From Phase 2

Input consumed: prototype messaging boundary; investor demo posture.
How it was used: Phase R1 goal definition; copy constraints.
Finding created from it: demo version-stamp recommendation.
Open dependency: WS-01/02 copy fixes.

---

## Staged path

Phase R1: Stable investor demo
Goal: Keep the frozen public demo credible — version/date stamp, unfreeze checklist.
Required work: MG-06 doc work; simulator page stamp.
Depends on Phase 1: No. Depends on Phase 2: copy fixes (WS-01/02) so site and demo agree.
Risks: staleness vs current capability. Dependencies: none. Estimated effort: hours.
Do not build until: — (safe now).

Phase R2: Authenticated TextScan
Goal: Live TextScan for signed-in testers.
Required work: recover + source-control scan-identify (MG-01); prove server-side JWT + quota (mirror stylechat-generate); fix session-listener origin check (MG-02); dev-gate URL tokens (MG-03).
Depends on Phase 1: stylechat-generate as reference pattern; KC-01 lesson.
Risks: unaudited backend function. Effort: 1–2 days after function source recovered.
Do not build until: MG-01/02/03 closed.

Phase R3: Phone-to-HUD session bridge
Goal: Sign in on phone, glasses webapp inherits session securely.
Required work: origin-allowlisted session postMessage (MG-02 fix is the foundation); handshake + expiry; document in BRIDGE_CONTRACT.md.
Depends on Phase 1: Supabase JWT-only model (confirmed — no second token system exists to bridge).
Risks: token exfiltration via embedder; fixed by allowlist + handshake. Effort: 2–3 days.
Do not build until: R2 security items done.

Phase R4: Scan handoff from phone
Goal: Phone captures → HUD shows results.
Required work: mobileBridgeClient (exists, WS gated) hardened; capture payloads through the REAL sanitizer (already present here).
Depends on Phase 1: analyze contract; KC-01 fix (authenticated analyze) strongly preferred first.
Risks: image payloads over bridge; keep sanitizer-first ordering (scanPipeline already enforces order via injected steps). Effort: 3–5 days.
Do not build until: KC-01 fixed (else the bridge feeds an open endpoint).

Phase R5: StyleChat response cards
Goal: HUD-safe StyleChat rendering.
Required work: invoke stylechat-generate with bridged session; 600×600 card layout; respect daily/burst 429 semantics (retryAfter surfacing).
Depends on Phase 1: StyleChat contract (complete in handoff).
Risks: none new. Effort: 2–3 days.
Do not build until: R3.

Phase R6: Save to Closet / Dressing Room
Goal: Persist HUD results to the user's real library/rooms.
Required work: styleObjects/looks writes + room item add via existing RLS'd tables; replace localStorage guest library when linked.
Depends on Phase 1: Closet + Rooms contracts; KC-08 (blocks) irrelevant for write path.
Risks: contract drift — adopt shared-contract package (Phase 1 opportunity) first. Effort: 3–5 days.
Do not build until: shared contract or pinned API version exists.

Phase R7: Hardware validation
Goal: Real Meta glasses runtime validation (viewport, input, capture bridge, performance).
Required work: device sessions; datBridge webkit path validation; perf profile of MediaPipe on-device.
Depends on: access to hardware. Risks: unknowns; treat all prior phases as web-validated only. Effort: unknown (hardware-gated).
Do not build until: R2–R4 stable in simulator.

Phase R8: Production wearable beta
Goal: Invite-gated wearable beta.
Required work: unfreeze process (MG-06 checklist), monitoring, kill switches (copy featureFreeze pattern from mobile).
Do not build until: R7 hardware validation passes; website wearables page (Phase 2 timing table) ships honestly.

## Readiness scoring (1 concept → 5 production)

Investor demo readiness: 4 — live, frozen, safe (no config), honest labeling; -1 for staleness/version stamp.
Technical alpha readiness: 3 — pipelines + QA harness real; session security items open (MG-02/03), backend function unaudited (MG-01).
Hardware readiness: 1 — no evidence of on-device Meta validation in repo.
Production readiness: 1 — mock-first by design; README states scan pipeline mock-only until phone bridge validated.
Ecosystem integration readiness: 2 — same Supabase by config and JWT model compatible, but no Closet/Rooms/StyleChat integration implemented.
