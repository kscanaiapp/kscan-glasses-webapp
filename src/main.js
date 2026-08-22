import { initNavigation, focusFirstInView, registerFocusMatrix, resetFocusIndex } from './navigation.js';
import {
  capturePhoto,
  requestBetaCapture,
  getDatDiagnostics,
  getDatStatus,
  getMobileBridgeStatus,
  getBetaBridgeStatus,
  DATBridgeError,
  DAT_ERROR_CODES,
  toUserFriendlyCaptureError,
} from './datBridge.js';
import { isMobileBridgeEnabled } from './mobileBridgeConfig.js';
import { sanitizeImageBeforeUpload, SanitizerError, mapSanitizerErrorToUserMessage } from './privacyImageSanitizer.js';
import { analyzeImage, AnalyzeError, ANALYZE_ERROR_CODES, getAnalyzeMode } from './api.js';
import { FLOW_STATES, getFlowState, setFlowState } from './flowState.js';
import { runScanPipeline, PIPELINE_STAGES, PipelineInvariantError } from './scanPipeline.js';
import { mountSimulatorBadge, getSimulatorState } from './simulatorMode.js';
import { getSession, signInStub, signOut, isStubMode } from './authSession.js';
import { loadGuestLibrary, recordGuestScan, saveGuestItem, getStubLibraryExamples } from './libraryStore.js';
import { buildMockStyleMatch, makeEmptyStyleMatch } from './styleMatchContract.js';
import {
  analyzeTextQuery,
  TEXTSCAN_ERROR_CODES,
  textScanErrorToStyleMatch,
} from './services/textScan.js';
import {
  getSupabaseRuntimeStatus,
  hasSupabaseConfig,
  listenForSupabaseSessionMessages,
  signOutSupabaseSession,
} from './services/supabaseClient.js';
import {
  initBridgeStateListener,
  subscribeBridgeState,
  BRIDGE_STATUS,
  requestCapture,
  getBridgeState,
  cancelBridgeCapture,
  resetBridgeState,
} from './bridgeState.js';
import { createCompanionRuntime } from './companion/companionRuntime.js';
import { resolveCompanionTransport, TRANSPORT_STATE } from './companion/transport.js';
import { RUNTIME_STATE } from './companion/runtimeState.js';

const STATE = FLOW_STATES;

let currentView = 'home';
const screenHistory = [];
let lastDatErrorCode = 'none';
let lastSafeErrorCode = 'none'; // diagnostics: short error CODE only — never messages with payloads
let lastBridgeSnapshot = null; // diagnostics: latest bridge state (metadata-only by design)
let scanInFlight = false;
let scanToken = 0;
let pipelineMode = 'image'; // 'image' | 'text' | 'companion' — drives the processing stepper

// Hardware candidate diagnostics tracking
let successfulScanCount = 0;
let reconnectCount = 0;
let lastScanStartAt = 0;
let lastScanDurationMs = 0;

// Phone-companion mode (?companion=1): the HUD is driven by the companion
// runtime (pairing → trusted wearable session → structured result handoff).
// Without a configured peer the transport fails closed (UNAVAILABLE).
const COMPANION_MODE = new URLSearchParams(window.location.search).get('companion') === '1';
let companionRuntime = null;
let companionScanOnProcessing = false; // processing screen is showing a companion scan
let resultsOwner = 'local'; // 'local' | 'companion' — who rendered the visible results
let errorOwner = 'local'; // 'local' | 'companion' — who raised the visible error

// Production-representative pipeline steppers (Phase 28A).
// Image Scan mirrors the real capture → privacy → /api/analyze path.
// TextScan mirrors preset → session → scan-identify (mode: text).
const PIPELINE_LABELS = {
  image: ['Capture', 'Privacy', 'Analyze', 'StyleMatch', 'Results'],
  text: ['Preset', 'Session', 'scan-identify', 'StyleMatch', 'Results'],
  companion: ['Request', 'Phone Capture', 'Privacy', 'Analyze', 'Results'],
};

function renderPipeline(mode, activeIndex) {
  const list = document.getElementById('pipeline-steps');
  if (!list) return;
  list.innerHTML = '';
  const steps = PIPELINE_LABELS[mode] || [];
  steps.forEach((label, i) => {
    const li = document.createElement('li');
    li.className = i < activeIndex
      ? 'pipeline-step done'
      : i === activeIndex
        ? 'pipeline-step active'
        : 'pipeline-step';
    li.textContent = label;
    list.appendChild(li);
  });
}

// Terminal state after a completed pipeline: every step done, none active —
// the stepper must never remain stuck once results are shown.
function renderPipelineDone(mode) {
  renderPipeline(mode, (PIPELINE_LABELS[mode] || []).length);
}

// Pipeline abandoned (error/cancel/back) — remove all steps so no stale
// active step survives while the processing screen is hidden.
function clearPipeline() {
  const list = document.getElementById('pipeline-steps');
  if (list) list.innerHTML = '';
}

const els = {
  home: document.getElementById('home'),
  processing: document.getElementById('processing'),
  results: document.getElementById('results'),
  library: document.getElementById('library'),
  settings: document.getElementById('settings'),
  diagnostics: document.getElementById('diagnostics'),
  error: document.getElementById('error'),
  companion: document.getElementById('companion'),
  processingText: document.getElementById('processing-text'),
  processingSub: document.getElementById('processing-sub'),
  resultsList: document.getElementById('results-list'),
  resultsMatch: document.getElementById('results-match'),
  resultsEmpty: document.getElementById('results-empty'),
  errorMessage: document.getElementById('error-message'),
  textscanResults: document.getElementById('textscan-results'),
  hud: null,
};

const screens = [els.home, els.processing, els.results, els.library, els.settings, els.diagnostics, els.error, els.companion];

function updateHud() {
  if (!els.hud || !import.meta.env.DEV) return;

  const datDiagnostics = getDatDiagnostics();
  const betaStatus = getBetaBridgeStatus();
  const datState = betaStatus.enabled ? 'BETA' : (datDiagnostics.mock ? 'MOCK' : (datDiagnostics.bridgeReady ? 'READY' : 'MISSING'));
  const analyzeState = (import.meta.env.DEV && import.meta.env.VITE_MOCK_ANALYZE === 'true') ? 'MOCK' : 'REAL';
  const textscanState = isTextScanMockEnabled() ? 'MOCK' : 'LIVE';
  const backendState = String(import.meta.env.VITE_KSCAN_BACKEND_URL || '').trim() ? 'OK' : 'MISSING';
  const supabaseStatus = getSupabaseRuntimeStatus();
  const supabaseState = supabaseStatus.configured ? 'OK' : 'MISSING';
  const accountState = supabaseStatus.linked ? 'LINKED' : 'REQUIRED';
  const flow = getFlowState();

  els.hud.textContent = `DAT: ${datState} | ANALYZE: ${analyzeState} | TEXTSCAN: ${textscanState} | SUPABASE: ${supabaseState} | ACCOUNT: ${accountState} | SOURCE: PRESET | BACKEND: ${backendState} | FLOW: ${flow}`;
}

// Bridge scaffold events (simulator/runtime) override the static badge so
// the HUD can demonstrate requesting/capturing/success/error/timeout states
// before real hardware validation. Metadata-only — never payloads.
function updateBridgeBadge(scaffold) {
  const badge = document.getElementById('bridge-status');
  if (!badge) return;

  if (scaffold && scaffold.status && scaffold.status !== BRIDGE_STATUS.IDLE) {
    const status = String(scaffold.status).toUpperCase();
    badge.textContent = `BRIDGE: ${status}`;
    badge.className = scaffold.status === BRIDGE_STATUS.SUCCESS
      ? 'bridge-badge ready'
      : (scaffold.status === BRIDGE_STATUS.ERROR || scaffold.status === BRIDGE_STATUS.TIMEOUT)
        ? 'bridge-badge pending'
        : 'bridge-badge mock';
    setPill('pill-bridge', scaffold.status === BRIDGE_STATUS.SUCCESS ? 'ok' : 'mock', `Bridge: ${status}`);
    return;
  }

  const betaStatus = getBetaBridgeStatus();
  const datStatus = getDatStatus();

  if (betaStatus.enabled) {
    badge.textContent = 'BRIDGE: BETA';
    badge.className = 'bridge-badge beta';
  } else if (datStatus.includes('mock')) {
    badge.textContent = 'BRIDGE: MOCK';
    badge.className = 'bridge-badge mock';
  } else if (datStatus.includes('ready')) {
    badge.textContent = 'BRIDGE: READY';
    badge.className = 'bridge-badge ready';
  } else {
    badge.textContent = 'BRIDGE: PENDING';
    badge.className = 'bridge-badge pending';
  }
  setPill('pill-bridge', datStatus.includes('ready') || betaStatus.enabled ? 'ok' : 'mock',
    betaStatus.enabled ? 'Bridge: Beta stub' : datStatus.includes('mock') ? 'Bridge: Mock' : datStatus.includes('ready') ? 'Bridge: Ready' : 'Bridge: Pending');
}

