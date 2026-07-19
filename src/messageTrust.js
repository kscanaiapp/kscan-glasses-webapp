// Canonical postMessage trust policy — hardware-validation candidate.
//
// ONE shared evaluator for every inbound window.message channel in the app:
// Supabase session bridge, capture bridge state machine (bridgeState.js),
// and the DAT adapter (datBridge.js wraps this evaluator).
//
// Default trust rules (deliberately strict):
//   - event.origin must be a well-formed https: origin (http: only for
//     localhost dev) and must match the current origin OR an explicitly
//     configured allowlist entry.
//   - 'null' origins are always rejected.
//   - Wildcard ('*') allowlist entries are ignored by design.
//   - Malformed origins are rejected, both on the event and in allowlists.
//   - When requireSource is true (default), event.source must be one of the
//     explicitly approved source windows (normally window.parent / window).
//   - Message data must be an object with an allowlisted `type` when
//     allowedTypes is provided.
//
// There is NO origin-blind hardware mode. A cross-origin Meta runtime parent
// is only ever trusted when its exact origin is pinned via configuration.

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export const MESSAGE_TRUST_REASONS = {
  OK_SELF_ORIGIN: 'OK_SELF_ORIGIN',
  OK_ALLOWLISTED_ORIGIN: 'OK_ALLOWLISTED_ORIGIN',
  REJECT_MISSING_EVENT: 'REJECT_MISSING_EVENT',
  REJECT_MISSING_MESSAGE_DATA: 'REJECT_MISSING_MESSAGE_DATA',
  REJECT_UNSUPPORTED_MESSAGE_TYPE: 'REJECT_UNSUPPORTED_MESSAGE_TYPE',
  REJECT_NULL_ORIGIN: 'REJECT_NULL_ORIGIN',
  REJECT_MALFORMED_ORIGIN: 'REJECT_MALFORMED_ORIGIN',
  REJECT_ORIGIN_NOT_ALLOWED: 'REJECT_ORIGIN_NOT_ALLOWED',
  REJECT_SOURCE_NOT_APPROVED: 'REJECT_SOURCE_NOT_APPROVED',
};

/**
 * Normalize a serialized origin string to its canonical form.
 * Returns null for anything that is not an acceptable origin:
 * non-strings, empty, 'null', '*', unparseable, non-https (except local
 * http dev origins), or strings that are not exactly a serialized origin.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'null') return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const isHttps = url.protocol === 'https:';
  const isLocalHttp = url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname);
  if (!isHttps && !isLocalHttp) return null;
  // Must be exactly a serialized origin — no path, query, hash, or userinfo.
  if (url.origin !== trimmed) return null;
  return url.origin;
}

/**
 * Build the effective origin allowlist: the app's own origin plus any
 * explicitly configured entries (comma-separated strings or arrays).
 * Wildcards, 'null', and malformed entries are dropped silently.
 */
export function buildMessageOriginAllowlist(entries = [], selfOrigin = '') {
  const list = new Set();
  const self = normalizeOrigin(selfOrigin);
  if (self) list.add(self);
  const flat = Array.isArray(entries) ? entries : [entries];
  for (const entry of flat) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const normalized = normalizeOrigin(part);
      if (normalized) list.add(normalized);
    }
  }
  return list;
}

/**
 * Evaluate whether an inbound message event may be trusted.
 *
 * @param {object} eventLike - the MessageEvent (or a test stub).
 * @param {object} options
 * @param {Set<string>} [options.allowlist] - normalized origin allowlist.
 * @param {string} [options.selfOrigin] - window.location.origin of the app.
 * @param {Array} [options.approvedSources] - approved event.source windows
 *   (normally [window.parent, window]).
 * @param {boolean} [options.requireSource=true] - pin event.source.
 * @param {Set<string>} [options.allowedTypes] - when given, data.type must
 *   be a member and data must be an object.
 * @returns {{ trusted: boolean, reason: string }}
 */
export function evaluateMessageTrust(eventLike, options = {}) {
  const {
    allowlist = new Set(),
    selfOrigin = '',
    approvedSources = [],
    requireSource = true,
    allowedTypes = null,
  } = options;
  const R = MESSAGE_TRUST_REASONS;

  if (!eventLike || typeof eventLike !== 'object') {
    return { trusted: false, reason: R.REJECT_MISSING_EVENT };
  }

  if (allowedTypes instanceof Set) {
    const data = eventLike.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { trusted: false, reason: R.REJECT_MISSING_MESSAGE_DATA };
    }
    if (typeof data.type !== 'string' || !allowedTypes.has(data.type)) {
      return { trusted: false, reason: R.REJECT_UNSUPPORTED_MESSAGE_TYPE };
    }
  }

  const origin = eventLike.origin;
  if (origin === 'null' || origin === null || origin === undefined || origin === '') {
    return { trusted: false, reason: R.REJECT_NULL_ORIGIN };
  }
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return { trusted: false, reason: R.REJECT_MALFORMED_ORIGIN };
  }

  const normalizedSelf = normalizeOrigin(selfOrigin);
  const isSelf = normalizedSelf !== null && normalizedOrigin === normalizedSelf;
  if (!isSelf && !allowlist.has(normalizedOrigin)) {
    return { trusted: false, reason: R.REJECT_ORIGIN_NOT_ALLOWED };
  }

  if (requireSource) {
    const sources = Array.isArray(approvedSources) ? approvedSources.filter(Boolean) : [];
    if (sources.length === 0 || !sources.includes(eventLike.source)) {
      return { trusted: false, reason: R.REJECT_SOURCE_NOT_APPROVED };
    }
  }

  return {
    trusted: true,
    reason: isSelf ? R.OK_SELF_ORIGIN : R.OK_ALLOWLISTED_ORIGIN,
  };
}
