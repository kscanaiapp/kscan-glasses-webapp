// TextScan adapter for the Meta Ray-Ban Display webapp.
// Meta-only: calls the canonical scan-identify Edge Function with mode: 'text'.

import {
  getSupabaseClient,
  getSupabaseSession,
  hasSupabaseConfig,
  invokeSupabaseFunction,
  listenForSupabaseSessionMessages,
  refreshSupabaseSession,
} from './supabaseClient.js';

export const TEXTSCAN_ERROR_CODES = {
  CONFIG_REQUIRED: 'CONFIG_REQUIRED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  EMPTY_QUERY: 'EMPTY_QUERY',
  INVALID_INPUT: 'INVALID_INPUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  NON_FASHION: 'NON_FASHION',
  TIMEOUT: 'TIMEOUT',
  BUSY: 'BUSY',
  UNKNOWN: 'UNKNOWN',
};

const EDGE_FUNCTION = 'scan-identify';
const MAX_TEXT_QUERY_LEN = 500;
const MAX_SPOKEN_SUMMARY_LEN = 120;
const MAX_HUD_ERROR_LEN = 35;
const TOTAL_TIMEOUT_MS = 8000;
const NETWORK_RETRY_DELAYS_MS = [250, 700];

const SAFE_MESSAGES = {
  [TEXTSCAN_ERROR_CODES.CONFIG_REQUIRED]: 'Supabase missing.',
  [TEXTSCAN_ERROR_CODES.AUTH_REQUIRED]: 'Sign in required.',
  [TEXTSCAN_ERROR_CODES.EMPTY_QUERY]: 'Pick a fashion phrase.',
  [TEXTSCAN_ERROR_CODES.INVALID_INPUT]: 'Invalid fashion phrase.',
  [TEXTSCAN_ERROR_CODES.NETWORK_ERROR]: 'Connection failed.',
  [TEXTSCAN_ERROR_CODES.MALFORMED_RESPONSE]: 'Unexpected response.',
  [TEXTSCAN_ERROR_CODES.NON_FASHION]: 'Not a fashion query.',
  [TEXTSCAN_ERROR_CODES.TIMEOUT]: 'Taking too long.',
  [TEXTSCAN_ERROR_CODES.BUSY]: 'TextScan already running.',
  [TEXTSCAN_ERROR_CODES.UNKNOWN]: 'Something went wrong.',
};

let liveRequestInFlight = false;

listenForSupabaseSessionMessages();

function safeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : [];
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampConfidence(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function clampText(value, max) {
  const text = safeText(value, '');
  return text.length > max ? text.slice(0, max).trim() : text;
}

function safeHudMessage(code, fallback) {
  const message = safeText(SAFE_MESSAGES[code], fallback || SAFE_MESSAGES[TEXTSCAN_ERROR_CODES.UNKNOWN]);
  return message.length <= MAX_HUD_ERROR_LEN ? message : `${message.slice(0, MAX_HUD_ERROR_LEN - 1).trim()}…`;
}

function safeSpokenSummary(value, fallback) {
  const text = safeText(value, fallback || SAFE_MESSAGES[TEXTSCAN_ERROR_CODES.UNKNOWN])
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[redacted]');
  return text.length <= MAX_SPOKEN_SUMMARY_LEN ? text : `${text.slice(0, MAX_SPOKEN_SUMMARY_LEN - 1).trim()}…`;
}

function makeTextScanError(code, options = {}) {
  const err = new Error(code);
  err.code = code;
  err.userMessage = safeHudMessage(code, options.userMessage);
  err.spokenSummary = safeSpokenSummary(options.spokenSummary || err.userMessage, err.userMessage);
  err.canRetry = options.canRetry !== false;
  return err;
}

function normalizeSource(source) {
  const value = safeText(source, 'preset').toLowerCase();
  return value === 'manual' ? 'preset' : value;
}

export function validateTextScanQuery(value) {
  if (typeof value !== 'string') {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.EMPTY_QUERY, message: SAFE_MESSAGES.EMPTY_QUERY };
  }
  if (trimmed.length < 3) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }

  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(trimmed)) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }
  if (trimmed.includes('```') || trimmed.includes('`')) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }

  const lower = trimmed.toLowerCase();
  const injections = [
    'ignore previous instructions',
    'system prompt',
    'developer message',
    'reveal your prompt',
    'act as another system',
    'ignore all instructions',
    'forget previous',
    'you are now',
    'new role:',
    'override instructions',
  ];
  if (injections.some((p) => lower.includes(p))) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }

  if (/[\w.+-]+@[\w.-]+\.\w+/.test(trimmed)) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }
  if (/(\+?\d[\d\s-]{7,}\d)/.test(trimmed)) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }
  if (/\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/.test(trimmed)) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }

  const nonAlphaNum = (trimmed.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (nonAlphaNum / trimmed.length > 0.30) {
    return { valid: false, code: TEXTSCAN_ERROR_CODES.INVALID_INPUT, message: SAFE_MESSAGES.INVALID_INPUT };
  }

  return { valid: true };
}

