# Meta Physical Device Candidate — Takeover State

**Audit date:** 2026-08-22
**Auditor:** Claude (Sonnet 5), this session
**Scope:** `kscan-glasses-webapp` (Meta HUD + backend) plus the two related mobile worktrees discovered during the audit.

---

## Current branch / HEAD / remote state

- **Repo:** `kscan-glasses-webapp`, worktree `C:/Users/jsmit/kscan-glasses-webapp`
- **Branch:** `feature/meta-physical-device-candidate-v1`
- **HEAD:** `c45bcbec0ce14df340a2e2407be24a1c5f39397d` — identical to the historical verified baseline (`feature/meta-connected-runtime-phase-a`, also at `c45bcbe`, 15 commits ahead of `origin/feature/meta-connected-runtime-phase-a`, unpushed).
- **No commits since baseline.** All physical-device-candidate work is **uncommitted** in the working tree.
- A `rescue/takeover-preserve-c45bcbe` branch and a `codex/disable-render-caller-meta-20260721` branch already exist locally, evidence this exact takeover/hostile-audit pipeline has run at least once before on this repo.
- `stash@{0}` holds an unrelated "temp stash before branch switch" from the phase-a branch — left untouched.

## Historical verified baseline (reproduced, not reused)

Every historical Phase A number reproduced exactly on this session's own run of the current tree:

