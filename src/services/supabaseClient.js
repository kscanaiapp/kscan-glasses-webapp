import { createClient } from '@supabase/supabase-js';
import {
  buildMessageOriginAllowlist,
  evaluateMessageTrust,
} from '../messageTrust.js';

const SESSION_MESSAGE_TYPES = new Set([
  'kscan:supabase-session',
  'kscan:supabase-token',
]);

let client = null;
let clientConfigKey = '';
let sessionMessageListenerInstalled = false;
let bearerOverride = null;
let lastSessionSource = 'none';
let lastSessionLinked = false;
let testClient = null;
let testConfig = null;

function readRuntimeConfig() {
  if (typeof window === 'undefined') return {};
  const config = window.__KSCAN_CONFIG__;
  return config && typeof config === 'object' ? config : {};
}

function readViteEnv() {
  try {
    return {
      VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
      VITE_SESSION_ALLOWED_ORIGINS: import.meta.env.VITE_SESSION_ALLOWED_ORIGINS,
      VITE_SUPABASE_PERSIST_SESSION: import.meta.env.VITE_SUPABASE_PERSIST_SESSION,
    };
  } catch {
    return {};
  }
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * URL-token intake is ONLY ever enabled in the dev server or the explicit
 * LOCAL QA simulator build. The expression below is written so the bundler
 * can constant-fold it in production (`__KSCAN_SIMULATOR_BUILD__` → false,
 * `import.meta.env.DEV` → false), which makes the entire intake path dead
 * code that is tree-shaken out of the shipped bundle — there is no reachable
 * way to feed tokens via query string or fragment.
 * `typeof` guards keep Node test contexts (no vite env) safe.
 */
export function computeUrlTokenIntakeEnabled({ simulatorBuild = false, dev = false } = {}) {
  return simulatorBuild === true || dev === true;
}

const URL_TOKEN_INTAKE_ENABLED =
  (typeof __KSCAN_SIMULATOR_BUILD__ !== 'undefined' && __KSCAN_SIMULATOR_BUILD__ === true) ||
  (typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true);

/**
 * Session persistence policy:
 *   - production / private hardware QA: never persist (false).
 *   - public/shared preview: never persist (false).
 *   - trusted local developer mode: only when explicitly configured with
 *     VITE_SUPABASE_PERSIST_SESSION=true in a dev server.
 * A real session is never persisted merely because the SDK defaults to it.
 */
export function computePersistSessionEnabled({ dev = false, envFlag = '' } = {}) {
  return dev === true && safeString(envFlag) === 'true';
}

function isPersistSessionEnabled() {
  let dev = false;
  try {
    dev = import.meta.env.DEV === true;
  } catch {
    dev = false;
  }
  return computePersistSessionEnabled({
    dev,
    envFlag: readViteEnv().VITE_SUPABASE_PERSIST_SESSION,
  });
}

// ── Client construction ────────────────────────────────────────────────────

export function getSupabaseConfig() {
  if (testConfig) return testConfig;
  const runtime = readRuntimeConfig();
  const env = readViteEnv();
  const url = safeString(runtime.SUPABASE_URL) || safeString(env.VITE_SUPABASE_URL);
  const anonKey = safeString(runtime.SUPABASE_ANON_KEY) || safeString(env.VITE_SUPABASE_ANON_KEY);
  return { url, anonKey, configured: Boolean(url && anonKey) };
}

export function hasSupabaseConfig() {
  return getSupabaseConfig().configured;
}

export function getSupabaseClient() {
  if (testClient) return testClient;
  const config = getSupabaseConfig();
  if (!config.configured) return null;

  const key = `${config.url}::${config.anonKey}`;
  if (client && clientConfigKey === key) return client;

  clientConfigKey = key;
  client = createClient(config.url, config.anonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: isPersistSessionEnabled(),
    },
  });
  return client;
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const accessToken = safeString(value.access_token) || safeString(value.accessToken);
  const refreshToken = safeString(value.refresh_token) || safeString(value.refreshToken);
  if (!accessToken) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

function readTokenFromRuntimeConfig() {
  const runtime = readRuntimeConfig();
  const session =
    normalizeSession(runtime.supabaseSession) ||
    normalizeSession(runtime.SUPABASE_SESSION);
  if (session) return { session, source: 'runtime-session' };

  const accessToken =
    safeString(runtime.supabaseAccessToken) ||
    safeString(runtime.AUTH_TOKEN);
  if (accessToken) return { accessToken, source: 'runtime-token' };
  return null;
}

// ── URL token intake (dev / LOCAL QA simulator builds only) ───────────────
// Never reachable in production builds: URL_TOKEN_INTAKE_ENABLED is a
// compile-time false there and the call site folds away.
function readTokenFromSearchParams(params) {
  const accessToken =
    safeString(params.get('access_token')) ||
    safeString(params.get('supabaseAccessToken')) ||
    safeString(params.get('AUTH_TOKEN'));
  const refreshToken =
    safeString(params.get('refresh_token')) ||
    safeString(params.get('supabaseRefreshToken'));

  if (accessToken && refreshToken) {
    return {
      session: { access_token: accessToken, refresh_token: refreshToken },
      source: 'url-session',
    };
  }
  if (accessToken) return { accessToken, source: 'url-token' };
  return null;
}

