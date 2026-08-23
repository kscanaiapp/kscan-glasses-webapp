#!/usr/bin/env node
// Wearable deployment-drift guard.
//
// Why this exists: the P2-01 commerce-grouping repair was committed, tested
// green (16/16 source tests), and then REGRESSED IN STAGING anyway — the
// deployed `wearable-scan` had been rolled back to v8 while the repo still held
// the fixed source. Source tests cannot see that. This guard closes the gap by
// comparing what is DEPLOYED against what is COMMITTED, and by probing the
// deployed functions for the invariants that have actually broken before.
//
//   Layer A  deployed-vs-source fingerprint  (needs Supabase CLI auth)
//   Layer B  live behavioural contract locks (needs staging URL + publishable key)
//   Layer C  source invariant locks          (no credentials; always runs)
//
// Usage:
//   node scripts/wearable-deploy-drift-guard.mjs               # all layers it can run
//   node scripts/wearable-deploy-drift-guard.mjs --require-live # fail if A/B are skipped
//   node scripts/wearable-deploy-drift-guard.mjs --source-only  # layer C only
//
// Environment:
//   SUPABASE_PROJECT_REF        staging project ref            (layers A, B)
//   SUPABASE_PUBLISHABLE_KEY    staging publishable key        (layer B)
//   SUPABASE_ACCESS_TOKEN       optional; the CLI's own login is used otherwise
//
// No credential value is ever printed by this script.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows ships these tools as .cmd shims, and Node refuses to spawn those
// without a shell. Arguments are therefore validated rather than trusted: the
// only interpolated value is the project ref, which is checked below.
const WIN = process.platform === 'win32';
const runOpts = (extra) => Object.assign({ stdio: 'pipe' }, WIN ? { shell: true } : {}, extra);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS = ['wearable-scan', 'wearable-bridge', 'wearable-save', 'wearable-open-on-phone'];

const argv = new Set(process.argv.slice(2));
const REQUIRE_LIVE = argv.has('--require-live');
const SOURCE_ONLY = argv.has('--source-only');

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || '';
const PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY || '';

// The project ref reaches a shell on Windows, so it must be an opaque token and
// nothing else. A malformed value is a configuration error, not something to
// pass through.
if (PROJECT_REF && !/^[a-z0-9]{16,32}$/.test(PROJECT_REF)) {
  console.error('SUPABASE_PROJECT_REF is not a valid project ref.');
  process.exit(2);
}

let failures = 0;
let skipped = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
};
const skip = (name, why) => {
  console.log(`SKIP  ${name} — ${why}`);
  skipped++;
};

// Line endings must not be allowed to masquerade as drift: a Windows clone can
// check out CRLF while the deployed copy is LF.
const fingerprint = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

