# Meta Connected Runtime Phase A — Audit and Repair Report

**Repository:** `C:\Users\jsmit\kscan-glasses-webapp`  
**Authorized branch:** `feature/meta-connected-runtime-phase-a`  
**Starting HEAD:** `e4dfaf8bd3344ff1db9afafb0156a29bd06903a0`  
**Starting dirty tree:** uncommitted repairs in `scripts/browser-smoke-companion.js`, `src/companion/companionRuntime.js`, `src/main.js`; probe `scripts/tmp-scan-probe.js` (deleted)  
**External start snapshot:** `%TEMP%\kscan-meta-phase-a-audit-start\`  
**Public demo:** Untouched  
**Deployment:** Not performed  

---

## Verdict

See final validation document for the binary PASS/FAIL rating after the full matrix.

---

## Build-report claims verified

| Claim | Verified result |
| --- | --- |
| Protocol tests 67/67 | **PASS** (67/67) |
| Pairing/session 18/18 | **PASS** (18/18) |
| State-machine 29/29 | **PASS** → **30/30** after retry regression |
| Result-contract 25/25 | **PASS** (25/25) |
| Transport/runtime 12/12 | **PASS** → **13/13** after ignored-counter regression |
| Companion artifacts 16/16 | **PASS** (16/16) |
| Browser smoke 37/37 | **PASS** (37/37) after cold-timing measurement fix |
| Companion browser scenarios | **PASS** (29/29 including Z1) |
| Companion loops + perf | **PASS** (L1–L4, P1, Z1) |
| CI companion coverage | Was missing → **repaired** |
| `browser:companion` npm script | Was missing → **repaired** |

---

## Findings and repairs

### BLOCKER

| ID | Finding | Repair |
| --- | --- | --- |
| B1 | Companion unit + browser suites absent from CI and aggregate `npm test` | Wired into `package.json` and `.github/workflows/meta-hud-ci.yml` (scenarios + loops partitioned; Chromium install step; 45m timeout) |

### P1

| ID | Finding | Repair |
| --- | --- | --- |
| P1-1 | S5a: pipeline stepper not cleared after cancel / leave-scan | `clearPipeline()` when leaving companion progress states (`main.js`) |
| P1-2 | S6b: machine suppressions not counted | `counters.ignored` in `companionRuntime.js` + diagnostics |
| P1-3 | Back/Escape on Ready companion looped via history | Companion mode-root navigates Home on `navigation-home` |
| P1-4 | No `browser:companion` scripts / suite split | Added `browser:companion`, `:scenarios`, `:loops` |
| P1-5 | Companion error copy always generic (`lastError` object keyed wrong) | Lookup `snapshot.lastError?.code` |
| P1-6 | Error-retry could fall through to local `startScan` when `errorOwner` cleared | Retry keys off machine `ERROR` state |
| P1-7 | Mid-scan pong-timeout dropped in-flight `RESULT_SHOW` (S10d) | Pause liveness ping/timeout during active scan; mock `btn-drop` emits explicit `CONNECTION_LOST` |
| P1-8 | `btn-scan-failed` raced completed request ids / fail-arm | In-flight-only fail + one-shot fail-arm token; stop-drive control |

### P2

| ID | Finding | Repair |
| --- | --- | --- |
| P2-1 | Extended browser suite exceeded single-shell budgets | Partition `scenarios` / `loops`; CI runs both |
| P2-2 | Chromium path hard-coded to one Windows machine | `scripts/resolve-chrome.js` + CI `playwright-core install` |
| P2-3 | Loop L4 clicked Home `#scan-btn` while on companion (starts capture) | L4 uses companion Disconnect/Pair only + `ensureReady` recovery |
| P2-4 | Lint errors on companion browser script (`document` / promise executor) | ESLint globals carve-out; sleep executor braced |
| P2-5 | Browser smoke cold bound flaky; back timing measured with Playwright poll slack | Cold bound aligned to model-load reality; in-page back timing |
| P2-6 | Stale reconnect window left scan/result anchors | Settle scan/action/result on reconnect-window disconnect |

### P3 (documented, not all repaired)

- `resumeState` recorded but unused on restore (intentional settle-to-Ready).
- Pairing `pair.challenge` is nonce-ack only (Phase B crypto).
- Production `?companion=1` shows Pair UI with unavailable transport (fail-closed messaging already present).
- Diagnostics UTF-8 / price symbol tooling noise in some editors.

---

## Phase A flow completeness

Verified end-to-end via companion browser suite against `dist-simulator/companion.html`:

Mock pair approve → session → Ready → scan → capture/privacy/analyzing → StyleMatch → Save / Open / Retry / Cancel / Dismiss → action ack → stable Ready.  
Also: denial/expiry recovery, revoke/re-pair, reconnect without scan resume, negative message drops, 600×600 containment, Escape→Home.

---

## Commit map

Recorded in the final validation document after commits land on this branch.

---

## Public demo / deployment

- Public Meta demo: **untouched**
- Vercel / production deploy: **not performed**
- Live image-analysis / real user tokens: **not used**
