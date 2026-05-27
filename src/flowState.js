export const FLOW_STATES = {
  IDLE: 'IDLE',
  CAPTURING: 'CAPTURING',
  SANITIZING: 'SANITIZING',
  ANALYZING: 'ANALYZING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
};

let flowState = FLOW_STATES.IDLE;
const listeners = new Set();

export function setFlowState(next) {
  flowState = next;
  listeners.forEach((listener) => {
    try {
      listener(flowState);
    } catch {
      // keep listener failures isolated
    }
  });
}

export function getFlowState() {
  return flowState;
}

export function subscribeFlowState(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