// ─── Home status pills (production-representative, honest states) ───

function setPill(id, dotState, text) {
  const pill = document.getElementById(id);
  if (!pill) return;
  const dot = pill.querySelector('.dot');
  const label = pill.querySelector('span');
  if (dot) dot.className = `dot ${dotState}`;
  if (label) label.textContent = text;
}

function updateHomeStatusPills() {
  const supa = getSupabaseRuntimeStatus();
  const textscanMock = isTextScanMockEnabled();

  setPill(
    'pill-textscan',
    textscanMock ? 'mock' : supa.configured ? 'ok' : 'off',
    textscanMock ? 'TextScan: Mock' : supa.configured ? 'TextScan: Live Ready' : 'TextScan: Config Required',
  );
  setPill(
    'pill-session',
    supa.linked ? 'ok' : 'off',
    supa.linked ? 'Session: Linked' : 'Session: Required',
  );
}

function setState(next) {
  setFlowState(next);
  const sub = els.processingSub;
  if (next === STATE.CAPTURING) {
    els.processingText.textContent = 'Capturing...';
    if (sub) sub.textContent = '';
    renderPipeline('image', 0);
  }
  if (next === STATE.SANITIZING) {
    els.processingText.textContent = 'Protecting privacy...';
    if (sub) sub.textContent = '';
    renderPipeline('image', 1);
  }
  if (next === STATE.ANALYZING) {
    els.processingText.textContent = 'Analyzing scan...';
    if (sub) sub.textContent = 'Fashion AI is working';
    renderPipeline(pipelineMode, 2);
  }
  updateHud();
}

function syncViewA11y(activeViewId) {
  screens.forEach((screen) => {
    if (!screen) return;
    const active = screen.id === activeViewId;
    screen.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
}

function showScreen(viewId, pushHistory = true) {
  resetFocusIndex();

  // 'processing' and 'error' are transient scan-flow screens — never a valid
  // Back destination, so never record them in navigation history. Otherwise
  // results→Back (or retry chains) would land on a dead processing screen.
  if (pushHistory && currentView !== viewId && currentView !== 'processing' && currentView !== 'error') {
    screenHistory.push(currentView);
  }

  screens.forEach((screen) => {
    if (!screen) return;
    screen.classList.add('hidden');
  });

  els[viewId].classList.remove('hidden');
  currentView = viewId;
  syncViewA11y(viewId);

  if (viewId === 'library') renderLibrary();
  if (viewId === 'settings') renderSettings();
  if (viewId === 'diagnostics') renderDiagnostics();

  if (viewId === 'results') {
    // Check if TextScan result is active
    const textscanCard = els.textscanResults?.querySelector('.textscan-result-card');
    const retryBtn = els.textscanResults?.querySelector('.textscan-retry-btn');
    if (textscanCard && !els.textscanResults.classList.contains('hidden')) {
      const focusTarget = retryBtn || document.getElementById('results-back-btn');
      focusTarget?.focus();
      return;
    }
    const firstCard = els.resultsList.querySelector('.product-card.focusable');
    if (firstCard) {
      firstCard.focus();
      return;
    }
    document.getElementById('results-back-btn')?.focus();
    return;
  }

  if (viewId === 'error') {
    document.getElementById('error-retry-btn')?.focus();
    return;
  }

  if (viewId === 'processing') {
    document.getElementById('cancel-btn')?.focus();
    return;
  }

  focusFirstInView(viewId);
}

function safeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function createText(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function createStyleMatchItemCard(item) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'row product-card focusable';

  const hasImage = typeof item.imageUrl === 'string' && item.imageUrl.length > 0;
  if (hasImage) {
    const image = document.createElement('img');
    image.className = 'product-thumb';
    image.src = item.imageUrl;
    image.alt = 'Product image';
    card.appendChild(image);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'product-thumb product-thumb-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    card.appendChild(placeholder);
  }

  const meta = document.createElement('div');
  meta.className = 'product-meta';

  const sourcePill = document.createElement('span');
  sourcePill.className = `source-pill ${item.sourceType}`;
  sourcePill.textContent = item.sourceType === 'retail' ? 'Retail — demo' : item.sourceType === 'resale' ? 'Resale — demo' : 'Suggested — demo';
  meta.appendChild(sourcePill);

  meta.appendChild(createText('p', 'brand', safeText(item.subtitle, 'Unknown Brand')));
  meta.appendChild(createText('p', 'name', safeText(item.title, 'Unknown item')));

  const priceText = safeText(item.priceLabel, 'Price unavailable');
  meta.appendChild(createText('p', 'price', priceText));

  const actions = document.createElement('div');
  actions.className = 'product-actions';

  const saveAction = createText('span', 'product-action-btn primary-action', 'Save Look');
  // Phone handoff is not built in this phase — render an honest, disabled
  // label instead of a dead affordance (P3-UX-02).
  const phoneAction = createText('span', 'product-action-btn action-disabled', 'Phone handoff — coming soon');
  phoneAction.setAttribute('aria-disabled', 'true');
  actions.appendChild(saveAction);
  actions.appendChild(phoneAction);
  meta.appendChild(actions);
  card.appendChild(meta);

  // Enter/click on a result card saves metadata (brand/name/price only —
  // never images) to the guest library.
  card.addEventListener('click', () => {
    const result = saveGuestItem({
      brand: safeText(item.subtitle, 'Unknown Brand'),
      name: safeText(item.title, 'Unnamed Product'),
      price: safeText(item.priceLabel, 'Price unavailable'),
    });
    if (result.saved) {
      saveAction.textContent = 'Saved';
      card.classList.add('saved');
    } else if (result.reason === 'duplicate') {
      saveAction.textContent = 'Saved';
      card.classList.add('saved');
    } else {
      saveAction.textContent = 'Unable to save';
    }
  });
  return card;
}

function renderStyleMatch(styleMatch) {
  const panel = els.resultsMatch;
  if (!panel) return;
  panel.innerHTML = '';

  const sm = styleMatch && typeof styleMatch === 'object' ? styleMatch : makeEmptyStyleMatch();

  const card = document.createElement('div');
  card.className = 'glass-card gold-border style-match-card';

  const header = document.createElement('div');
  header.className = 'style-match-header';
  header.appendChild(createText('span', 'style-match-title', 'Style Match'));

  const badgeRow = document.createElement('div');
  badgeRow.style.display = 'flex';
  badgeRow.style.gap = '8px';
  badgeRow.style.flexWrap = 'wrap';

  if (sm.meta?.confidenceLabel) {
    badgeRow.appendChild(createText('span', 'confidence-badge', sm.meta.confidenceLabel));
  }
  if (sm.meta?.scanModeLabel) {
    badgeRow.appendChild(createText('span', 'scan-mode-pill', `Scan Mode: ${sm.meta.scanModeLabel}`));
  }
  if (sm.meta?.sourceLabel) {
    badgeRow.appendChild(createText('span', 'scan-mode-pill', sm.meta.sourceLabel));
  }
  header.appendChild(badgeRow);
  card.appendChild(header);

  card.appendChild(createText('div', 'detected-style', sm.summary || 'Style Match'));

  const attrRow = document.createElement('div');
  attrRow.className = 'style-attributes';
  const keywords = Array.isArray(sm.intent?.keywords) ? sm.intent.keywords : [];
  keywords.slice(0, 5).forEach((attr) => {
    attrRow.appendChild(createText('span', 'attr-pill', safeText(attr, '')));
  });
  card.appendChild(attrRow);

  const disclaimer = document.createElement('p');
  disclaimer.className = 'source-disclaimer';
  disclaimer.textContent = sm.meta?.isDemo ? 'Mock demo data — no live inventory or pricing' : 'Results may vary — verify before purchase';
  card.appendChild(disclaimer);

  panel.appendChild(card);
}

function renderProducts(styleMatch) {
  resultsOwner = 'local';
  document.getElementById('companion-actions')?.classList.add('hidden');
  const sm = styleMatch && typeof styleMatch === 'object' ? styleMatch : makeEmptyStyleMatch();
  const itemGroups = [
    { key: 'retail', label: 'Retail — demo source' },
    { key: 'resale', label: 'Resale — demo source' },
    { key: 'suggested', label: 'Suggested Sources' },
  ];
  els.resultsList.innerHTML = '';
  renderStyleMatch(sm);

  const hasAnyItems = itemGroups.some((g) => Array.isArray(sm.items?.[g.key]) && sm.items[g.key].length > 0);

  if (!hasAnyItems) {
    els.resultsEmpty.classList.remove('hidden');
    if (els.resultsMatch) els.resultsMatch.classList.add('hidden');
    registerFocusMatrix('results', [
      [document.getElementById('results-back-btn')],
      [document.getElementById('retry-empty-btn')],
    ]);
    return;
  }

  els.resultsEmpty.classList.add('hidden');
  if (els.resultsMatch) els.resultsMatch.classList.remove('hidden');

  itemGroups.forEach((group) => {
    const items = Array.isArray(sm.items?.[group.key]) ? sm.items[group.key] : [];
    if (!items.length) return;

    const groupHeader = document.createElement('div');
    groupHeader.className = 'source-group';
    const sourceHeader = document.createElement('div');
    sourceHeader.className = 'source-header';
    const dot = document.createElement('span');
    dot.className = `source-dot ${group.key}`;
    sourceHeader.appendChild(dot);
    sourceHeader.appendChild(document.createTextNode(group.label));
    groupHeader.appendChild(sourceHeader);
    els.resultsList.appendChild(groupHeader);

    items.forEach((item) => {
      const card = createStyleMatchItemCard(item);
      els.resultsList.appendChild(card);
    });
  });

  registerFocusMatrix('results', [
    [document.getElementById('results-back-btn')],
    ...Array.from(els.resultsList.querySelectorAll('.product-card')).map((el) => [el]),
  ]);
}

function showError(message) {
  setState(STATE.ERROR);
  clearPipeline(); // pipeline halted — no stale active step
  els.errorMessage.textContent = safeText(message, 'Something went wrong.');
  showScreen('error');
}

function normalizeScanError(error) {
  if (error instanceof SanitizerError) {
    return mapSanitizerErrorToUserMessage(error);
  }

  if (error instanceof PipelineInvariantError) {
    return "We couldn't verify this image is safe to upload. Please try again.";
  }

  if (error instanceof AnalyzeError) {
    if (error.code === ANALYZE_ERROR_CODES.LIVE_DISABLED) return 'Live analysis disabled — private QA config required.';
    if (error.code === ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED) return 'Unable to connect. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.TIMEOUT) return 'Unable to connect. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.NETWORK) return 'Unable to connect. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.NON_2XX) return 'Something went wrong. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_JSON) return 'Something went wrong. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_SHAPE) return 'Something went wrong. Try again.';
    return 'Something went wrong. Try again.';
  }

  if (error?.code) lastSafeErrorCode = String(error.code).slice(0, 40);

  // Bridge scaffold errors (Phase 29) — not DATBridgeError instances
  if (error?.code === 'BRIDGE_TIMEOUT') return 'Unable to capture. Try again.';
  if (error?.code === 'CAPTURE_INVALID') return "Couldn't read image. Try again.";
  if (error?.code === 'BRIDGE_ERROR') return 'Capture failed. Try again.';
  if (error?.code === 'BRIDGE_CANCELLED') return 'Scan cancelled.';
  if (error?.code === 'BRIDGE_SUPERSEDED') return 'Scan replaced. Try again.';
  if (error?.code === 'STALE_CAPTURE') return 'Capture expired. Try again.';
  if (error?.code === 'PRIVACY_FAILED') return 'Privacy scan failed. Try again.';
  if (error?.code === 'ANALYZE_FAILED') return 'Analysis failed. Try again.';

  if (!(error instanceof DATBridgeError)) {
    return safeText(error?.message, 'Scan failed. Please try again.');
  }

  lastDatErrorCode = error.code || DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE;
  updateHud();
  return toUserFriendlyCaptureError(error);
}

