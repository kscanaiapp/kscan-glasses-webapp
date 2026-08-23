// Auth/session infrastructure for the virtual alpha.
//
// Phase 11 behavior:
//   - Scanning ALWAYS works without login (guest mode).
//   - If Supabase env vars are absent, the app runs in OFFLINE STUB mode:
//     no network calls, a fixed mock session, and a visible banner
//     "Supabase stub – virtual-alpha only."
//   - A live Supabase client is NOT wired in this phase because
//     @supabase/supabase-js is not an installed dependency (dependency
//     installs require explicit approval). The session-provider seam below
//     is where the real client plugs in later.
//   - Never log emails, user IDs, or tokens.

export const SESSION_MODES = {
  STUB: 'stub',
  SUPABASE_READY: 'supabase-ready', // env present, client not yet installed
};

export const STUB_USER_EMAIL = 'dev@virtual-alpha.local';

const SESSION_FLAG_KEY = 'kscan.session.v1'; // stores only {signedIn: boolean, mode} — never tokens

export function parseSupabaseEnv(envLike = {}) {
  const url = typeof envLike.VITE_SUPABASE_URL === 'string' ? envLike.VITE_SUPABASE_URL.trim() : '';
  const anonKey = typeof envLike.VITE_SUPABASE_ANON_KEY === 'string' ? envLike.VITE_SUPABASE_ANON_KEY.trim() : '';
  return { configured: Boolean(url && anonKey) };
}

function readAuthEnv() {
  // Static refs only so Vite inlines just these literals.
  try {
    return {
      VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
    };
  } catch {
    return {};
  }
}

function getStorage(storageLike) {
  if (storageLike) return storageLike;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readSessionFlag(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_FLAG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSessionFlag(storage, flag) {
  if (!storage) return;
  try {
    storage.setItem(SESSION_FLAG_KEY, JSON.stringify(flag));
  } catch {
    // storage unavailable — session stays in-memory only
  }
}

export function getSessionMode(envLike) {
  const env = envLike || readAuthEnv();
  return parseSupabaseEnv(env).configured ? SESSION_MODES.SUPABASE_READY : SESSION_MODES.STUB;
}

/**
 * Returns the current session or null (guest). Stub mode restores the
 * signed-in flag from localStorage; no tokens exist or are stored.
 */
export function getSession({ storageLike, envLike } = {}) {
  const mode = getSessionMode(envLike);
  const storage = getStorage(storageLike);
  const flag = readSessionFlag(storage);

  if (flag?.signedIn) {
    return Object.freeze({
      mode,
      user: Object.freeze({ email: STUB_USER_EMAIL }),
      isStub: true,
    });
  }
  return null;
}

/** Stub sign-in: flips the local flag. No network, no credentials. */
export function signInStub({ storageLike } = {}) {
  writeSessionFlag(getStorage(storageLike), { signedIn: true, mode: 'stub', v: 1 });
  return getSession({ storageLike });
}

export function signOut({ storageLike } = {}) {
  writeSessionFlag(getStorage(storageLike), { signedIn: false, mode: 'stub', v: 1 });
  return null;
}

export function isStubMode(envLike) {
  return getSessionMode(envLike) === SESSION_MODES.STUB;
}