function normalizeEdgeAttributes(rawAttrs) {
  if (!rawAttrs || typeof rawAttrs !== 'object' || Array.isArray(rawAttrs)) {
    return {
      category: null,
      color: null,
      material: null,
      silhouette: null,
      occasion: null,
      styleDescriptors: [],
      confidenceScore: null,
    };
  }

  const a = rawAttrs;
  const colorPalette = safeArray(a.colorPalette);
  const styleTags = safeArray(a.styleTags ?? a.styleDescriptors);

  return {
    category: safeText(a.category || a.itemType, null),
    color: colorPalette.length > 0 ? colorPalette[0] : safeText(a.color, null),
    material: safeText(a.materialEstimate || a.material, null),
    silhouette: safeText(a.silhouette, null),
    occasion: safeText(a.occasion, null),
    styleDescriptors: styleTags,
    confidenceScore: clampConfidence(a.confidenceScore),
  };
}

function isMalformedEdgeResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return true;
  const status = safeText(response.status, '').toLowerCase();
  if (!status) return true;
  if (status.includes('non')) return false;
  if (status === 'failed') return false;
  if (!response.attributes || typeof response.attributes !== 'object' || Array.isArray(response.attributes)) return true;
  return false;
}

export function buildTextScanStyleMatch(response, query, isDemo = false) {
  const r = response && typeof response === 'object' ? response : {};
  const status = safeText(r.status, '').toLowerCase();
  const isNonFashion = status.includes('non');
  const isMalformed = isMalformedEdgeResponse(r);
  const isFailed = status === 'failed' || isMalformed;

  const attrs = normalizeEdgeAttributes(r.attributes);
  const confidence = isNonFashion ? 0 : attrs.confidenceScore;
  const userMessage = safeText(r.userMessage, '');
  const errorCode = isNonFashion
    ? TEXTSCAN_ERROR_CODES.NON_FASHION
    : isMalformed
      ? TEXTSCAN_ERROR_CODES.MALFORMED_RESPONSE
      : TEXTSCAN_ERROR_CODES.UNKNOWN;
  const summary = isNonFashion || isFailed
    ? safeHudMessage(errorCode)
    : userMessage || 'Analyzed your fashion request.';
  const spokenSummary = safeSpokenSummary(
    isNonFashion || isFailed ? summary : userMessage || 'TextScan found a fashion style match.',
    summary,
  );

  return {
    id: makeId('textscan'),
    source: 'textscan',
    confidence,
    summary,
    spokenSummary,
    intent: {
      style: attrs.styleDescriptors.length > 0 ? attrs.styleDescriptors.join(', ') : null,
      occasion: attrs.occasion,
      colors: attrs.color ? [attrs.color] : [],
      materials: attrs.material ? [attrs.material] : [],
      silhouette: attrs.silhouette,
      keywords: attrs.styleDescriptors,
    },
    items: { retail: [], resale: [], suggested: [] },
    actions: {
      canSave: !isNonFashion && !isFailed,
      canOpenOnPhone: false,
    },
    meta: {
      scanModeLabel: 'TextScan',
      confidenceLabel: confidence !== null ? `${Math.round(confidence * 100)}%` : 'Unavailable',
      isDemo,
    },
    ...(isFailed || isNonFashion
      ? {
          error: {
            code: errorCode,
            message: summary,
            canRetry: !isNonFashion,
          },
        }
      : {}),
  };
}