// ─── Hardware candidate build detection ──────────────────────────────
function isHardwareCandidateBuild() {
  return typeof __KSCAN_HARDWARE_CANDIDATE_BUILD__ !== 'undefined'
    && __KSCAN_HARDWARE_CANDIDATE_BUILD__ === true;
}

// ─── Hardware test mode (Phase 30) ───────────────────────────────────
// Canonical activation: ?mode=hardware on the app URL.
// Advanced runtime activation: window.__KSCAN_CONFIG__.HARDWARE_TEST_MODE = true.
// Hardware test mode implies USE_REAL_BRIDGE = true so the Scan button uses
// bridgeState.requestCapture(). It is a TEST mode: Alpha / hardware-pending
// labels stay on, mock/live labeling is unchanged, privacy pipeline is
// unchanged, and no secrets are exposed. Default behavior without the flag
// remains safe simulator/mock.
function isHardwareTestMode() {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'hardware') return true;
  } catch {
    // location unavailable — fall through to runtime config
  }
  const runtime = window.__KSCAN_CONFIG__;
  return Boolean(runtime && typeof runtime === 'object' && runtime.HARDWARE_TEST_MODE === true);
}

function shouldUseBridgeCapture() {
  if (isHardwareTestMode()) return true; // hardware test mode implies real bridge
  if (typeof window !== 'undefined') {
    const runtime = window.__KSCAN_CONFIG__;
    if (runtime && typeof runtime === 'object') {
      if (runtime.USE_REAL_BRIDGE === true) return true;
      if (runtime.VITE_USE_REAL_BRIDGE === 'true') return true;
    }
  }
  try {
    if (import.meta.env.VITE_USE_REAL_BRIDGE === 'true') return true;
  } catch {
    // env unavailable
  }
  return false;
}

async function handleBridgeImage(imageData, metadata, token) {
  if (typeof imageData !== 'string' || !imageData.trim().startsWith('data:image/')) {
    const err = new Error('Invalid image payload');
    err.code = 'CAPTURE_INVALID';
    throw err;
  }

  if (token !== scanToken) {
    const err = new Error('Scan cancelled.');
    err.code = 'SCAN_CANCELLED';
    throw err;
  }

  setState(STATE.SANITIZING);
  renderPipeline('image', 1);

  const sanitized = await sanitizeImageBeforeUpload(imageData);
  if (token !== scanToken) {
    const err = new Error('Scan cancelled.');
    err.code = 'SCAN_CANCELLED';
    throw err;
  }

  setState(STATE.ANALYZING);
  renderPipeline('image', 2);

  const response = await analyzeImage(sanitized, {
    onSlow: () => {
      if (els.processingSub) els.processingSub.textContent = 'Still working...';
    },
  });

  return response;
}

async function runBridgeScanPipeline(token) {
  setState(STATE.CAPTURING);
  renderPipeline('image', 0);

  const { image, metadata } = await requestCapture();
  if (token !== scanToken) {
    const err = new Error('Scan cancelled.');
    err.code = 'SCAN_CANCELLED';
    throw err;
  }

  return await handleBridgeImage(image, metadata, token);
}

export async function startScan() {
  if (scanInFlight) return; // prevent duplicate scan triggers while processing
  scanInFlight = true;
  errorOwner = 'local';
  const token = ++scanToken;
  pipelineMode = 'image';
  try {
    setState(STATE.IDLE);
    lastDatErrorCode = 'none';
    showScreen('processing');

    let response;
    lastScanStartAt = performance.now();
    if (shouldUseBridgeCapture()) {
      response = await runBridgeScanPipeline(token);
    } else {
      const { response: pipelineResponse } = await runScanPipeline({
        capture: () => capturePhoto(),
        sanitize: (captured) => sanitizeImageBeforeUpload(captured),
        analyze: (sanitized) => analyzeImage(sanitized, {
          onSlow: () => {
            if (els.processingSub) els.processingSub.textContent = 'Still working...';
          },
        }),
        isCancelled: () => token !== scanToken,
        onStage: (stage) => {
          if (token !== scanToken) return; // cancelled — ignore stale stage updates
          if (stage === PIPELINE_STAGES.CAPTURING) setState(STATE.CAPTURING);
          if (stage === PIPELINE_STAGES.SANITIZING) setState(STATE.SANITIZING);
          if (stage === PIPELINE_STAGES.ANALYZING) setState(STATE.ANALYZING);
        },
      });
      response = pipelineResponse;
    }

    if (token !== scanToken) return; // cancelled mid-flight — discard stale result

    lastScanDurationMs = Math.round(performance.now() - lastScanStartAt);
    successfulScanCount += 1;

    // Guest scan history: small metadata only — never images or payloads.
    const products = Array.isArray(response?.products) ? response.products : [];
    recordGuestScan({
      productCount: products.length,
      topBrand: products[0]?.brand || '',
      topName: products[0]?.name || '',
    });

    // Build canonical StyleMatch contract from raw response.
    // Future integrations (TextScan, backend analyze, StyleChat, mobile handoff)
    // should replace this adapter call with their own adapter that still returns
    // a canonical StyleMatch. The UI consumes ONLY the canonical shape.
    const styleMatch = buildMockStyleMatch(response);

    // Reset textscan results container before showing image scan results
    if (els.textscanResults) els.textscanResults.classList.add('hidden');
    if (els.textscanResults) els.textscanResults.innerHTML = '';
    if (els.resultsMatch) els.resultsMatch.classList.remove('hidden');
    if (els.resultsList) els.resultsList.classList.remove('hidden');

    renderProducts(styleMatch);
    renderPipelineDone(pipelineMode); // terminal state — stepper never stuck
    setState(STATE.SUCCESS);
    showScreen('results');
    focusFirstInView('results');
  } catch (error) {
    if (token !== scanToken) return; // cancelled — suppress stale error
    if (error?.code === 'SCAN_CANCELLED' || error?.code === 'BRIDGE_CANCELLED') return;
    showError(normalizeScanError(error));
  } finally {
    if (token === scanToken) scanInFlight = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TextScan flow
// ═══════════════════════════════════════════════════════════════════

let textScanInFlight = false;
let textScanToken = 0;

function isTextScanMockEnabled() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('textscanMode');
  if (params.get('sim') === '1' && mode === 'live') return false;
  if (params.get('sim') === '1' && mode === 'mock') return true;
  return import.meta.env.DEV && import.meta.env.VITE_MOCK_TEXTSCAN === 'true';
}

function emitTextScanStatus(payload) {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) return;
  try {
    window.parent.postMessage({
      type: 'kscan:textscan-live-status',
      ...payload,
    }, window.location.origin);
  } catch {
    // Simulator status events are best effort and metadata-only.
  }
}

