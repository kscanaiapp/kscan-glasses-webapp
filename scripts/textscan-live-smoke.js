// Phase 27 — TextScan live smoke QA harness.
// Node built-ins only. No external dependencies beyond @supabase/supabase-js.
// Usage: node scripts/textscan-live-smoke.js
// Exit 0: passed or skipped (missing env/session).
// Exit 1: live QA attempted and failed.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ACCESS_TOKEN = process.env.KSCAN_TEST_SUPABASE_ACCESS_TOKEN || '';
const REFRESH_TOKEN = process.env.KSCAN_TEST_SUPABASE_REFRESH_TOKEN || '';

function redact(value) {
  if (!value || typeof value !== 'string') return '(empty)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function log(label, detail) {
  console.log(`[smoke] ${label}: ${detail}`);
}

function hasConfig() {
  return Boolean(SUPABASE_URL.trim() && SUPABASE_ANON_KEY.trim());
}

function hasSession() {
  return Boolean(ACCESS_TOKEN.trim());
}

async function run() {
  log('config', hasConfig() ? `url=${redact(SUPABASE_URL)} key=${redact(SUPABASE_ANON_KEY)}` : 'missing');
  log('session', hasSession() ? `access=${redact(ACCESS_TOKEN)} refresh=${redact(REFRESH_TOKEN)}` : 'missing');

  if (!hasConfig() || !hasSession()) {
    console.log('\nSKIPPED: missing live QA env/session');
    console.log('Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and KSCAN_TEST_SUPABASE_ACCESS_TOKEN to run live smoke.');
    process.exit(0);
  }

  const supabase = createClient(SUPABASE_URL.trim(), SUPABASE_ANON_KEY.trim(), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });

  if (ACCESS_TOKEN && REFRESH_TOKEN) {
    log('auth', 'hydrating full session');
    const { error } = await supabase.auth.setSession({
      access_token: ACCESS_TOKEN.trim(),
      refresh_token: REFRESH_TOKEN.trim(),
    });
    if (error) {
      log('auth', `setSession failed: ${error.message}`);
      console.log('\nFAILED: auth hydration error');
      process.exit(1);
    }
    log('auth', 'session hydrated');
  } else {
    log('auth', 'access-token-only mode (no refresh)');
  }

  const payload = {
    mode: 'text',
    textQuery: 'black oversized blazer',
    source: 'preset',
    clientTimestamp: new Date().toISOString(),
  };

  log('invoke', `scan-identify mode:text query="${payload.textQuery}" source=${payload.source}`);

  const invokeOptions = { body: payload };
  if (!REFRESH_TOKEN && ACCESS_TOKEN) {
    invokeOptions.headers = { Authorization: `Bearer ${ACCESS_TOKEN.trim()}` };
  }

  const { data, error } = await supabase.functions.invoke('scan-identify', invokeOptions);

  if (error) {
    const status = error.status || error.context?.status || 0;
    const category =
      status === 401 || status === 403 ? 'AUTH_ERROR'
        : status >= 500 ? 'SERVER_ERROR'
          : status >= 400 ? 'CLIENT_ERROR'
            : 'NETWORK_ERROR';
    log('result', `error category=${category} status=${status} message="${error.message || 'unknown'}"`);
    console.log(`\nFAILED: live smoke invocation returned ${category} (status ${status})`);
    process.exit(1);
  }

  log('result', `status=${data?.status || 'unknown'}`);

  if (!data || typeof data !== 'object') {
    log('result', 'response is not an object');
    console.log('\nFAILED: malformed response (not an object)');
    process.exit(1);
  }

  const checks = [];

  const status = typeof data.status === 'string' ? data.status : '';
  checks.push(['status-present', Boolean(status), status || '(missing)']);

  const hasAttrs = data.attributes && typeof data.attributes === 'object' && !Array.isArray(data.attributes);
  checks.push(['attributes-present', Boolean(hasAttrs), hasAttrs ? 'object' : typeof data.attributes]);

  const userMessage = typeof data.userMessage === 'string' ? data.userMessage : '';
  checks.push(['userMessage-present', Boolean(userMessage), userMessage ? userMessage.slice(0, 60) : '(missing)']);

  const responseStr = JSON.stringify(data);
  const hasStackTrace = /at\s+\w+\s+\(/.test(responseStr) || responseStr.includes('Error:');
  checks.push(['no-stack-trace', !hasStackTrace, hasStackTrace ? 'FOUND' : 'clean']);

  const secretPatterns = ['SERVICE_ROLE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  const hasSecrets = secretPatterns.some((p) => responseStr.includes(p));
  checks.push(['no-secrets', !hasSecrets, hasSecrets ? 'FOUND' : 'clean']);

  const hasImagePayload = responseStr.includes('data:image/');
  checks.push(['no-image-payload', !hasImagePayload, hasImagePayload ? 'FOUND' : 'clean']);

  const spokenSummary = userMessage || (status === 'completed' ? 'TextScan found a fashion style match.' : '');
  checks.push(['spoken-summary-derivable', Boolean(spokenSummary), spokenSummary.slice(0, 60) || '(empty)']);
  checks.push(['spoken-summary-length', spokenSummary.length <= 120, `${spokenSummary.length} chars`]);

  console.log('\n=== Live Smoke Results ===');
  let failed = false;
  for (const [name, ok, detail] of checks) {
    const label = ok ? 'PASS' : 'FAIL';
    if (!ok) failed = true;
    console.log(`${label} | ${name} | ${detail}`);
  }

  if (failed) {
    console.log('\nFAILED: one or more live smoke checks failed');
    process.exit(1);
  }

  console.log('\n[OK] Live smoke passed.');
  process.exit(0);
}

run().catch((err) => {
  console.error(`\nFAILED: unexpected error: ${err.message}`);
  process.exit(1);
});
