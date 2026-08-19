# K SCAN AI META GLASSES — SIMULATOR V2 BUILD REPORT

## Executive Summary

Simulator V2 (`simulator-v2.html`) is a premium, product-first browser presentation of the K Scan AI Meta glasses experience, built alongside — not over — the existing engineering simulator (`simulator.html`) and protocol test console (`companion.html`). It puts the phone-companion relationship at the center: a paired-phone visualization, an animated handoff cue between the glasses and phone, and a guided journey (Pair → Ready → Scan → Privacy → Identify → Discover → Save) that a first-time viewer can follow without opening any engineering control.

The 600×600 HUD is the real production companion-mode build (`index.html?companion=1`), unmodified. No HUD rendering, state-machine, protocol, or result-contract logic was duplicated or forked — Simulator V2 acts as the phone peer over the same canonical message contract the real phone will eventually use.

## Starting Source

- Public demo: `https://kscan-glasses-demo.vercel.app/simulator.html` (not touched by this work; remains the rollback reference).
- Repo: `C:\Users\jsmit\kscan-glasses-webapp` (`origin` = `github.com/kscanaiapp/kscan-glasses-webapp`).
- Stated baseline `feature/meta-connected-runtime-phase-a` @ `c45bcbec0ce14df340a2e2407be24a1c5f39397d` was verified current and used as the branch point.
- **Important divergence found during inspection:** the checked-out branch (`feature/meta-physical-device-candidate-v1`) sat at the same SHA but carried substantial **uncommitted** work — a real phone-side companion runtime (`phoneCompanion.js`, `companionSave.js`, `companionOpenOnPhone.js`, `wearableBackend.js`) talking to a live Supabase backend for physical-hardware pairing. That work is unrelated to this browser simulator and was left completely untouched; Simulator V2 was built in an isolated git worktree off the clean baseline SHA so the dirty tree was never at risk.

## New Branch / Final SHA

- Worktree: `C:\Users\jsmit\kscan-glasses-simulator-v2-20260819` (git worktree, not a subdirectory of the primary checkout).
- Branch: `feature/meta-simulator-v2`, branched from `c45bcbec0ce14df340a2e2407be24a1c5f39397d`.
- Final HEAD: `bab86be` — see Commits below for the full, current list (includes the review fix below; this doc predates that commit).
- Not pushed. Not merged. Not deployed anywhere.

## Existing Simulator Assessment

`simulator.html` is an engineering QA control room: a 600×600 iframe plus scenario dropdowns, manual `capture-photo`/`capture.*` bridge injection buttons, TextScan mode controls, and a raw message log — accurate and useful, but organized around the image/text-scan bridge, not the paired-phone architecture the Meta build is actually converging on. It also has no phone-companion visualization at all: `?companion=1` mode exists in the HUD but nothing in `simulator.html` speaks the companion protocol, so companion mode isn't reachable there.

`companion.html` (existing, separate) *does* act as a mock phone, but keeps the same engineering-first layout: raw buttons for every protocol message, a dense control panel, no guided journey, no visual hierarchy.

Both remain fully intact and useful; Simulator V2 does not replace either.

## Design Direction