function buildErrorStyleMatch(error, query, isDemo = false) {
  const code = error?.code || TEXTSCAN_ERROR_CODES.UNKNOWN;
  const message = safeHudMessage(code, error?.userMessage);
  return {
    id: makeId('textscan_err'),
    source: 'textscan',
    confidence: 0,
    summary: message,
    spokenSummary: safeSpokenSummary(error?.spokenSummary || message, message),
    intent: { style: null, occasion: null, colors: [], materials: [], silhouette: null, keywords: [] },
    items: { retail: [], resale: [], suggested: [] },
    actions: { canSave: false, canOpenOnPhone: false },
    meta: {
      scanModeLabel: 'TextScan',
      confidenceLabel: 'Unavailable',
      isDemo,
    },
    error: {
      code,
      message,
      canRetry: error?.canRetry !== false,
    },
  };
}

function readRuntimeMockFlag() {
  if (typeof window === 'undefined') return false;
  const config = window.__KSCAN_CONFIG__;
  if (!config || typeof config !== 'object') return false;
  return (config.KSCAN_SIMULATOR === true || config.DEV === true) && config.VITE_MOCK_TEXTSCAN === true;
}

function isMockMode(options) {
  if (options.mock === true) return true;
  if (readRuntimeMockFlag()) return true;
  const env = import.meta.env || {};
  return env.DEV === true && env.VITE_MOCK_TEXTSCAN === 'true';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function invokeErrorStatus(error) {
  return error?.status || error?.context?.status || error?.cause?.status || error?.response?.status || 0;
}

function isAuthError(error) {
  const status = invokeErrorStatus(error);
  const message = safeText(error?.message, '').toLowerCase();
  return status === 401 || status === 403 || message.includes('jwt') || message.includes('auth');
}

function isRetryableNetworkError(error) {
  const status = invokeErrorStatus(error);
  if (status >= 500) return true;
  if (error?.name === 'AbortError') return false;
  return !status;
}

async function invokeScanIdentify(textQuery, source, signal) {
  const { data, error } = await invokeSupabaseFunction(EDGE_FUNCTION, {
    body: {
      mode: 'text',
      textQuery,
      source,
      clientTimestamp: new Date().toISOString(),
    },
    signal,
  });

  if (error) {
    error.status = invokeErrorStatus(error);
    throw error;
  }
  if (isMalformedEdgeResponse(data)) {
    throw makeTextScanError(TEXTSCAN_ERROR_CODES.MALFORMED_RESPONSE, { canRetry: true });
  }
  return data;
}

async function invokeWithRetry(textQuery, source) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  let authRetried = false;
  let networkRetries = 0;

  try {
    while (Date.now() - startedAt < TOTAL_TIMEOUT_MS) {
      try {
        return await invokeScanIdentify(textQuery, source, controller.signal);
      } catch (error) {
        if (error?.code === TEXTSCAN_ERROR_CODES.CONFIG_REQUIRED) {
          throw makeTextScanError(TEXTSCAN_ERROR_CODES.CONFIG_REQUIRED, { canRetry: false });
        }
        if (error?.code === TEXTSCAN_ERROR_CODES.AUTH_REQUIRED) {
          throw makeTextScanError(TEXTSCAN_ERROR_CODES.AUTH_REQUIRED, { canRetry: false });
        }
        if (error?.code === TEXTSCAN_ERROR_CODES.MALFORMED_RESPONSE) throw error;
        if (error?.name === 'AbortError') {
          throw makeTextScanError(TEXTSCAN_ERROR_CODES.TIMEOUT, { canRetry: true });
        }
        if (isAuthError(error) && !authRetried) {
          authRetried = true;
          const refreshed = await refreshSupabaseSession();
          if (refreshed.linked) continue;
          throw makeTextScanError(TEXTSCAN_ERROR_CODES.AUTH_REQUIRED, { canRetry: false });
        }
        if (isRetryableNetworkError(error) && networkRetries < NETWORK_RETRY_DELAYS_MS.length) {
          const delay = NETWORK_RETRY_DELAYS_MS[networkRetries];
          networkRetries += 1;
          if (Date.now() - startedAt + delay >= TOTAL_TIMEOUT_MS) {
            throw makeTextScanError(TEXTSCAN_ERROR_CODES.TIMEOUT, { canRetry: true });
          }
          await sleep(delay, controller.signal);
          continue;
        }
        throw makeTextScanError(TEXTSCAN_ERROR_CODES.NETWORK_ERROR, { canRetry: true });
      }
    }
    throw makeTextScanError(TEXTSCAN_ERROR_CODES.TIMEOUT, { canRetry: true });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function analyzeTextQuery(textQuery, options = {}) {
  const source = normalizeSource(options.source || 'preset');
  const trimmed = safeText(textQuery, '');
  const capped = clampText(trimmed, MAX_TEXT_QUERY_LEN);
  const mock = isMockMode(options);

  const validation = validateTextScanQuery(capped);
  if (!validation.valid) {
    throw makeTextScanError(validation.code, {
      userMessage: validation.message,
      spokenSummary: validation.message,
      canRetry: validation.code !== TEXTSCAN_ERROR_CODES.EMPTY_QUERY,
    });
  }

  if (mock) {
    const mockResponse = await runMockScenario(capped, source);
    return buildTextScanStyleMatch(mockResponse, capped, true);
  }

  if (liveRequestInFlight) {
    throw makeTextScanError(TEXTSCAN_ERROR_CODES.BUSY, { canRetry: true });
  }
  liveRequestInFlight = true;

  try {
    if (!hasSupabaseConfig() || !getSupabaseClient()) {
      throw makeTextScanError(TEXTSCAN_ERROR_CODES.CONFIG_REQUIRED, { canRetry: false });
    }

    const session = await getSupabaseSession();
    if (options.requireAuth !== false && !session.linked) {
      throw makeTextScanError(TEXTSCAN_ERROR_CODES.AUTH_REQUIRED, { canRetry: false });
    }

    const response = await invokeWithRetry(capped, source);
    return buildTextScanStyleMatch(response, capped, false);
  } catch (error) {
    if (error?.code && TEXTSCAN_ERROR_CODES[error.code]) throw error;
    throw makeTextScanError(TEXTSCAN_ERROR_CODES.UNKNOWN, { canRetry: true });
  } finally {
    liveRequestInFlight = false;
  }
}

const MOCK_SCENARIOS = {
  'black oversized blazer': {
    status: 'completed',
    attributes: {
      category: 'Outerwear',
      itemType: 'Blazer',
      silhouette: 'Oversized',
      colorPalette: ['Black'],
      materialEstimate: 'Wool blend',
      styleTags: ['minimal', 'structured', 'quiet luxury'],
      occasion: 'Work',
      confidenceScore: 0.92,
    },
    userMessage: 'Black oversized blazer with structured shoulders.',
    recommendedProducts: [],
  },
  'quiet luxury office outfit': {
    status: 'completed',
    attributes: {
      category: 'Outfit',
      itemType: 'Suit',
      silhouette: 'Tailored',
      colorPalette: ['Charcoal', 'Cream'],
      materialEstimate: 'Cashmere, silk',
      styleTags: ['quiet luxury', 'minimal', 'tailored'],
      occasion: 'Work',
      confidenceScore: 0.88,
    },
    userMessage: 'Quiet luxury office outfit in neutral tones.',
    recommendedProducts: [],
  },
  'blue bag': {
    status: 'completed',
    attributes: {
      category: 'Accessories',
      itemType: 'Handbag',
      silhouette: 'Structured',
      colorPalette: ['Navy'],
      materialEstimate: 'Leather',
      styleTags: ['minimal', 'classic'],
      occasion: 'Everyday',
      confidenceScore: 0.85,
    },
    userMessage: 'Structured navy leather handbag.',
    recommendedProducts: [],
  },
  'minimal white sneakers': {
    status: 'completed',
    attributes: {
      category: 'Footwear',
      itemType: 'Sneakers',
      silhouette: 'Low-top',
      colorPalette: ['White', 'Off-white'],
      materialEstimate: 'Leather, rubber',
      styleTags: ['minimal', 'clean', 'everyday'],
      occasion: 'Casual',
      confidenceScore: 0.90,
    },
    userMessage: 'Minimal white low-top sneakers.',
    recommendedProducts: [],
  },
  'streetwear hoodie minimal': {
    status: 'completed',
    attributes: {
      category: 'Tops',
      itemType: 'Hoodie',
      silhouette: 'Relaxed',
      colorPalette: ['Heather Grey'],
      materialEstimate: 'Cotton fleece',
      styleTags: ['streetwear', 'minimal', 'oversized'],
      occasion: 'Casual',
      confidenceScore: 0.87,
    },
    userMessage: 'Minimal streetwear hoodie in relaxed fit.',
    recommendedProducts: [],
  },
  'non fashion test': {
    status: 'non_fashion',
    userMessage: "This doesn't appear to be a fashion query.",
    recommendedProducts: [],
  },
  'asdf random': {
    status: 'non_fashion',
    userMessage: "This doesn't appear to be a fashion query.",
    recommendedProducts: [],
  },
  'network failure': {
    status: 'failed',
    userMessage: 'Connection failed.',
    recommendedProducts: [],
  },
  'malformed response': {
    status: 'completed',
    userMessage: 'Unexpected response.',
    recommendedProducts: [],
  },
};

async function runMockScenario(query) {
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });

  const lower = query.toLowerCase().trim();
  if (MOCK_SCENARIOS[lower]) return MOCK_SCENARIOS[lower];

  for (const [key, scenario] of Object.entries(MOCK_SCENARIOS)) {
    if (lower.includes(key.split(' ')[0]) || key.includes(lower.split(' ')[0])) return scenario;
  }

  return {
    status: 'completed',
    attributes: {
      category: 'Fashion',
      itemType: 'Item',
      colorPalette: ['Neutral'],
      styleTags: ['minimal'],
      confidenceScore: 0.75,
    },
    userMessage: `Analyzed: "${query}"`,
    recommendedProducts: [],
  };
}

