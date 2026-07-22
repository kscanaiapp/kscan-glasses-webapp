// Backend analyze client.
//
// Contract (DO NOT CHANGE): POST {KSCAN_BACKEND_URL}/api/analyze
// with JSON body exactly { image: <sanitized JPEG data URL string> }.
//
// Phase 11 retry policy (documented in README/QA_REPORT):
//   - First attempt timeout: 10s.
//   - Retry ONCE only on timeout or HTTP 5xx, after a 2s delay.
//   - Second attempt timeout: 15s.
//   - No retry on 4xx, malformed JSON, or network failure.
//
// Logging policy: never log image payloads, base64, scan results, or
// product matches. Errors carry generic codes + HTTP status only.

export const ANALYZE_FIRST_TIMEOUT_MS = 10000;
export const ANALYZE_RETRY_TIMEOUT_MS = 15000;
export const ANALYZE_RETRY_DELAY_MS = 2000;
const ANALYZE_SLOW_HINT_MS = 5000;

export const ANALYZE_ERROR_CODES = {
  BACKEND_NOT_CONFIGURED: 'BACKEND_NOT_CONFIGURED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  NON_2XX: 'NON_2XX',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_SHAPE: 'INVALID_SHAPE',
  MOCK_ERROR: 'MOCK_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  LIVE_DISABLED: 'LIVE_DISABLED',
};

export class AnalyzeError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'AnalyzeError';
    this.code = code;
    this.status = Number.isFinite(status) ? status : null;
  }
}

function normalizeBackendUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

function toText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toSafeImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const raw = value.trim();
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw;
  } catch {
    return '';
  }
  return '';
}

export function normalizeProduct(item) {
  const source = item && typeof item === 'object' ? item : {};

  const brand = toText(source.brand ?? source.brandName, 'Unknown Brand');
  const name = toText(source.name ?? source.title ?? source.productName, 'Unnamed Product');
  const priceValue = source.price ?? source.priceText;
  const rangeValue = source.priceRange;

  const price = toText(priceValue, typeof rangeValue === 'string' && rangeValue.trim() ? rangeValue.trim() : 'Price unavailable');
  const priceRange = typeof rangeValue === 'string' && rangeValue.trim() ? rangeValue.trim() : undefined;

  const imageUrl = toSafeImageUrl(source.imageUrl ?? source.image ?? source.thumbnail);
  const url = toSafeImageUrl(source.url ?? source.productUrl ?? source.link);

  return {
    brand,
    name,
    price,
    ...(priceRange ? { priceRange } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(url ? { url } : {}),
  };
}

function mapAnalyzeError(error) {
  if (error instanceof AnalyzeError) return error;
  if (error?.name === 'AbortError') {
    return new AnalyzeError(ANALYZE_ERROR_CODES.TIMEOUT, 'Request timed out. Please try again.');
  }
  return new AnalyzeError(ANALYZE_ERROR_CODES.NETWORK, 'Cannot reach server. Check connection.');
}

function normalizeAnalyzeResponse(json) {
  if (!json || typeof json !== 'object') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_SHAPE, 'Unexpected server response.');
  }

  const sourceProducts = Array.isArray(json.products) ? json.products : [];
  const products = sourceProducts.map(normalizeProduct).slice(0, 5);

  return {
    products,
    style_metadata: json.style_metadata && typeof json.style_metadata === 'object' ? json.style_metadata : undefined,
    raw: json,
  };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error) {
  if (!(error instanceof AnalyzeError)) return false;
  if (error.code === ANALYZE_ERROR_CODES.TIMEOUT) return true;
  if (error.code === ANALYZE_ERROR_CODES.NON_2XX && error.status !== null && error.status >= 500) return true;
  return false;
}

async function attemptAnalyze(endpoint, sanitizedBase64, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: sanitizedBase64 }),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapAnalyzeError(error);
    }

    if (!response.ok) {
      throw new AnalyzeError(ANALYZE_ERROR_CODES.NON_2XX, 'Analysis failed. Please try again.', response.status);
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_JSON, 'Unexpected server response.');
    }

    return normalizeAnalyzeResponse(json);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Pure, dependency-injected analyze core. Used directly by node contract
 * tests; analyzeImage() wires real env + global fetch below.
 */
