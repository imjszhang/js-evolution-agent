import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { runtimeForSubject } from './evolve-runs.mjs';

export function storeForSubject(root, subject) {
  return createIntelligenceStore({ baseDir: runtimeForSubject(root, subject).intelligenceDir });
}

export function recordDaemonEvent(root, subject, event) {
  try {
    storeForSubject(root, subject).recordEvolutionEvent({
      subject,
      ...event,
    });
    return { recorded: true };
  } catch (e) {
    console.warn(`failed to record daemon event: ${e?.message || e}`);
    return { recorded: false, error: e?.message || String(e) };
  }
}
