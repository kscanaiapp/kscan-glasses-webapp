import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalizeWearableResult } from './normalize.ts';

/**
 * wearable-scan Edge Function
 * Authenticated gateway for wearable-originated scans.
 * Flow: validate wearable session (bridge-owned schema) → rate limit →
 * canonical scan-identify (image mode, source='meta_wearable') →
 * normalize bounded wearable result.
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Configuration
const SCAN_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const SCAN_RATE_LIMIT_MAX = 10; // max scans per window per user

// In-memory rate limit store (per-function-instance; acceptable for Phase 1)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

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
// by the wearable-bridge Edge Function on the K Scan backend (see
// supabase/README.md): token_hash (SHA-256), revoked_at, expires_at,
// and pairings that reach status='consumed' when a session is issued.
async function validateSession(supabase: any, token: string) {
  const tokenHash = await hashToken(token);

  const { data: sessions, error } = await supabase
    .from('wearable_sessions')
    .select('id, pairing_id, user_id, device_id, expires_at, revoked_at, protocol_version')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .limit(1);

  if (error || !sessions || sessions.length === 0) return null;
  const session = sessions[0];
  if (new Date(session.expires_at) <= new Date()) return null;

  // Pairing must be fully consumed (approved + session issued)
  const { data: pairings } = await supabase
    .from('wearable_pairings')
    .select('id, status')
    .eq('id', session.pairing_id)
    .eq('status', 'consumed')
    .limit(1);

  if (!pairings || pairings.length === 0) return null;

  return session;
}

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(userId);
  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(userId, { count: 1, resetAt: now + SCAN_RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= SCAN_RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

function sanitizeImageInput(image: unknown): string | null {
  if (typeof image !== 'string') return null;
  const trimmed = image.trim();
  // Accept ONLY sanitized JPEG data URLs produced by the phone privacy
  // pipeline. Arbitrary HTTPS URLs are rejected: fetching them server-side
  // would be an SSRF surface and would bypass phone-side privacy sanitization.
  if (trimmed.startsWith('data:image/jpeg;base64,')) {
    const base64 = trimmed.slice('data:image/jpeg;base64,'.length);
    if (base64.length > 0 && base64.length <= 5 * 1024 * 1024) return trimmed; // 5MB max
  }
  return null;
}

/**
 * Invoke the canonical K Scan scanner — the scan-identify Edge Function in
 * the same Supabase project (image mode). There is no separate Meta scanner;
 * wearable scans go through the exact same fashion-analysis gateway as the
 * mobile app, with source='meta_wearable' stamping for downstream analytics.
 */
async function callCanonicalScanner(imageDataUrl: string, requestId: string): Promise<any> {
  const imageBase64 = imageDataUrl.slice('data:image/jpeg;base64,'.length);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/scan-identify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        mode: 'image',
        imageBase64,
        source: 'meta_wearable',
        scanSessionId: requestId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`ANALYZE_FAILED: ${response.status} ${text.slice(0, 200)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
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

  // ── scan ─────────────────────────────────────────────────────────────────
  if (action === 'scan') {
    const sessionToken = payload?.sessionToken;
    const image = payload?.image;
    const requestId = payload?.requestId || `scan_${Date.now()}`;

    if (!sessionToken || typeof sessionToken !== 'string') {
      return errorResponse('MISSING_TOKEN', 'sessionToken is required');
    }

    const sanitizedImage = sanitizeImageInput(image);
    if (!sanitizedImage) {
      return errorResponse('INVALID_IMAGE', 'Image must be a sanitized JPEG data URL from the phone privacy pipeline', 400);
    }

    // Validate session
    const session = await validateSession(supabase, sessionToken);
    if (!session) {
      return errorResponse('INVALID_SESSION', 'Session is invalid, expired, or revoked', 401);
    }

    // Rate limit
    if (!checkRateLimit(session.user_id)) {
      return errorResponse('RATE_LIMITED', 'Too many scans. Please wait a moment.', 429);
    }

    // Touch activity (bridge schema column: last_seen_at)
    const now = new Date().toISOString();
    await supabase
      .from('wearable_sessions')
      .update({ last_seen_at: now })
      .eq('id', session.id);

    // Call the canonical K Scan scanner (scan-identify, image mode)
    let analyzeResult;
    try {
      analyzeResult = await callCanonicalScanner(sanitizedImage, requestId);
    } catch (err: any) {
      console.error('canonical scanner error:', err.message);
      return errorResponse('ANALYZE_FAILED', 'Could not analyze image. Please try again.', 502);
    }

    // Normalize for wearable
    let wearableResult;
    try {
      wearableResult = normalizeWearableResult(analyzeResult, requestId);
    } catch (err: any) {
      console.error('result normalization error:', err.message);
      return errorResponse('RESULT_NORMALIZATION_FAILED', 'Could not format result.', 500);
    }

    return jsonResponse({
      ok: true,
      result: wearableResult,
      requestId,
    });
  }

  return errorResponse('UNKNOWN_ACTION', `Unknown action: ${action}`, 400);
});
