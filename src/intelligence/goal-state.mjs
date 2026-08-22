import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, writeJsonFile } from '../infra/files.mjs';
import { createIntelligenceStore } from './store.mjs';
import { validateGoalShape } from './goal-patches.mjs';

export function activeGoalsPathForRuntime(runtimeRoot) {
  return join(runtimeRoot, 'data', 'goals', 'active_goals.json');
}

function goalId(goal) {
  return goal?.id ?? goal?.goal_id ?? null;
}

function defaultStore(runtimeRoot) {
  return createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

export function readActiveGoalState(runtime) {
  const path = activeGoalsPathForRuntime(runtime.runtimeRoot);
  return {
    runtime,
    path,
    goals: readJsonSafe(path, null),
  };
}

/**
 * @param {any} runtime
 * @param {any} nextGoal
 * @param {{ type?: string, reason: string, evidenceRefs?: any[], cycle?: string | null, store?: any, causalIdentity?: object }} [opts]
 */
export function applyActiveGoalState(runtime, nextGoal, {
  type = 'updated',
  reason,
  evidenceRefs = [],
  cycle = null,
  store = null,
  causalIdentity = null,
} = {}) {
  if (!reason || !String(reason).trim()) throw new Error('Missing required reason.');
  const validation = validateGoalShape(nextGoal);
  if (!validation.valid) throw new Error(validation.detail || validation.reason);

  const path = activeGoalsPathForRuntime(runtime.runtimeRoot);
  const previousGoal = readJsonSafe(path, null);
  const event = {
    type,
    goal_id: goalId(nextGoal) ?? goalId(previousGoal),
    previous_goal: previousGoal,
    next_goal: nextGoal,
    reason: String(reason).trim(),
    evidence_refs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    cycle_id: cycle,
    ...(causalIdentity ?? {}),
  };
  writeJsonFile(path, nextGoal);
  let written;
  try {
    written = (store ?? defaultStore(runtime.runtimeRoot)).recordGoalEvent(event);
  } catch (error) {
    if (previousGoal == null) rmSync(path, { force: true });
    else writeJsonFile(path, previousGoal);
    throw error;
  }
  return {
    runtime,
    path,
    previousGoal,
    nextGoal,
    event,
    written,
  };
}
