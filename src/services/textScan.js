// TextScan adapter for Meta Ray-Ban Display webapp.
//
// Bridges text-origin fashion queries to the canonical scan-identify Edge Function
// (mode: 'text'). Returns a StyleMatch-compatible shape for the HUD renderer.
//
// Architecture note:
//   - This is a Meta-webapp-only adapter. No Google glasses abstraction.
//   - Supabase auth is a future seam; when the app installs @supabase/supabase-js
//     and wires a real client, the TODOs below become live calls.
//   - Until then, live calls return AUTH_REQUIRED and the UI falls back to
//     simulator/mock mode.
//
// Phase 25 build: 2026-06-20

// ═══════════════════════════════════════════════════════════════════
// Error codes
// ═══════════════════════════════════════════════════════════════════

export const TEXTSCAN_ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  EMPTY_QUERY: 'EMPTY_QUERY',
  INVALID_INPUT: 'INVALID_INPUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  NON_FASHION: 'NON_FASHION',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
};

// ═══════════════════════════════════════════════════════════════════
// HUD-safe messages (≤ 60 chars where possible)
// ═══════════════════════════════════════════════════════════════════

const SAFE_EMPTY_MESSAGE = 'Enter a fashion description to start.';
const SAFE_AUTH_MESSAGE = 'Sign in to analyze fashion requests.';
const SAFE_NETWORK_MESSAGE = 'Connection failed. Try again.';
const SAFE_MALFORMED_MESSAGE = 'Unexpected response. Try again.';
const SAFE_NON_FASHION_MESSAGE = 'Not a fashion query. Try again.';
const SAFE_TIMEOUT_MESSAGE = 'Taking too long. Try again.';
const SAFE_UNKNOWN_MESSAGE = 'Something went wrong. Try again.';
const SAFE_INVALID_MESSAGE = 'Invalid input. Describe a fashion item.';