function renderTextScanResult(styleMatch) {
  const panel = els.textscanResults;
  if (!panel) return;
  panel.innerHTML = '';

  const sm = styleMatch && typeof styleMatch === 'object' ? styleMatch : {};
  const hasError = sm.error && typeof sm.error === 'object';
  const sourceLabel = safeText(sm.meta?.sourceLabel, 'SOURCE PRESET');
  const modeLabel = sm.meta?.isDemo ? 'TEXTSCAN MOCK' : 'TEXTSCAN LIVE';
  const supabaseLabel = hasSupabaseConfig() ? 'SUPABASE READY' : 'SUPABASE MISSING';
  const linkedLabel = getSupabaseRuntimeStatus().linked ? 'ACCOUNT LINKED' : 'SIGN IN REQUIRED';

  const card = document.createElement('div');
  card.className = 'textscan-result-card';

  // Header
  const header = document.createElement('div');
  header.className = 'textscan-result-header';
  header.appendChild(createText('span', 'textscan-result-title', 'Text Scan Result'));
  if (sm.meta?.confidenceLabel) {
    header.appendChild(createText('span', 'confidence-badge', sm.meta.confidenceLabel));
  }
  card.appendChild(header);

  const badgeStrip = document.createElement('div');
  badgeStrip.className = 'textscan-status-strip';
  badgeStrip.appendChild(createText('span', 'scan-mode-pill', modeLabel));
  badgeStrip.appendChild(createText('span', hasSupabaseConfig() ? 'scan-mode-pill' : 'scan-mode-pill warn', supabaseLabel));
  badgeStrip.appendChild(createText('span', getSupabaseRuntimeStatus().linked ? 'scan-mode-pill' : 'scan-mode-pill warn', linkedLabel));
  badgeStrip.appendChild(createText('span', 'scan-mode-pill', sourceLabel));
  card.appendChild(badgeStrip);

  // Summary
  if (sm.summary) {
    card.appendChild(createText('div', 'textscan-result-summary', sm.summary));
  }

  // Passive spoken summary — display-only data from the adapter (already
  // length-clamped and base64-redacted there). No audio is ever played.
  if (!hasError && sm.spokenSummary && sm.spokenSummary !== sm.summary) {
    card.appendChild(createText('p', 'textscan-spoken', `Spoken (passive): ${sm.spokenSummary}`));
  }

  // Error
  if (hasError) {
    card.appendChild(createText('div', 'textscan-error', sm.error.message));
  }

  // Intent pills
  const intentGrid = document.createElement('div');
  intentGrid.className = 'textscan-intent-grid';

  const intent = sm.intent || {};
  const addPill = (label, value) => {
    if (Array.isArray(value) && value.length === 0) return;
    if (value === null || value === undefined || value === '') return;
    const display = Array.isArray(value) ? value.join(', ') : String(value);
    const pill = createText('span', 'textscan-intent-pill', `${label}: ${display}`);
    intentGrid.appendChild(pill);
  };

  addPill('Style', intent.style);
  addPill('Occasion', intent.occasion);
  if (Array.isArray(intent.colors) && intent.colors.length > 0) {
    intent.colors.forEach((c) => addPill('Color', c));
  }
  if (Array.isArray(intent.materials) && intent.materials.length > 0) {
    intent.materials.forEach((m) => addPill('Material', m));
  }
  addPill('Silhouette', intent.silhouette);
  if (Array.isArray(intent.keywords) && intent.keywords.length > 0) {
    intent.keywords.slice(0, 5).forEach((k) => addPill('Tag', k));
  }

  if (intentGrid.children.length === 0) {
    intentGrid.appendChild(createText('span', 'textscan-intent-pill empty', 'No details available'));
  }
  card.appendChild(intentGrid);

  // Retry button for errors
  if (hasError && sm.error.canRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-primary focusable textscan-retry-btn';
    retryBtn.textContent = 'Try Again';
    retryBtn.addEventListener('click', () => {
      const lastQuery = panel.dataset.lastQuery;
      if (lastQuery) startTextScan(lastQuery);
    });
    card.appendChild(retryBtn);
  }

  panel.appendChild(card);
}

export async function startTextScan(query) {
  if (textScanInFlight) return;
  textScanInFlight = true;
  errorOwner = 'local';
  const token = ++textScanToken;
  const source = 'preset';
  pipelineMode = 'text';

  if (els.textscanResults) els.textscanResults.dataset.lastQuery = query;

  const isMock = isTextScanMockEnabled();

  try {
    setState(STATE.ANALYZING);
    showScreen('processing');
    els.processingText.textContent = 'Analyzing text...';
    if (els.processingSub) els.processingSub.textContent = 'Fashion AI is working';
    emitTextScanStatus({
      mode: isMock ? 'mock' : 'live',
      source,
      status: isMock ? 'configured' : (hasSupabaseConfig() ? 'configured' : 'missing-config'),
    });

    const styleMatch = await analyzeTextQuery(query, { source, mock: isMock });
    if (styleMatch.meta) styleMatch.meta.sourceLabel = 'SOURCE PRESET';

    if (token !== textScanToken) return;

    recordGuestScan({
      productCount: 0,
      topBrand: styleMatch.intent?.style || '',
      topName: styleMatch.summary?.slice(0, 40) || '',
    });

    renderTextScanResult(styleMatch);

    if (els.resultsMatch) els.resultsMatch.classList.add('hidden');
    if (els.resultsList) els.resultsList.classList.add('hidden');
    if (els.resultsEmpty) els.resultsEmpty.classList.add('hidden');
    if (els.textscanResults) els.textscanResults.classList.remove('hidden');

    renderPipelineDone('text'); // terminal state — stepper never stuck
    setState(STATE.SUCCESS);
    showScreen('results');
    focusFirstInView('results');
    emitTextScanStatus({
      mode: isMock ? 'mock' : 'live',
      source,
      status: styleMatch.error ? 'failed' : 'completed',
    });
  } catch (error) {
    if (token !== textScanToken) return;

    const errorCode = error.code || TEXTSCAN_ERROR_CODES.UNKNOWN;
    lastSafeErrorCode = String(errorCode).slice(0, 40);
    const userMessage = error.userMessage || 'Something went wrong.';
    const errorMatch = textScanErrorToStyleMatch(error, query, isMock);
    if (errorMatch.meta) errorMatch.meta.sourceLabel = 'SOURCE PRESET';

    renderTextScanResult(errorMatch);

    if (els.resultsMatch) els.resultsMatch.classList.add('hidden');
    if (els.resultsList) els.resultsList.classList.add('hidden');
    if (els.resultsEmpty) els.resultsEmpty.classList.add('hidden');
    if (els.textscanResults) els.textscanResults.classList.remove('hidden');

    renderPipelineDone('text'); // error contract rendered as result — stepper done
    setState(STATE.SUCCESS);
    showScreen('results');
    focusFirstInView('results');
    emitTextScanStatus({
      mode: isMock ? 'mock' : 'live',
      source,
      status: errorCode === TEXTSCAN_ERROR_CODES.AUTH_REQUIRED
        ? 'auth-required'
        : errorCode === TEXTSCAN_ERROR_CODES.CONFIG_REQUIRED
          ? 'missing-config'
          : 'failed',
    });
  } finally {
    if (token === textScanToken) textScanInFlight = false;
  }
}

function onBack() {
  if (currentView === 'home') return;
  if (currentView === 'processing') {
    if (companionScanOnProcessing && companionRuntime) {
      companionRuntime.cancel(); // machine settles and re-renders a stable screen
      return;
    }
    scanToken += 1; // invalidate in-flight scan
    scanInFlight = false;
    textScanToken += 1; // invalidate any in-flight text scan
    textScanInFlight = false;
    cancelBridgeCapture(); // settle any pending bridge request (BRIDGE_CANCELLED)
    setState(STATE.IDLE);
    clearPipeline(); // abandoned pipeline — no stale active step
  }
  // Companion-owned screens delegate Back to the runtime state machine
  // first (dismiss result, cancel pairing, leave reconnect, etc.). The
  // machine declines with 'navigation-home' when Home is the real target —
  // the companion screen is a mode root, so go straight Home rather than
  // walking history back into the same screen.
  if (companionRuntime && currentView === 'companion') {
    const res = companionRuntime.back();
    if (res && res.accepted) return;
    showScreen('home', false);
    return;
  }
  if (companionRuntime && currentView === 'results' && resultsOwner === 'companion'
    && companionRuntime.getSnapshot().state === RUNTIME_STATE.RESULTS) {
    companionRuntime.back(); // RESULTS back = dismiss → machine moves to Ready
    return;
  }
  const previous = screenHistory.pop() || 'home';
  showScreen(previous, false);
}

