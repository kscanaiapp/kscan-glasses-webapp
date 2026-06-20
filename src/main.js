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
import { analyzeImage, AnalyzeError, ANALYZE_ERROR_CODES } from './api.js';
import { FLOW_STATES, getFlowState, setFlowState } from './flowState.js';
import { runScanPipeline, PIPELINE_STAGES, PipelineInvariantError } from './scanPipeline.js';
import { mountSimulatorBadge, getSimulatorState } from './simulatorMode.js';
import { getSession, signInStub, signOut, isStubMode } from './authSession.js';
import { loadGuestLibrary, recordGuestScan, saveGuestItem, getStubLibraryExamples } from './libraryStore.js';

const STATE = FLOW_STATES;

let currentView = 'home';
const screenHistory = [];
let lastDatErrorCode = 'none';
let scanInFlight = false;
let scanToken = 0;

const els = {
  home: document.getElementById('home'),
  processing: document.getElementById('processing'),
  results: document.getElementById('results'),
  library: document.getElementById('library'),
  settings: document.getElementById('settings'),
  error: document.getElementById('error'),
  processingText: document.getElementById('processing-text'),
  processingSub: document.getElementById('processing-sub'),
  resultsList: document.getElementById('results-list'),
  resultsMatch: document.getElementById('results-match'),
  resultsEmpty: document.getElementById('results-empty'),
  errorMessage: document.getElementById('error-message'),
  hud: null,
};

const screens = [els.home, els.processing, els.results, els.library, els.settings, els.error];

function updateHud() {
  if (!els.hud || !import.meta.env.DEV) return;

  const datDiagnostics = getDatDiagnostics();
  const betaStatus = getBetaBridgeStatus();
  const datState = betaStatus.enabled ? 'BETA' : (datDiagnostics.mock ? 'MOCK' : (datDiagnostics.bridgeReady ? 'READY' : 'MISSING'));
  const analyzeState = (import.meta.env.DEV && import.meta.env.VITE_MOCK_ANALYZE === 'true') ? 'MOCK' : 'REAL';
  const backendState = String(import.meta.env.VITE_KSCAN_BACKEND_URL || '').trim() ? 'OK' : 'MISSING';
  const flow = getFlowState();

  els.hud.textContent = `DAT: ${datState} | ANALYZE: ${analyzeState} | BACKEND: ${backendState} | FLOW: ${flow}`;
}

function updateBridgeBadge() {
  const badge = document.getElementById('bridge-status');
  if (!badge) return;

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
}

