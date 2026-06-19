import { initNavigation, focusFirstInView, registerFocusMatrix, resetFocusIndex } from './navigation.js';
import {
  capturePhoto,
  getDatDiagnostics,
  getMobileBridgeStatus,
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
  resultsList: document.getElementById('results-list'),
  resultsEmpty: document.getElementById('results-empty'),
  errorMessage: document.getElementById('error-message'),
  hud: null,
};

const screens = [els.home, els.processing, els.results, els.library, els.settings, els.error];

function updateHud() {
  if (!els.hud || !import.meta.env.DEV) return;

  const datDiagnostics = getDatDiagnostics();
  const datState = datDiagnostics.mock ? 'MOCK' : (datDiagnostics.bridgeReady ? 'READY' : 'MISSING');
  const analyzeState = (import.meta.env.DEV && import.meta.env.VITE_MOCK_ANALYZE === 'true') ? 'MOCK' : 'REAL';
  const backendState = String(import.meta.env.VITE_KSCAN_BACKEND_URL || '').trim() ? 'OK' : 'MISSING';
  const flow = getFlowState();

  els.hud.textContent = `DAT: ${datState} | ANALYZE: ${analyzeState} | BACKEND: ${backendState} | FLOW: ${flow}`;
}

function setState(next) {
  setFlowState(next);
  if (next === STATE.CAPTURING) els.processingText.textContent = 'Capturing...';
  if (next === STATE.SANITIZING) els.processingText.textContent = 'Protecting privacy...';
  if (next === STATE.ANALYZING) els.processingText.textContent = 'Analyzing...';
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

function createProductCard(product) {
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
  meta.appendChild(createText('p', 'brand', safeText(product.brand, 'Unknown Brand')));
  meta.appendChild(createText('p', 'name', safeText(product.name, 'Unnamed Product')));

  const priceText = safeText(product.priceRange || product.price, 'Price unavailable');
  meta.appendChild(createText('p', 'price', priceText));

  const action = createText('p', 'link', 'Press Enter to save');
  meta.appendChild(action);
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
      action.textContent = 'Saved to Library';
      card.classList.add('saved');
    } else if (result.reason === 'duplicate') {
      action.textContent = 'Already in Library';
    } else {
      action.textContent = 'Could not save';
    }
  });
  return card;
}

function renderProducts(data) {
  const products = Array.isArray(data?.products) ? data.products : [];
  els.resultsList.innerHTML = '';

  if (!products.length) {
    const empty = els.resultsEmpty.querySelector('p');
    if (empty) empty.textContent = 'No matches found. Try another angle.';
    els.resultsEmpty.classList.remove('hidden');
    registerFocusMatrix('results', [
      [document.getElementById('results-back-btn')],
      [document.getElementById('retry-empty-btn')],
    ]);
    return;
  }

  els.resultsEmpty.classList.add('hidden');

  products.forEach((product) => {
    const card = createProductCard(product);
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
    if (error.code === ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED) return 'Backend not configured.';
    if (error.code === ANALYZE_ERROR_CODES.TIMEOUT) return 'Request timed out. Try again.';
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
          els.processingText.textContent = 'Waking up Fashion AI...';
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
  const prefix = isExample ? 'Example: ' : '';
  return count > 0
    ? `${prefix}${date} · ${count} match${count === 1 ? '' : 'es'}${top}`
    : `${prefix}${date} · No matches`;
}

function appendStubBanner(panel) {
  if (!isStubMode()) return;
  const banner = document.createElement('p');
  banner.className = 'stub-banner';
  banner.textContent = 'Supabase stub – virtual-alpha only.';
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

  panel.appendChild(createText('h2', null, 'Saved Items'));
  const savedItems = [
    ...guest.savedItems.map((item) => ({ item, isExample: false })),
    ...examples.savedItems.map((item) => ({ item, isExample: true })),
  ];
  if (!savedItems.length) {
    panel.appendChild(createText('p', 'empty-note', 'No saved items yet.'));
  }
  savedItems.forEach(({ item, isExample }) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row focusable';
    row.textContent = `${isExample ? 'Example: ' : ''}${item.brand} — ${item.name} (${item.price})`;
    panel.appendChild(row);
    rows.push(row);
  });

  panel.appendChild(createText('h2', null, 'Scan History'));
  const scans = [
    ...guest.scans.map((scan) => ({ scan, isExample: false })),
    ...examples.scans.map((scan) => ({ scan, isExample: true })),
  ];
  if (!scans.length) {
    panel.appendChild(createText('p', 'empty-note', 'No scans yet.'));
  }
  scans.forEach(({ scan, isExample }) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row focusable';
    row.textContent = formatScanRow(scan, isExample);
    panel.appendChild(row);
    rows.push(row);
  });

  registerFocusMatrix('library', [
    [document.getElementById('library-back-btn')],
    ...rows.map((el) => [el]),
  ]);
}

// ─── Settings screen ─────────────────────────────────────────────────

// Plain-text status rows. Shows hostname at most — never full URLs,
// query params, keys, tokens, or raw env values.
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

  let backendText;
  if (scenario) {
    backendText = `mock (${scenario})`;
  } else if (mockAnalyze) {
    backendText = 'mock';
  } else {
    const raw = String(import.meta.env.VITE_KSCAN_BACKEND_URL || '').trim();
    if (!raw) {
      backendText = 'unavailable';
    } else {
      try {
        backendText = `configured (${new URL(raw).hostname})`;
      } catch {
        backendText = 'configured';
      }
    }
  }

  const rows = [
    `Simulator: ${sim.active ? 'enabled' : 'disabled'}`,
    `Backend: ${backendText}`,
    `Supabase: ${isStubMode() ? 'stub' : 'configured'}`,
    `Auth: ${session ? 'stub session' : 'guest'}`,
  ];
  rows.forEach((text) => {
    const row = document.createElement('p');
    row.className = 'status-row';
    row.textContent = text;
    status.appendChild(row);
  });
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
    authBtn.textContent = session ? 'Sign Out' : 'Sign In (stub)';
    authBtn.classList.toggle('row-danger', Boolean(session));
  }

  renderSettingsStatus(panel);

  let banner = panel.querySelector('.stub-banner');
  if (isStubMode() && !banner) {
    banner = document.createElement('p');
    banner.className = 'stub-banner';
    banner.textContent = 'Supabase stub – virtual-alpha only.';
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
  initMobileBridgeDebug();
  mountSimulatorBadge(document.getElementById('app'));
  showScreen('home', false);
  setState(STATE.IDLE);
}

init();