Deep near-black stage, restrained champagne/gold accent (reused from the HUD's existing warm palette so the two surfaces read as one product), soft radial glow, generous negative space. The 600×600 HUD stays the unambiguous hero, framed in an abstract lens-style panel (no invented Meta hardware geometry). The phone is a small, animated companion — not a second full app — with a handoff chip that visibly travels between the two surfaces on every pairing/scan/result/save event, making the "glasses talk to phone talk to K Scan AI" architecture legible at a glance.

## Simulator V2 Architecture

```
simulator-v2.html                      (new Vite entry, LOCAL QA build only)
  └─ #hud-frame → index.html?companion=1   (REAL production HUD, unmodified)
src/simulatorV2/
  ├─ mockPhoneEngine.js   phone-peer engine: reuses src/companion/{protocol,resultFixtures}.js
  │                       and src/messageTrust.js exactly as src/companion/mockCompanion.js does —
  │                       refactored to be DOM-decoupled so it's reusable outside companion.html
  ├─ demoFixtures.js      category-flavored (fictional-brand) demo result fixtures,
  │                       shaped to pass src/companion/resultContract.js unchanged
  └─ simulatorV2.js       shell controller: phone-panel rendering, handoff animation,
                          guided journey, Auto Demo loop, Demo/QA mode toggle,
                          developer drawer wiring, performance panel
```

Nothing in `src/companion/*`, `src/main.js`, `style.css`, or `index.html` was modified. This was a deliberate scope decision: those files are shared with the actively-developed physical-hardware track, and the HUD's own results/pairing rendering is already reasonably built out. The "largest visual improvement" the brief asked for on the result experience is delivered in the *outer* premium chrome (a product-highlight mirror card), not by rewriting the shared production renderer.

## HUD Changes

None. The 600×600 panel is byte-identical production code (companion mode), preserving its QA value as a regression surface and avoiding any risk to the actively-developed physical-device branch that shares these files.

## Phone Companion

A small phone-shell panel (rounded frame, notch, live-region screen) renders one of: waiting, incoming pairing request (Approve/Not Now), connected/ready, capturing, privacy check, matching, result ready, working, saved/opened, or connection lost. State transitions are driven by the same protocol messages a real phone would send/receive — nothing here is faked independently of the wire traffic. A "handoff chip" animates down (glasses → phone) or up (phone → glasses) on pairing requests, scan requests, result delivery, and save/open acknowledgements.

## Pairing Experience

Home → Scan reveals the HUD's own "Pair Phone" screen; tapping it sends `pair.request`. The phone panel shows "Meta glasses want to connect" with Approve/Not Now. Approve issues `pair.approved` then `session.ready` (matching the existing mock-phone timing), and the HUD advances Connected → Ready. No protocol messages or tokens are exposed in the demo layer — only in QA-mode's message log, and only as metadata (type, direction, short request-id), never payloads.

## Scan / Processing Experience

Scan sends `capture.request`; the phone engine drives `capture.started` → `scan.processing` (privacy) → `scan.processing` (analyzing) → `result.show`, each stage reflected on both the HUD's real pipeline stepper and the phone panel ("Capturing…", "Privacy Check — faces protected locally before analysis", "Matching — looking for similar pieces").

## Privacy Presentation

Brief and reassuring, matching the phone-panel copy above; the HUD's own privacy-processing screen is unchanged. The QA strip and "About this simulation" modal keep the simulated/no-hardware framing visible without dominating the page.

## Result Experience

The HUD renders its own existing results screen unmodified. Alongside it, a product-highlight card (outer chrome) mirrors the same result data with a category icon, brand/name/price, confidence badge, retail/resale source line, and a 1/N carousel over alternatives — Prev/Next also click the corresponding row inside the real HUD so both surfaces stay in sync. Demo scenarios: Sunglasses, Handbag, Sneakers, Jacket, Watch, No Match, Connection Loss — all fictional brands/prices, clearly labeled `demoMode: true`.

## Save Experience

The card's Save button proxies a real click on the HUD's own Save control — no parallel action path exists. Saving is acknowledged through the real `action.accepted` → `action.completed` round trip; the phone panel shows "Saved — Added to your K Scan AI Closet."

## Open-on-Phone Experience

Same proxy pattern via the real `action.open_on_phone` flow; the phone panel shows "Opened — Continue on your phone."

## Connection / Recovery States

QA-mode Drop/Restore controls exercise the real `connection.lost`/`connection.restored` messages and the HUD's Reconnecting state. The "Connection Loss" demo scenario automates this: mid-scan, the phone silently drops, the HUD shows Reconnecting, and the engine restores after ~3.2s (comfortably inside the HUD's real 10s reconnect window) — Ready resumes automatically.