function setState(next) {
  setFlowState(next);
  const sub = els.processingSub;
  if (next === STATE.CAPTURING) {
    els.processingText.textContent = 'Capturing...';
    if (sub) sub.textContent = '';
  }
  if (next === STATE.SANITIZING) {
    els.processingText.textContent = 'Protecting privacy...';
    if (sub) sub.textContent = '';
  }
  if (next === STATE.ANALYZING) {
    els.processingText.textContent = 'Analyzing scan...';
    if (sub) sub.textContent = 'Fashion AI is working';
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

  if (pushHistory && currentView !== viewId) screenHistory.push(currentView);

  screens.forEach((screen) => {
    if (!screen) return;
    screen.classList.add('hidden');
  });

  els[viewId].classList.remove('hidden');
  currentView = viewId;
  syncViewA11y(viewId);

  if (viewId === 'library') renderLibrary();
  if (viewId === 'settings') renderSettings();

  if (viewId === 'results') {
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

function createProductCard(product, sourceType) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'row product-card focusable';

  const hasImage = typeof product.imageUrl === 'string' && product.imageUrl.length > 0;
  if (hasImage) {
    const image = document.createElement('img');
    image.className = 'product-thumb';
    image.src = product.imageUrl;
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
  sourcePill.className = `source-pill ${sourceType}`;
  sourcePill.textContent = sourceType === 'retail' ? 'Retail — demo' : sourceType === 'resale' ? 'Resale — demo' : 'Suggested — demo';
  meta.appendChild(sourcePill);

  meta.appendChild(createText('p', 'brand', safeText(product.brand, 'Unknown Brand')));
  meta.appendChild(createText('p', 'name', safeText(product.name, 'Unknown item')));

  const priceText = safeText(product.priceRange || product.price, 'Price unavailable');
  meta.appendChild(createText('p', 'price', priceText));

  const actions = document.createElement('div');
  actions.className = 'product-actions';

  const saveAction = createText('span', 'product-action-btn primary-action', 'Save Look');
  const phoneAction = createText('span', 'product-action-btn', 'Open on Phone');
  actions.appendChild(saveAction);
  actions.appendChild(phoneAction);
  meta.appendChild(actions);
  card.appendChild(meta);

  // Enter/click on a result card saves metadata (brand/name/price only —
  // never images) to the guest library.
  card.addEventListener('click', () => {
    const result = saveGuestItem({
      brand: safeText(product.brand, 'Unknown Brand'),
      name: safeText(product.name, 'Unnamed Product'),
      price: safeText(product.priceRange || product.price, 'Price unavailable'),
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

function buildSourceType(index, total) {
  if (index < 2) return 'retail';
  if (index < 3 || (total >= 4 && index === 3)) return 'resale';
  return 'suggested';
}

function renderStyleMatch(data) {
  const panel = els.resultsMatch;
  if (!panel) return;
  panel.innerHTML = '';

  const styleMeta = data?.style_metadata && typeof data.style_metadata === 'object' ? data.style_metadata : {};
  const detectedStyle = safeText(styleMeta.detected_style || styleMeta.style, 'Modern Minimalist Layering');
  const attributes = Array.isArray(styleMeta.attributes) ? styleMeta.attributes : ['Cream knit', 'tailored outerwear', 'soft neutral palette'];
  const confidence = Number.isFinite(styleMeta.confidence) ? styleMeta.confidence : 94;
  const scanMode = safeText(styleMeta.scan_mode || styleMeta.mode, 'Outfit');

  const card = document.createElement('div');
  card.className = 'glass-card gold-border style-match-card';

  const header = document.createElement('div');
  header.className = 'style-match-header';
  header.appendChild(createText('span', 'style-match-title', 'Style Match'));

  const badgeRow = document.createElement('div');
  badgeRow.style.display = 'flex';
  badgeRow.style.gap = '8px';
  badgeRow.style.flexWrap = 'wrap';
  badgeRow.appendChild(createText('span', 'confidence-badge', `${confidence}% Match`));
  badgeRow.appendChild(createText('span', 'scan-mode-pill', `Scan Mode: ${scanMode}`));
  header.appendChild(badgeRow);
  card.appendChild(header);

  card.appendChild(createText('div', 'detected-style', detectedStyle));

  const attrRow = document.createElement('div');
  attrRow.className = 'style-attributes';
  attributes.slice(0, 5).forEach((attr) => {
    attrRow.appendChild(createText('span', 'attr-pill', safeText(attr, '')));
  });
  card.appendChild(attrRow);

  const disclaimer = document.createElement('p');
  disclaimer.className = 'source-disclaimer';
  disclaimer.textContent = 'Mock demo data — no live inventory or pricing';
  card.appendChild(disclaimer);

  panel.appendChild(card);
}

function renderProducts(data) {
  const products = Array.isArray(data?.products) ? data.products : [];
  els.resultsList.innerHTML = '';
  renderStyleMatch(data);

  if (!products.length) {
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

  // Group by source type for visual grouping
  let currentSource = null;
  const total = products.length;

  products.forEach((product, index) => {
    const sourceType = buildSourceType(index, total);
    if (sourceType !== currentSource) {
      currentSource = sourceType;
      const groupHeader = document.createElement('div');
      groupHeader.className = 'source-group';
      const sourceHeader = document.createElement('div');
      sourceHeader.className = 'source-header';
      const dot = document.createElement('span');
      dot.className = `source-dot ${sourceType}`;
      sourceHeader.appendChild(dot);
      const labelText = sourceType === 'retail' ? 'Retail — demo source' : sourceType === 'resale' ? 'Resale — demo source' : 'Suggested Sources';
      sourceHeader.appendChild(document.createTextNode(labelText));
      groupHeader.appendChild(sourceHeader);
      els.resultsList.appendChild(groupHeader);
    }
    const card = createProductCard(product, sourceType);
    els.resultsList.appendChild(card);
  });

  registerFocusMatrix('results', [
    [document.getElementById('results-back-btn')],
    ...Array.from(els.resultsList.querySelectorAll('.product-card')).map((el) => [el]),
  ]);
}

function showError(message) {
  setState(STATE.ERROR);
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
    if (error.code === ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED) return 'Unable to connect. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.TIMEOUT) return 'Unable to connect. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.NETWORK) return 'Unable to connect. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.NON_2XX) return 'Something went wrong. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_JSON) return 'Something went wrong. Try again.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_SHAPE) return 'Something went wrong. Try again.';
    return 'Something went wrong. Try again.';
  }

  if (!(error instanceof DATBridgeError)) {
    return safeText(error?.message, 'Scan failed. Please try again.');
  }

  lastDatErrorCode = error.code || DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE;
  updateHud();
  return toUserFriendlyCaptureError(error);
}

export async function startScan() {
  if (scanInFlight) return; // prevent duplicate scan triggers while processing
  scanInFlight = true;
  const token = ++scanToken;
  try {
    setState(STATE.IDLE);
    lastDatErrorCode = 'none';
    showScreen('processing');

    const { response } = await runScanPipeline({
      capture: () => capturePhoto(),
      sanitize: (captured) => sanitizeImageBeforeUpload(captured),
      analyze: (sanitized) => analyzeImage(sanitized, {
        onSlow: () => {
          if (els.processingSub) els.processingSub.textContent = 'Still working...';
        },
      }),
      onStage: (stage) => {
        if (token !== scanToken) return; // cancelled — ignore stale stage updates
        if (stage === PIPELINE_STAGES.CAPTURING) setState(STATE.CAPTURING);
        if (stage === PIPELINE_STAGES.SANITIZING) setState(STATE.SANITIZING);
        if (stage === PIPELINE_STAGES.ANALYZING) setState(STATE.ANALYZING);
      },
    });

    if (token !== scanToken) return; // cancelled mid-flight — discard stale result

    // Guest scan history: small metadata only — never images or payloads.
    const products = Array.isArray(response?.products) ? response.products : [];
    recordGuestScan({
      productCount: products.length,
      topBrand: products[0]?.brand || '',
      topName: products[0]?.name || '',
    });

    renderProducts(response);
    setState(STATE.SUCCESS);
    showScreen('results');
    focusFirstInView('results');
  } catch (error) {
    if (token !== scanToken) return; // cancelled — suppress stale error
    showError(normalizeScanError(error));
  } finally {
    if (token === scanToken) scanInFlight = false;
  }
}

function onBack() {
  if (currentView === 'home') return;
  if (currentView === 'processing') {
    scanToken += 1; // invalidate in-flight scan
    scanInFlight = false;
    setState(STATE.IDLE);
  }
  const previous = screenHistory.pop() || 'home';
  showScreen(previous, false);
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
  const authBadge = session ? '<span class="status-badge on">Live</span>' : '<span class="status-badge off">Guest</span>';

  const voiceEnabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_VOICE_PLACEHOLDER === 'true';
  const voiceBadge = voiceEnabled
    ? '<span class="status-badge warn">future device test</span>'
    : '<span class="status-badge off">future device test</span>';

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
  status.appendChild(makeRow('Account', authBadge));
  status.appendChild(makeRow('Voice', voiceBadge));
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
    signOut();
  } else {
    signInStub();
  }
  renderSettings();
  focusFirstInView('settings');
}

function wireButtons() {
  document.getElementById('scan-btn').addEventListener('click', startScan);
  document.getElementById('retry-empty-btn').addEventListener('click', startScan);
  document.getElementById('error-retry-btn').addEventListener('click', startScan);

  document.getElementById('library-btn').addEventListener('click', () => showScreen('library'));
  document.getElementById('settings-btn').addEventListener('click', () => showScreen('settings'));

  document.getElementById('library-back-btn').addEventListener('click', onBack);
  document.getElementById('settings-back-btn').addEventListener('click', onBack);
  document.getElementById('results-back-btn').addEventListener('click', onBack);
  document.getElementById('settings-auth-btn').addEventListener('click', onAuthToggle);
  document.getElementById('error-home-btn').addEventListener('click', () => {
    setState(STATE.IDLE);
    showScreen('home', false);
  });
  document.getElementById('cancel-btn').addEventListener('click', () => {
    scanToken += 1; // invalidate any in-flight scan
    scanInFlight = false;
    setState(STATE.IDLE);
    showScreen('home', false);
  });
}

function registerMatrices() {
  registerFocusMatrix('home', [
    [document.getElementById('scan-btn')],
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
  initNavigation({ onBack });
  registerMatrices();
  wireButtons();
  initStatus();
  updateBridgeBadge();
  initMobileBridgeDebug();
  mountSimulatorBadge(document.getElementById('app'));
  showScreen('home', false);
  setState(STATE.IDLE);
}

init();
