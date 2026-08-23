import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./20260823170850_reconcile_wearable_schema_with_staging.sql', import.meta.url), 'utf8');

for (const constraint of [
  'wearable_pairings_device_model_check',
  'wearable_pairings_device_app_version_check',
  'wearable_pairings_protocol_version_check',
  'wearable_sessions_revoke_reason_check',
  'wearable_messages_frame_check',
  'wearable_results_payload_check',
  'wearable_results_revision_check',
  'wearable_actions_action_type_check',
  'wearable_actions_status_check',
]) {
  assert.match(migration, new RegExp(`ADD CONSTRAINT ${constraint}`), `${constraint} must be restored`);
}

assert.match(migration, /ALTER COLUMN last_seen_at SET DEFAULT now\(\),\s*ALTER COLUMN last_seen_at SET NOT NULL/);
assert.match(migration, /ALTER COLUMN result_id DROP NOT NULL,\s*ALTER COLUMN status SET DEFAULT 'pending'/);
assert.match(migration, /'cancel', 'retry'/);
assert.match(migration, /wearable_results_revision_check CHECK \(revision BETWEEN 1 AND 1000\)/);

// Residual staging divergences found by diffing live staging against source.
// wearable_auth_attempts backs wearable-bridge's throttlePairAttempt(); without
// it pair.approve/pair.deny throw SAFE_BACKEND_FAILURE on every call.
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.wearable_auth_attempts\s*\(/);
assert.match(migration, /ADD CONSTRAINT wearable_auth_attempts_operation_check\s*\n?\s*CHECK/);
assert.match(migration, /'pair\.approve', 'pair\.deny'/);
assert.match(migration, /CREATE INDEX IF NOT EXISTS wearable_auth_attempts_window\s*\n?\s*ON/);
assert.match(migration, /ALTER TABLE public\.wearable_auth_attempts ENABLE ROW LEVEL SECURITY;/);

// The phone action-poll index staging runs.
assert.match(migration, /CREATE INDEX IF NOT EXISTS wearable_actions_phone_poll\s*\n?\s*ON/);

// Staging has no default on wearable_results.status; source defaulted it to
// 'completed', which would let an incomplete write land as a finished result.
assert.match(migration, /ALTER TABLE public\.wearable_results ALTER COLUMN status DROP DEFAULT/);

// Supabase default privileges hand anon/authenticated full DML on new public
// tables. Staging revoked that for every wearable table; source must too.
assert.match(migration, /REVOKE ALL ON public\.%I FROM anon, authenticated/);
assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.%I TO service_role/);
for (const table of [
  'wearable_pairings', 'wearable_sessions', 'wearable_messages',
  'wearable_results', 'wearable_actions', 'wearable_auth_attempts',
]) {
  assert.match(migration, new RegExp(`'${table}'`), `${table} must be in the privilege sweep`);
}