| Suite | Historical | This session |
|---|---|---|
| Companion protocol | 67/67 | **67/67** |
| Pairing/session | 18/18 | **18/18** |
| State machine | 30/30 | **30/30** |
| Result contract | 25/25 | **25/25** |
| Reconnect | 13/13 | **13/13** |
| Browser smoke | 37/37 | **37/37** (first run hit a 1ms perf-threshold flake, p95 251ms vs 250ms target; clean re-run confirmed it's timing noise, not a regression) |
| Companion scenarios (browser) | 29/29 | **29/29** |
| Companion loops (browser) | 11/11 | **11/11** |
| Security | 40/40 | **40/40** |
| Contract | 128/128 | **128/128** |
| Privacy/containment | 16/16 | **16/16** |
| Bridge lifecycle | 19/19 | **19/19** |
| Static | 0 fail | **0 fail** |
| Lint | 0 errors | **0 errors** (30 pre-existing style warnings) |
| Artifact separation | 16/16 (Phase A) | **25/25** (expanded — hardware build target is new) |

New suite added by the uncommitted work: **`test:wearable` 14/14 PASS.**
All three build targets (`build`, `build:simulator`, `build:hardware`) succeed.

**Baseline verdict: GREEN.** Nothing needed restoring — the tree was already healthy.

## Uncommitted work found (this branch)

Tracked-file diffs (small, all verified benign):
- `main.js`: hardware-candidate diagnostics panel + `PRIVATE HARDWARE CANDIDATE` banner (dead-code-eliminated from prod/simulator bundles, asserted by `verify-artifacts.js`).
- `protocol.js`: `SESSION_READY` schema extended with `sessionToken`/`sessionExpiresAt` fields (to relay the wearable session token to a real phone) — added but **not yet consumed anywhere**.
- `styleMatchContract.js`: new `buildBackendStyleMatch()` adapter for real (non-demo) results — added but **not yet consumed anywhere**.
- `.gitignore`, `eslint.config.js`: new `dist-production/`/`dist-hardware/` build dirs.
- `scripts/security-tests.js`, `verify-artifacts.js`, `static-tests.js`, `browser-smoke.js`: expanded assertions for the hardware-candidate artifact and companion checks (all passing).

Untracked (new):
- `src/companion/{phoneCompanion,wearableBackend,companionSave,companionOpenOnPhone,resultFormatter}.js` — full real backend integration layer, unit-tested (`test:wearable`, 14/14), **but not imported anywhere else in the app** (confirmed by repo-wide grep). `phoneCompanion.js` is explicitly documented in its own header as "the mobile counterpart to the HUD companionRuntime" — i.e. a reference/local-QA phone-side implementation of the real protocol, not a HUD-side integration. The actual live `companionRuntime`/`main.js` still runs on the Phase-A `mockCompanion.js`.
- `scripts/wearable-integration-tests.js`, `vite.hardware.config.js` — wired into `package.json`, both exercised and green.
- `supabase/` (functions + 1 migration + README) — see Backend section below.

## Backend changes found — LIVE, not just local

Verified directly against Supabase project `yzqjvdfgefveprobvvyw` ("K Scan AI Staging") via MCP, independent of any repo file:

- Tables **already deployed**: `wearable_pairings` (1 row), `wearable_sessions`, `wearable_messages`, `wearable_results`, `wearable_actions`, `wearable_auth_attempts` — all RLS-enabled, no client policies (service-role-only by design; confirmed by `get_advisors` — the only findings are the expected `rls_enabled_no_policy` INFO items, same pattern as the pre-existing `product_catalog` table).
- Edge functions **ACTIVE**: `wearable-bridge` (v2), `wearable-scan` (v2), `wearable-save` (v2), `wearable-open-on-phone` (v1).
- 4 migrations applied on staging 2026-08-19: pairing/sessions, saved_scans wearable source, source widening for `meta_wearable`, and a security-hardening pass.
- `get_advisors` (security): no wearable-specific findings beyond the expected INFO-level RLS-no-policy items. All WARN-level findings are pre-existing, unrelated to this work (SECURITY DEFINER function warnings across the rest of the app, plus the known billing-gated Leaked Password Protection item).

**Drift found and repaired:** the local `supabase/functions/wearable-bridge/index.ts` was a stale snapshot labeled "version 1" while the live function is version 2. The v1→v2 diff on staging fixed two real gaps: (1) `phone.send` writing `wearable_results` via a bare upsert with no ownership/revision check (any session could have overwritten another user's result by reusing its UUID) — v2 adds an ownership + monotonic-revision guard; (2) `phone.action` had no conflict detection for an `actionId` reused with a different `resultId`/`actionType` — v2 adds `ACTION_CONFLICT` rejection; (3) no pairing-attempt rate limiting — v2 throttles `pair.approve`/`pair.deny` via `wearable_auth_attempts`. **Repaired this session**: local file rewritten verbatim from the live v2 source (`deno check` passes against the function's own `deno.json`). `wearable-save`, `wearable-scan`, `wearable-open-on-phone` local files were already byte-identical to what's deployed — no drift there.

## Mobile changes found — two independent, disconnected branches

### 1. `feature/meta-physical-device-candidate-v1-mobile` @ `07193c3` (worktree `C:/src/KScan-meta-physical-device-v1`)

All work here is **uncommitted** — no branch/stash elsewhere holds it; if this worktree is lost, the work is gone.

**Critical finding — parallel, incompatible backend.** This branch invented its own edge function (`wearable-companion`) and its own tables (`wearable_events`, `wearable_action_receipts`) instead of calling the already-deployed `wearable-bridge`/`wearable-scan`. Concretely incompatible with the live contract: 8-char alphanumeric challenge codes vs. live's 6-digit numeric; string `protocol_version` vs. live's integer; JWT-based scan auth vs. live's session-token-based; a third, different session TTL (60 min in its migration vs. this task's own stated 30 min vs. live's actual 15 min). Its migration uses `CREATE TABLE IF NOT EXISTS` against table names that **already exist live with different columns** — applied to the same project, it would silently no-op rather than create its expected schema, and its edge functions would then fail at runtime. **None of this mobile client code can function against the real, deployed backend today.**

Per-capability classification: pairing-approval UI is real (not a stub) but broken end-to-end (wrong backend target); the JWT-authority pattern itself is correctly implemented but authenticates against a function that's never called by the live system; capture-request handling is real but uses an incompatible wire format; the fail-closed privacy sanitizer (`services/metaWearablePrivacy.ts`) is genuinely complete and untested-but-sound (local ML-Kit + Skia masking, never falls back to raw); "Open on Phone" opens the exact result (real design) but again targets the non-deployed function.

**Standalone bug, independent of the architecture question:** `contexts/AuthSessionContext.tsx:261-272` calls `revokeMetaWearableSessions('phone-sign-out')` with **no try/catch**. Since the target function doesn't exist, this throws — which means `supabase.auth.signOut()` never executes on the next line. Gated behind `META_WEARABLE_CANDIDATE_ENABLED` (default OFF) so dormant today, **but** the new `meta-physical-candidate` EAS build profile in this branch's `eas.json` diff sets that flag to `true` by default — so building that profile would break sign-out for every user, not just wearable users.

Type-checks clean (`tsc --noEmit`: 0 errors). No destabilization risk to the in-flight `ios/full-submission-readiness-v2` release branch — file-level diff shows no functional overlap (only a likely-auto-mergeable `package.json` script-block collision).

### 2. `feature/privacy-lens-glasses-ingestion-v1` @ `962245f` (worktree `C:/src/KScan-glasses-ingestion-v1`)

Clean working tree (fully committed on its own branch). Independently re-verified: 143/143 unit tests pass, all static/source audits pass, `tsc --noEmit` shows only the pre-existing baseline error unrelated to this work. Fail-closed invariant independently checked across every code path — no violation found.

The Android XR native capture bridge is real, working native code (Kotlin, CameraX + `androidx.xr.projected`), registered and wired into `MainApplication.kt`. The Meta iOS/Android side has **no native module at all** — `NativeModules.KScanMetaWearables` is referenced but never defined anywhere in the repo; the branch's own docs candidly label this `NOT VERIFIED`. More importantly: **nothing in the running app calls the glasses capture path at all** — no button, screen, or route triggers it; the only glasses-related code that executes today is idle-directory cleanup on app mount. This is pre-built infrastructure sitting ahead of a missing trigger UI and a missing Meta native SDK integration, not a broken feature.

**Zero overlap with branch #1** — no shared files, no imports of each other, confirmed by grep both directions. Connecting device-pairing/UI (branch #1, once its backend is fixed) to capture-sanitization (branch #2) requires an explicit integration that doesn't exist yet.

(Side note: all 30 commits on this branch are authored by `Parity Gate Fixture <gate@example.invalid>` — the known git-identity-contamination artifact from [[project_git_identity_contamination]]. Doesn't affect code correctness; the audit re-verified everything independently rather than trusting the branch's self-authored evidence docs.)

## Completed / Partial / Broken — summary classification

| Piece | Classification |
|---|---|
| Meta HUD companion protocol/pairing/state-machine/reconnect (Phase A) | **COMPLETE + VERIFIED** (reproduced this session) |
| Wearable backend (tables, RLS, edge functions) | **COMPLETE + VERIFIED** (live, active, advisors clean; one drift bug found+fixed) |
| Meta-side reference phone simulator + backend client (`phoneCompanion.js`, `wearableBackend.js`, `companionSave.js`, `companionOpenOnPhone.js`, `resultFormatter.js`) | **COMPLETE + UNVERIFIED end-to-end** — unit-tested in isolation (14/14), never wired into the live HUD runtime |
| HUD runtime wiring to the real backend (swap `mockCompanion.js` for the real transport) | **NOT IMPLEMENTED** — Phase A's own audit doc anticipated this as a clean adapter-seam swap requiring no HUD/state-machine rewrite; that swap was never made |
| Mobile pairing/session UI (`feature/meta-physical-device-candidate-v1-mobile`) | **PARTIAL / BROKEN** — real UI, wrong backend contract, one dormant-but-armed sign-out bug |
| Mobile privacy-lens glasses ingestion | **PARTIAL** — sanitizer + Android XR bridge complete and verified; unreachable from any UI; no Meta native module exists |
| Private hardware-candidate build artifact separation | **COMPLETE + VERIFIED** (25/25, includes the new hardware target) |

## Current blockers

**P1 — Architecture fork, needs a product decision, not a unilateral fix.** Two independently-built, internally-complete wearable backends exist for the same feature, targeting the same live Supabase project, and are mutually incompatible. Recommendation: retire `wearable-companion`/`wearable_events`/`wearable_action_receipts` (currently uncommitted, unshippable) and re-point the mobile pairing/capture UI at the already-live, already-correct `wearable-bridge`/`wearable-scan`/`wearable-save`/`wearable-open-on-phone` contract — reusing this repo's `phoneCompanion.js`/`wearableBackend.js` as the reference implementation to port from. This is a recommendation, not an action taken: it discards real work on the mobile branch and I did not want to do that without sign-off.

**P1 — Dormant sign-out bug** in `feature/meta-physical-device-candidate-v1-mobile`'s `AuthSessionContext.tsx` (no try/catch around a revoke call to a function that doesn't exist). Not yet armed in production (flag default OFF) but the branch's own new build profile flips it on by default. Should be fixed regardless of which backend direction is chosen, before that build profile is ever used.

