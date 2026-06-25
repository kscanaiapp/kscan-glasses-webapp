import { createClient } from '@supabase/supabase-js';

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
    };
  } catch {
    return {};
  }
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

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
      persistSession: true,
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

async function applySessionPayload(payload) {
  const supabase = getSupabaseClient();
  if (!supabase) return { linked: false, source: payload?.source || 'none' };

  if (payload?.session?.access_token && payload.session.refresh_token) {
    try {
      const { data, error } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (error) {
        lastSessionLinked = false;
        lastSessionSource = payload.source || 'runtime-session';
        return { linked: false, source: lastSessionSource };
      }
      bearerOverride = null;
      lastSessionLinked = Boolean(data?.session);
      lastSessionSource = payload.source || 'runtime-session';
      return { linked: lastSessionLinked, session: data?.session || null, source: lastSessionSource };
    } catch {
      lastSessionLinked = false;
      lastSessionSource = payload.source || 'runtime-session';
      return { linked: false, source: lastSessionSource };
    }
  }

  if (payload?.accessToken) {
    bearerOverride = payload.accessToken;
    lastSessionLinked = true;
    lastSessionSource = payload.source || 'runtime-token';
    return { linked: true, accessToken: bearerOverride, source: lastSessionSource };
  }

  return { linked: false, source: payload?.source || 'none' };
}

export async function hydrateSupabaseSessionFromRuntime() {
  const payload = readTokenFromRuntimeConfig() || readTokenFromUrl();
  if (!payload) return { linked: false, source: 'none' };
  return applySessionPayload(payload);
}

export function listenForSupabaseSessionMessages() {
  if (typeof window === 'undefined') return;
  if (sessionMessageListenerInstalled) return;
  sessionMessageListenerInstalled = true;

  window.addEventListener('message', (event) => {
    const data = event?.data;
    if (!data || typeof data !== 'object' || !SESSION_MESSAGE_TYPES.has(data.type)) return;

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
