import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * wearable-save Edge Function
 * Idempotent save handler for wearable-originated scan results.
 * Flow: validate session → validate result → idempotent persistence → ack.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Authenticate a PHONE caller via Supabase user JWT. Used by the
 * save_as_phone path, where the phone (auth authority) saves a result it
 * owns — the wearable session token never leaves the HUD in this path.
 */
async function requireAuthUser(req: Request): Promise<{ id: string } | null> {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user?.id) return null;
  return { id: data.user.id };
}

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

function validateResultPayload(result: any): { ok: boolean; error?: string } {
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'Result must be an object' };
  }
  if (!result.resultId || typeof result.resultId !== 'string') {
    return { ok: false, error: 'result.resultId is required' };
  }
  if (result.resultId.length > 128) {
    return { ok: false, error: 'resultId too long' };
  }
  return { ok: true };
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

  // ── save ─────────────────────────────────────────────────────────────────
  if (action === 'save') {
    const sessionToken = payload?.sessionToken;
    const result = payload?.result;
    const requestId = payload?.requestId;

    if (!sessionToken || typeof sessionToken !== 'string') {
      return errorResponse('MISSING_TOKEN', 'sessionToken is required');
    }

    const resultValidation = validateResultPayload(result);
    if (!resultValidation.ok) {
      return errorResponse('INVALID_RESULT', resultValidation.error || 'Invalid result payload');
    }

    // Validate session
    const session = await validateSession(supabase, sessionToken);
    if (!session) {
      return errorResponse('INVALID_SESSION', 'Session is invalid, expired, or revoked', 401);
    }

    // Idempotency: saved_scans has a partial unique index on
    // (user_id, local_id). The wearable resultId is stored as local_id, so a
    // duplicate Save for the same result returns the existing row instead of
    // inserting a second one. ACK only after this check/insert succeeds.
    const { data: existing } = await supabase
      .from('saved_scans')
      .select('id, saved_at')
      .eq('user_id', session.user_id)
      .eq('local_id', result.resultId)
      .limit(1);

    if (existing && existing.length > 0) {
      return jsonResponse({
        ok: true,
        saved: true,
        idempotent: true,
        savedScanId: existing[0].id,
        savedAt: existing[0].saved_at,
      });
    }

    // Persist save against the REAL saved_scans schema
    // (20260617215307_create_saved_scans.sql). There is no result_id column;
    // result identity lives in local_id, content in analysis_result/products.
    const now = new Date().toISOString();
    const products = Array.isArray(result.alternatives) || result.primaryMatch
      ? [result.primaryMatch, ...(Array.isArray(result.alternatives) ? result.alternatives : [])].filter(Boolean)
      : [];
    const { data: savedScan, error: insertError } = await supabase
      .from('saved_scans')
      .insert({
        user_id: session.user_id,
        local_id: result.resultId,
        title: typeof result?.primaryMatch?.title === 'string' ? result.primaryMatch.title.slice(0, 200) : null,
        scan_type: 'camera',
        analysis_result: {
          resultId: result.resultId,
          summary: result.summary || null,
          confidence: result.confidence ?? null,
        },
        products,
        source: 'meta_wearable',
        metadata: {
          device_id: session.device_id,
          session_id: session.id,
          request_id: requestId || null,
          saved_from: 'meta_wearable',
        },
      })
      .select('id')
      .single();

    if (insertError || !savedScan) {
      // Unique-index race: a concurrent duplicate Save arrived first.
      if (insertError?.code === '23505') {
        const { data: raced } = await supabase
          .from('saved_scans')
          .select('id, saved_at')
          .eq('user_id', session.user_id)
          .eq('local_id', result.resultId)
          .limit(1);
        if (raced && raced.length > 0) {
          return jsonResponse({ ok: true, saved: true, idempotent: true, savedScanId: raced[0].id, savedAt: raced[0].saved_at });
        }
      }
      console.error('save insert error:', insertError);
      return errorResponse('SAVE_FAILED', 'Could not save scan result', 500);
    }

    // Touch session activity (bridge schema column: last_seen_at)
    await supabase
      .from('wearable_sessions')
      .update({ last_seen_at: now })
      .eq('id', session.id);

    return jsonResponse({
      ok: true,
      saved: true,
      savedScanId: savedScan.id,
      savedAt: now,
    });
  }

  // ── save_as_phone ──────────────────────────────────────────────────────────
  // Phone-authorized save: the phone holds no wearable token; it authenticates
  // with its user JWT and may only save results the bridge recorded for that
  // user (wearable_results ownership check). Same idempotency rules as 'save'.
  if (action === 'save_as_phone') {
    const authUser = await requireAuthUser(req);
    if (!authUser) {
      return errorResponse('AUTH_REQUIRED', 'A valid user session (Authorization: Bearer) is required', 401);
    }

    const resultId = payload?.resultId;
    const requestId = payload?.requestId;

    const resultValidation = validateResultPayload({ resultId });
    if (!resultValidation.ok) {
      return errorResponse('INVALID_RESULT', resultValidation.error || 'Invalid result');
    }

    // Ownership: the result must exist in wearable_results for this user.
    const { data: owned } = await supabase
      .from('wearable_results')
      .select('id, payload')
      .eq('id', resultId)
      .eq('user_id', authUser.id)
      .limit(1);
    if (!owned || owned.length === 0) {
      return errorResponse('INVALID_RESULT', 'Result not found for this user', 404);
    }
    const ownedResult = owned[0].payload && typeof owned[0].payload === 'object' ? owned[0].payload : {};

    const { data: existing } = await supabase
      .from('saved_scans')
      .select('id, saved_at')
      .eq('user_id', authUser.id)
      .eq('local_id', resultId)
      .limit(1);
    if (existing && existing.length > 0) {
      return jsonResponse({ ok: true, saved: true, idempotent: true, savedScanId: existing[0].id, savedAt: existing[0].saved_at });
    }

    const now = new Date().toISOString();
    const { data: savedScan, error: insertError } = await supabase
      .from('saved_scans')
      .insert({
        user_id: authUser.id,
        local_id: resultId,
        title: typeof ownedResult?.primaryMatch?.title === 'string' ? ownedResult.primaryMatch.title.slice(0, 200) : null,
        scan_type: 'camera',
        analysis_result: {
          resultId,
          summary: ownedResult.summary || null,
          confidence: ownedResult.confidence ?? null,
        },
        products: [ownedResult.primaryMatch, ...(Array.isArray(ownedResult.alternatives) ? ownedResult.alternatives : [])].filter(Boolean),
        source: 'meta_wearable',
        metadata: { request_id: requestId || null, saved_from: 'meta_wearable', saved_by: 'phone' },
      })
      .select('id')
      .single();

    if (insertError || !savedScan) {
      if (insertError?.code === '23505') {
        const { data: raced } = await supabase
          .from('saved_scans')
          .select('id, saved_at')
          .eq('user_id', authUser.id)
          .eq('local_id', resultId)
          .limit(1);
        if (raced && raced.length > 0) {
          return jsonResponse({ ok: true, saved: true, idempotent: true, savedScanId: raced[0].id, savedAt: raced[0].saved_at });
        }
      }
      console.error('save_as_phone insert error:', insertError);
      return errorResponse('SAVE_FAILED', 'Could not save scan result', 500);
    }

    return jsonResponse({ ok: true, saved: true, savedScanId: savedScan.id, savedAt: now });
  }

  return errorResponse('UNKNOWN_ACTION', `Unknown action: ${action}`, 400);
});
