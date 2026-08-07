import { recordDaemonEvent, storeForSubject } from './daemon-events.mjs';
import { writeDaemonProjection, buildDaemonProjection } from './daemon-projection.mjs';
import { updateWorkerHeartbeat, readWorkerState } from './daemon-worker-state.mjs';
import { resolveEvolutionMode, setSubjectEvolutionMode } from './evolution-mode.mjs';

/**
 * Update subjects.json evolution.mode and emit side effects for operators / viewer SSE.
 */
export function applyEvolutionModeChange(root, subject, mode, { recordEvent = true, trigger = 'cli' } = {}) {
  const before = resolveEvolutionMode(root, { subject });
  const result = setSubjectEvolutionMode(root, subject, mode);
  const after = resolveEvolutionMode(root, { subject });

  if (result.changed && recordEvent) {
    recordDaemonEvent(root, subject, {
      type: 'evolution_mode_changed',
      status: 'ok',
      from: before.mode,
      to: after.mode,
      source: after.source,
      trigger,
    });
  }

  const worker = readWorkerState(root, subject);
  if (worker && ['running', 'stopping'].includes(worker.status)) {
    updateWorkerHeartbeat(root, subject, {
      evolution_mode: after.mode,
      evolution_mode_source: after.source,
    });
  }

  try {
    const store = storeForSubject(root, subject);
    writeDaemonProjection(root, subject, buildDaemonProjection(root, subject, { store }));
  } catch {
    // projection is best-effort for viewer runtime_updated
  }

  return {
    ...result,
    resolved: after,
  };
}