// ─── Phone companion runtime (connected-glasses Phase A) ─────────────
// Active only with ?companion=1. The HUD renders whatever the canonical
// runtime state machine dictates — this layer never keeps its own scan
// state. Mock phone is the only peer available in this build, and every
// surface stays labelled LOCAL QA / HW VALIDATION PENDING.

// Machine states rendered on the dedicated companion screen. Scan progress
// reuses the processing screen; Results/Error use their own screens.
const COMPANION_SCREEN_STATES = new Set([
  RUNTIME_STATE.DISCONNECTED, RUNTIME_STATE.PAIRING, RUNTIME_STATE.PAIRING_DENIED,
  RUNTIME_STATE.PAIRING_EXPIRED, RUNTIME_STATE.CONNECTED, RUNTIME_STATE.READY,
  RUNTIME_STATE.RECONNECTING, RUNTIME_STATE.SESSION_REVOKED,
  RUNTIME_STATE.ACTION_PENDING, RUNTIME_STATE.ACTION_CONFIRMED,
]);

// Scan-progress states → processing-screen step index (companion pipeline).
const COMPANION_STEP_INDEX = {
  [RUNTIME_STATE.CAPTURE_REQUESTED]: 0,
  [RUNTIME_STATE.CAPTURING_ON_PHONE]: 1,
  [RUNTIME_STATE.PRIVACY_PROCESSING]: 2,
  [RUNTIME_STATE.ANALYZING]: 3,
};

const COMPANION_PILL = {
  [RUNTIME_STATE.DISCONNECTED]: ['off', 'Phone: Off'],
  [RUNTIME_STATE.PAIRING]: ['mock', 'Phone: Pairing'],
  [RUNTIME_STATE.PAIRING_DENIED]: ['mock', 'Phone: Denied'],
  [RUNTIME_STATE.PAIRING_EXPIRED]: ['mock', 'Phone: Expired'],
  [RUNTIME_STATE.CONNECTED]: ['ok', 'Phone: Connected'],
  [RUNTIME_STATE.READY]: ['ok', 'Phone: Ready'],
  [RUNTIME_STATE.CAPTURE_REQUESTED]: ['ok', 'Phone: Scanning'],
  [RUNTIME_STATE.CAPTURING_ON_PHONE]: ['ok', 'Phone: Scanning'],
  [RUNTIME_STATE.PRIVACY_PROCESSING]: ['ok', 'Phone: Scanning'],
  [RUNTIME_STATE.ANALYZING]: ['ok', 'Phone: Scanning'],
  [RUNTIME_STATE.RESULTS]: ['ok', 'Phone: Ready'],
  [RUNTIME_STATE.ACTION_PENDING]: ['ok', 'Phone: Working'],
  [RUNTIME_STATE.ACTION_CONFIRMED]: ['ok', 'Phone: Ready'],
  [RUNTIME_STATE.ERROR]: ['mock', 'Phone: Error'],
  [RUNTIME_STATE.RECONNECTING]: ['mock', 'Phone: Reconnecting'],
  [RUNTIME_STATE.SESSION_REVOKED]: ['off', 'Phone: Ended'],
};

// Safe user-facing text for machine error codes — never raw payloads.
const COMPANION_ERROR_TEXT = {
  CAPTURE_TIMEOUT: 'The phone did not respond in time. Try again.',
  SCAN_TIMEOUT: 'The scan took too long. Try again.',
  ACTION_TIMEOUT: 'The phone did not confirm that action.',
  CAPTURE_FAILED: 'The phone could not capture. Try again.',
  SCAN_FAILED: 'The phone could not finish the scan. Try again.',
  ACTION_FAILED: 'The phone could not complete that action.',
  SESSION_EXPIRED: 'Session ended. Pair again to continue.',
};

function updateCompanionPill(state) {
  const [dot, text] = COMPANION_PILL[state] || ['off', 'Phone: Off'];
  setPill('pill-companion', dot, text);
}

function companionIntent(intent) {
  if (!companionRuntime) return;
  if (intent === 'back') {
    const res = companionRuntime.back();
    if (!res || !res.accepted) showScreen('home', false);
    return;
  }
  const fn = {
    pair: 'pair', scan: 'scan', cancel: 'cancel', retry: 'retry',
    dismiss: 'dismiss', save: 'save', open_on_phone: 'openOnPhone', unpair: 'unpair',
  }[intent];
  if (fn) companionRuntime[fn]();
}

function setCompanionButton(btn, action) {
  if (!btn) return;
  if (!action) {
    btn.classList.add('hidden');
    btn.onclick = null;
    return;
  }
  btn.textContent = action.label;
  btn.onclick = () => companionIntent(action.intent);
  btn.classList.remove('hidden');
}

function renderCompanionPairingSteps(state) {
  const steps = document.getElementById('comp-steps');
  if (!steps) return;
  steps.innerHTML = '';
  const activeIndex = state === RUNTIME_STATE.PAIRING ? 1
    : state === RUNTIME_STATE.CONNECTED ? 2 : -1;
  if (activeIndex < 0) return;
  ['Request', 'Approve on phone', 'Ready'].forEach((label, i) => {
    const li = document.createElement('li');
    li.className = i < activeIndex ? 'pipeline-step done' : i === activeIndex ? 'pipeline-step active' : 'pipeline-step';
    li.textContent = label;
    steps.appendChild(li);
  });
}

function renderCompanionScreen(snapshot, meta) {
  if (!meta) return;
  const state = snapshot.state;
  const transportDown = companionRuntime
    && companionRuntime.getDiagnostics().transport === TRANSPORT_STATE.UNAVAILABLE;

  document.getElementById('comp-title').textContent = meta.title;
  const support = document.getElementById('comp-support');
  if (support) {
    support.textContent = transportDown
      ? 'Phone companion is unavailable in this build.'
      : (meta.support || '');
  }
  document.getElementById('comp-spinner')?.classList.toggle('hidden', meta.progress !== 'indeterminate');
  document.getElementById('comp-mode-label')?.classList.toggle('hidden', !COMPANION_MODE);
  renderCompanionPairingSteps(state);

  const primary = document.getElementById('comp-primary-btn');
  const secondary = [1, 2, 3].map((i) => document.getElementById(`comp-secondary-${i}`));
  setCompanionButton(primary, meta.primary);
  const secondaryActions = Array.isArray(meta.secondary) ? meta.secondary.slice(0, 3) : [];
  secondary.forEach((btn, i) => setCompanionButton(btn, secondaryActions[i] || null));

  const visible = [primary, ...secondary].filter((b) => b && !b.classList.contains('hidden'));
  registerFocusMatrix('companion', visible.map((b) => [b]));

  if (currentView !== 'companion') {
    // Never make a dismissed result re-reachable via Back from this screen.
    showScreen('companion', currentView !== 'results');
  }
  if (!visible.includes(document.activeElement)) {
    const target = meta.focusTarget === 'primary' && visible.includes(primary)
      ? primary
      : visible[0];
    target?.focus();
  }
}

function onCompanionStateChange(snapshot, { meta }) {
  const state = snapshot.state;
  updateCompanionPill(state);
  if (currentView === 'diagnostics') renderDiagnostics();

  if (COMPANION_STEP_INDEX[state] !== undefined) {
    if (currentView !== 'processing') {
      // A new scan invalidates prior results as a Back destination.
      for (let i = screenHistory.length - 1; i >= 0; i -= 1) {
        if (screenHistory[i] === 'results') screenHistory.splice(i, 1);
      }
    }
    companionScanOnProcessing = true;
    pipelineMode = 'companion';
    els.processingText.textContent = meta.title;
    if (els.processingSub) els.processingSub.textContent = meta.support || '';
    renderPipeline('companion', COMPANION_STEP_INDEX[state]);
    if (currentView !== 'processing') showScreen('processing');
    return;
  }
  // Left the scan-progress states: clear the stepper so no stale active
  // step survives on the now-hidden processing screen.
  if (companionScanOnProcessing) clearPipeline();
  companionScanOnProcessing = false;

  if (state === RUNTIME_STATE.RECONNECTING) {
    reconnectCount += 1;
  }

  if (state === RUNTIME_STATE.ERROR) {
    errorOwner = 'companion';
    const code = snapshot.lastError && typeof snapshot.lastError === 'object'
      ? snapshot.lastError.code
      : snapshot.lastError;
    showError(COMPANION_ERROR_TEXT[code] || 'Something went wrong. Try again.');
    return;
  }
  if (state === RUNTIME_STATE.RESULTS) {
    // Fresh result.show paints via onCompanionResult. Returning from
    // ActionPending/ActionConfirmed also re-emits detail.result → onResult.
    // If we somehow land here without that paint, restore the results screen.
    if (snapshot.hasResult && currentView !== 'results') {
      showScreen('results');
    }
    return;
  }
  if (COMPANION_SCREEN_STATES.has(state)) {
    renderCompanionScreen(snapshot, meta);
  }
}

