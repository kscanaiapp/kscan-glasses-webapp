// Wearable result formatter — converts K Scan backend / companion results
// into a small, bounded HUD payload.
//
// Constraints (do not weaken):
//   - Output must serialize below MAX_WEARABLE_RESULT_BYTES (12 KB).
//   - No image data, base64, or raw capture fields.
//   - URLs are dropped to null if unsafe.
//   - Strings are truncated to safe lengths.
//   - Missing optional fields never crash rendering.

import { isSafeUrl } from './protocol.js';

export const MAX_WEARABLE_RESULT_BYTES = 12 * 1024;

export const FORMATTER_ERRORS = Object.freeze({
  OVERSIZED: 'RESULT_OVERSIZED',
  MALFORMED: 'RESULT_MALFORMED',
  EMPTY: 'RESULT_EMPTY',
});

function safeText(value, maxLen, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[<>\x00-\x1F]/g, '').trim();
  if (!cleaned) return fallback;
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen - 1).trimEnd();
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return isSafeUrl(value.trim()) ? value.trim() : null;
}

function safePrice(price) {
  if (price === null || price === undefined) return 'Price unavailable';
  if (typeof price === 'string') return safeText(price, 40, 'Price unavailable');
  if (typeof price === 'object' && price !== null) {
    const label = safeText(price.label, 40, '');
    if (label) return label;
    if (typeof price.amount === 'number' && Number.isFinite(price.amount) && price.amount >= 0) {
      const cur = safeText(price.currency, 3, 'USD').toUpperCase();
      const symbol = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥' }[cur] || `${cur} `;
      const rounded = Math.round(price.amount * 100) / 100;
      return `${symbol}${rounded % 1 === 0 ? rounded : rounded.toFixed(2)}`;
    }
  }
  return 'Price unavailable';
}

function makeItemId(prefix, index) {
  return `${prefix}_item_${index}`;
}

/**
 * Build a wearable-friendly result from a backend analyze response.
 * This is the adapter used when the phone receives a raw backend result
 * and needs to send a compact result through the bridge.
 *
 * @param {object} backendResult - raw response from K Scan analyzer.
 * @param {string} requestId - active bridge request ID.
 * @returns {{ ok: boolean, result?: object, code?: string }}
 */
