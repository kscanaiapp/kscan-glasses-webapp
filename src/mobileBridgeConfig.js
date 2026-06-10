// Mobile bridge dev-mode configuration (Phase 17).
//
// Decides whether the glasses web app should request capture through the
// K Scan mobile bridge alpha (Wi-Fi/WebSocket dev transport) instead of the
// existing DAT/mock simulator path.
//
// PRODUCTION SAFETY:
// - The mobile bridge is OFF by default. It is enabled only by an explicit
//   dev query param (`?bridge=mobile&bridgeWs=ws://...`), an equivalent
//   hash-appended query param, or the Vite env flag
//   VITE_ENABLE_MOBILE_BRIDGE=true.
// - No bridge connection is opened unless explicitly enabled.
// - This is a K Scan development bridge, NOT a verified Meta glasses
//   transport. `ws://` is unencrypted and is acceptable for localhost / a
//   trusted LAN only — never over the public internet. Production transport
//   would require `wss://`, authentication, and official Meta transport
//   evidence.
//
// Parsing is done once via parseMobileBridgeConfig(); callers receive a
// stable, frozen config object — config is not re-parsed on every render.

export const DEFAULT_MOBILE_BRIDGE_WS_URL = 'ws://localhost:8787';

const ACCEPTED_WS_SCHEMES = ['ws:', 'wss:'];

/**
 * Extract a URLSearchParams covering both the normal query string and a
 * hash-appended query string (SPA/router fallback), e.g.
 *   /?bridge=mobile&bridgeWs=ws://localhost:8787
 *   /#/?bridge=mobile&bridgeWs=ws://localhost:8787
 *   /#?bridge=mobile&bridgeWs=ws://localhost:8787
 * Query string wins over hash when both define the same key.
 */
function buildParams(locationLike) {
  const search = typeof locationLike?.search === 'string' ? locationLike.search : '';
  const hash = typeof locationLike?.hash === 'string' ? locationLike.hash : '';

  const params = new URLSearchParams();

  // Hash first (lower priority), then search (higher priority) so that
  // setting a key in `search` overrides the same key from the hash.
  const hashQueryIndex = hash.indexOf('?');
  if (hashQueryIndex !== -1) {
    const hashQuery = hash.slice(hashQueryIndex + 1);
    for (const [key, value] of new URLSearchParams(hashQuery)) {
      params.set(key, value);
    }
  }

  const searchQuery = search.startsWith('?') ? search.slice(1) : search;
  for (const [key, value] of new URLSearchParams(searchQuery)) {
    params.set(key, value);
  }

  return params;
}

/**
 * Validate that a candidate string is a usable ws:// or wss:// URL.
 * Rejects http/https, empty, relative, malformed, javascript:, data:,
 * file:, and any other scheme. Returns the normalized URL string or null.
 */
export function normalizeWebSocketUrl(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!ACCEPTED_WS_SCHEMES.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;

  return parsed.toString();
}

/**
 * Pure parser used by tests and the cached helpers below.
 * @param {{search?: string, hash?: string}} locationLike
 * @param {Record<string, string|undefined>} envLike  Vite-style env object.
 */
export function parseMobileBridgeConfig(locationLike = {}, envLike = {}) {
  const params = buildParams(locationLike);

  const queryBridge = params.get('bridge');
  const queryWs = params.get('bridgeWs');

  const envEnabled = String(envLike.VITE_ENABLE_MOBILE_BRIDGE || '').toLowerCase() === 'true';
  const envWs = envLike.VITE_MOBILE_BRIDGE_WS_URL;

  // Query param `bridge=mobile` (exact match) requests mobile bridge mode.
  // Otherwise the env flag may enable it. Query param overrides env.
  const requestedViaQuery = queryBridge === 'mobile';
  const enabled = requestedViaQuery || envEnabled;

  if (!enabled) {
    return Object.freeze({
      enabled: false,
      url: null,
      source: 'disabled',
      error: null,
    });
  }

  // Resolve the WS URL:
  //   1. explicit query param `bridgeWs` (highest priority), then
  //   2. explicit env VITE_MOBILE_BRIDGE_WS_URL, then
  //   3. the localhost default — but ONLY when enabled via the env flag
  //      (per Task 2, the env URL is optional). Query-mode requires an
  //      explicit URL so that a bare `?bridge=mobile` fails safely.
  let rawUrl = null;
  let urlSource = null;
  if (typeof queryWs === 'string' && queryWs.length > 0) {
    rawUrl = queryWs;
    urlSource = 'query';
  } else if (typeof envWs === 'string' && envWs.length > 0) {
    rawUrl = envWs;
    urlSource = 'env';
  } else if (envEnabled && !requestedViaQuery) {
    rawUrl = DEFAULT_MOBILE_BRIDGE_WS_URL;
    urlSource = 'default';
  }

  const normalized = rawUrl === null ? null : normalizeWebSocketUrl(rawUrl);
  if (!normalized) {
    // Enabled but the URL is missing/invalid — fail safely.
    return Object.freeze({
      enabled: true,
      url: null,
      source: requestedViaQuery ? 'query' : 'env',
      urlSource,
      error: 'BRIDGE_UNAVAILABLE',
    });
  }

  return Object.freeze({
    enabled: true,
    url: normalized,
    source: requestedViaQuery ? 'query' : 'env',
    urlSource,
    error: null,
  });
}

function readLocation() {
  if (typeof window === 'undefined' || !window.location) {
    return { search: '', hash: '' };
  }
  return { search: window.location.search, hash: window.location.hash };
}

function readEnv() {
  // Reference only the specific vars statically so Vite inlines just these
  // two literals at build time. Accessing the whole `import.meta.env` object
  // would inline the entire env (leaking other VITE_* names/values and
  // defeating dev-code tree-shaking) into the production bundle.
  try {
    return {
      VITE_ENABLE_MOBILE_BRIDGE: import.meta.env.VITE_ENABLE_MOBILE_BRIDGE,
      VITE_MOBILE_BRIDGE_WS_URL: import.meta.env.VITE_MOBILE_BRIDGE_WS_URL,
    };
  } catch {
    return {};
  }
}

// Parse once and cache. Tests should call parseMobileBridgeConfig directly.
let cachedConfig = null;
function getConfig() {
  if (!cachedConfig) {
    cachedConfig = parseMobileBridgeConfig(readLocation(), readEnv());
  }
  return cachedConfig;
}

export function isMobileBridgeEnabled() {
  return getConfig().enabled === true;
}

export function getMobileBridgeUrl() {
  return getConfig().url;
}

export function getMobileBridgeDebugConfig() {
  const config = getConfig();
  // Safe metadata only — never secrets or payloads.
  return {
    enabled: config.enabled,
    url: config.url,
    source: config.source,
    urlSource: config.urlSource || null,
    error: config.error,
  };
}