// Structured result handoff: the machine only emits this after protocol,
// session, and result-contract validation, correlated to the active request.
function onCompanionResult(styleMatch) {
  resultsOwner = 'companion';
  renderPipelineDone('companion');
  renderStyleMatch(styleMatch);
  renderCompanionResultItems(styleMatch);
  showScreen('results');
}

function renderCompanionResultItems(styleMatch) {
  resultsOwner = 'companion';
  els.resultsEmpty.classList.add('hidden');
  if (els.resultsMatch) els.resultsMatch.classList.remove('hidden');
  els.resultsList.innerHTML = '';

  const groups = [
    ['retail', styleMatch.meta?.isDemo ? 'Retail — mock phone source' : 'Retail — K Scan Live'],
    ['resale', styleMatch.meta?.isDemo ? 'Resale — mock phone source' : 'Resale — K Scan Live'],
    ['suggested', 'Suggested Sources'],
  ];
  groups.forEach(([key, label]) => {
    const items = Array.isArray(styleMatch.items?.[key]) ? styleMatch.items[key] : [];
    if (!items.length) return;
    const groupHeader = document.createElement('div');
    groupHeader.className = 'source-group';
    const sourceHeader = document.createElement('div');
    sourceHeader.className = 'source-header';
    const dot = document.createElement('span');
    dot.className = `source-dot ${key}`;
    sourceHeader.appendChild(dot);
    sourceHeader.appendChild(document.createTextNode(label));
    groupHeader.appendChild(sourceHeader);
    els.resultsList.appendChild(groupHeader);

    items.forEach((item) => {
      els.resultsList.appendChild(createCompanionItemRow(item));
    });
  });

  // Action bar visibility follows the session capability intersection
  // computed by the result contract (never show an action we cannot send).
  const bar = document.getElementById('companion-actions');
  bar?.classList.remove('hidden');
  document.getElementById('comp-action-save')?.classList.toggle('hidden', !styleMatch.actions?.canSave);
  document.getElementById('comp-action-open')?.classList.toggle('hidden', !styleMatch.actions?.canOpenOnPhone);

  const matrix = [[document.getElementById('results-back-btn')]];
  ['comp-action-save', 'comp-action-open', 'comp-action-retry', 'comp-action-dismiss']
    .map((id) => document.getElementById(id))
    .filter((b) => b && !b.classList.contains('hidden'))
    .forEach((b) => matrix.push([b]));
  Array.from(els.resultsList.querySelectorAll('.companion-item')).forEach((el) => matrix.push([el]));
  registerFocusMatrix('results', matrix);
}

// Alternative-result navigation: rows are real controls — selecting one
// swaps the summary card to that item. No dead focus targets.
function createCompanionItemRow(item) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row product-card focusable companion-item';
  row.setAttribute('aria-pressed', 'false');

  const body = document.createElement('span');
  body.className = 'product-meta';
  body.appendChild(createText('span', 'product-name', safeText(item.title, 'Unnamed Product')));
  const detail = [item.subtitle, item.priceLabel].filter(Boolean).join(' · ');
  body.appendChild(createText('span', 'product-price', detail || 'Price unavailable'));
  row.appendChild(body);

  row.addEventListener('click', () => {
    Array.from(els.resultsList.querySelectorAll('.companion-item')).forEach((el) => {
      el.classList.remove('selected');
      el.setAttribute('aria-pressed', 'false');
    });
    row.classList.add('selected');
    row.setAttribute('aria-pressed', 'true');
    const summary = els.resultsMatch?.querySelector('.detected-style');
    if (summary) summary.textContent = safeText(item.title, 'Style Match');
  });
  return row;
}

function initCompanionRuntime() {
  const transport = resolveCompanionTransport({
    peerWindow: window.parent !== window ? window.parent : null,
    selfOrigin: window.location.origin,
    targetOrigin: window.location.origin,
  });
  companionRuntime = createCompanionRuntime({
    transport,
    onStateChange: onCompanionStateChange,
    onResult: onCompanionResult,
  });
  companionRuntime.start();
  updateCompanionPill(companionRuntime.getSnapshot().state);
  // Safe metadata surface (matches __kscanBridgeDebug pattern): dev server
  // and the LOCAL QA simulator build only — never in the production bundle.
  const isSimulatorBuild = typeof __KSCAN_SIMULATOR_BUILD__ !== 'undefined'
    && __KSCAN_SIMULATOR_BUILD__ === true;
  if (import.meta.env.DEV || isSimulatorBuild) {
    window.__kscanCompanionDebug = () => companionRuntime.getDiagnostics();
  }
}

// Home Scan button in companion mode: scan only from Ready; otherwise the
// companion screen is the truthful next step (pair / reconnect / recover).
function onCompanionScanIntent() {
  if (!companionRuntime) return;
  if (companionRuntime.getSnapshot().state === RUNTIME_STATE.READY) {
    companionRuntime.scan();
    return;
  }
  renderCompanionScreen(companionRuntime.getSnapshot(), companionRuntime.getStateMeta());
}


// ─── Library screen ──────────────────────────────────────────────────

function formatScanRow(scan, isExample) {
  const date = typeof scan.capturedAt === 'string' ? scan.capturedAt.slice(0, 10) : '';
  const count = Number.isFinite(scan.productCount) ? scan.productCount : 0;
  const top = scan.topBrand ? ` · ${scan.topBrand}` : '';
  return count > 0
    ? `${date} · ${count} match${count === 1 ? '' : 'es'}${top}`
    : `${date} · No matches`;
}

function appendStubBanner(panel) {
  if (!isStubMode()) return;
  const banner = document.createElement('p');
  banner.className = 'stub-banner';
  banner.textContent = 'Demo mode — guest session';
  panel.appendChild(banner);
}

function renderLibrary() {
  const panel = document.getElementById('library-panel');
  if (!panel) return;
  panel.innerHTML = '';

  appendStubBanner(panel);

  const guest = loadGuestLibrary();
  const examples = isStubMode() ? getStubLibraryExamples() : { scans: [], savedItems: [] };

  const rows = [];

  panel.appendChild(createText('h2', null, 'Saved Looks'));
  const savedItems = [
    ...guest.savedItems.map((item) => ({ item, isExample: false })),
    ...examples.savedItems.map((item) => ({ item, isExample: true })),
  ];
  if (!savedItems.length) {
    panel.appendChild(createText('p', 'empty-note', 'No saved items yet.'));
  }
  savedItems.forEach(({ item }) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row focusable';
    row.textContent = `${item.brand} — ${item.name} (${item.price})`;
    panel.appendChild(row);
    rows.push(row);
  });

  if (savedItems.length > 0) {
    panel.appendChild(createText('div', 'section-divider', ''));
  }

  panel.appendChild(createText('h2', null, 'Scan History'));
  const scans = [
    ...guest.scans.map((scan) => ({ scan, isExample: false })),
    ...examples.scans.map((scan) => ({ scan, isExample: true })),
  ];
  if (!scans.length) {
    panel.appendChild(createText('p', 'empty-note', 'No scans yet'));
  }
  scans.forEach(({ scan }) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row focusable';
    row.textContent = formatScanRow(scan);
    panel.appendChild(row);
    rows.push(row);
  });

  registerFocusMatrix('library', [
    [document.getElementById('library-back-btn')],
    ...rows.map((el) => [el]),
  ]);
}

// ─── Settings screen ─────────────────────────────────────────────────