**P2 — HUD not wired to the real backend.** The Meta HUD still drives its companion UI from `mockCompanion.js` even though a tested, live-backend-integrated replacement exists. Low technical risk (the adapter seam was purpose-built for this swap) but real product-facing work, not a "restore baseline" repair.

**P3 (cosmetic)** — `phoneCompanion.js` defines `makeNonce()` but never calls it (dead code, `eslint no-unused-vars`); worth resolving whichever way (wire it in for replay protection, or remove it) once the file is actually wired up.

## Recommended continuation point

1. Get a decision from the user on the mobile backend fork before writing any more mobile code (this session did not touch either mobile worktree).
2. Independent of #1, wire the Meta HUD's live `companionRuntime` to the real `wearableBackend.js`/`phoneCompanion.js` transport in place of `mockCompanion.js` — this is well-scoped, backend-verified, and carries no mobile-branch dependency risk.
3. Once #1 is resolved, port the mobile pairing-approval UI and privacy-lens capture pipeline onto the corrected backend contract, fix the sign-out bug, and connect capture-sanitization (branch #2) to a real trigger UI.
4. Physical Meta hardware remains the only gate this session cannot exercise, consistent with the original brief.

No commits were made to git in this session; all changes described as "repaired" are working-tree edits to `kscan-glasses-webapp` only (the `wearable-bridge/index.ts` drift fix). No pushes were performed. No mobile files were modified.