export function buildWearableResult(backendResult, requestId) {
  if (!backendResult || typeof backendResult !== 'object') {
    return { ok: false, code: FORMATTER_ERRORS.MALFORMED };
  }

  const products = Array.isArray(backendResult.products) ? backendResult.products : [];
  const meta = backendResult.style_metadata && typeof backendResult.style_metadata === 'object'
    ? backendResult.style_metadata
    : {};

  if (products.length === 0 && !meta.summary && !meta.detected_style) {
    return { ok: false, code: FORMATTER_ERRORS.EMPTY };
  }

  const resultId = `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const primary = products.length > 0 ? {
    title: safeText(products[0].name || products[0].title, 120, 'Unnamed Product'),
    brand: safeText(products[0].brand || products[0].brandName, 80),
    price: { label: safePrice(products[0].price || products[0].priceText) },
    commerceGroup: 'retail',
    retailer: safeText(products[0].brand || products[0].brandName || products[0].retailer, 80),
    thumbnailUrl: safeUrl(products[0].imageUrl || products[0].image || products[0].thumbnail),
    href: safeUrl(products[0].url || products[0].productUrl || products[0].link),
  } : null;

  const alternatives = products.slice(1, 6).map((p, i) => ({
    title: safeText(p.name || p.title, 120, 'Unnamed Product'),
    brand: safeText(p.brand || p.brandName, 80),
    price: { label: safePrice(p.price || p.priceText) },
    commerceGroup: i < 2 ? 'retail' : 'resale',
    retailer: safeText(p.brand || p.brandName || p.retailer, 80),
    resaleSource: safeText(p.resaleSource || p.marketplace, 80),
    thumbnailUrl: safeUrl(p.imageUrl || p.image || p.thumbnail),
    href: safeUrl(p.url || p.productUrl || p.link),
  }));

  const confidence = typeof meta.confidence === 'number' && meta.confidence >= 0 && meta.confidence <= 100
    ? Math.round(meta.confidence)
    : null;

  const result = {
    resultId,
    requestId,
    summary: safeText(meta.summary || meta.detected_style || 'Style match found', 300),
    confidence,
    primaryMatch: primary,
    alternatives,
    actions: ['save', 'open_on_phone'],
    generatedAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    demoMode: false,
  };

  // Size check
  const size = JSON.stringify(result).length;
  if (size > MAX_WEARABLE_RESULT_BYTES) {
    // Trim: drop thumbnails first, then trim alternatives
    if (primary) primary.thumbnailUrl = null;
    alternatives.forEach((a) => { a.thumbnailUrl = null; });
    const trimmedSize = JSON.stringify(result).length;
    if (trimmedSize > MAX_WEARABLE_RESULT_BYTES) {
      // Hard trim: keep only primary + 2 alternatives
      result.alternatives = alternatives.slice(0, 2);
      const hardSize = JSON.stringify(result).length;
      if (hardSize > MAX_WEARABLE_RESULT_BYTES) {
        return { ok: false, code: FORMATTER_ERRORS.OVERSIZED };
      }
    }
  }

  return { ok: true, result };
}

/**
 * Convert a canonical StyleMatch (from styleMatchContract.js) into a
 * wearable HUD payload. Used when the phone already has a StyleMatch
 * and needs to send it through the bridge in the companion wire format.
 *
 * @param {object} styleMatch - canonical StyleMatch shape.
 * @param {string} requestId - active bridge request ID.
 * @returns {{ ok: boolean, result?: object, code?: string }}
 */
const COMMERCE_GROUPS = new Set(['retail', 'resale', 'suggested']);

export function buildWearableResultFromStyleMatch(styleMatch, requestId) {
  if (!styleMatch || typeof styleMatch !== 'object') {
    return { ok: false, code: FORMATTER_ERRORS.MALFORMED };
  }

  const allItems = [
    ...(styleMatch.items?.retail || []),
    ...(styleMatch.items?.resale || []),
    ...(styleMatch.items?.suggested || []),
  ];

  if (allItems.length === 0 && !styleMatch.summary) {
    return { ok: false, code: FORMATTER_ERRORS.EMPTY };
  }

  const resultId = styleMatch.id || `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const primary = allItems.length > 0 ? {
    title: safeText(allItems[0].title, 120, 'Unnamed Product'),
    brand: safeText(allItems[0].subtitle, 80),
    price: { label: safeText(allItems[0].priceLabel, 40, 'Price unavailable') },
    // Preserve the item's own group. Collapsing anything that is not
    // 'resale' into 'retail' was the outbound half of the same defect: a
    // suggested item made the round trip and came back labelled retail.
    commerceGroup: COMMERCE_GROUPS.has(allItems[0].sourceType) ? allItems[0].sourceType : 'retail',
    retailer: safeText(allItems[0].subtitle, 80),
    thumbnailUrl: safeUrl(allItems[0].imageUrl),
    href: safeUrl(allItems[0].href),
  } : null;

  const alternatives = allItems.slice(1, 6).map((item, i) => ({
    title: safeText(item.title, 120, 'Unnamed Product'),
    brand: safeText(item.subtitle, 80),
    price: { label: safeText(item.priceLabel, 40, 'Price unavailable') },
    commerceGroup: item.sourceType === 'resale' ? 'resale' : 'retail',
    retailer: safeText(item.subtitle, 80),
    thumbnailUrl: safeUrl(item.imageUrl),
    href: safeUrl(item.href),
  }));

  const result = {
    resultId,
    requestId,
    summary: safeText(styleMatch.summary, 300, 'Style match found'),
    confidence: styleMatch.confidence !== null && styleMatch.confidence !== undefined
      ? Math.round(styleMatch.confidence)
      : null,
    primaryMatch: primary,
    alternatives,
    actions: ['save', 'open_on_phone'],
    generatedAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    demoMode: styleMatch.meta?.isDemo === true,
  };

  const size = JSON.stringify(result).length;
  if (size > MAX_WEARABLE_RESULT_BYTES) {
    if (primary) primary.thumbnailUrl = null;
    alternatives.forEach((a) => { a.thumbnailUrl = null; });
    const trimmedSize = JSON.stringify(result).length;
    if (trimmedSize > MAX_WEARABLE_RESULT_BYTES) {
      result.alternatives = alternatives.slice(0, 2);
      const hardSize = JSON.stringify(result).length;
      if (hardSize > MAX_WEARABLE_RESULT_BYTES) {
        return { ok: false, code: FORMATTER_ERRORS.OVERSIZED };
      }
    }
  }

  return { ok: true, result };
}