// ── Layer A — deployed source must equal committed source ────────────────────
function layerA() {
  console.log('\n── Layer A: deployed vs committed source ──');
  if (!PROJECT_REF) return skip('deployed-source fingerprint', 'SUPABASE_PROJECT_REF is not set');

  let work;
  try {
    work = mkdtempSync(join(tmpdir(), 'wearable-drift-'));
    for (const fn of FUNCTIONS) {
      try {
        execFileSync('supabase', ['functions', 'download', fn, '--project-ref', PROJECT_REF], runOpts({ cwd: work }));
      } catch (error) {
        ok(`${fn}: downloadable`, false, 'supabase functions download failed (is the CLI logged in?)');
        continue;
      }

      const deployedDir = join(work, 'supabase', 'functions', fn);
      const repoDir = join(ROOT, 'supabase', 'functions', fn);
      if (!existsSync(deployedDir)) { ok(`${fn}: downloadable`, false, 'no source returned'); continue; }

      const deployedFiles = readdirSync(deployedDir).filter((f) => f.endsWith('.ts')).sort();
      for (const file of deployedFiles) {
        const repoFile = join(repoDir, file);
        if (!existsSync(repoFile)) {
          ok(`${fn}/${file}: committed`, false, 'deployed function has a file the repo does not');
          continue;
        }
        const deployedHash = fingerprint(readFileSync(join(deployedDir, file), 'utf8'));
        const repoHash = fingerprint(readFileSync(repoFile, 'utf8'));
        ok(`${fn}/${file}: deployed === committed`, deployedHash === repoHash,
          deployedHash === repoHash ? deployedHash.slice(0, 16) : `deployed ${deployedHash.slice(0, 12)} vs repo ${repoHash.slice(0, 12)}`);
      }

      // A source file that exists in the repo but not in the deployment means
      // the deployed bundle is missing committed behaviour.
      const repoFiles = readdirSync(repoDir)
        .filter((f) => f.endsWith('.ts') && !f.includes('_test') && !f.endsWith('.test.ts'));
      for (const file of repoFiles) {
        if (!deployedFiles.includes(file)) ok(`${fn}/${file}: present in deployment`, false, 'committed file is not deployed');
      }
    }
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

// ── Layer B — the invariants that have actually broken before, probed live ───
async function post(fn, body, { jwt, raw } = {}) {
  const headers = { apikey: PUBLISHABLE, 'Content-Type': 'application/json' };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const started = Date.now();
  const response = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/${fn}`, {
    method: 'POST', headers, body: raw ?? JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})), ms: Date.now() - started };
}

async function layerB() {
  console.log('\n── Layer B: live deployed behaviour ──');
  if (!PROJECT_REF || !PUBLISHABLE) {
    return skip('live contract probes', 'SUPABASE_PROJECT_REF / SUPABASE_PUBLISHABLE_KEY not set');
  }

  // P2-06 — an oversized body must be refused promptly. Before the repair this
  // pinned a worker for ~160 s and answered 503, which is a denial-of-wallet.
  try {
    const oversized = JSON.stringify({ operation: 'pair.create', frame: 'A'.repeat(620_000) });
    const r = await post('wearable-bridge', null, { raw: oversized });
    ok('P2-06 oversized body is refused, not hung', r.status === 413 && r.ms < 10_000, `${r.status} in ${r.ms}ms`);
  } catch (error) {
    ok('P2-06 oversized body is refused, not hung', false, `request never completed: ${error.name}`);
  }

  // Session ownership — a protected mutation must not be reachable without a user JWT.
  const unauth = await post('wearable-bridge', {
    operation: 'phone.action', sessionId: crypto.randomUUID(),
    actionId: crypto.randomUUID(), resultId: crypto.randomUUID(), actionType: 'save',
  });
  ok('session ownership: phone.action without a JWT is refused', unauth.status === 401 && unauth.body.code === 'AUTH_REQUIRED', unauth.body.code || String(unauth.status));

  // A forged wearable token must not resolve to a session.
  const forged = await post('wearable-bridge', { operation: 'session.poll', wearableToken: 'x'.repeat(48) });
  ok('session ownership: a forged wearable token is refused', forged.body.code === 'SESSION_INVALID', forged.body.code || String(forged.status));

  // wearable-scan must accept only sanitized JPEG data URLs.
  for (const [label, image] of [
    ['https URL', 'https://example.invalid/a.jpg'],
    ['file URL', 'file:///etc/passwd'],
    ['PNG data URL', 'data:image/png;base64,iVBORw0KGgo='],
  ]) {
    const r = await post('wearable-scan', { sessionToken: 'z'.repeat(48), image, requestId: crypto.randomUUID() });
    ok(`wearable-scan rejects a ${label}`, r.status >= 400, String(r.status));
  }
}

// ── Layer B2 — locks that only a real session can exercise ──────────────────
// Raw-content rejection, stale-revision rejection and Save idempotency all sit
// BEHIND session validation. Probing them with a forged token only re-proves
// session validation, so these are skipped loudly rather than passed cheaply
// when no QA account is configured.
const frameOf = (messageType, sessionId, deviceId, payload) => JSON.stringify({
  protocolVersion: 1, messageType, requestId: crypto.randomUUID(), deviceId, sessionId,
  timestamp: Date.now(), payload,
});

async function layerB2() {
  console.log('\n── Layer B2: authenticated deployed behaviour ──');
  const email = process.env.SUPABASE_QA_EMAIL || '';
  const password = process.env.SUPABASE_QA_PASSWORD || '';
  if (!PROJECT_REF || !PUBLISHABLE) return skip('authenticated contract locks', 'staging project/key not set');
  if (!email || !password) {
    return skip('authenticated contract locks',
      'SUPABASE_QA_EMAIL / SUPABASE_QA_PASSWORD not set — raw-content, stale-revision and Save-idempotency locks NOT exercised');
  }

  const login = await fetch(`https://${PROJECT_REF}.supabase.co/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000),
  }).then((r) => r.json());
  const jwt = login.access_token;
  if (!jwt) return ok('QA account can sign in', false, 'no access token returned');

  const wearableDeviceId = crypto.randomUUID();
  const phoneDeviceId = crypto.randomUUID();
  const created = await post('wearable-bridge', {
    operation: 'pair.create',
    frame: frameOf('pair.request', '', wearableDeviceId, { model: 'drift-guard', appVersion: '0.0.0-ci' }),
  });
  const ticket = created.body.ticket;
  if (!ticket) return ok('drift guard can establish a session', false, created.body.code || String(created.status));
  await post('wearable-bridge', { operation: 'pair.approve', challengeCode: ticket.challengeCode, phoneDeviceId }, { jwt });
  const polled = await post('wearable-bridge', { operation: 'pair.poll', pairingHandle: ticket.pairingHandle, pairingSecret: ticket.pairingSecret });
  const frames = ((polled.body.poll && polled.body.poll.frames) || []).map((f) => JSON.parse(f));
  const sessionId = (frames.find((f) => f.messageType === 'pair.approved') || {}).sessionId;
  if (!sessionId) return ok('drift guard can establish a session', false, 'pair.poll returned no session');

  // Raw imagery must never transit the frame relay — now reaching the content check.
  const rawImage = await post('wearable-bridge', {
    operation: 'phone.send', sessionId,
    frame: frameOf('result.show', sessionId, phoneDeviceId, { image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }),
  }, { jwt });
  ok('raw imagery is rejected by the frame relay', rawImage.body.code === 'FORBIDDEN_CONTENT', rawImage.body.code || String(rawImage.status));

  // Stale revisions must never overwrite a newer result.
  const resultId = crypto.randomUUID();
  const result = { resultId, scanStatus: 'completed', summary: 'drift guard', products: [] };
  await post('wearable-bridge', { operation: 'phone.send', sessionId, frame: frameOf('result.show', sessionId, phoneDeviceId, { result }) }, { jwt });
  await post('wearable-bridge', { operation: 'phone.send', sessionId, frame: frameOf('result.update', sessionId, phoneDeviceId, { result, revision: 2 }) }, { jwt });
  const rewind = await post('wearable-bridge', { operation: 'phone.send', sessionId, frame: frameOf('result.update', sessionId, phoneDeviceId, { result, revision: 1 }) }, { jwt });
  ok('a stale revision cannot overwrite a newer result', rewind.body.code === 'STALE_REVISION', rewind.body.code || String(rewind.status));

  // A stable actionId must drive Save idempotency.
  const actionId = crypto.randomUUID();
  const first = await post('wearable-bridge', { operation: 'phone.action', sessionId, actionId, resultId, actionType: 'save' }, { jwt });
  const replay = await post('wearable-bridge', { operation: 'phone.action', sessionId, actionId, resultId, actionType: 'save' }, { jwt });
  ok('a stable actionId makes Save idempotent',
    first.body.duplicate === false && replay.body.duplicate === true,
    `first duplicate=${first.body.duplicate}, replay duplicate=${replay.body.duplicate}`);

  // An actionId is single-purpose.
  const conflict = await post('wearable-bridge', { operation: 'phone.action', sessionId, actionId, resultId, actionType: 'open_on_phone' }, { jwt });
  ok('an actionId cannot be reused for a different action', conflict.body.code === 'ACTION_CONFLICT', conflict.body.code || String(conflict.status));

  await post('wearable-bridge', { operation: 'phone.revoke_all', reason: 'sign_out' }, { jwt });
}