function readTokenFromUrl() {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  const searchParams = new URLSearchParams(url.search);
  const result = readTokenFromSearchParams(hashParams) || readTokenFromSearchParams(searchParams);
  if (!result) return null;

  try {
    hashParams.delete('access_token');
    hashParams.delete('refresh_token');
    hashParams.delete('supabaseAccessToken');
    hashParams.delete('supabaseRefreshToken');
    hashParams.delete('AUTH_TOKEN');
    searchParams.delete('access_token');
    searchParams.delete('refresh_token');
    searchParams.delete('supabaseAccessToken');
    searchParams.delete('supabaseRefreshToken');
    searchParams.delete('AUTH_TOKEN');

    const nextSearch = searchParams.toString();
    const nextHash = hashParams.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`;
    window.history.replaceState(window.history.state, document.title, nextUrl);
  } catch {
    // URL cleanup is best effort only.
  }

  return result;
}

// ── Session application / cleanup ──────────────────────────────────────────

// Best-effort local-only SDK sign-out: clears the SDK's own session state
// without a network revoke call. Used before session replacement, after
// failed hydration, and on explicit sign-out.
async function clearSdkSessionLocal(supabase) {
  if (!supabase || !supabase.auth || typeof supabase.auth.signOut !== 'function') return;
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // Local cleanup is best effort; state flags below are authoritative.
  }
}

function resetLocalAuthMarkers() {
  bearerOverride = null;
  lastSessionLinked = false;
}

async function applySessionPayload(payload) {
  const supabase = getSupabaseClient();
  if (!supabase) return { linked: false, source: payload?.source || 'none' };

  if (payload?.session?.access_token && payload.session.refresh_token) {
    // Session replacement: clear previous auth state BEFORE applying the new
    // session so a partial/duplicate injection can never blend two sessions.
    if (lastSessionLinked || bearerOverride) {
      await clearSdkSessionLocal(supabase);
      bearerOverride = null;
    }
    try {
      const { data, error } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (error) {
        // Failed hydration must leave no partial session behind.
        await clearSdkSessionLocal(supabase);
        resetLocalAuthMarkers();
        lastSessionSource = payload.source || 'runtime-session';
        return { linked: false, source: lastSessionSource };
      }
      bearerOverride = null;
      lastSessionLinked = Boolean(data?.session);
      lastSessionSource = payload.source || 'runtime-session';
      return { linked: lastSessionLinked, session: data?.session || null, source: lastSessionSource };
    } catch {
      await clearSdkSessionLocal(supabase);
      resetLocalAuthMarkers();
      lastSessionSource = payload.source || 'runtime-session';
      return { linked: false, source: lastSessionSource };
    }
  }

  if (payload?.accessToken) {
    if (lastSessionLinked) {
      await clearSdkSessionLocal(supabase);
    }
    bearerOverride = payload.accessToken;
    lastSessionLinked = true;
    lastSessionSource = payload.source || 'runtime-token';
    return { linked: true, accessToken: bearerOverride, source: lastSessionSource };
  }

  return { linked: false, source: payload?.source || 'none' };
}

export async function hydrateSupabaseSessionFromRuntime() {
  const runtimePayload = readTokenFromRuntimeConfig();
  if (runtimePayload) return applySessionPayload(runtimePayload);
  // URL-token intake exists only in dev / LOCAL QA simulator builds. The
  // ternary on a compile-time constant lets the production bundler drop the
  // entire intake path from the shipped bundle.
  const urlPayload = URL_TOKEN_INTAKE_ENABLED ? readTokenFromUrl() : null;
  if (!urlPayload) return { linked: false, source: 'none' };
  return applySessionPayload(urlPayload);
}

/**
 * Explicit sign-out: clears SDK session state, bearer-token overrides, and
 * all app-owned auth markers. Safe to call with no client configured.
 */
export async function signOutSupabaseSession() {
  const supabase = getSupabaseClient();
  await clearSdkSessionLocal(supabase);
  resetLocalAuthMarkers();
  lastSessionSource = 'none';
  return { linked: false, source: 'signed-out' };
}

// ── Session message listener (trust-gated) ─────────────────────────────────

function readSessionAllowedOriginEntries() {
  const entries = [];
  const runtime = readRuntimeConfig();
  if (typeof runtime.SESSION_ALLOWED_ORIGINS === 'string') entries.push(runtime.SESSION_ALLOWED_ORIGINS);
  const env = readViteEnv();
  if (typeof env.VITE_SESSION_ALLOWED_ORIGINS === 'string') entries.push(env.VITE_SESSION_ALLOWED_ORIGINS);
  return entries;
}

function evaluateSessionMessageTrust(event) {
  const selfOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const allowlist = buildMessageOriginAllowlist(readSessionAllowedOriginEntries(), selfOrigin);
  const approvedSources = [];
  try {
    if (window.parent) approvedSources.push(window.parent);
  } catch {
    // cross-origin access guard — should not happen for window.parent
  }
  try {
    if (!approvedSources.includes(window)) approvedSources.push(window);
  } catch {
    // ignore
  }
  return evaluateMessageTrust(event, {
    allowlist,
    selfOrigin,
    approvedSources,
    requireSource: true,
    allowedTypes: SESSION_MESSAGE_TYPES,
  });
}

export function listenForSupabaseSessionMessages() {
  if (typeof window === 'undefined') return;
  if (sessionMessageListenerInstalled) return;
  sessionMessageListenerInstalled = true;

  window.addEventListener('message', (event) => {
    // Canonical trust policy: origin must be self or explicitly allowlisted,
    // source must be the approved parent window, type must be supported.
    // Untrusted messages are dropped silently — never logged with payloads.
    if (!evaluateSessionMessageTrust(event).trusted) return;

    const data = event.data;
    const session = normalizeSession(data.session);
    const accessToken = safeString(data.accessToken) || safeString(data.access_token);
    const payload = session
      ? { session, source: 'postMessage-session' }
      : accessToken
        ? { accessToken, source: 'postMessage-token' }
        : null;
    if (!payload) return;

    applySessionPayload(payload).then((result) => {
      if (result.linked && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kscan:supabase-session-linked', {
          detail: { source: result.source },
        }));
      }
    });
  });
}

export async function getSupabaseSession() {
  if (!hasSupabaseConfig()) return { session: null, accessToken: null, linked: false, source: 'missing-config' };

  listenForSupabaseSessionMessages();
  const hydrated = await hydrateSupabaseSessionFromRuntime();
  if (hydrated.linked) {
    return {
      session: hydrated.session || null,
      accessToken: hydrated.accessToken || bearerOverride,
      linked: true,
      source: hydrated.source,
    };
  }

  const supabase = getSupabaseClient();
  if (!supabase) return { session: null, accessToken: null, linked: false, source: 'missing-config' };

  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      lastSessionLinked = true;
      lastSessionSource = 'sdk-session';
      return { session: data.session, accessToken: null, linked: true, source: lastSessionSource };
    }
  } catch {
    // Missing/expired SDK sessions are handled by the caller as AUTH_REQUIRED.
  }

  if (bearerOverride) {
    return { session: null, accessToken: bearerOverride, linked: true, source: lastSessionSource || 'bearer-token' };
  }

  lastSessionLinked = false;
  return { session: null, accessToken: null, linked: false, source: 'none' };
}

export async function refreshSupabaseSession() {
  const supabase = getSupabaseClient();
  if (!supabase) return { linked: false, source: 'missing-config' };
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data?.session) {
      bearerOverride = null;
      lastSessionLinked = true;
      lastSessionSource = 'sdk-refresh';
      return { linked: true, session: data.session, source: lastSessionSource };
    }
  } catch {
    // Refresh failure maps to AUTH_REQUIRED at the adapter boundary.
  }
  return hydrateSupabaseSessionFromRuntime();
}

export async function invokeSupabaseFunction(functionName, options = {}) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    const err = new Error('SUPABASE_CONFIG_REQUIRED');
    err.code = 'CONFIG_REQUIRED';
    throw err;
  }
  const session = await getSupabaseSession();
  if (!session.linked) {
    const err = new Error('SUPABASE_AUTH_REQUIRED');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }

  const invokeOptions = { ...options };
  if (session.accessToken && !session.session) {
    invokeOptions.headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${session.accessToken}`,
    };
  }
  return supabase.functions.invoke(functionName, invokeOptions);
}

export function getSupabaseRuntimeStatus() {
  return {
    configured: hasSupabaseConfig(),
    linked: lastSessionLinked,
    source: lastSessionSource,
  };
}

export function __setSupabaseTestSession(accessToken) {
  bearerOverride = safeString(accessToken) || null;
  lastSessionLinked = Boolean(bearerOverride);
  lastSessionSource = bearerOverride ? 'test-token' : 'none';
}

export function __setSupabaseTestClient(mockClient, configured = true) {
  testClient = mockClient || null;
  testConfig = configured
    ? { url: 'https://example.supabase.co', anonKey: 'mock-anon-key', configured: true }
    : null;
  bearerOverride = null;
  lastSessionLinked = false;
  lastSessionSource = 'none';
}

// Test-only hooks. Not imported by the app entry point; tree-shaken from
// production bundles.
export const __testHooks = {
  readTokenFromSearchParams,
  evaluateSessionMessageTrust,
  clearSdkSessionLocal,
};
