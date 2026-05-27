import { initNavigation, focusFirstInView, registerFocusMatrix, resetFocusIndex } from './navigation.js';
import {
  capturePhoto,
  getDatStatus,
  getDatDiagnostics,
  DATBridgeError,
  DAT_ERROR_CODES,
  toUserFriendlyCaptureError,
} from './datBridge.js';
import { sanitizeImageBeforeUpload } from './privacyImageSanitizer.js';
import { analyzeImage } from './api.js';
import { initVoice } from './voice.js';

const STATE = {
  IDLE: 'IDLE',
  CAPTURING: 'CAPTURING',
  SANITIZING: 'SANITIZING',
  ANALYZING: 'ANALYZING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
};

let appState = STATE.IDLE;
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
  hudMock: document.getElementById('hud-mock'),
  hudBridge: document.getElementById('hud-bridge'),
  hudStatus: document.getElementById('hud-status'),
  hudError: document.getElementById('hud-error'),
};

const screens = [els.home, els.processing, els.results, els.library, els.settings, els.error];

function updateHud() {
  const diagnostics = getDatDiagnostics();
  if (els.hudMock) els.hudMock.textContent = `MOCK: ${diagnostics.mock ? 'ON' : 'OFF'}`;
  if (els.hudBridge) {
    const bridgeText = diagnostics.adapter === 'unavailable'
      ? 'MISSING'
      : 'READY';
    els.hudBridge.textContent = `BRIDGE: ${bridgeText}`;
  }
  if (els.hudStatus) els.hudStatus.textContent = `STATUS: ${appState}`;
  if (els.hudError) els.hudError.textContent = `LAST ERROR: ${lastDatErrorCode}`;
}

function setState(next) {
  appState = next;
  if (next === STATE.CAPTURING) els.processingText.textContent = 'Capturing...';
  if (next === STATE.SANITIZING) els.processingText.textContent = 'Sanitizing...';
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

function renderProducts(data) {
  const products = Array.isArray(data?.products) ? data.products : [];
  els.resultsList.innerHTML = '';

  if (!products.length) {
    els.resultsEmpty.classList.remove('hidden');
    registerFocusMatrix('results', [
      [document.getElementById('results-back-btn')],
      [document.getElementById('retry-empty-btn')],
    ]);
    return;
  }

  els.resultsEmpty.classList.add('hidden');

  products.forEach((product) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'row product-card focusable';

    const img = product.image
      ? `<img class="product-thumb" src="${product.image}" alt="Product image" />`
      : '<div class="product-thumb" aria-hidden="true"></div>';

    const confidenceText = Number.isFinite(product.confidence)
      ? `${Math.round(product.confidence * 100)}%`
      : 'n/a';

    card.innerHTML = `
      ${img}
      <div class="product-meta">
        <p>${safeText(product.brand, 'Unknown Brand')}</p>
        <p class="name">${safeText(product.name, 'Unnamed Product')}</p>
        <p class="price">${safeText(product.price, 'Price unavailable')}</p>
        <p class="confidence">Confidence: ${confidenceText}</p>
        <p class="link">Buy/Open: ${safeText(product.link, '#')}</p>
      </div>
    `;

    card.addEventListener('click', () => {});
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
  if (!(error instanceof DATBridgeError)) {
    return safeText(error?.message, 'Scan failed. Please try again.');
  }

  lastDatErrorCode = error.code || DAT_ERROR_CODES.INVALID_CAPTURE_RESPONSE;
  updateHud();
  return toUserFriendlyCaptureError(error);
}

export async function startScan() {
  try {
    lastDatErrorCode = 'none';
    showScreen('processing');

    setState(STATE.CAPTURING);
    const captured = await capturePhoto();

    setState(STATE.SANITIZING);
    const sanitized = await sanitizeImageBeforeUpload(captured);

    setState(STATE.ANALYZING);
    const response = await analyzeImage(sanitized);

    renderProducts(response);
    setState(STATE.SUCCESS);
    showScreen('results');
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
  document.getElementById('error-home-btn').addEventListener('click', () => showScreen('home'));
  document.getElementById('cancel-btn').addEventListener('click', () => showScreen('home'));
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
  if (import.meta.env.PROD) {
    document.body.classList.add('prod');
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
