// Companion Open-on-Phone action handler — phone-side
//
// Handles action.open_on_phone messages from the Meta HUD by validating
// the wearable session and generating a deep link via the
// wearable-open-on-phone Edge Function.

import { wearableOpenOnPhone } from './wearableBackend.js';

export const OPEN_ERRORS = Object.freeze({
  NO_SESSION: 'NO_SESSION',
  INVALID_RESULT: 'INVALID_RESULT',
  BACKEND_FAILED: 'BACKEND_FAILED',
});

/**
 * Handle an open-on-phone action from the HUD.
 *
 * @param {object} options
 * @param {string} options.sessionToken - the HUD's wearable session token.
 * @param {object} options.result - the validated result payload from the bridge.
 * @param {string} options.requestId - the active bridge request ID.
 * @returns {Promise<{ ok: boolean, code?: string, deepLink?: string }>}
 */
export async function handleCompanionOpenOnPhone({ sessionToken, result, requestId }) {
  if (!sessionToken || typeof sessionToken !== 'string') {
    return { ok: false, code: OPEN_ERRORS.NO_SESSION };
  }
  if (!result || typeof result !== 'object' || !result.resultId) {
    return { ok: false, code: OPEN_ERRORS.INVALID_RESULT };
  }

  const res = await wearableOpenOnPhone(sessionToken, result.resultId, result);
  if (!res.ok) {
    return { ok: false, code: OPEN_ERRORS.BACKEND_FAILED, message: res.message };
  }

  return {
    ok: true,
    deepLink: res.deepLink,
  };
}
