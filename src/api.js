const ANALYZE_TIMEOUT_MS = 25000;
const ANALYZE_SLOW_HINT_MS = 5000;

export const ANALYZE_ERROR_CODES = {
  BACKEND_NOT_CONFIGURED: 'BACKEND_NOT_CONFIGURED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  NON_2XX: 'NON_2XX',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_SHAPE: 'INVALID_SHAPE',
};

export class AnalyzeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnalyzeError';
    this.code = code;
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

function normalizeProduct(item) {
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

export async function analyzeImage(sanitizedBase64, options = {}) {
  const backend = normalizeBackendUrl(import.meta.env.VITE_KSCAN_BACKEND_URL);
  if (!backend) {
    throw new AnalyzeError(ANALYZE_ERROR_CODES.BACKEND_NOT_CONFIGURED, 'Backend not configured.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  const slowHintId = setTimeout(() => {
    if (typeof options.onSlow === 'function') options.onSlow();
  }, ANALYZE_SLOW_HINT_MS);

  try {
    let response;
    try {
      response = await fetch(`${backend}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: sanitizedBase64 }),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapAnalyzeError(error);
    }

    if (!response.ok) {
      throw new AnalyzeError(ANALYZE_ERROR_CODES.NON_2XX, 'Analysis failed. Please try again.');
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new AnalyzeError(ANALYZE_ERROR_CODES.INVALID_JSON, 'Unexpected server response.');
    }

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
  } finally {
    clearTimeout(timeoutId);
    clearTimeout(slowHintId);
  }
}
