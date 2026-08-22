// Style Match Contract — canonical object shape and adapter layer.
//
// This module separates UI rendering from data sources. The canonical
// `StyleMatch` shape is stable across mock/demo, future backend analyze,
// future TextScan, future StyleChat, and future mobile handoff flows.
//
// Any source-specific adapter should return a fully normalized `StyleMatch`.
// The UI (`renderStyleMatch`, `renderProducts`) consumes ONLY this shape.

// ═══════════════════════════════════════════════════════════════════
// Canonical StyleMatch shape (JSDoc — JS-only repo)
// ═══════════════════════════════════════════════════════════════════
//
// type StyleMatch = {
//   id: string
//   source: 'scan' | 'textscan' | 'stylechat' | 'demo'
//   confidence: number | null
//   summary: string
//
//   intent: {
//     style: string | null
//     occasion: string | null
//     colors: string[]
//     materials: string[]
//     silhouette: string | null
//     keywords: string[]
//   }
//
//   items: {
//     retail: Array<StyleMatchItem>
//     resale: Array<StyleMatchItem>
//     suggested: Array<StyleMatchItem>
//   }
//
//   actions: {
//     canSave: boolean
//     canOpenOnPhone: boolean
//   }
//
//   meta: {
//     scanModeLabel: string | null
//     confidenceLabel: string | null
//     isDemo: boolean
//   }
// }
//
// type StyleMatchItem = {
//   id: string
//   title: string
//   subtitle: string | null
//   priceLabel: string | null
//   imageUrl: string | null
//   href: string | null
//   sourceType: 'retail' | 'resale' | 'suggested'
// }
//
// ═══════════════════════════════════════════════════════════════════

function safeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : [];
}

function makeId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

// ── Deterministic source grouping (preserves current demo behavior) ──
function buildSourceType(index, total) {
  if (index < 2) return 'retail';
  if (index < 3 || (total >= 4 && index === 3)) return 'resale';
  return 'suggested';
}

// ── Normalize a raw product into a StyleMatchItem ──
export function makeStyleMatchItem(product, sourceType) {
  const p = product && typeof product === 'object' ? product : {};
  return {
    id: makeId('item'),
    title: safeText(p.name || p.title || p.productName, 'Unnamed Product'),
    subtitle: safeText(p.brand || p.brandName, 'Unknown Brand'),
    priceLabel: safeText(p.priceRange || p.price || p.priceText, 'Price unavailable'),
    imageUrl: typeof p.imageUrl === 'string' && p.imageUrl.trim() ? p.imageUrl.trim() : null,
    href: typeof p.url === 'string' && p.url.trim() ? p.url.trim() : null,
    sourceType,
  };
}

// ── Normalize any raw source into a canonical StyleMatch ──
export function normalizeStyleMatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const styleMeta = r.style_metadata && typeof r.style_metadata === 'object' ? r.style_metadata : {};
  const products = Array.isArray(r.products) ? r.products : [];

  const confidence = Number.isFinite(styleMeta.confidence) ? styleMeta.confidence : null;
  const scanModeLabel = safeText(styleMeta.scan_mode || styleMeta.mode, null);

  // Build item groups deterministically from the product list
  const items = { retail: [], resale: [], suggested: [] };
  const total = products.length;
  products.forEach((product, index) => {
    const sourceType = buildSourceType(index, total);
    const item = makeStyleMatchItem(product, sourceType);
    items[sourceType].push(item);
  });

  return {
    id: makeId('match'),
    source: 'demo',
    confidence,
    summary: safeText(styleMeta.summary || styleMeta.detected_style || styleMeta.style, 'Modern Minimalist Layering'),

    intent: {
      style: safeText(styleMeta.style || styleMeta.detected_style, null),
      occasion: safeText(styleMeta.occasion, null),
      colors: safeArray(styleMeta.colors),
      materials: safeArray(styleMeta.materials),
      silhouette: safeText(styleMeta.silhouette, null),
      keywords: safeArray(styleMeta.keywords || styleMeta.attributes),
    },

    items,

    actions: {
      canSave: true,
      canOpenOnPhone: true,
    },

    meta: {
      scanModeLabel,
      confidenceLabel: confidence !== null ? `${confidence}% Match` : null,
      isDemo: true,
    },
  };
}

// ── Adapter: real backend analyze response → StyleMatch ──
//
// Used by the wearable scan path when the phone receives a live backend
// result. Returns a canonical StyleMatch with source='scan' and isDemo=false.
export function buildBackendStyleMatch(response) {
  const normalized = normalizeStyleMatch(response);
  // Override demo markers for real backend results
  normalized.source = 'scan';
  normalized.meta.isDemo = false;
  normalized.meta.sourceLabel = 'K SCAN LIVE';
  return normalized;
}

// ── Adapter: current mock/demo analyze response → StyleMatch ──
//
// This is the entry point for the existing investor demo. It takes the
// raw response from `analyzeImage()` (mock or scenario) and returns a
// stable canonical StyleMatch.
//
// Future integrations should add their own adapter that also returns
// a canonical StyleMatch, e.g.:
//   - buildTextScanStyleMatch(textScanResponse)
//   - buildBackendStyleMatch(analyzeResponse)
//   - buildStyleChatStyleMatch(styleChatSeed)
//   - buildHandoffStyleMatch(mobilePayload)
//
// The UI never consumes raw source shapes directly.
export function buildMockStyleMatch(response) {
  return normalizeStyleMatch(response);
}

// ── Minimal empty StyleMatch for safe fallback rendering ──
export function makeEmptyStyleMatch() {
  return {
    id: makeId('match'),
    source: 'demo',
    confidence: null,
    summary: 'No style match found',
    intent: {
      style: null,
      occasion: null,
      colors: [],
      materials: [],
      silhouette: null,
      keywords: [],
    },
    items: {
      retail: [],
      resale: [],
      suggested: [],
    },
    actions: {
      canSave: false,
      canOpenOnPhone: false,
    },
    meta: {
      scanModeLabel: null,
      confidenceLabel: null,
      isDemo: true,
    },
  };
}