export async function performAnalyzeRequest(sanitizedBase64, deps = {}) {
  const {
    backendUrl,
    fetchImpl,
    onSlow,
    firstTimeoutMs = ANALYZE_FIRST_TIMEOUT_MS,
    secondTimeoutMs = ANALYZE_RETRY_TIMEOUT_MS,
    retryDelayMs = ANALYZE_RETRY_DELAY_MS,
    slowHintMs = ANALYZE_SLOW_HINT_MS,
  } = deps;

  if (typeof sanitizedBase64 !== 'string' || sanitizedBase64.trim().length < 16) {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_INPUT, 'Analysis failed. Please try again.');
  }

  const backend = normalizeBackendUrl(backendUrl);
  if (!backend) {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED, 'Backend not configured.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.NETWORK, 'Cannot reach server. Check connection.');
  }

  const endpoint = `${backend}/api/analyze`;
  const slowHintId = setTimeout(() => {
    if (typeof onSlow === 'function') onSlow();
  }, slowHintMs);

  try {
    try {
      return await attemptAnalyze(endpoint, sanitizedBase64, firstTimeoutMs, fetchImpl);
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      await waitMs(retryDelayMs);
      return await attemptAnalyze(endpoint, sanitizedBase64, secondTimeoutMs, fetchImpl);
    }
  } finally {
    clearTimeout(slowHintId);
  }
}

// ─── Env / simulator scenario plumbing ───────────────────────────────

function readApiEnv() {
  // Static references only so Vite inlines just these literals.
  try {
    return {
      DEV: import.meta.env.DEV === true,
      VITE_KSCAN_BACKEND_URL: import.meta.env.VITE_KSCAN_BACKEND_URL,
      VITE_MOCK_ANALYZE: import.meta.env.VITE_MOCK_ANALYZE,
      VITE_MOCK_ANALYZE_DELAY_MS: import.meta.env.VITE_MOCK_ANALYZE_DELAY_MS,
      VITE_MOCK_ANALYZE_ERROR: import.meta.env.VITE_MOCK_ANALYZE_ERROR,
      VITE_ENABLE_SIMULATOR: import.meta.env.VITE_ENABLE_SIMULATOR,
      VITE_ENABLE_PRIVATE_LIVE_ANALYZE: import.meta.env.VITE_ENABLE_PRIVATE_LIVE_ANALYZE,
    };
  } catch {
    return { DEV: false };
  }
}

/**
 * The public demo is mock-only unless private QA is explicitly enabled.
 * A configured backend URL alone must never activate network analysis.
 */
export function isPrivateLiveAnalyzeEnabled(envLike = {}, runtimeLike = {}) {
  if (runtimeLike && runtimeLike.ENABLE_PRIVATE_LIVE_ANALYZE === true) return true;
  return String(envLike.VITE_ENABLE_PRIVATE_LIVE_ANALYZE || '').toLowerCase() === 'true';
}

function isMockAnalyzeEnabled(envLike = {}) {
  return String(envLike.VITE_MOCK_ANALYZE || '').toLowerCase() === 'true';
}

export function getAnalyzeMode(envLike = readApiEnv(), runtimeLike = undefined) {
  const runtime = runtimeLike === undefined
    ? (typeof window !== 'undefined' && window.__KSCAN_CONFIG__ && typeof window.__KSCAN_CONFIG__ === 'object'
      ? window.__KSCAN_CONFIG__
      : {})
    : runtimeLike;
  if (isMockAnalyzeEnabled(envLike)) return 'mock';
  if (isPrivateLiveAnalyzeEnabled(envLike, runtime)) return 'private-live';
  return 'live-disabled';
}

export const ANALYZE_SCENARIOS = ['success', 'empty', 'http-400', 'http-500', 'timeout', 'malformed', 'offline'];

/**
 * Simulator-only analyze scenario override via `?mockAnalyze=<scenario>`.
 * Honored only when DEV or VITE_ENABLE_SIMULATOR=true — inert in production.
 * Pure for node tests.
 */
export function parseAnalyzeScenario(locationLike = {}, envLike = {}) {
  const allowed = envLike.DEV === true || String(envLike.VITE_ENABLE_SIMULATOR || '').toLowerCase() === 'true';
  if (!allowed) return null;

  const search = typeof locationLike.search === 'string' ? locationLike.search : '';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = String(params.get('mockAnalyze') || '').trim().toLowerCase();
  return ANALYZE_SCENARIOS.includes(raw) ? raw : null;
}

