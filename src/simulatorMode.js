// Formal simulator mode (Phase 11).
//
// Gating: simulator features are allowed only when the build is DEV or
// VITE_ENABLE_SIMULATOR=true (staging). In a production build with the flag
// unset, every entry point below is inert — no badge, no scenario overrides.
//
// Activation (when allowed): mock DAT capture enabled, an analyze scenario
// override is present (?mockAnalyze=...), `?dat=parent` (parent-frame
// simulator run), or explicit `?sim=1`.
//
// The SIM badge renders top-right on the app shell (outside every screen,
// so it is visible on all screens), 24px tall, gold high-contrast border.

export function parseSimulatorState(locationLike = {}, envLike = {}) {
  const allowed = envLike.DEV === true
    || String(envLike.VITE_ENABLE_SIMULATOR || '').toLowerCase() === 'true';

  if (!allowed) return { allowed: false, active: false, reasons: [] };

  const search = typeof locationLike.search === 'string' ? locationLike.search : '';
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);

  const reasons = [];
  if (envLike.DEV === true && String(envLike.VITE_MOCK_DAT || '').toLowerCase() === 'true' && params.get('dat') !== 'parent') {
    reasons.push('mock-dat');
  }
  if (envLike.DEV === true && String(envLike.VITE_MOCK_ANALYZE || '').toLowerCase() === 'true') {
    reasons.push('mock-analyze');
  }
  if (params.get('mockAnalyze')) reasons.push('analyze-scenario');
  if (params.get('dat') === 'parent') reasons.push('parent-frame');
  if (params.get('sim') === '1') reasons.push('explicit');

  return { allowed: true, active: reasons.length > 0, reasons };
}

function readSimEnv() {
  try {
    return {
      DEV: import.meta.env.DEV === true,
      VITE_ENABLE_SIMULATOR: import.meta.env.VITE_ENABLE_SIMULATOR,
      VITE_MOCK_DAT: import.meta.env.VITE_MOCK_DAT,
      VITE_MOCK_ANALYZE: import.meta.env.VITE_MOCK_ANALYZE,
    };
  } catch {
    return { DEV: false };
  }
}

export function getSimulatorState() {
  const locationLike = typeof window !== 'undefined' && window.location ? window.location : {};
  return parseSimulatorState(locationLike, readSimEnv());
}

/**
 * Mounts the persistent SIM badge on the app shell when simulator mode is
 * active. Safe no-op otherwise. Never overlaps the scan button or results
 * text (top-right corner, above screen content, pointer-events none).
 */
export function mountSimulatorBadge(appRoot) {
  const state = getSimulatorState();
  if (!state.active || !appRoot || document.getElementById('sim-badge')) return state;

  const badge = document.createElement('div');
  badge.id = 'sim-badge';
  badge.textContent = 'SIM';
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-label', 'Simulator mode active');
  badge.title = `Simulator active: ${state.reasons.join(', ')}`;
  appRoot.appendChild(badge);
  return state;
}