// ── Layer C — source invariants, enforced by the real behavioural suites ─────
function layerC() {
  console.log('\n── Layer C: committed source invariants ──');
  const suites = [
    ['P2-01 commerce grouping (suggested must not collapse to retail)', ['test', '--no-check', 'supabase/functions/wearable-scan/_test.ts']],
    ['P3-04 Save idempotency key', ['test', '--allow-all', 'supabase/functions/wearable-bridge/savedScanIdempotency_test.ts']],
  ];
  for (const [name, args] of suites) {
    try {
      execFileSync('deno', args, runOpts({ cwd: ROOT }));
      ok(name, true);
    } catch (error) {
      ok(name, false, (error.stdout?.toString() || error.message).split('\n').slice(-6).join(' ').trim());
    }
  }

  try {
    execFileSync(process.execPath, ['--test', 'supabase/migrations/wearable_schema_reconciliation.test.mjs'], { cwd: ROOT, stdio: 'pipe' });
    ok('P2-05 schema reconciliation stays complete', true);
  } catch (error) {
    ok('P2-05 schema reconciliation stays complete', false, (error.stdout?.toString() || error.message).split('\n').slice(-4).join(' ').trim());
  }
}

console.log('Wearable deployment-drift guard');
console.log(`project ref: ${PROJECT_REF || '(unset)'}   publishable key: ${PUBLISHABLE ? 'provided' : '(unset)'}`);

layerC();
if (!SOURCE_ONLY) {
  layerA();
  await layerB();
  await layerB2();
}

if (REQUIRE_LIVE && skipped > 0) {
  console.log(`\nFAIL  --require-live was set but ${skipped} check group(s) were skipped for missing configuration.`);
  failures += skipped;
}

console.log(`\n${failures ? 'DRIFT GUARD FAILED' : 'DRIFT GUARD PASSED'} — ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
