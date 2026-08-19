// Simulator V2 controller — LOCAL QA / NON-PRODUCTION.
//
// Wires the premium glasses-stage + phone-companion shell to:
//   - the real production HUD (index.html?companion=1) in the 600×600 iframe
//   - src/simulatorV2/mockPhoneEngine.js acting as the paired phone, over the
//     SAME canonical companion protocol/result-contract the real phone uses
//
// This file owns presentation only — pairing rules, scan lifecycle, result
// validation, and focus/keyboard behavior all live in the HUD build and in
// mockPhoneEngine's reuse of src/companion/*. Nothing here re-implements them.

import { createMockPhoneEngine, PHONE_UI_STATE, getFixtureKeys } from './mockPhoneEngine.js';
import { DEMO_SCENARIOS } from './demoFixtures.js';

const $ = (id) => document.getElementById(id);
const frame = $('hud-frame');

const els = {
  modeDemo: $('mode-demo-btn'),
  modeQa: $('mode-qa-btn'),
  devDrawer: $('dev-drawer'),
  phoneScreen: $('phone-screen'),
  handoffChip: $('handoff-chip'),
  productHighlight: $('product-highlight'),
  phIcon: $('ph-icon'),
  phConfidence: $('ph-confidence'),
  phTitle: $('ph-title'),
  phMeta: $('ph-meta'),
  phSource: $('ph-source'),
  phDots: $('ph-dots'),
  startExperience: $('start-experience-btn'),
  autoDemo: $('auto-demo-btn'),
  scenarioSelect: $('scenario-select'),
  flowSteps: $('flow-steps'),
  flowStatusText: $('flow-status-text'),
  aboutBtn: $('about-btn'),
  aboutModal: $('about-modal'),
  aboutClose: $('about-close'),
  devLog: $('dev-log'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Icon library (original line-art, no third-party assets) ──────────────
const ICONS = {
  sunglasses: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="13" cy="26" r="9"/><circle cx="35" cy="26" r="9"/><path d="M22 24h4"/><path d="M4 22l4-6h6"/><path d="M44 22l-4-6h-6"/></svg>',
  handbag: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18a8 8 0 0 1 16 0"/><rect x="8" y="18" width="32" height="22" rx="4"/><path d="M8 26h32"/></svg>',
  sneakers: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 30v6a2 2 0 0 0 2 2h34a2 2 0 0 0 2-2c0-4-4-5-9-7l-9-8-8 3-4-5-8 3v8Z"/><path d="M14 30h10"/></svg>',
  jacket: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6h12l4 6 8 4-3 8-5-2v20a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V22l-5 2-3-8 8-4Z"/><path d="M24 12v10"/></svg>',
  watch: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="16" height="16" rx="3"/><path d="M20 16V8h8v8"/><path d="M20 32v8h8v-8"/><path d="M24 21v4l3 2"/></svg>',
  'no-match': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="24" cy="24" r="16"/><path d="M16 16l16 16"/></svg>',
  'connection-loss': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8 30a20 20 0 0 1 32 0"/><path d="M16 36a10 10 0 0 1 16 0"/><path d="M24 40v.01"/><path d="M6 8l36 36"/></svg>',
  generic: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="10" width="28" height="28" rx="5"/><path d="M18 24h12M24 18v12"/></svg>',
};

// ── Journey breadcrumb ─────────────────────────────────────────────────
const FLOW_STEPS = ['Pair', 'Ready', 'Scan', 'Privacy', 'Identify', 'Discover', 'Save'];
const PHONE_STATE_TO_STEP = {
  [PHONE_UI_STATE.IDLE]: 0,
  [PHONE_UI_STATE.INCOMING_REQUEST]: 0,
  [PHONE_UI_STATE.CONNECTED_READY]: 1,
  [PHONE_UI_STATE.CAPTURING]: 2,
  [PHONE_UI_STATE.PRIVACY]: 3,
  [PHONE_UI_STATE.ANALYZING]: 4,
  [PHONE_UI_STATE.RESULT_READY]: 5,
  [PHONE_UI_STATE.ACTION_PENDING]: 6,
  [PHONE_UI_STATE.ACTION_DONE]: 6,
  [PHONE_UI_STATE.DROPPED]: 0,
};
const FLOW_STATUS_TEXT = {
  [PHONE_UI_STATE.IDLE]: 'Ready to pair.',
  [PHONE_UI_STATE.INCOMING_REQUEST]: 'Check your phone to approve.',
  [PHONE_UI_STATE.CONNECTED_READY]: 'Connected. Point at an item and scan.',
  [PHONE_UI_STATE.CAPTURING]: 'Capturing on phone…',
  [PHONE_UI_STATE.PRIVACY]: 'Protecting privacy — faces masked on-device.',
  [PHONE_UI_STATE.ANALYZING]: 'Finding matches…',
  [PHONE_UI_STATE.RESULT_READY]: 'Match found.',
  [PHONE_UI_STATE.ACTION_PENDING]: 'Working…',
  [PHONE_UI_STATE.ACTION_DONE]: 'Done.',
  [PHONE_UI_STATE.DROPPED]: 'Connection lost — reconnecting…',
};

function renderFlowSteps() {
  els.flowSteps.innerHTML = '';
  FLOW_STEPS.forEach((label) => {
    const li = document.createElement('li');
    li.textContent = label;
    els.flowSteps.appendChild(li);
  });
}
renderFlowSteps();

function setFlowStep(uiState) {
  const activeIndex = PHONE_STATE_TO_STEP[uiState] ?? 0;
  Array.from(els.flowSteps.children).forEach((li, i) => {
    li.classList.toggle('done', i < activeIndex);
    li.classList.toggle('active', i === activeIndex);
  });
  els.flowStatusText.textContent = FLOW_STATUS_TEXT[uiState] || '';
}

// ── Performance panel (simulated, local measurements only) ───────────────
const perf = { pairStart: null, scanStart: null, actionStart: null };
function markPerf(id, ms) {
  const el = $(id);
  if (el) el.textContent = `${Math.round(ms)} ms`;
}

// ── Dev log / status wiring ───────────────────────────────────────────────
function devLog(direction, messageType, extra = '') {
  const line = document.createElement('div');
  const pillColor = direction === 'drop' ? '#FF9F9F' : direction === 'in' ? '#9fd3ff' : '#ffd28f';
  line.innerHTML = `<span style="color:${pillColor}">${direction === 'drop' ? '⨯' : direction === 'in' ? '↓' : '↑'}</span> `;
  line.appendChild(document.createTextNode(`${messageType}${extra ? ` ${extra}` : ''}`));
  els.devLog.appendChild(line);
  els.devLog.scrollTop = els.devLog.scrollHeight;
  while (els.devLog.children.length > 200) els.devLog.removeChild(els.devLog.firstChild);
}

// ── Handoff chip animation (glasses ⇄ phone relationship cue) ────────────
function playHandoff(direction, label) {
  const chip = els.handoffChip;
  chip.textContent = label;
  chip.classList.remove('fly-down', 'fly-up');
  if (reducedMotion) {
    chip.style.opacity = '1';
    setTimeout(() => { chip.style.opacity = '0'; }, 900);
    return;
  }
  // Force reflow so the animation restarts even for the same class.
  void chip.offsetWidth;
  chip.classList.add(direction === 'glasses-to-phone' ? 'fly-down' : 'fly-up');
}

// ── Phone screen rendering ─────────────────────────────────────────────
function iconMarkup(key) {
  return ICONS[key] || ICONS.generic;
}

function renderPhoneScreen(uiState, detail = {}) {
  const screen = els.phoneScreen;
  screen.innerHTML = '';

  const brand = document.createElement('span');
  brand.className = 'phone-brand';
  brand.textContent = 'K Scan AI';
  screen.appendChild(brand);

  const addIcon = (key) => {
    const wrap = document.createElement('div');
    wrap.className = 'phone-icon';
    wrap.innerHTML = iconMarkup(key);
    screen.appendChild(wrap);
  };
  const addSpinner = () => {
    const s = document.createElement('div');
    s.className = 'phone-spinner';
    screen.appendChild(s);
  };
  const addTitle = (text) => {
    const t = document.createElement('p');
    t.className = 'phone-title';
    t.textContent = text;
    screen.appendChild(t);
  };
  const addSupport = (text) => {
    const p = document.createElement('p');
    p.className = 'phone-support';
    p.textContent = text;
    screen.appendChild(p);
  };
  const addActions = (buttons) => {
    const wrap = document.createElement('div');
    wrap.className = 'phone-actions';
    buttons.forEach(({ id, label, kind, onClick }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      if (id) btn.id = id;
      btn.className = `phone-btn ${kind}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      wrap.appendChild(btn);
    });
    screen.appendChild(wrap);
  };

  switch (uiState) {
    case PHONE_UI_STATE.IDLE:
      addIcon('generic');
      addTitle('Waiting for glasses');
      addSupport('Open K Scan AI on your glasses to connect.');
      break;
    case PHONE_UI_STATE.INCOMING_REQUEST:
      addIcon('generic');
      addTitle('Meta glasses want to connect');
      addSupport('Approve to start scanning together.');
      addActions([
        { id: 'phone-approve-btn', label: 'Approve', kind: 'primary', onClick: () => phoneEngine.approve() },
        { id: 'phone-deny-btn', label: 'Not Now', kind: 'ghost', onClick: () => phoneEngine.deny() },
      ]);
      break;
    case PHONE_UI_STATE.CONNECTED_READY:
      addIcon('generic');
      addTitle('Connected');
      addSupport('Ready to scan.');
      break;
    case PHONE_UI_STATE.CAPTURING:
      addSpinner();
      addTitle('Capturing…');
      addSupport('Hold steady.');
      break;
    case PHONE_UI_STATE.PRIVACY:
      addSpinner();
      addTitle('Privacy Check');
      addSupport('Faces protected locally before analysis.');
      break;
    case PHONE_UI_STATE.ANALYZING:
      addSpinner();
      addTitle('Matching');
      addSupport('Looking for similar pieces.');
      break;
    case PHONE_UI_STATE.RESULT_READY:
      addIcon(detail.result?.__icon || 'generic');
      addTitle('Result ready');
      addSupport('Continue on your glasses, or here.');
      break;
    case PHONE_UI_STATE.ACTION_PENDING:
      addSpinner();
      addTitle('Working…');
      addSupport('Confirming with your glasses.');
      break;
    case PHONE_UI_STATE.ACTION_DONE:
      addIcon('generic');
      addTitle(detail.actionType && detail.actionType.includes('open') ? 'Opened' : 'Saved');
      addSupport(detail.actionType && detail.actionType.includes('open') ? 'Continue on your phone.' : 'Added to your K Scan AI Closet.');
      break;
    case PHONE_UI_STATE.DROPPED:
      addIcon('connection-loss');
      addTitle('Connection Lost');
      addSupport('Trying to reconnect…');
      break;
    default:
      addIcon('generic');
      addTitle('K Scan AI');
  }
}

// ── Product highlight (result mirror — presentation only) ────────────────
let currentMatches = [];
let currentMatchIndex = 0;
let currentSummary = '';
let currentConfidence = null;

function renderProductHighlight() {
  if (!currentMatches.length) {
    els.productHighlight.classList.remove('visible');
    return;
  }
  const m = currentMatches[currentMatchIndex];
  els.phIcon.innerHTML = iconMarkup(currentIcon);
  els.phConfidence.textContent = currentConfidence !== null ? `${currentConfidence}% Match` : '';
  els.phConfidence.style.display = currentConfidence !== null ? '' : 'none';
  els.phTitle.textContent = m.title;
  const priceLabel = formatPrice(m.price);
  els.phMeta.textContent = [m.brand, priceLabel].filter(Boolean).join(' · ') || currentSummary;
  els.phSource.textContent = m.commerceGroup === 'resale'
    ? `Resale — ${m.resaleSource || 'demo source'}`
    : `Retail — ${m.retailer || 'demo source'}`;
  els.phDots.innerHTML = '';
  currentMatches.forEach((_, i) => {
    const dot = document.createElement('span');
    if (i === currentMatchIndex) dot.classList.add('active');
    els.phDots.appendChild(dot);
  });
  els.productHighlight.classList.add('visible');
}

function formatPrice(price) {
  if (!price) return 'Price unavailable';
  if (price.label) return price.label;
  if (typeof price.amount === 'number') {
    const symbol = { USD: '$', EUR: '€', GBP: '£' }[price.currency] || '';
    return `${symbol}${price.amount}`;
  }
  return 'Price unavailable';
}

let currentIcon = 'generic';

function loadResultIntoHighlight(result) {
  const items = [result.primaryMatch, ...(result.alternatives || [])].filter(Boolean);
  currentMatches = items;
  currentMatchIndex = 0;
  currentSummary = result.summary || '';
  currentConfidence = typeof result.confidence === 'number' ? result.confidence : null;
  currentIcon = result.__icon || 'generic';
  if (!items.length) {
    // No-match scenario: still surface the honest summary, no carousel.
    els.productHighlight.classList.remove('visible');
    return;
  }
  renderProductHighlight();
}

function hideProductHighlight() {
  currentMatches = [];
  els.productHighlight.classList.remove('visible');
}

$('ph-prev').addEventListener('click', () => {
  if (!currentMatches.length) return;
  currentMatchIndex = (currentMatchIndex - 1 + currentMatches.length) % currentMatches.length;
  renderProductHighlight();
  mirrorAlternativeClick(currentMatchIndex);
});
$('ph-next').addEventListener('click', () => {
  if (!currentMatches.length) return;
  currentMatchIndex = (currentMatchIndex + 1) % currentMatches.length;
  renderProductHighlight();
  mirrorAlternativeClick(currentMatchIndex);
});

function mirrorAlternativeClick(index) {
  const doc = frameDoc();
  if (!doc) return;
  // Primary match (index 0) has no HUD row of its own to click; alternatives
  // are the .companion-item rows in DOM order (index-1 within that list).
  if (index === 0) return;
  const rows = doc.querySelectorAll('.companion-item');
  const row = rows[index - 1];
  if (row) row.click();
}

$('ph-save').addEventListener('click', () => clickInFrame('#comp-action-save'));
$('ph-open').addEventListener('click', () => clickInFrame('#comp-action-open'));
$('ph-retry').addEventListener('click', () => clickInFrame('#comp-action-retry'));
$('ph-dismiss').addEventListener('click', () => clickInFrame('#comp-action-dismiss'));

// ── Iframe helpers ─────────────────────────────────────────────────────
function frameWin() {
  try { return frame.contentWindow || null; } catch { return null; }
}
function frameDoc() {
  try { return frame.contentWindow?.document || null; } catch { return null; }
}
function clickInFrame(selector) {
  const doc = frameDoc();
  const el = doc?.querySelector(selector);
  if (el && !el.classList.contains('hidden') && !el.disabled) {
    el.click();
    return true;
  }
  return false;
}
function frameSrc() {
  return `./index.html?companion=1&sim=1&v2=1&t=${Date.now()}`;
}
function loadFrame() {
  return new Promise((resolve) => {
    const onLoad = () => { frame.removeEventListener('load', onLoad); resolve(); };
    frame.addEventListener('load', onLoad);
    frame.src = frameSrc();
  });
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── Mock phone engine ──────────────────────────────────────────────────
const phoneEngine = createMockPhoneEngine({
  getFrameWindow: frameWin,
  selfOrigin: window.location.origin,
  callbacks: {
    onLog: (dir, type, extra) => devLog(dir, type, extra),
    onSessionStatus: (text) => { $('dev-session-status').textContent = text; },
    onScanStatus: (text) => { $('dev-scan-status').textContent = text; },
    onActionStatus: (text) => { $('dev-action-status').textContent = text; },
    onHandoff: (direction, label) => playHandoff(direction, label),
    onResultSent: (result) => loadResultIntoHighlight(result),
    onPhoneState: (uiState, detail) => {
      renderPhoneScreen(uiState, detail);
      setFlowStep(uiState);
      trackPerf(uiState);
      // The HUD leaves the results screen (and its action bar) the instant
      // an action is initiated — ACTION_PENDING/ACTION_DONE render on the
      // companion "Working…/Done" screen instead. Hide the mirror then, so
      // its Save/Open/Retry/Dismiss buttons never target stale, hidden
      // elements inside the iframe.
      if ([PHONE_UI_STATE.CONNECTED_READY, PHONE_UI_STATE.IDLE, PHONE_UI_STATE.DROPPED,
        PHONE_UI_STATE.ACTION_PENDING, PHONE_UI_STATE.ACTION_DONE, PHONE_UI_STATE.CAPTURING].includes(uiState)) {
        hideProductHighlight();
      }
      if (uiState === PHONE_UI_STATE.DROPPED && demoScenarioKey === 'connectionLoss') {
        scheduleConnectionLossRecovery();
      }
    },
  },
});
renderPhoneScreen(PHONE_UI_STATE.IDLE);
setFlowStep(PHONE_UI_STATE.IDLE);

function trackPerf(uiState) {
  const now = performance.now();
  if (uiState === PHONE_UI_STATE.INCOMING_REQUEST) perf.pairStart = now;
  if (uiState === PHONE_UI_STATE.CONNECTED_READY && perf.pairStart !== null) {
    markPerf('perf-pair', now - perf.pairStart);
    perf.pairStart = null;
  }
  if (uiState === PHONE_UI_STATE.CAPTURING) perf.scanStart = now;
  if (uiState === PHONE_UI_STATE.PRIVACY && perf.scanStart !== null) {
    markPerf('perf-scan-proc', now - perf.scanStart);
  }
  if (uiState === PHONE_UI_STATE.RESULT_READY && perf.scanStart !== null) {
    markPerf('perf-scan-result', now - perf.scanStart);
    perf.scanStart = null;
  }
  if (uiState === PHONE_UI_STATE.ACTION_PENDING) perf.actionStart = now;
  if (uiState === PHONE_UI_STATE.ACTION_DONE && perf.actionStart !== null) {
    markPerf('perf-action', now - perf.actionStart);
    perf.actionStart = null;
  }
}

function scheduleConnectionLossRecovery() {
  setTimeout(() => {
    if (phoneEngine.getUiState() === PHONE_UI_STATE.DROPPED) phoneEngine.restore();
  }, 3200);
}

// ── Demo scenario selection ────────────────────────────────────────────
let demoScenarioKey = 'sunglasses';
Object.entries(DEMO_SCENARIOS).forEach(([key, cfg]) => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = cfg.label;
  els.scenarioSelect.appendChild(opt);
});
els.scenarioSelect.value = demoScenarioKey;
phoneEngine.setDemoScenario(DEMO_SCENARIOS[demoScenarioKey].builder);
els.scenarioSelect.addEventListener('change', () => {
  demoScenarioKey = els.scenarioSelect.value;
  phoneEngine.setDemoScenario(DEMO_SCENARIOS[demoScenarioKey].builder);
});

// ── QA drawer fixture select ───────────────────────────────────────────
const devFixtureSelect = $('dev-fixture-select');
getFixtureKeys().forEach((key) => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = key;
  devFixtureSelect.appendChild(opt);
});
devFixtureSelect.value = 'full';
devFixtureSelect.addEventListener('change', () => {
  phoneEngine.clearDemoScenario();
  phoneEngine.setFixture(devFixtureSelect.value);
});

// ── Developer drawer wiring ─────────────────────────────────────────────
function wire(id, fn) { $(id)?.addEventListener('click', fn); }
wire('dev-approve', () => phoneEngine.approve());
wire('dev-deny', () => phoneEngine.deny());
wire('dev-expire-pair', () => phoneEngine.expirePairing());
wire('dev-revoke', () => phoneEngine.revokeSession());
wire('dev-drop', () => phoneEngine.drop());
wire('dev-restore', () => phoneEngine.restore());
wire('dev-refresh-required', () => phoneEngine.refreshRequired());
wire('dev-drive-auto', () => phoneEngine.driveAuto());
wire('dev-stop-drive', () => phoneEngine.stopDrive());
wire('dev-capture-started', () => phoneEngine.sendCaptureStarted());
wire('dev-privacy', () => phoneEngine.sendPrivacy());
wire('dev-analyzing', () => phoneEngine.sendAnalyzing());
wire('dev-scan-failed', () => phoneEngine.sendScanFailed());
wire('dev-send-result', () => phoneEngine.sendResult());
wire('dev-ack-accept', () => phoneEngine.ackAccept());
wire('dev-ack-complete', () => phoneEngine.ackComplete());
wire('dev-ack-fail', () => phoneEngine.ackFail());
wire('dev-neg-malformed', () => phoneEngine.negMalformed());
wire('dev-neg-stale', () => phoneEngine.negStale());
wire('dev-neg-dupe', () => phoneEngine.negDupe());
wire('dev-neg-oversize', () => phoneEngine.negOversize());
wire('dev-neg-device', () => phoneEngine.negWrongDevice());
wire('dev-neg-session', () => phoneEngine.negWrongSession());
wire('dev-clear-log', () => { els.devLog.textContent = ''; });
$('dev-auto-ack').addEventListener('change', (e) => phoneEngine.setAutoAck(e.target.checked));

// ── Demo / QA mode toggle ───────────────────────────────────────────────
function setMode(mode) {
  const isQa = mode === 'qa';
  els.modeDemo.setAttribute('aria-selected', String(!isQa));
  els.modeQa.setAttribute('aria-selected', String(isQa));
  els.devDrawer.hidden = !isQa;
}
els.modeDemo.addEventListener('click', () => setMode('demo'));
els.modeQa.addEventListener('click', () => setMode('qa'));

// ── About modal ─────────────────────────────────────────────────────────
els.aboutBtn.addEventListener('click', () => { els.aboutModal.hidden = false; els.aboutClose.focus(); });
els.aboutClose.addEventListener('click', () => { els.aboutModal.hidden = true; els.aboutBtn.focus(); });
els.aboutModal.addEventListener('click', (e) => { if (e.target === els.aboutModal) els.aboutModal.hidden = true; });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.aboutModal.hidden) els.aboutModal.hidden = true;
});

// ── Start Experience (guided journey) ───────────────────────────────────
// Reused by both "Start Experience" and each Auto Demo loop iteration —
// must NOT touch autoDemoRunning itself, or a running auto-demo would kill
// its own loop on the very first reset of every iteration.
async function resetJourney() {
  phoneEngine.resetPhoneState();
  hideProductHighlight();
  ['perf-pair', 'perf-scan-proc', 'perf-scan-result', 'perf-action', 'perf-dismiss'].forEach((id) => { $(id).textContent = '—'; });
  await loadFrame();
}

async function goToPairScreen() {
  await sleep(120);
  clickInFrame('#scan-btn');
  await sleep(120);
  clickInFrame('#comp-primary-btn'); // "Pair Phone" — glasses-side action
}

els.startExperience.addEventListener('click', async () => {
  autoDemoRunning = false; // a manual guided run takes over from any auto-demo
  setAutoDemoButton(false);
  await resetJourney();
  await goToPairScreen();
});

// ── Auto Demo (unattended, for recording) ───────────────────────────────
let autoDemoRunning = false;

function setAutoDemoButton(running) {
  els.autoDemo.setAttribute('aria-pressed', String(running));
  els.autoDemo.textContent = running ? 'Stop Auto Demo' : 'Auto Demo';
}

async function waitForPhoneState(target, timeoutMs = 8000) {
  const start = performance.now();
  while (autoDemoRunning && performance.now() - start < timeoutMs) {
    if (phoneEngine.getUiState() === target) return true;
    await sleep(100);
  }
  return phoneEngine.getUiState() === target;
}

async function runAutoDemoLoop() {
  while (autoDemoRunning) {
    await resetJourney();
    if (!autoDemoRunning) return;
    await goToPairScreen();
    await sleep(500);
    if (!autoDemoRunning) return;
    phoneEngine.approve();
    await waitForPhoneState(PHONE_UI_STATE.CONNECTED_READY);
    await sleep(700);
    if (!autoDemoRunning) return;

    if (demoScenarioKey === 'connectionLoss') {
      clickInFrame('#comp-primary-btn'); // Scan
      await sleep(700);
      phoneEngine.drop();
      await waitForPhoneState(PHONE_UI_STATE.DROPPED);
      await sleep(3600); // engine auto-restores after ~3.2s
      await waitForPhoneState(PHONE_UI_STATE.CONNECTED_READY, 6000);
      await sleep(1200);
      continue;
    }

    clickInFrame('#comp-primary-btn'); // Scan
    await waitForPhoneState(PHONE_UI_STATE.RESULT_READY, 12000);
    await sleep(1400);
    if (!autoDemoRunning) return;

    const openThisRound = Math.random() > 0.5;
    clickInFrame(openThisRound ? '#comp-action-open' : '#comp-action-save');
    await waitForPhoneState(PHONE_UI_STATE.ACTION_DONE, 4000);
    await sleep(1600);
    if (!autoDemoRunning) return;

    // Action complete moves the HUD off the results screen onto its own
    // "Done" companion screen — comp-primary-btn (relabeled "Done") is the
    // dismiss control there, not the (now hidden) results action bar.
    clickInFrame('#comp-primary-btn');
    await waitForPhoneState(PHONE_UI_STATE.CONNECTED_READY, 4000);
    await sleep(1800);
  }
}

els.autoDemo.addEventListener('click', () => {
  autoDemoRunning = !autoDemoRunning;
  setAutoDemoButton(autoDemoRunning);
  if (autoDemoRunning) runAutoDemoLoop();
});

// ── Initial load ─────────────────────────────────────────────────────────
loadFrame();
