import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./20260823141131_reconcile_wearable_schema_with_staging.sql', import.meta.url), 'utf8');

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