function parseMockDelayMs(envLike) {
  const raw = envLike.VITE_MOCK_ANALYZE_DELAY_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 900;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return 900;
  return Math.max(0, Math.min(5000, value));
}

function buildMockProducts() {
  return [
    {
      brand: 'Aether Loom',
      name: 'Chrome Arc Jacket',
      price: '$189',
      priceRange: '$179-$209',
      imageUrl: '/images/placeholder-item-1.png',
      url: 'https://example.com/products/chrome-arc-jacket',
    },
    {
      brand: 'Nova Thread',
      name: 'Cyan Edge Utility Vest',
      price: '$124',
      imageUrl: '/images/placeholder-item-2.png',
      url: 'https://example.com/products/cyan-edge-vest',
    },
    {
      brand: 'Glassline',
      name: 'Nightline Taper Pant',
      price: '$98',
      priceRange: '$89-$109',
      url: 'https://example.com/products/nightline-pant',
    },
    {
      brand: 'Orbit Form',
      name: 'Signal Knit Top',
      price: '$76',
      imageUrl: '/images/placeholder-item-4.png',
      url: 'https://example.com/products/signal-knit',
    },
  ];
}

async function runScenarioMock(scenario, sanitizedBase64, envLike) {
  if (typeof sanitizedBase64 !== 'string' || sanitizedBase64.trim().length < 16) {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_INPUT, 'Analysis failed. Please try again.');
  }

  await waitMs(parseMockDelayMs(envLike));

  if (scenario === 'empty') {
    return { products: [], style_metadata: { source: 'mock-scenario' }, raw: { mode: 'mock', scenario } };
  }
  if (scenario === 'http-400') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.NON_2XX, 'Analysis failed. Please try again.', 400);
  }
  if (scenario === 'http-500') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.NON_2XX, 'Analysis failed. Please try again.', 500);
  }
  if (scenario === 'timeout') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.TIMEOUT, 'Request timed out. Please try again.');
  }
  if (scenario === 'malformed') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_JSON, 'Unexpected server response.');
  }
  if (scenario === 'offline') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.NETWORK, 'Cannot reach server. Check connection.');
  }

  const products = buildMockProducts().map(normalizeProduct).slice(0, 5);
  return { products, style_metadata: { source: 'mock-scenario' }, raw: { mode: 'mock', scenario } };
}

async function runMockAnalyze(sanitizedBase64, envLike) {
  if (typeof sanitizedBase64 !== 'string' || sanitizedBase64.trim().length < 16) {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_INPUT, 'Analysis failed. Please try again.');
  }

  await waitMs(parseMockDelayMs(envLike));

  if (envLike.DEV === true && envLike.VITE_MOCK_ANALYZE === 'true' && envLike.VITE_MOCK_ANALYZE_ERROR === 'true') {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.MOCK_ERROR, 'Analysis failed. Please try again.');
  }

  const products = buildMockProducts().map(normalizeProduct).slice(0, 5);
  return { products, style_metadata: { source: 'mock' }, raw: { mode: 'mock' } };
}

export async function analyzeImage(sanitizedBase64, options = {}) {
  const env = readApiEnv();
  const runtime = typeof window !== 'undefined' && window.__KSCAN_CONFIG__ && typeof window.__KSCAN_CONFIG__ === 'object'
    ? window.__KSCAN_CONFIG__
    : {};
  const locationLike = typeof window !== 'undefined' && window.location ? window.location : {};

  // Simulator scenario override (dev/staging only; inert in production).
  const scenario = parseAnalyzeScenario(locationLike, env);
  if (scenario) {
    return runScenarioMock(scenario, sanitizedBase64, env);
  }

  // Explicit mock mode is safe in every build: it never calls a backend.
  if (isMockAnalyzeEnabled(env)) {
    return runMockAnalyze(sanitizedBase64, env);
  }

  if (!isPrivateLiveAnalyzeEnabled(env, runtime)) {
    throw new AnalyzeError(
      ANALYZE_ERROR_CODES.LIVE_DISABLED,
      'Live analysis is disabled. Private QA configuration required.',
    );
  }

  return performAnalyzeRequest(sanitizedBase64, {
    backendUrl: env.VITE_KSCAN_BACKEND_URL || runtime.KSCAN_BACKEND_URL,
    fetchImpl: typeof fetch === 'function' ? fetch.bind(globalThis) : undefined,
    onSlow: options.onSlow,
  });
}
