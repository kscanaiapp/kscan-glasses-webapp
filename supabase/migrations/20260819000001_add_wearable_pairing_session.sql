-- Migration: Shared K Scan wearable backend (Meta physical device candidate)
-- Created: 2026-08-19 (rewritten during takeover to mirror the AUTHORITATIVE
-- schema already deployed to K Scan AI Staging with the wearable-bridge
-- Edge Function — see supabase/README.md).
--
-- The earlier draft of this migration (user_id+device_id unique pairings,
-- session_token_hash + status enum sessions, capabilities arrays) was
-- SUPERSEDED: it conflicted with the deployed bridge schema and must never
-- be applied. This file mirrors what staging actually runs.
--
-- Rollback (staging only, never production without owner approval):
--   DROP TABLE IF EXISTS wearable_actions, wearable_results, wearable_messages,
--     wearable_sessions, wearable_pairings;

-- ── wearable_pairings ──────────────────────────────────────────────────────
-- Challenge-code pairing tickets. status: pending → approved → consumed
-- (or denied/expired). Challenge and pairing secret are SHA-256 hashed.
CREATE TABLE IF NOT EXISTS public.wearable_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_handle uuid NOT NULL DEFAULT gen_random_uuid(),
  challenge_hash text NOT NULL,
  pairing_secret_hash text NOT NULL,
  request_id uuid NOT NULL,
  device_id uuid NOT NULL,
  device_model text NOT NULL DEFAULT '',
  device_app_version text NOT NULL DEFAULT '',
  protocol_version integer NOT NULL DEFAULT 1,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_device_id uuid,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pairing_handle),
  UNIQUE (request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS wearable_pairings_one_pending_device
  ON public.wearable_pairings(device_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wearable_pairings_pending_expiry
  ON public.wearable_pairings(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wearable_pairings_user_created
  ON public.wearable_pairings(user_id, created_at DESC);

ALTER TABLE public.wearable_pairings ENABLE ROW LEVEL SECURITY;
-- No client policies: service-role (Edge Function) access only.

-- ── wearable_sessions ──────────────────────────────────────────────────────
-- Short-lived wearable sessions (15 min TTL). Token stored as SHA-256 hash.
CREATE TABLE IF NOT EXISTS public.wearable_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_id uuid NOT NULL REFERENCES public.wearable_pairings(id) ON DELETE CASCADE UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  protocol_version integer NOT NULL DEFAULT 1,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wearable_sessions_one_active_device
  ON public.wearable_sessions(device_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS wearable_sessions_expiry
  ON public.wearable_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS wearable_sessions_user_active
  ON public.wearable_sessions(user_id, created_at DESC) WHERE revoked_at IS NULL;

ALTER TABLE public.wearable_sessions ENABLE ROW LEVEL SECURITY;
-- No client policies: service-role (Edge Function) access only.

-- ── wearable_messages ──────────────────────────────────────────────────────
-- Durable frame relay queue between wearable and phone (both directions).
CREATE TABLE IF NOT EXISTS public.wearable_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.wearable_sessions(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('to_phone', 'to_wearable')),
  request_id uuid NOT NULL,
  message_type text NOT NULL,
  frame jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, direction, request_id, message_type)
);

CREATE INDEX IF NOT EXISTS wearable_messages_poll
  ON public.wearable_messages(session_id, direction, id);
CREATE INDEX IF NOT EXISTS wearable_messages_expiry
  ON public.wearable_messages(expires_at);

ALTER TABLE public.wearable_messages ENABLE ROW LEVEL SECURITY;

-- ── wearable_results ───────────────────────────────────────────────────────
-- Canonical result store with revision tracking for stale-result protection.
CREATE TABLE IF NOT EXISTS public.wearable_results (
  id uuid PRIMARY KEY, -- resultId minted by the phone/scanner path
  session_id uuid NOT NULL REFERENCES public.wearable_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scan_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'completed',
  payload jsonb NOT NULL,
  saved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, scan_id)
);

CREATE INDEX IF NOT EXISTS wearable_results_user_created
  ON public.wearable_results(user_id, created_at DESC);

ALTER TABLE public.wearable_results ENABLE ROW LEVEL SECURITY;

-- ── wearable_actions ───────────────────────────────────────────────────────
-- Idempotent action ledger (save / open_on_phone). One row per actionId.
CREATE TABLE IF NOT EXISTS public.wearable_actions (
  id uuid PRIMARY KEY, -- actionId minted by the wearable
  session_id uuid NOT NULL REFERENCES public.wearable_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES public.wearable_results(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('save', 'open_on_phone')),
  status text NOT NULL DEFAULT 'completed',
  safe_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, id)
);

ALTER TABLE public.wearable_actions ENABLE ROW LEVEL SECURITY;

-- ── saved_scans source widening ────────────────────────────────────────────
-- Staging already widened saved_scans_source_check to include 'wearable'.
-- This block preserves that value and adds 'meta_wearable' for saves that
-- flow through wearable-save. Dropping the constraint without preserving
-- 'wearable' would break existing wearable rows — a confirmed takeover defect
-- in the earlier draft of this migration.
DO $$
BEGIN
  ALTER TABLE public.saved_scans DROP CONSTRAINT IF EXISTS saved_scans_source_check;
  ALTER TABLE public.saved_scans DROP CONSTRAINT IF EXISTS chk_saved_scans_source;
  ALTER TABLE public.saved_scans ADD CONSTRAINT saved_scans_source_check
    CHECK ((source IS NULL) OR (source = ANY (ARRAY['mobile'::text, 'web'::text, 'system'::text, 'wearable'::text, 'meta_wearable'::text])));
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'saved_scans table not found — skipping source constraint update';
  WHEN duplicate_object THEN
    RAISE NOTICE 'Constraint already updated';
END $$;
