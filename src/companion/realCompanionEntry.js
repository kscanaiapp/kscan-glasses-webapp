// Real phone companion entry — PRIVATE HARDWARE CANDIDATE QA ONLY.
//
// This is the bootstrap for companion-real.html. It wires createPhoneCompanion
// (the real, backend-integrated phone-side state machine) to the SAME
// parent-window transport contract the mock companion's HUD side already
// uses (src/companion/transport.js createParentWindowTransport), embedding
// the HUD in an iframe exactly like the mock companion page does.
//
// Unlike the mock companion, this page requires a REAL Supabase user session
// (its own client instance, separate from the HUD iframe's JS realm) because
// the phone is the auth authority: pairing approval, session issuance, save,
// and open-on-phone all run against the live wearable-bridge/wearable-scan/
// wearable-save/wearable-open-on-phone Edge Functions with a real user JWT.
//
// This file must never ship in any built artifact — see the vite.*.config.js
// rollupOptions.input lists, none of which reference companion-real.html.
// scripts/verify-artifacts.js asserts this.

import { createParentWindowTransport } from './transport.js';
import { createPhoneCompanion, PHONE_STATE } from './phoneCompanion.js';
import { getSupabaseClient, hasSupabaseConfig } from '../services/supabaseClient.js';

const els = {
  frame: document.getElementById('hud-frame'),
  signinForm: document.getElementById('signin-form'),
  signinEmail: document.getElementById('signin-email'),
  signinPassword: document.getElementById('signin-password'),
  signinStatus: document.getElementById('signin-status'),
  signoutBtn: document.getElementById('btn-signout'),
  authPanel: document.getElementById('auth-panel'),
  controlPanel: document.getElementById('control-panel'),
  approveBtn: document.getElementById('btn-approve'),
  denyBtn: document.getElementById('btn-deny'),
  unpairBtn: document.getElementById('btn-unpair'),
  phoneState: document.getElementById('phone-state'),
  log: document.getElementById('log'),
  noConfig: document.getElementById('no-config'),
};

let companion = null;

function log(line) {
  if (!els.log) return;
  const row = document.createElement('div');
  row.textContent = `${new Date().toISOString().slice(11, 19)} ${line}`;
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.children.length > 300) els.log.removeChild(els.log.firstChild);
}

// LOCAL QA fixture capture: draws a deterministic placeholder image on a
// canvas rather than requiring a real camera. Real phone capture (camera/
// gallery) is a host-app responsibility per phoneCompanion.js's capture hook
// contract — this fixture exists only so the real backend pipeline (privacy
// sanitize → wearable-scan → canonical scanner) can be exercised end to end
// from a browser with no camera.
function fixtureCapture() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b3b4d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#d7dee6';
  ctx.font = '28px sans-serif';
  ctx.fillText('K Scan QA fixture capture', 24, 240);
  ctx.fillText(new Date().toISOString(), 24, 280);
  return Promise.resolve(canvas.toDataURL('image/jpeg', 0.85));
}

function renderPhoneState(snapshot) {
  if (!els.phoneState) return;
  els.phoneState.textContent = snapshot.state;
  const pairing = snapshot.state === PHONE_STATE.PAIRING;
  if (els.approveBtn) els.approveBtn.disabled = !pairing;
  if (els.denyBtn) els.denyBtn.disabled = !pairing;
  if (els.unpairBtn) els.unpairBtn.disabled = snapshot.state === PHONE_STATE.IDLE;
}

function startCompanion(userId) {
  if (companion) return;
  const transport = createParentWindowTransport({
    peerWindow: els.frame.contentWindow,
    selfOrigin: window.location.origin,
    targetOrigin: window.location.origin,
    onFatal: (reason) => log(`transport fatal: ${reason}`),
  });

  companion = createPhoneCompanion({
    transport,
    userId,
    capture: fixtureCapture,
    autoApprove: false, // required trust gate — this QA harness never bypasses it
    onStateChange: (snapshot) => {
      renderPhoneState(snapshot);
      log(`state -> ${snapshot.state}`);
    },
    onOutboundSent: (message) => log(`sent ${message.messageType}`),
  });
  companion.start();
  renderPhoneState(companion.getSnapshot());
  log('phone companion started (real backend)');
}

function stopCompanion() {
  if (!companion) return;
  companion.stop();
  companion = null;
  if (els.phoneState) els.phoneState.textContent = 'stopped';
}

async function handleSignIn(event) {
  event.preventDefault();
  const supabase = getSupabaseClient();
  if (!supabase) {
    els.signinStatus.textContent = 'Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing).';
    return;
  }
  els.signinStatus.textContent = 'Signing in...';
  const { data, error } = await supabase.auth.signInWithPassword({
    email: els.signinEmail.value.trim(),
    password: els.signinPassword.value,
  });
  if (error || !data?.user?.id) {
    els.signinStatus.textContent = `Sign-in failed: ${error?.message || 'unknown error'}`;
    return;
  }
  els.signinStatus.textContent = `Signed in as ${data.user.email || data.user.id}`;
  els.authPanel.classList.add('hidden');
  els.controlPanel.classList.remove('hidden');
  startCompanion(data.user.id);
}

async function handleSignOut() {
  stopCompanion();
  const supabase = getSupabaseClient();
  if (supabase) await supabase.auth.signOut();
  els.authPanel.classList.remove('hidden');
  els.controlPanel.classList.add('hidden');
  els.signinStatus.textContent = 'Signed out.';
}

function init() {
  if (!hasSupabaseConfig()) {
    els.noConfig?.classList.remove('hidden');
    els.authPanel?.classList.add('hidden');
    return;
  }
  els.signinForm?.addEventListener('submit', handleSignIn);
  els.signoutBtn?.addEventListener('click', handleSignOut);
  els.approveBtn?.addEventListener('click', () => companion?.approvePairing());
  els.denyBtn?.addEventListener('click', () => companion?.denyPairing('operator-denied'));
  els.unpairBtn?.addEventListener('click', () => companion?.unpair());
}

init();
