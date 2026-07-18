# Phase 28A–30 Baseline Reconciliation

Date: 2026-07-18
Branch: `feature/meta-hardware-validation-candidate`
Base commit: `e8572b812d3e2053eafd2137db0952202c5a140d` (`feature/meta-textscan-local-qa-p27`, Phase 27)

## Purpose

The Phase 28A–30 work existed only as an uncommitted dirty tree on
`feature/meta-textscan-local-qa-p27`. This document records its reconciliation
into a reproducible committed baseline before hardware-candidate hardening.

## Pre-commit state (recorded 2026-07-18)

- Branch: `feature/meta-textscan-local-qa-p27`, no upstream configured.
- HEAD: `e8572b8` (2026-06-24, ~3.5 weeks stale).
- Modified (tracked): `.env.example` (+33), `index.html` (+26),
  `simulator.html` (+133), `src/main.js` (+299), `style.css` (+101).
- Untracked: `src/bridgeState.js`, three phase handoff docs, two runtime docs,
  `META_AUDIT_2026-06-27.md`, `docs/audits/meta-glasses-audit-20260709/`.
- `git diff --check`: clean (CRLF notices only).
- Secret scan of diff and untracked files: no tokens, keys, or credentials found.
- Safety snapshot before any edits:
  `../kscan-meta-pre-hardware-candidate.patch`,
  `../kscan-meta-pre-hardware-candidate-status.txt`.

## Files preserved (committed)

| File | Phase | Role |
|---|---|---|
| `src/bridgeState.js` (new) | 28A/29/30 | Capture bridge state machine + `requestCapture()` + origin allowlist |
| `src/main.js` | 28A/29/30 | Status pills, pipeline stepper, bridge pipeline, hardware mode, diagnostics screen, spokenSummary display |
| `index.html` | 28A/30 | Alpha banner, pill markup, stepper container, diagnostics screen |
| `style.css` | 28A/30 | Banner/pill/stepper styles, 600×600 containment |
| `simulator.html` | 28A/29/30 | Bridge scenario controls, 640×640 synthetic fixture, live-status strip |
| `.env.example` | 29/30 | `VITE_USE_REAL_BRIDGE`, `VITE_BRIDGE_ALLOWED_ORIGINS`, reserved `VITE_BRIDGE_TARGET_ORIGIN` |
| `docs/phase-28a-build-handoff.md` | 28A | Phase handoff |
| `docs/phase-29-bridge-pipeline-handoff.md` | 29 | Phase handoff |
| `docs/phase-30-public-preview-handoff.md` | 30 | Phase handoff |
| `docs/meta-glasses-load-instructions.md` | 30 | Hardware load instructions (placeholder, not device-tested) |
| `docs/meta-runtime-preview-checklist.md` | 30 | Preview QA checklist |

## Files excluded (left untracked, not deleted)

| File | Reason |
|---|---|
| `META_AUDIT_2026-06-27.md` | Audit output, not product source. Superseded by the 2026-07-18 external audit. |
| `docs/audits/meta-glasses-audit-20260709/` (5 files) | Audit output folder. Preserved on disk for reference; not committed per change-control rule against committing audit folders. |

## Discrepancies found (current source wins)

1. The Phase 29 handoff says the simulator bridge fixture was a 1×1 PNG that may
   fail the sanitizer; Phase 30 replaced it with a lazy 640×640 synthetic canvas
   fixture. Current `simulator.html` contains the 640×640 fixture — preserved.
2. The 2026-06-27 in-repo audit claims `simulator.html` exclusion from `dist/`
   per README; current `vite.config.js` includes it as a build input, so
   `dist/simulator.html` IS emitted. Recorded as finding P3-PUB-01; fixed in a
   later workstream (build separation), not in this baseline commit.
3. The 2026-07-09 in-repo audit's session-listener origin finding (MG-02) and
   URL-token gating finding (MG-03) are NOT fixed in the dirty tree. Preserved
   as-is; fixed in subsequent workstreams.
4. No duplicate bridge state systems found: `datBridge.js` (DAT adapter,
   requestId-matched) and `bridgeState.js` (capture.* scaffold) are distinct and
   coexist by design; `startScan()` branches between them via
   `shouldUseBridgeCapture()`.
5. No conflicting hardware-mode flags: `?mode=hardware` → `isHardwareTestMode()`
   is the single canonical flag and implies bridge mode.
6. No unrelated Google/XR content in the dirty tree.

## Test baseline (this tree, before new edits)

| Command | Result |
|---|---|
| `npm run verify:models` | PASS |
| `npm run build` | PASS (vite 7.3.3; `dist/simulator.html` emitted — known P3-PUB-01) |
| `npm run test:static` | 0 FAIL / 7 WARN |
| `npm run test:contract` | 125/125 PASS |
| `npm run test:textscan` | PASS (fully mocked) |

## Architectural summary (as committed)

- Framework-free Vite + vanilla HTML/CSS/JS; fixed 600×600 HUD; D-pad
  (Arrow/Enter/Escape) navigation with per-screen focus matrices.
- Image Scan: capture (mock DAT adapter or `bridgeState.requestCapture()`)
  → validate → MediaPipe BlazeFace detect → mask → canvas re-encode (EXIF
  stripped, ≤800px max side, size-capped, fail-closed) → `/api/analyze`
  (or mock) → StyleMatch → HUD.
- TextScan: preset → `src/services/textScan.js` → Supabase session bridge →
  `scan-identify { mode: 'text' }` → StyleMatch-compatible result → HUD.
  Live contract externally unverified.
- Session intake: runtime config / URL tokens / postMessage
  (`kscan:supabase-session`, `kscan:supabase-token`) / existing SDK session.
  Known gaps P3-SEC-01/02 fixed in later workstreams.
- `?mode=hardware` implies bridge capture, shows `ALPHA · HW TEST MODE`;
  default banner remains `ALPHA · HW VALIDATION PENDING`.
- Runtime Diagnostics screen: statuses/codes only — no tokens, no base64,
  no image data, no env values.