export const TEXTSCAN_SIMULATOR_SCENARIOS = [
  { id: 'black-blazer', label: 'Black Oversized Blazer', query: 'black oversized blazer', source: 'preset' },
  { id: 'quiet-luxury', label: 'Quiet Luxury Office', query: 'quiet luxury office outfit', source: 'preset' },
  { id: 'blue-bag', label: 'Blue Bag', query: 'blue bag', source: 'preset' },
  { id: 'white-sneakers', label: 'Minimal White Sneakers', query: 'minimal white sneakers', source: 'preset' },
  { id: 'streetwear-hoodie', label: 'Streetwear Hoodie', query: 'streetwear hoodie minimal', source: 'preset' },
  { id: 'non-fashion', label: 'Non-Fashion Test', query: 'asdf random', source: 'preset' },
  { id: 'network-fail', label: 'Network Failure', query: 'network failure', source: 'preset' },
  { id: 'malformed', label: 'Malformed Response', query: 'malformed response', source: 'preset' },
];

export async function runSimulatorScenario(scenarioId) {
  const scenario = TEXTSCAN_SIMULATOR_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    throw makeTextScanError(TEXTSCAN_ERROR_CODES.UNKNOWN, { canRetry: false });
  }
  return analyzeTextQuery(scenario.query, { source: scenario.source, mock: true });
}

export function textScanErrorToStyleMatch(error, query, isDemo = false) {
  return buildErrorStyleMatch(error, query, isDemo);
}