// Status rows with badge-style indicators. Shows hostname at most — never
// full URLs, query params, keys, tokens, or raw env values.
function renderSettingsStatus(panel) {
  let status = panel.querySelector('#settings-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'settings-status';
    panel.appendChild(status);
  }
  status.innerHTML = '';

  const sim = getSimulatorState();
  const session = getSession();
  const params = new URLSearchParams(window.location.search);
  const scenario = sim.allowed ? params.get('mockAnalyze') : null;
  const mockAnalyze = import.meta.env.DEV && import.meta.env.VITE_MOCK_ANALYZE === 'true';

  let backendBadge;
  if (scenario) {
    backendBadge = '<span class="status-badge warn">Mock</span>';
  } else if (mockAnalyze) {
    backendBadge = '<span class="status-badge warn">Mock</span>';
  } else {
    const raw = String(import.meta.env.VITE_KSCAN_BACKEND_URL || '').trim();
    if (!raw) {
      backendBadge = '<span class="status-badge off">Unavailable</span>';
    } else {
      try {
        const hostname = new URL(raw).hostname;
        backendBadge = `<span class="status-badge on">${hostname}</span>`;
      } catch {
        backendBadge = '<span class="status-badge on">Configured</span>';
      }
    }
  }

  const simBadge = sim.active ? '<span class="status-badge on">On</span>' : '<span class="status-badge off">Off</span>';
  const supabaseBadge = isStubMode() ? '<span class="status-badge off">Unconfigured</span>' : '<span class="status-badge on">Live</span>';
  const supabaseRuntime = getSupabaseRuntimeStatus();
  const textscanSupabaseBadge = supabaseRuntime.configured
    ? '<span class="status-badge on">Configured</span>'
    : '<span class="status-badge off">Missing</span>';
  const authBadge = supabaseRuntime.linked
    ? '<span class="status-badge on">Linked</span>'
    : (session ? '<span class="status-badge warn">Stub</span>' : '<span class="status-badge off">Required</span>');

  const voiceEnabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_VOICE_PLACEHOLDER === 'true';
  const voiceBadge = voiceEnabled
    ? '<span class="status-badge warn">future device test</span>'
    : '<span class="status-badge off">future device test</span>';

  const textscanMock = isTextScanMockEnabled();
  const textscanBadge = textscanMock
    ? '<span class="status-badge warn">Mock</span>'
    : (supabaseRuntime.configured && supabaseRuntime.linked
      ? '<span class="status-badge on">Live</span>'
      : '<span class="status-badge off">Live blocked</span>');

  const mobileBridgeEnabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_MOBILE_BRIDGE_PLACEHOLDER === 'true';
  const mobileBridgeBadge = mobileBridgeEnabled
    ? '<span class="status-badge warn">prepared</span>'
    : '<span class="status-badge off">not validated</span>';

  const connectivityEnabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_CONNECTIVITY_STATUS === 'true';
  const connectivityBadge = connectivityEnabled
    ? '<span class="status-badge warn">pending device test</span>'
    : '<span class="status-badge off">pending device test</span>';

  const makeRow = (label, badgeHtml) => {
    const row = document.createElement('div');
    row.className = 'status-row';
    row.innerHTML = `<span>${label}</span>${badgeHtml}`;
    return row;
  };

  status.appendChild(makeRow('Simulator', simBadge));
  status.appendChild(makeRow('Backend', backendBadge));
  status.appendChild(makeRow('Supabase', supabaseBadge));
  status.appendChild(makeRow('TextScan Supabase', textscanSupabaseBadge));
  status.appendChild(makeRow('Account', authBadge));
  status.appendChild(makeRow('Voice', voiceBadge));
  status.appendChild(makeRow('TextScan', textscanBadge));
  status.appendChild(makeRow('TextScan Source', '<span class="status-badge on">Preset</span>'));
  status.appendChild(makeRow('Mobile bridge', mobileBridgeBadge));
  status.appendChild(makeRow('Connectivity', connectivityBadge));
}

function renderSettings() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;

  const session = getSession();
  const accountRow = document.getElementById('settings-account-row');
  const authBtn = document.getElementById('settings-auth-btn');

  if (accountRow) {
    accountRow.textContent = session ? `Account: ${session.user.email}` : 'Account: Guest';
  }
  if (authBtn) {
    authBtn.textContent = session ? 'Sign Out' : 'Sign In';
    authBtn.classList.toggle('row-danger', Boolean(session));
  }

  renderSettingsStatus(panel);

  let banner = panel.querySelector('.stub-banner');
  if (isStubMode() && !banner) {
    banner = document.createElement('p');
    banner.className = 'stub-banner';
    banner.textContent = 'Demo mode — guest session';
    panel.prepend(banner);
  }

  registerFocusMatrix('settings', [
    [document.getElementById('settings-back-btn')],
    ...Array.from(panel.querySelectorAll('.row.focusable')).map((el) => [el]),
  ]);
}

function onAuthToggle() {
  const session = getSession();
  if (session) {
    // Invalidate in-flight work and clear bridge/HUD user-specific state so
    // a previous account cannot leave capture results or pending requests.
    scanToken += 1;
    textScanToken += 1;
    scanInFlight = false;
    textScanInFlight = false;
    cancelBridgeCapture();
    resetBridgeState();
    clearPipeline();
    if (els.resultsList) els.resultsList.innerHTML = '';
    if (els.textscanResults) {
      els.textscanResults.innerHTML = '';
      els.textscanResults.classList.add('hidden');
    }
    signOut();
    // Also clear any bridged Supabase session state: SDK session, bearer
    // overrides, and app-owned auth markers (session cleanup policy).
    signOutSupabaseSession().catch(() => {
      // Best effort — local markers are reset regardless.
    });
  } else {
    signInStub();
  }
  renderSettings();
  focusFirstInView('settings');
}

// ─── Runtime Diagnostics screen (Phase 30) ──────────────────────────
// Fast, safe feedback surface for live runtime / hardware testing.
// Shows short statuses ONLY — never tokens, JWTs, base64, image data,
// secret env values, or full URLs (backend shows hostname at most,
// matching the existing Settings policy).

function renderDiagnostics() {
  const status = document.getElementById('diagnostics-status');
  if (!status) return;
  status.innerHTML = '';

  const supabaseRuntime = getSupabaseRuntimeStatus();
  const bridgeSnap = lastBridgeSnapshot || getBridgeState();
  const hardware = isHardwareTestMode();
  const bridgeMode = shouldUseBridgeCapture();
  const textscanMock = isTextScanMockEnabled();
  const sim = getSimulatorState();

  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
  const viewportOk = vw === 600 && vh === 600;

  const backendConfigured = Boolean(String(import.meta.env.VITE_KSCAN_BACKEND_URL || '').trim());

  const badge = (cls, text) => `<span class="status-badge ${cls}">${text}</span>`;
  const makeRow = (label, badgeHtml) => {
    const row = document.createElement('div');
    row.className = 'status-row';
    row.innerHTML = `<span>${label}</span>${badgeHtml}`;
    return row;
  };

  status.appendChild(makeRow('Viewport', badge(viewportOk ? 'on' : 'warn', `${vw}×${vh}${viewportOk ? '' : ' (target 600×600)'}`)));
  status.appendChild(makeRow('Runtime mode', hardware
    ? badge('warn', 'Hardware test')
    : badge(sim.active ? 'warn' : 'off', sim.active ? 'Simulator' : 'Standard')));
  status.appendChild(makeRow('Bridge mode', badge(bridgeMode ? 'warn' : 'off', bridgeMode ? 'Bridge' : 'Mock')));
  status.appendChild(makeRow('Bridge status', badge(
    bridgeSnap.status === 'success' ? 'on' : bridgeSnap.status === 'error' || bridgeSnap.status === 'timeout' ? 'warn' : 'off',
    bridgeSnap.status,
  )));
  status.appendChild(makeRow('Session', badge(supabaseRuntime.linked ? 'on' : 'off', supabaseRuntime.linked ? 'Present' : 'Missing')));
  status.appendChild(makeRow('Supabase config', badge(supabaseRuntime.configured ? 'on' : 'off', supabaseRuntime.configured ? 'Present' : 'Missing')));
  status.appendChild(makeRow('Backend URL', badge(backendConfigured ? 'on' : 'off', backendConfigured ? 'Configured' : 'Missing')));
  status.appendChild(makeRow('Privacy sanitizer', badge('on', 'Ready (lazy-load)')));
  status.appendChild(makeRow('TextScan', badge(
    textscanMock ? 'warn' : supabaseRuntime.configured ? 'on' : 'off',
    textscanMock ? 'Mock' : supabaseRuntime.configured ? 'Live-ready' : 'Config required',
  )));
  const analyzeMode = getAnalyzeMode();
  status.appendChild(makeRow('Image Scan', badge(
    analyzeMode === 'private-live' ? 'warn' : analyzeMode === 'mock' ? 'on' : 'off',
    analyzeMode === 'private-live' ? 'Private QA live' : analyzeMode === 'mock' ? 'Mock' : 'LIVE DISABLED',
  )));
  status.appendChild(makeRow('Last error code', badge(lastSafeErrorCode === 'none' ? 'off' : 'warn', lastSafeErrorCode)));
  status.appendChild(makeRow('Bridge error', badge(bridgeSnap.lastError ? 'warn' : 'off', bridgeSnap.lastError || 'none')));

  // Hardware candidate diagnostics (Objective R)
  status.appendChild(makeRow('Build mode', badge(
    isHardwareCandidateBuild() ? 'warn' : (isHardwareTestMode() ? 'warn' : 'off'),
    isHardwareCandidateBuild() ? 'Hardware Candidate Build' : (isHardwareTestMode() ? 'HW Test Mode' : 'Standard'),
  )));
  status.appendChild(makeRow('Scan count', badge(successfulScanCount > 0 ? 'on' : 'off', String(successfulScanCount))));
  status.appendChild(makeRow('Last scan duration', badge(lastScanDurationMs > 0 ? 'on' : 'off', `${lastScanDurationMs}ms`)));
  status.appendChild(makeRow('Reconnect count', badge(reconnectCount > 0 ? 'warn' : 'off', String(reconnectCount))));
  status.appendChild(makeRow('Privacy sanitizer', badge('on', 'Ready (lazy-load)')));
  status.appendChild(makeRow('Trusted origin', badge(
    window.location.origin.includes('localhost') ? 'warn' : 'on',
    window.location.origin || 'unknown',
  )));

  if (companionRuntime) {
    const d = companionRuntime.getDiagnostics(); // metadata only by design
    status.appendChild(makeRow('Companion', badge(
      d.state === RUNTIME_STATE.READY || d.state === RUNTIME_STATE.RESULTS ? 'on'
        : d.state === RUNTIME_STATE.DISCONNECTED ? 'off' : 'warn',
      d.state,
    )));
    status.appendChild(makeRow('Companion transport', badge(d.transport === TRANSPORT_STATE.OPEN ? 'on' : 'off', d.transport)));
    status.appendChild(makeRow('Companion session', badge(d.sessionValid ? 'on' : 'off', d.sessionValid ? 'Valid' : 'None')));
    status.appendChild(makeRow('Companion traffic', badge(
      d.dropped > 0 || d.ignored > 0 || d.invalidResults > 0 ? 'warn' : 'off',
      `tx ${d.sent} · rx ${d.received} · dropped ${d.dropped} · ignored ${d.ignored ?? 0} · bad-result ${d.invalidResults}`,
    )));
  }

  registerFocusMatrix('diagnostics', [
    [document.getElementById('diagnostics-back-btn')],
    [document.getElementById('diagnostics-refresh-btn')],
  ]);
}

