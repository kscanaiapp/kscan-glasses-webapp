// Companion runtime orchestrator — HUD side, Meta companion Phase A.
//
// Wires transport → protocol validation → result contract validation →
// session correlation → runtime state machine, and exposes a small
// app-facing API. Owns liveness (ping/pong), heartbeat ticks, and
// transport-failure synthesis of connection.lost.
//
// Safety rules (do not weaken):
//   - Every inbound message passes protocol.validateMessage BEFORE the
//     state machine sees it. Invalid messages are dropped and counted.
//   - result.show/update payloads pass validateResultPayload BEFORE the
//     machine sees them; invalid results are dropped.
//   - Outbound sends that fail synthesize connection loss — never silent.
//   - Diagnostics expose metadata only: no payloads, no tokens, no images.

import { MESSAGE_TYPES, validateMessage } from './protocol.js';
import { validateResultPayload, buildCompanionStyleMatch } from './resultContract.js';
import { createSessionManager } from './session.js';
import { createRuntimeMachine, RUNTIME_STATE, STATE_META } from './runtimeState.js';
import { TRANSPORT_STATE } from './transport.js';

const HEARTBEAT_MS = 1000;
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 8000;

export function makeHudDeviceId() {
  return `hud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} options
 * @param {object} options.transport - resolveCompanionTransport() result.
 * @param {string} [options.deviceId]
 * @param {(snapshot: object, meta: object) => void} [options.onStateChange]
 * @param {(styleMatch: object, result: object) => void} [options.onResult]
 * @param {(message: object) => void} [options.onOutboundSent] - test hook.
 */
export function createCompanionRuntime({ transport, deviceId = makeHudDeviceId(), onStateChange = () => {}, onResult = () => {}, onOutboundSent = () => {}, now = () => Date.now() } = {}) {
  if (!transport) throw new Error('companion runtime requires a transport');

  const sessionManager = createSessionManager({ deviceId, now });
  const counters = { sent: 0, received: 0, dropped: 0, invalidResults: 0 };
  let heartbeat = null;
  let lastPingAt = null;
  let lastPingSentAt = 0;
  let outstandingPingNonce = null;
  let pingSeq = 0;
  let started = false;

  function emitState(detail = {}) {
    onStateChange(machine.getSnapshot(), { meta: STATE_META[machine.getSnapshot().state], detail });
  }

  function synthesizeConnectionLost(reason) {
    const msg = {
      protocolVersion: 'kscan.meta.companion.v1',
      messageType: MESSAGE_TYPES.CONNECTION_LOST,
      messageId: `local_lost_${now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      requestId: null,
      sessionId: null,
      deviceId,
      timestamp: now(),
      expiresAt: now() + 60 * 1000,
      payload: { reason },
    };
    machine.dispatchInbound(msg);
  }

  const machine = createRuntimeMachine({
    sessionManager,
    now,
    onTransition: (prev, next, detail) => {
      if (next === RUNTIME_STATE.RESULTS && detail.result) {
        const styleMatch = buildCompanionStyleMatch(detail.result, {
          capabilities: sessionManager.snapshot().session?.capabilities ?? [],
        });
        onResult(styleMatch, detail.result);
      }
      emitState({ prev, transition: true, ...(detail || {}) });
    },
    onOutbound: (message) => {
      counters.sent += 1;
      onOutboundSent(message);
      const ok = transport.send(message);
      if (!ok) synthesizeConnectionLost('send-failed');
    },
  });

  function handleInbound(raw) {
    const paired = sessionManager.snapshot().pairingState === 'paired';
    const verdict = validateMessage(raw, { deviceId, paired, now: now() });
    if (!verdict.ok) {
      counters.dropped += 1;
      return;
    }
    const message = verdict.message;

    if (message.messageType === MESSAGE_TYPES.RESULT_SHOW || message.messageType === MESSAGE_TYPES.RESULT_UPDATE) {
      const resultVerdict = validateResultPayload(message.payload.result, { now: now() });
      if (!resultVerdict.ok) {
        counters.invalidResults += 1;
        return;
      }
      message.payload = { ...message.payload, result: resultVerdict.result };
    }

    if (message.messageType === MESSAGE_TYPES.CONNECTION_PONG) {
      // Stale-pong resistance: only the pong for the CURRENT outstanding
      // ping nonce refreshes liveness.
      if (outstandingPingNonce !== null && message.payload.nonce === outstandingPingNonce) {
        lastPingAt = null;
        outstandingPingNonce = null;
      }
    }

    counters.received += 1;
    machine.dispatchInbound(message);
  }

  function heartbeatTick() {
    machine.tick();

    const state = machine.getSnapshot().state;
    const transportState = transport.getConnectionState();

    // Liveness: while paired and transport open, ping on interval; a pong
    // older than PING_TIMEOUT_MS means the peer is gone.
    if (sessionManager.isSessionValid() && transportState === TRANSPORT_STATE.OPEN) {
      const nowMs = now();
      const activeState = state !== RUNTIME_STATE.RECONNECTING;
      if (activeState && outstandingPingNonce === null && nowMs - lastPingSentAt >= PING_INTERVAL_MS) {
        pingSeq += 1;
        lastPingAt = nowMs;
        lastPingSentAt = nowMs;
        outstandingPingNonce = `probe-${pingSeq}`;
        machine.sendPing(outstandingPingNonce);
      }
      if (activeState && outstandingPingNonce !== null && lastPingAt
        && nowMs - lastPingAt >= PING_TIMEOUT_MS) {
        lastPingAt = null;
        outstandingPingNonce = null;
        synthesizeConnectionLost('pong-timeout');
      }
    }
  }

  const runtime = {
    start() {
      if (started) return;
      started = true;
      transport.connect();
      transport.subscribe(handleInbound);
      heartbeat = setInterval(heartbeatTick, HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref(); // never hold a node process open
      emitState({ started: true });
    },
    stop() {
      started = false;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      transport.disconnect();
    },
    // User intents (D-pad) — forwarded to the state machine. Each returns
    // the machine's { accepted, reason? } verdict so the UI can fall back
    // to navigation when an intent is not valid in the current state.
    pair() { return machine.userIntent('pair'); },
    scan() { return machine.userIntent('scan'); },
    cancel() { return machine.userIntent('cancel'); },
    back() { return machine.userIntent('back'); },
    retry() { return machine.userIntent('retry'); },
    dismiss() { return machine.userIntent('dismiss'); },
    save() { return machine.userIntent('save'); },
    openOnPhone() { return machine.userIntent('open_on_phone'); },
    unpair() { return machine.userIntent('unpair'); },
    getSnapshot: () => machine.getSnapshot(),
    getStateMeta: () => STATE_META[machine.getSnapshot().state],
    getDiagnostics() {
      const snap = machine.getSnapshot();
      return {
        state: snap.state,
        session: snap.session,
        sessionValid: snap.sessionValid,
        requestInFlight: snap.requestId !== null,
        transport: transport.getConnectionState(),
        sent: counters.sent,
        received: counters.received,
        dropped: counters.dropped,
        invalidResults: counters.invalidResults,
        lastError: snap.lastError,
      };
    },
    // Test hooks — not used by the HUD UI.
    __test: { machine, sessionManager, handleInbound, heartbeatTick },
  };
  return runtime;
}