const MAX_TEXT_QUERY_LEN = 500;

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function safeText(value, fallback) {
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

// ═══════════════════════════════════════════════════════════════════
// Input validation (mirrors KScan mobile app rules)
// ═══════════════════════════════════════════════════════════════════

export function validateTextScanQuery(value) {
  if (typeof value !== 'string') {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { valid: false, message: SAFE_EMPTY_MESSAGE };
  }
  if (trimmed.length < 3) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }
  if (trimmed.length > MAX_TEXT_QUERY_LEN) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject base64-like payloads
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(trimmed)) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject code blocks
  if (trimmed.includes('```') || trimmed.includes('`')) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject prompt injection patterns
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
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject email addresses
  if (/[\w.+-]+@[\w.-]+\.\w+/.test(trimmed)) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject phone numbers
  if (/(\+?\d[\d\s-]{7,}\d)/.test(trimmed)) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject SSN-like patterns
  if (/\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/.test(trimmed)) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  // Reject excessive non-alphanumeric characters
  const nonAlphaNum = (trimmed.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (nonAlphaNum / trimmed.length > 0.30) {
    return { valid: false, message: SAFE_INVALID_MESSAGE };
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════════════════
// Edge response → StyleMatch adapter
// ═══════════════════════════════════════════════════════════════════

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

  // colorPalette is string[] from edge; take first as primary color
  const colorPalette = safeArray(a.colorPalette);
  const color = colorPalette.length > 0 ? colorPalette[0] : safeText(a.color, null);

  // styleTags is string[] from edge
  const styleTags = safeArray(a.styleTags);

  return {
    category: safeText(a.category || a.itemType, null),
    color,
    material: safeText(a.materialEstimate || a.material, null),
    silhouette: safeText(a.silhouette, null),
    occasion: safeText(a.occasion, null),
    styleDescriptors: styleTags,
    confidenceScore: clampConfidence(a.confidenceScore),
  };
}

/**
 * Build a canonical StyleMatch from a scan-identify text-mode response.
 *
 * @param {object} response - raw edge function response
 * @param {string} query - original text query
 * @param {boolean} isDemo - whether this is mock/simulator mode
 * @returns {object} canonical StyleMatch shape
 */
export function buildTextScanStyleMatch(response, query, isDemo = false) {
  const r = response && typeof response === 'object' ? response : {};
  const status = safeText(r.status, '').toLowerCase();
  const isNonFashion = status.includes('non');
  const isFailed = status === 'failed' || (!status && !r.attributes);

  const userMessage = safeText(r.userMessage, '');
  const attrs = normalizeEdgeAttributes(r.attributes);
  const confidence = isNonFashion ? 0 : attrs.confidenceScore;

  const summary = isNonFashion
    ? SAFE_NON_FASHION_MESSAGE
    : isFailed
      ? SAFE_UNKNOWN_MESSAGE
      : userMessage || 'Analyzed your fashion request.';

  return {
    id: makeId('textscan'),
    source: 'textscan',
    confidence,
    summary,

    intent: {
      style: attrs.styleDescriptors.length > 0 ? attrs.styleDescriptors.join(', ') : null,
      occasion: attrs.occasion,
      colors: attrs.color ? [attrs.color] : [],
      materials: attrs.material ? [attrs.material] : [],
      silhouette: attrs.silhouette,
      keywords: attrs.styleDescriptors,
    },

    items: {
      retail: [],
      resale: [],
      suggested: [],
    },

    actions: {
      canSave: !isNonFashion && !isFailed,
      canOpenOnPhone: false,
    },

    meta: {
      scanModeLabel: 'Text Scan',
      confidenceLabel: confidence !== null ? `${Math.round(confidence * 100)}%` : 'Unavailable',
      isDemo,
    },

    // Error envelope (only present on failure)
    ...(isFailed || isNonFashion
      ? {
          error: {
            code: isNonFashion ? TEXTSCAN_ERROR_CODES.NON_FASHION : TEXTSCAN_ERROR_CODES.UNKNOWN,
            message: summary,
            canRetry: !isNonFashion,
          },
        }
      : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Live backend call (future seam — Supabase client not yet installed)
// ═══════════════════════════════════════════════════════════════════

/**
 * Check whether the app has a live Supabase session for TextScan calls.
 *
 * TODO: replace with real session check when @supabase/supabase-js is installed.
 * For now, the app runs in stub mode and live calls are disabled.
 */
function hasLiveSession() {
  // Phase 25: no real Supabase client. Return false until auth is wired.
  return false;
}

/**
 * Invoke the scan-identify Edge Function with mode: 'text'.
 *
 * TODO: wire real supabase.functions.invoke when @supabase/supabase-js is installed
 * and the app has an authenticated session.
 */
async function invokeScanIdentify(textQuery, source) {
  // Future implementation:
  // const { data, error } = await supabase.functions.invoke('scan-identify', {
  //   body: {
  //     mode: 'text',
  //     textQuery,
  //     source,
  //     clientTimestamp: new Date().toISOString(),
  //   },
  // });
  // if (error) throw new Error(TEXTSCAN_ERROR_CODES.NETWORK_ERROR);
  // return data;

  throw new Error(TEXTSCAN_ERROR_CODES.AUTH_REQUIRED);
}

// ═══════════════════════════════════════════════════════════════════
// Main adapter
// ═══════════════════════════════════════════════════════════════════

/**
 * Analyze a fashion text query via the canonical TextScan path.
 *
 * @param {string} textQuery - normalized fashion text query (3–500 chars)
 * @param {object} options
 * @param {string} [options.source='manual'] - source label for tracing
 * @param {boolean} [options.mock=false] - force mock mode (simulator)
 * @returns {Promise<object>} canonical StyleMatch shape
 */
export async function analyzeTextQuery(textQuery, options = {}) {
  const source = safeText(options.source, 'manual');
  const trimmed = safeText(textQuery, '');

  // 1. Validate input
  const validation = validateTextScanQuery(trimmed);
  if (!validation.valid) {
    const err = new Error(TEXTSCAN_ERROR_CODES.INVALID_INPUT);
    err.userMessage = validation.message;
    err.code = TEXTSCAN_ERROR_CODES.INVALID_INPUT;
    err.canRetry = false;
    throw err;
  }

  // 2. Mock/simulator mode — no backend call
  if (options.mock) {
    const mockResponse = await runMockScenario(trimmed, source);
    return buildTextScanStyleMatch(mockResponse, trimmed, true);
  }

  // 3. Check live session availability
  if (!hasLiveSession()) {
    const err = new Error(TEXTSCAN_ERROR_CODES.AUTH_REQUIRED);
    err.userMessage = SAFE_AUTH_MESSAGE;
    err.code = TEXTSCAN_ERROR_CODES.AUTH_REQUIRED;
    err.canRetry = false;
    throw err;
  }

  // 4. Live backend call (future seam)
  try {
    const response = await invokeScanIdentify(trimmed, source);
    return buildTextScanStyleMatch(response, trimmed, false);
  } catch (error) {
    const err = new Error(TEXTSCAN_ERROR_CODES.NETWORK_ERROR);
    err.userMessage = SAFE_NETWORK_MESSAGE;
    err.code = TEXTSCAN_ERROR_CODES.NETWORK_ERROR;
    err.canRetry = true;
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Mock scenarios (simulator / dev-only)
// ═══════════════════════════════════════════════════════════════════

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
    userMessage: 'Connection failed. Try again.',
    recommendedProducts: [],
  },

  'malformed response': {
    status: 'completed',
    attributes: {
      category: 'Unknown',
      confidenceScore: 'not-a-number',
    },
    userMessage: 'Unexpected response.',
    recommendedProducts: [],
  },
};

async function runMockScenario(query, source) {
  // Small delay to simulate network latency
  await new Promise((resolve) => setTimeout(resolve, 800));

  const lower = query.toLowerCase().trim();

  // Exact match first
  if (MOCK_SCENARIOS[lower]) {
    return MOCK_SCENARIOS[lower];
  }

  // Partial match
  for (const [key, scenario] of Object.entries(MOCK_SCENARIOS)) {
    if (lower.includes(key.split(' ')[0]) || key.includes(lower.split(' ')[0])) {
      return scenario;
    }
  }

  // Default: successful generic fashion response
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

// ═══════════════════════════════════════════════════════════════════
// Simulator scenario registry (for external simulator control)
// ═══════════════════════════════════════════════════════════════════

export const TEXTSCAN_SIMULATOR_SCENARIOS = [
  { id: 'black-blazer', label: 'Black Oversized Blazer', query: 'black oversized blazer', source: 'manual' },
  { id: 'quiet-luxury', label: 'Quiet Luxury Office', query: 'quiet luxury office outfit', source: 'manual' },
  { id: 'blue-bag', label: 'Blue Bag', query: 'blue bag', source: 'manual' },
  { id: 'white-sneakers', label: 'Minimal White Sneakers', query: 'minimal white sneakers', source: 'manual' },
  { id: 'streetwear-hoodie', label: 'Streetwear Hoodie', query: 'streetwear hoodie minimal', source: 'manual' },
  { id: 'non-fashion', label: 'Non-Fashion Test', query: 'asdf random', source: 'manual' },
  { id: 'network-fail', label: 'Network Failure', query: 'network failure', source: 'manual' },
  { id: 'malformed', label: 'Malformed Response', query: 'malformed response', source: 'manual' },
];

/**
 * Run a simulator scenario by ID.
 * @param {string} scenarioId - one of TEXTSCAN_SIMULATOR_SCENARIOS[].id
 * @returns {Promise<object>} StyleMatch result
 */
export async function runSimulatorScenario(scenarioId) {
  const scenario = TEXTSCAN_SIMULATOR_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    const err = new Error(TEXTSCAN_ERROR_CODES.UNKNOWN);
    err.userMessage = 'Unknown scenario. Try again.';
    err.code = TEXTSCAN_ERROR_CODES.UNKNOWN;
    err.canRetry = false;
    throw err;
  }
  return analyzeTextQuery(scenario.query, { source: scenario.source, mock: true });
}