function wireButtons() {
  document.getElementById('scan-btn').addEventListener('click', () => {
    if (COMPANION_MODE && companionRuntime) {
      onCompanionScanIntent();
      return;
    }
    startScan();
  });
  document.getElementById('retry-empty-btn').addEventListener('click', startScan);
  document.getElementById('error-retry-btn').addEventListener('click', () => {
    // Prefer machine state over errorOwner flag — a prior local scan can
    // clear the flag while the companion machine is still in ERROR.
    if (companionRuntime && companionRuntime.getSnapshot().state === RUNTIME_STATE.ERROR) {
      errorOwner = 'local';
      const res = companionRuntime.retry();
      if (!res || res.accepted === false) companionRuntime.back(); // e.g. session gone
      return;
    }
    if (errorOwner === 'companion' && companionRuntime) {
      errorOwner = 'local';
      const res = companionRuntime.retry();
      if (!res || res.accepted === false) companionRuntime.back();
      return;
    }
    startScan();
  });

  document.getElementById('library-btn').addEventListener('click', () => showScreen('library'));
  document.getElementById('settings-btn').addEventListener('click', () => showScreen('settings'));

  // Wire TextScan preset buttons
  document.querySelectorAll('.textscan-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const query = btn.dataset.query;
      if (query) startTextScan(query);
    });
  });

  document.getElementById('library-back-btn').addEventListener('click', onBack);
  document.getElementById('settings-back-btn').addEventListener('click', onBack);
  document.getElementById('results-back-btn').addEventListener('click', onBack);
  document.getElementById('diagnostics-back-btn')?.addEventListener('click', onBack);
  document.getElementById('settings-diagnostics-btn')?.addEventListener('click', () => showScreen('diagnostics'));
  document.getElementById('diagnostics-refresh-btn')?.addEventListener('click', renderDiagnostics);
  document.getElementById('settings-auth-btn').addEventListener('click', onAuthToggle);
  document.getElementById('error-home-btn').addEventListener('click', () => {
    if (errorOwner === 'companion' && companionRuntime) {
      errorOwner = 'local';
      companionRuntime.back(); // settle machine to Ready/Disconnected
    }
    setState(STATE.IDLE);
    showScreen('home', false);
  });
  document.getElementById('cancel-btn').addEventListener('click', () => {
    if (companionScanOnProcessing && companionRuntime) {
      companionRuntime.cancel(); // sends action.cancel, settles pending work
      return;
    }
    scanToken += 1; // invalidate any in-flight scan
    scanInFlight = false;
    textScanToken += 1; // invalidate any in-flight text scan
    textScanInFlight = false;
    cancelBridgeCapture(); // settle any pending bridge request (BRIDGE_CANCELLED)
    setState(STATE.IDLE);
    clearPipeline(); // abandoned pipeline — no stale active step
    showScreen('home', false);
  });
  // Companion result action bar — intents go through the runtime so the
  // machine enforces state, capability, and ack correlation.
  document.getElementById('comp-action-save')?.addEventListener('click', () => companionRuntime?.save());
  document.getElementById('comp-action-open')?.addEventListener('click', () => companionRuntime?.openOnPhone());
  document.getElementById('comp-action-retry')?.addEventListener('click', () => companionRuntime?.retry());
  document.getElementById('comp-action-dismiss')?.addEventListener('click', () => companionRuntime?.dismiss());
}

function registerMatrices() {
  const textscanPresets = Array.from(document.querySelectorAll('.textscan-preset'));
  registerFocusMatrix('home', [
    [document.getElementById('scan-btn')],
    ...textscanPresets.map((el) => [el]),
    [document.getElementById('library-btn')],
    [document.getElementById('settings-btn')],
  ]);

  registerFocusMatrix('processing', [[document.getElementById('cancel-btn')]]);

  registerFocusMatrix('error', [
    [document.getElementById('error-retry-btn')],
    [document.getElementById('error-home-btn')],
  ]);
}

function initStatus() {
  if (import.meta.env.DEV && !els.hud) {
    const hud = document.createElement('aside');
    hud.id = 'dat-hud';
    hud.setAttribute('aria-hidden', 'true');
    hud.textContent = 'DAT: CHECKING | ANALYZE: CHECKING | BACKEND: CHECKING | FLOW: IDLE';
    document.getElementById('app')?.appendChild(hud);
    els.hud = hud;
  }
  updateHud();
}

function initMobileBridgeDebug() {
  // Dev-only, opt-in safe metadata surface. Exposed as a window function
  // (no production DOM) and only when DEV build AND mobile bridge mode is
  // explicitly enabled. Returns safe metadata only — never image/base64.
  if (!import.meta.env.DEV || !isMobileBridgeEnabled()) return;
  if (typeof window === 'undefined') return;
  window.__kscanBridgeDebug = () => getMobileBridgeStatus();
}

function init() {
  listenForSupabaseSessionMessages();
  window.addEventListener('kscan:supabase-session-linked', () => {
    updateHud();
    updateHomeStatusPills();
    if (currentView === 'settings') renderSettings();
  });
  initNavigation({ onBack });
  registerMatrices();
  wireButtons();
  initStatus();
  updateBridgeBadge();
  updateHomeStatusPills();
  // Bridge scaffold: simulator/runtime capture.* events drive the HUD badge
  // and home pill. Scaffold only — no real camera, metadata only.
  initBridgeStateListener();
  subscribeBridgeState((bridge) => {
    lastBridgeSnapshot = bridge; // metadata-only by bridgeState design
    updateBridgeBadge(bridge);
    if (currentView === 'diagnostics') renderDiagnostics();
    if (currentView === 'processing') {
      if (bridge.status === BRIDGE_STATUS.REQUESTING) {
        els.processingText.textContent = 'Requesting capture...';
        renderPipeline('image', 0);
      }
      if (bridge.status === BRIDGE_STATUS.CAPTURING) {
        els.processingText.textContent = 'Capturing...';
        renderPipeline('image', 0);
      }
      if (bridge.status === BRIDGE_STATUS.ERROR || bridge.status === BRIDGE_STATUS.TIMEOUT) {
        if (els.processingSub) els.processingSub.textContent = safeText(bridge.lastError, '');
      }
    }
  });
  initMobileBridgeDebug();
  mountSimulatorBadge(document.getElementById('app'));
  // Hardware test mode: keep the Alpha claim but make the mode visible.
  // Still not a validation claim — labels stay "pending" until real testing.
  if (isHardwareTestMode()) {
    const banner = document.getElementById('alpha-banner');
    if (banner) banner.textContent = 'ALPHA · HW TEST MODE';
    setPill('pill-bridge', 'mock', 'Bridge: HW Test');
  }
  // Hardware candidate: distinct banner from public demo and simulator.
  // The condition is a compile-time constant expression (define + typeof
  // fold) so the banner STRING ITSELF is dead-code-eliminated from the
  // production and simulator bundles — scripts/verify-artifacts.js asserts
  // the string is absent there and present in dist-hardware.
  if (typeof __KSCAN_HARDWARE_CANDIDATE_BUILD__ !== 'undefined'
    && __KSCAN_HARDWARE_CANDIDATE_BUILD__ === true) {
    const banner = document.getElementById('alpha-banner');
    if (banner) banner.textContent = 'PRIVATE HARDWARE CANDIDATE — NOT FOR PUBLIC RELEASE';
  }
  // Phone companion: active only with ?companion=1; otherwise the pill is
  // hidden because no companion relationship exists in this build mode.
  if (COMPANION_MODE) {
    initCompanionRuntime();
    const banner = document.getElementById('alpha-banner');
    if (banner) banner.textContent = 'ALPHA · MOCK PHONE — LOCAL QA · HW VALIDATION PENDING';
  } else {
    document.getElementById('pill-companion')?.classList.add('hidden');
  }
  showScreen('home', false);
  setState(STATE.IDLE);
  if (import.meta.env.DEV) window.startTextScan = startTextScan;
}

init();
