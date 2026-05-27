import { initNavigation, focusFirstInView, registerFocusMatrix, resetFocusIndex } from './navigation.js';
import {
  capturePhoto,
  getDatStatus,
  getDatDiagnostics,
  DATBridgeError,
  DAT_ERROR_CODES,
  toUserFriendlyCaptureError,
} from './datBridge.js';
import { sanitizeImageBeforeUpload, SanitizerError, mapSanitizerErrorToUserMessage } from './privacyImageSanitizer.js';
import { analyzeImage, AnalyzeError, ANALYZE_ERROR_CODES } from './api.js';
import { initVoice } from './voice.js';
import { FLOW_STATES, getFlowState, setFlowState } from './flowState.js';

const STATE = FLOW_STATES;

let currentView = 'home';
const screenHistory = [];
let lastDatErrorCode = 'none';

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
  datStatus: document.getElementById('dat-status'),
  voiceStatus: document.getElementById('voice-status'),
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
  meta.appendChild(createText('p', 'link', product.url ? 'Open product' : 'No link available'));
  card.appendChild(meta);

  card.addEventListener('click', () => {});
  return card;
}

function renderProducts(data) {
  const products = Array.isArray(data?.products) ? data.products : [];
  els.resultsList.innerHTML = '';

  if (!products.length) {
    const empty = els.resultsEmpty.querySelector('p');
    if (empty) empty.textContent = 'No items identified';
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

  if (error instanceof AnalyzeError) {
    if (error.code === ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED) return 'Backend not configured.';
    if (error.code === ANALYZE_ERROR_CODES.TIMEOUT) return 'Request timed out. Please try again.';
    if (error.code === ANALYZE_ERROR_CODES.NETWORK) return 'Cannot reach server. Check connection.';
    if (error.code === ANALYZE_ERROR_CODES.NON_2XX) return 'Analysis failed. Please try again.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_JSON) return 'Unexpected server response.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_SHAPE) return 'Unexpected server response.';
    if (error.code === ANALYZE_ERROR_CODES.MOCK_ERROR) return 'Analysis failed. Please try again.';
    if (error.code === ANALYZE_ERROR_CODES.INVALID_INPUT) return 'Analysis failed. Please try again.';
    return 'Analysis failed. Please try again.';
  }

  if (!(error instanceof DATBridgeError)) {
    return safeText(error?.message, 'Scan failed. Please try again.');
  }

  lastDatErrorCode = error.code || DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE;
  updateHud();
  return toUserFriendlyCaptureError(error);
}

export async function startScan() {
  try {
    setState(STATE.IDLE);
    lastDatErrorCode = 'none';
    showScreen('processing');

    setState(STATE.CAPTURING);
    const captured = await capturePhoto();

    setState(STATE.SANITIZING);
    const sanitized = await sanitizeImageBeforeUpload(captured);

    setState(STATE.ANALYZING);
    const response = await analyzeImage(sanitized, {
      onSlow: () => {
        els.processingText.textContent = 'Waking up Fashion AI...';
      },
    });

    renderProducts(response);
    setState(STATE.SUCCESS);
    showScreen('results');
    focusFirstInView('results');
  } catch (error) {
    showError(normalizeScanError(error));
  }
}

function onBack() {
  if (currentView === 'home') return;
  const previous = screenHistory.pop() || 'home';
  showScreen(previous, false);
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
  document.getElementById('error-home-btn').addEventListener('click', () => {
    setState(STATE.IDLE);
    showScreen('home');
  });
  document.getElementById('cancel-btn').addEventListener('click', () => {
    setState(STATE.IDLE);
    showScreen('home');
  });
}

function registerMatrices() {
  registerFocusMatrix('home', [
    [document.getElementById('scan-btn')],
    [document.getElementById('library-btn')],
    [document.getElementById('settings-btn')],
  ]);

  registerFocusMatrix('processing', [[document.getElementById('cancel-btn')]]);

  registerFocusMatrix('library', [
    [document.getElementById('library-back-btn')],
    ...Array.from(document.querySelectorAll('#library .row')).map((el) => [el]),
  ]);

  registerFocusMatrix('settings', [
    [document.getElementById('settings-back-btn')],
    ...Array.from(document.querySelectorAll('#settings .row')).map((el) => [el]),
  ]);

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

  els.datStatus.textContent = getDatStatus();
  updateHud();

  const voice = initVoice({ onScan: startScan });
  if (!voice.supported) {
    els.voiceStatus.textContent = 'Voice: unavailable';
    return;
  }

  els.voiceStatus.textContent = 'Voice: available';
  voice.start();
}

function initSupabasePlaceholder() {
  const url = import.meta.env.VITE_SUPABASE_URL || '';
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
  void { configured: Boolean(url && anon) };
}

function init() {
  initNavigation({ onBack });
  registerMatrices();
  wireButtons();
  initStatus();
  initSupabasePlaceholder();
  showScreen('home', false);
  setState(STATE.IDLE);
}

init();
