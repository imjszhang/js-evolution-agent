import { recordDaemonEvent, storeForSubject } from './daemon-events.mjs';
import { writeDaemonProjection, buildDaemonProjection } from './daemon-projection.mjs';
import { updateWorkerHeartbeat, readWorkerState } from './daemon-worker-state.mjs';
import {
  resolveEvolutionState,
  setSubjectEvolutionState,
} from '../product/evolution-state.mjs';

/**
 * Persist evolution.state and emit operator / viewer side effects.
 */
export function applyEvolutionStateChange(root, subject, state, { recordEvent = true, trigger = 'cli' } = {}) {
  const before = resolveEvolutionState(root, subject);
  const result = setSubjectEvolutionState(root, subject, state);
  const after = resolveEvolutionState(root, subject);

  if (result.changed && recordEvent) {
    recordDaemonEvent(root, subject, {
      type: 'evolution_state_changed',
      status: 'ok',
      from: before.state,
      to: after.state,
      source: after.mapped_from,
      trigger,
    });
  }

  const worker = readWorkerState(root, subject);
  if (worker && ['running', 'stopping'].includes(worker.status)) {
    updateWorkerHeartbeat(root, subject, {
      evolution_state: after.state,
      evolution_state_source: after.mapped_from,
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
