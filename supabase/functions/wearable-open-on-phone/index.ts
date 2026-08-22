import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * wearable-open-on-phone Edge Function
 * Generates deep-link payloads for phone handoff from Meta glasses.
 * Flow: validate session → generate deep link → ack.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Deep link base URL (env-driven)
const KSCAN_DEEP_LINK_BASE = Deno.env.get('KSCAN_DEEP_LINK_BASE') || 'kscan://result';

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status = 400) {
  return jsonResponse({ ok: false, code, message }, status);
}

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Session validation targets the AUTHORITATIVE shared wearable schema owned
// by the wearable-bridge Edge Function (see supabase/README.md).
async function validateSession(supabase: any, token: string) {
  const tokenHash = await hashToken(token);

  const { data: sessions, error } = await supabase
    .from('wearable_sessions')
    .select('id, pairing_id, user_id, device_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .limit(1);

  if (error || !sessions || sessions.length === 0) return null;
  const session = sessions[0];
  if (new Date(session.expires_at) <= new Date()) return null;

  const { data: pairings } = await supabase
    .from('wearable_pairings')
    .select('id, status')
    .eq('id', session.pairing_id)
    .eq('status', 'consumed')
    .limit(1);

  if (!pairings || pairings.length === 0) return null;

  return session;
}

function buildDeepLink(resultId: string, payload: any): string {
  const url = new URL(KSCAN_DEEP_LINK_BASE);
  url.searchParams.set('resultId', resultId);
  url.searchParams.set('source', 'meta_wearable');
  if (payload?.summary) {
    url.searchParams.set('summary', String(payload.summary).slice(0, 100));
  }
  if (payload?.confidence !== undefined && payload.confidence !== null) {
    url.searchParams.set('confidence', String(payload.confidence));
  }
  // Include a short-lived nonce for verification (optional)
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return errorResponse('METHOD_NOT_ALLOWED', 'Only POST is allowed', 405);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return errorResponse('INVALID_JSON', 'Request body is not valid JSON', 400);
  }

  const action = payload?.action;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── generate_link ────────────────────────────────────────────────────────
  if (action === 'generate_link') {
    const sessionToken = payload?.sessionToken;
    const resultId = payload?.resultId;
    const result = payload?.result;

    if (!sessionToken || typeof sessionToken !== 'string') {
      return errorResponse('MISSING_TOKEN', 'sessionToken is required');
    }
    if (!resultId || typeof resultId !== 'string' || resultId.length > 128) {
      return errorResponse('MISSING_RESULT_ID', 'resultId is required and must be ≤128 chars');
    }

    // Validate session
    const session = await validateSession(supabase, sessionToken);
    if (!session) {
      return errorResponse('INVALID_SESSION', 'Session is invalid, expired, or revoked', 401);
    }

    // Build deep link
    const deepLink = buildDeepLink(resultId, result || {});

    // Touch session activity (bridge schema column: last_seen_at)
    const now = new Date().toISOString();
    await supabase
      .from('wearable_sessions')
      .update({ last_seen_at: now })
      .eq('id', session.id);

    return jsonResponse({
      ok: true,
      deepLink,
      resultId,
      source: 'meta_wearable',
    });
  }

  return errorResponse('UNKNOWN_ACTION', `Unknown action: ${action}`, 400);
});
