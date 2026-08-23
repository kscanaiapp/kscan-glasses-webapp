// Scan pipeline orchestration: capture → sanitize → analyze.
//
// This module structurally enforces the privacy invariant: analyzeImage can
// only ever receive the SANITIZER'S OUTPUT. The raw capture string is held
// in a local and never passed to the analyze step. Node contract tests
// verify ordering and payload routing with injected steps.

export const PIPELINE_STAGES = {
  CAPTURING: 'CAPTURING',
  SANITIZING: 'SANITIZING',
  ANALYZING: 'ANALYZING',
};

const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export class PipelineInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PipelineInvariantError';
  }
}

export class PipelineCancelledError extends Error {
  constructor(message = 'Scan cancelled.') {
    super(message);
    this.name = 'PipelineCancelledError';
    this.code = 'SCAN_CANCELLED';
  }
}

/**
 * @param {object} steps
 * @param {() => Promise<string>} steps.capture
 * @param {(captured: string) => Promise<string>} steps.sanitize
 * @param {(sanitized: string) => Promise<object>} steps.analyze
 * @param {(stage: string) => void} [steps.onStage]
 * @param {() => boolean} [steps.isCancelled] - when true between stages,
 *   analyze is never invoked (cancel/back must not reach the backend).
 * @returns {Promise<{response: object}>} analyze response. The sanitized
 *   payload is intentionally NOT returned to callers — no screen needs it,
 *   and not exposing it prevents accidental storage/logging.
 */
export async function runScanPipeline({ capture, sanitize, analyze, onStage, isCancelled } = {}) {
  if (typeof capture !== 'function' || typeof sanitize !== 'function' || typeof analyze !== 'function') {
    throw new PipelineInvariantError('Pipeline requires capture, sanitize, and analyze steps.');
  }

  const cancelled = () => typeof isCancelled === 'function' && isCancelled();
  const notify = (stage) => {
    if (typeof onStage === 'function') onStage(stage);
  };

  notify(PIPELINE_STAGES.CAPTURING);
  const captured = await capture();
  if (cancelled()) throw new PipelineCancelledError();

  notify(PIPELINE_STAGES.SANITIZING);
  const sanitized = await sanitize(captured);
  if (cancelled()) throw new PipelineCancelledError();

  if (typeof sanitized !== 'string' || !sanitized.startsWith(JPEG_DATA_URL_PREFIX)) {
    throw new PipelineInvariantError('Sanitizer did not return a JPEG data URL; upload blocked.');
  }

  notify(PIPELINE_STAGES.ANALYZING);
  const response = await analyze(sanitized);

  return { response };
}