**Resolved in a follow-up commit (`bab86be`):** a manual Drop→wait-past-10s→Restore previously left the phone-panel mirror optimistically claiming "Connected/Ready" after the HUD had already (correctly) fallen back to Disconnected — there is no protocol ack for a late restore, so the mirror was guessing. `drop()` now records when the connection went down, and `restore()` mirrors the HUD's own `RUNTIME_TIMEOUTS.RECONNECT` window (with a small safety margin) instead of assuming success — verified live for both the within-window and past-window cases.

## Demo Mode

Default mode. Clean shell, guided "Start Experience" (reset → pair-screen → hands control to the phone panel's Approve button), scenario picker, flow breadcrumb (Pair/Ready/Scan/Privacy/Identify/Discover/Save) with a live status line, developer drawer hidden.

## QA Mode

Toggling to QA reveals the full developer drawer without touching which engine is driving the HUD — same `mockPhoneEngine` instance, same protocol traffic either way.

## Developer Controls

Collapsible drawer: Pairing & Session (approve/deny/expire/revoke/drop/restore/refresh-required), Scan Drive (manual stage-by-stage sends, fixture picker using the existing `src/companion/resultFixtures.js` fixtures — including the hostile ones: oversized, malformed, unsafe-URL, HTML-injection, auth-data, image-data), Action Acknowledgements, Negative Tests (malformed, stale requestId, duplicate terminal, oversized, wrong device, wrong session), a simulated/local Performance panel, and the Message Log (metadata only, matching the existing privacy policy).

## Auto-Demo

Unattended loop: reset → pair → (wait for a real tap in guided mode, or auto-approve in Auto Demo) → Ready → Scan → Result → Save or Open (alternating) → Done → Dismiss → repeat, or the Connection-Loss variant when that scenario is selected. Manually interruptible via the same button (toggles to "Stop Auto Demo"). Verified over multiple consecutive loops including a full connection-loss recovery cycle with zero console errors.

## Accessibility

Standard focusable buttons throughout the outer chrome (no custom ARIA roving-tabindex reinvented); `prefers-reduced-motion` disables the handoff-chip flight animation and shortens all CSS transitions; the About modal traps focus on open/close and closes on Escape or backdrop click; the HUD iframe retains its existing D-pad/keyboard navigation untouched.

## Responsive Validation

Verified via DOM-level metrics (no horizontal `scrollWidth` overflow) at 1280, 1920, and 2560px, and at 390–705px narrow widths — with a fix applied (see Remaining Issues) for a decorative glow that bled past the viewport edge at narrow widths. The 600×600 HUD scales down proportionally below 720px rather than clipping.

## Visual QA

Pixel screenshots were **not available in this session** — the sandboxed browser pane did not composite for `screenshot()` calls. Visual QA was instead performed via live DOM/computed-style inspection (element geometry, overflow detection, focus/visibility state at each journey step) plus manual, scripted interaction through the actual running page for every screen in the guided journey, the phone panel's every state, the product-highlight card, and both narrow and wide viewports. This is a real gap relative to the requested pixel-level visual QA and should be closed with a human (or screenshot-capable session) pass before sign-off.

## Functional QA

Manually driven end-to-end through the live dev server: Start Experience → Pair → Approve → Ready → Scan → Result → Save → Done → Dismiss → Ready (full loop, verified via HUD screen/state introspection at each step); QA-mode drawer toggle and message log; Drop/Restore connection recovery; a negative malformed-message injection. All behaved correctly, with two real bugs found and fixed during this pass (below).

## Automated Tests

- `npm run test:static` — 0 FAIL / 7 WARN (pre-existing, unrelated to this work).
- `npm run test:contract` — 128 PASS / 0 FAIL.
- `npm run test:companion` (protocol + pairing + statemachine + result + reconnect) — all suites PASS, 0 FAIL.
- `npm run lint` — 0 errors (25 pre-existing warnings, none in new files).
- `node scripts/verify-artifacts.js` — **19 PASS / 0 FAIL**, including 3 new assertions confirming `simulator-v2.html` and its controller chunk are absent from `dist/` and present with LOCAL QA labeling in `dist-simulator/`.
- `npm run browser:simulator-v2` (new, Playwright-core against the built `dist-simulator/`) — **13 PASS / 0 FAIL**: boot/console cleanliness, Closet-not-Library terminology, full guided journey through Save→Done→Dismiss, No-Match scenario, QA drawer + message log, a negative-message injection, reduced-motion presence, and no-overflow at 1920px and mobile widths.

Bugs found and fixed during this pass:
1. Demo fixtures carried a presentation-only `__icon` field that the HUD's strict result-contract field allowlist would have silently rejected (every demo result would have failed to render on the HUD while the outer chrome misleadingly still showed it). Fixed by stripping the field before it goes over the wire.
2. After Save/Open completes, the HUD navigates off the results screen entirely onto its own "Done" screen — the outer mirror and Auto-Demo loop were targeting the now-hidden results action bar. Fixed by tracking the real state transition and targeting the correct control.
3. Auto Demo's shared `resetJourney()` helper cleared its own `autoDemoRunning` flag on every loop iteration, killing the loop after one pass. Fixed by scoping that reset to the manual "Start Experience" entry point only.
4. A decorative glow (`.lens-glow`) bled past the viewport edge at narrow widths, forcing real horizontal scroll on mobile. Fixed with a page-level `overflow-x: hidden` safety net.

## Files Changed

- `simulator-v2.html` (new)
- `src/simulatorV2/mockPhoneEngine.js` (new)
- `src/simulatorV2/demoFixtures.js` (new)
- `src/simulatorV2/simulatorV2.js` (new)
- `scripts/simulator-v2-tests.js` (new)
- `vite.simulator.config.js` (added `simulatorV2` entry)
- `scripts/verify-artifacts.js` (added simulator-v2 separation assertions)
- `eslint.config.js` (added simulator-v2-tests.js to the browser-globals override)
- `package.json` (added `browser:simulator-v2` script)
- `docs/simulator-v2-review-handoff.md` (this document)

## Commits

On `feature/meta-simulator-v2`, branched from `c45bcbec0ce14df340a2e2407be24a1c5f39397d`:

1. `feat(simulator): add Simulator V2 immersive glasses+phone experience`
2. `chore(simulator): wire Simulator V2 into build, lint, and artifact checks`
3. `test(simulator): add Simulator V2 browser suite`
4. `docs(simulator): add simulator v2 review handoff`
5. `fix(simulator): match the phone mirror to the HUD's real reconnect window`
6. `docs(simulator): update handoff for the reconnect-window fix` (this commit)

## Preview / Deployment Status

Not deployed. `npm run build:simulator` was run locally and verified (`dist-simulator/simulator-v2.html`); no Vercel preview or other deployment was created. The public demo at `kscan-glasses-demo.vercel.app/simulator.html` is untouched. Creating a preview deployment would need explicit approval and Vercel project access this session did not have reason to assume.

## Remaining Issues

- **Pixel-level visual QA still not performed** (see Visual QA) — a second attempt in a fresh dev-server session also found the sandbox's browser pane not compositing frames for screenshots. This remains the one open item before external/investor presentation; needs a session (or a human) where the pane actually renders.
- ~~The reconnect-mirror mismatch under a slow manual Drop→Restore (>10s)~~ — **fixed** (`bab86be`); see Connection / Recovery States.
- Simulator V2 intentionally does not include the image/text-scan bridge scenario console from `simulator.html` (oversized/invalid/permission/timeout capture-photo scenarios, TextScan preset injection) — those remain exclusively in the legacy `simulator.html`, linked from the "About this simulation" modal. This was a deliberate scope decision (the brief's five priority changes are all companion/wearable-journey focused) rather than an oversight, but is worth confirming with product before sign-off.
- No preview deployment exists yet; someone with Vercel access should cut one from this branch for stakeholder review once approved.

## Final Verdict

**PASS — META GLASSES SIMULATOR V2 READY FOR PRODUCT REVIEW**, with the visual-QA gap above flagged for a follow-up human pass before it is shown externally.
