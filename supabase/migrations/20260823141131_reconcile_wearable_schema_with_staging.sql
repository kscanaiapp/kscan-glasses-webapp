-- Reconciles the committed wearable schema with K Scan AI Staging's verified
-- constraint and column contract. This is deliberately additive/idempotent:
-- it repairs environments built from the old migration without weakening
-- staging's already-enforced limits.

ALTER TABLE public.wearable_pairings
  ALTER COLUMN device_model DROP DEFAULT,
  ALTER COLUMN device_app_version DROP DEFAULT,
  ALTER COLUMN protocol_version DROP DEFAULT;

ALTER TABLE public.wearable_pairings
  DROP CONSTRAINT IF EXISTS wearable_pairings_device_model_check,
  ADD CONSTRAINT wearable_pairings_device_model_check
    CHECK (char_length(device_model) BETWEEN 1 AND 80),
  DROP CONSTRAINT IF EXISTS wearable_pairings_device_app_version_check,
  ADD CONSTRAINT wearable_pairings_device_app_version_check
    CHECK (char_length(device_app_version) BETWEEN 1 AND 40),
  DROP CONSTRAINT IF EXISTS wearable_pairings_check,
  ADD CONSTRAINT wearable_pairings_check CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS wearable_pairings_check1,
  ADD CONSTRAINT wearable_pairings_check1 CHECK (status <> 'pending' OR user_id IS NULL),
  DROP CONSTRAINT IF EXISTS wearable_pairings_protocol_version_check,
  ADD CONSTRAINT wearable_pairings_protocol_version_check CHECK (protocol_version = 1);

UPDATE public.wearable_sessions
  SET last_seen_at = created_at
  WHERE last_seen_at IS NULL;

ALTER TABLE public.wearable_sessions
  ALTER COLUMN last_seen_at SET DEFAULT now(),
  ALTER COLUMN last_seen_at SET NOT NULL,
  ALTER COLUMN protocol_version DROP DEFAULT;

ALTER TABLE public.wearable_sessions
  DROP CONSTRAINT IF EXISTS wearable_sessions_check,
  ADD CONSTRAINT wearable_sessions_check CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS wearable_sessions_check1,
  ADD CONSTRAINT wearable_sessions_check1
    CHECK ((revoked_at IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  DROP CONSTRAINT IF EXISTS wearable_sessions_protocol_version_check,
  ADD CONSTRAINT wearable_sessions_protocol_version_check CHECK (protocol_version = 1),
  DROP CONSTRAINT IF EXISTS wearable_sessions_revoke_reason_check,
  ADD CONSTRAINT wearable_sessions_revoke_reason_check
    CHECK (revoke_reason IS NULL OR revoke_reason IN ('user_revoked', 'expired', 'replaced', 'sign_out', 'error'));

ALTER TABLE public.wearable_messages
  DROP CONSTRAINT IF EXISTS wearable_messages_check,
  ADD CONSTRAINT wearable_messages_check CHECK (expires_at > created_at),
  DROP CONSTRAINT IF EXISTS wearable_messages_frame_check,
  ADD CONSTRAINT wearable_messages_frame_check CHECK (octet_length(frame::text) <= 65536),
  DROP CONSTRAINT IF EXISTS wearable_messages_message_type_check,
  ADD CONSTRAINT wearable_messages_message_type_check CHECK (char_length(message_type) BETWEEN 3 AND 48);

ALTER TABLE public.wearable_results
  DROP CONSTRAINT IF EXISTS wearable_results_payload_check,
  ADD CONSTRAINT wearable_results_payload_check CHECK (octet_length(payload::text) <= 49152),
  DROP CONSTRAINT IF EXISTS wearable_results_revision_check,
  ADD CONSTRAINT wearable_results_revision_check CHECK (revision BETWEEN 1 AND 1000),
  DROP CONSTRAINT IF EXISTS wearable_results_status_check,
  ADD CONSTRAINT wearable_results_status_check CHECK (status IN ('completed', 'partial', 'failed'));

ALTER TABLE public.wearable_actions
  ALTER COLUMN result_id DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE public.wearable_actions
  DROP CONSTRAINT IF EXISTS wearable_actions_action_type_check,
  ADD CONSTRAINT wearable_actions_action_type_check CHECK (action_type IN ('save', 'open_on_phone', 'cancel', 'retry')),
  DROP CONSTRAINT IF EXISTS wearable_actions_status_check,
  ADD CONSTRAINT wearable_actions_status_check CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  DROP CONSTRAINT IF EXISTS wearable_actions_safe_error_code_check,
  ADD CONSTRAINT wearable_actions_safe_error_code_check CHECK (safe_error_code IS NULL OR char_length(safe_error_code) <= 48);
