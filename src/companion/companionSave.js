// Companion Save action handler — phone-side
//
// Handles action.save messages from the Meta HUD by validating the
// wearable session and persisting the result via the wearable-save
// Edge Function. Returns an action acknowledgement for the bridge.

import { wearableSave } from './wearableBackend.js';

export const SAVE_ERRORS = Object.freeze({
  NO_SESSION: 'NO_SESSION',
  INVALID_RESULT: 'INVALID_RESULT',
  BACKEND_FAILED: 'BACKEND_FAILED',
  DUPLICATE: 'DUPLICATE_SAVE',
});

/**
 * Handle a save action from the HUD.
 *
 * @param {object} options
 * @param {string} options.sessionToken - the HUD's wearable session token.
 * @param {object} options.result - the validated result payload from the bridge.
 * @param {string} options.requestId - the active bridge request ID.
 * @returns {Promise<{ ok: boolean, code?: string, savedScanId?: string, idempotent?: boolean }>}
 */
export async function handleCompanionSave({ sessionToken, result, requestId }) {
  if (!sessionToken || typeof sessionToken !== 'string') {
    return { ok: false, code: SAVE_ERRORS.NO_SESSION };
  }
  if (!result || typeof result !== 'object' || !result.resultId) {
    return { ok: false, code: SAVE_ERRORS.INVALID_RESULT };
  }

  const res = await wearableSave(sessionToken, result, requestId);
  if (!res.ok) {
    return { ok: false, code: SAVE_ERRORS.BACKEND_FAILED, message: res.message };
  }

  return {
    ok: true,
    savedScanId: res.savedScanId,
    idempotent: res.idempotent === true,
  };
}
