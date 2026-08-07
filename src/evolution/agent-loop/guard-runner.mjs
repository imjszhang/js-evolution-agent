import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decisionFingerprint } from '../../engine/index.mjs';
import { getSubjectEntry } from '../../infra/subjects.mjs';

function nowIso() {
  return new Date().toISOString();
}

function guardStatePath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'evolution', 'agent_loop_guard_state.json');
}

function readGuardState(runtimeRoot) {
  const path = guardStatePath(runtimeRoot);
  if (!existsSync(path)) {
    return { schema_version: 1, guards: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      schema_version: 1,
      guards: raw?.guards && typeof raw.guards === 'object' ? raw.guards : {},
    };
  } catch {
    return { schema_version: 1, guards: {} };
  }
}

function writeGuardState(runtimeRoot, state) {
  const path = guardStatePath(runtimeRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Load evolution.guards from subject registry (enabled and disabled).
 * Shared by guard-runner and rule-feedback callers.
 */
export function loadSubjectGuards(root, subject) {
  if (!root || !subject) return [];
  try {
    const entry = getSubjectEntry(root, subject);
    const guards = entry?.evolution?.guards;
    return Array.isArray(guards) ? guards : [];
  } catch {
    return [];
  }
}

/** Enabled guards only (enabled !== false and has id). */
export function loadEnabledGuards(root, subject) {
  return loadSubjectGuards(root, subject).filter((g) => g && g.enabled !== false && g.id);
}

function normalizeAction(guard) {
  const raw = guard?.action && typeof guard.action === 'object' ? guard.action : {};
  const type = String(raw.type || '').trim();
  if (!type) return null;
  const guardId = String(guard.id || '').trim();
  return {
    type,
    description: String(raw.description || `Mechanical guard: ${guard.id}`),
    serves_goal: raw.serves_goal || undefined,
    priority: raw.priority || 'high',
    params: raw.params && typeof raw.params === 'object' ? raw.params : {},
    // Origin markers for assess / rule-feedback (not in decisionFingerprint).
    origin: 'mechanical_guard',
    guard_id: guardId || undefined,
  };
}

/**
 * Run mechanical guards configured on the subject registry.
 * Does not consume agent_loop action budget. Never throws.
 *
 * @param {{ root: string, loopCtx: object }} opts
 * @returns {Promise<{ ran: object[], skipped: object[], events: object[] }>}
 */
export async function runMechanicalGuards({ root, loopCtx } = {}) {
  const ran = [];
  const skipped = [];
  const events = [];
  if (!loopCtx?.runtime?.runtimeRoot || !loopCtx.cycleId) {
    return { ran, skipped, events };
  }

  const runtimeRoot = loopCtx.runtime.runtimeRoot;
  const subject = loopCtx.runtime.subject;
  const currentCycleId = loopCtx.cycleId;
  const allGuards = loadSubjectGuards(root, subject);
  const guards = allGuards.filter((g) => g && g.enabled !== false && g.id);

  const state = readGuardState(runtimeRoot);
  const { decisionQueue, executor, emitEvent, dedup, executed, logger } = loopCtx;

  // Detect removed guards (state entry exists but no longer in enabled config).
  const enabledIds = new Set(guards.map((g) => String(g.id)));
  for (const stateId of Object.keys(state.guards || {})) {
    if (enabledIds.has(stateId)) continue;
    if (state.guards[stateId]?._removed_emitted) continue;
    const removedEvent = {
      type: 'mechanical_guard_removed',
      status: 'ok',
      guard_id: stateId,
      cycle_id: currentCycleId,
      serves_goal: state.guards[stateId]?.serves_goal ?? null,
    };
    emitEvent?.(removedEvent);
    events.push(removedEvent);
    state.guards[stateId] = {
      ...state.guards[stateId],
      _removed_emitted: true,
      removed_at_cycle_id: currentCycleId,
    };
  }

  if (!guards.length) {
    try {
      writeGuardState(runtimeRoot, state);
    } catch (e) {
      logger?.warning?.(`[exec] failed to persist guard state: ${e?.message || e}`);
    }
    return { ran, skipped, events };
  }

  for (const guard of guards) {
    const guardId = String(guard.id);
    const everyCycles = Math.max(1, Math.trunc(Number(guard.every_cycles) || 1));
    const servesGoal = guard?.action?.serves_goal ?? null;
    let entry = state.guards[guardId];
    if (!entry || entry._removed_emitted) {
      // First sighting (or re-registered after removal): treat as due.
      const isReregister = Boolean(entry?._removed_emitted);
      entry = {
        last_seen_cycle_id: currentCycleId,
        cycles_since_last_run: everyCycles,
        last_run_cycle_id: null,
        last_run_at: null,
        last_status: null,
        serves_goal: servesGoal,
      };
      state.guards[guardId] = entry;
      const registeredEvent = {
        type: 'mechanical_guard_registered',
        status: 'ok',
        guard_id: guardId,
        cycle_id: currentCycleId,
        serves_goal: servesGoal,
        every_cycles: everyCycles,
        reregistered: isReregister,
      };
      emitEvent?.(registeredEvent);
      events.push(registeredEvent);
    } else if (entry.last_seen_cycle_id !== currentCycleId) {
      entry.cycles_since_last_run = Number(entry.cycles_since_last_run || 0) + 1;
      entry.last_seen_cycle_id = currentCycleId;
      if (servesGoal != null) entry.serves_goal = servesGoal;
    }

    if (entry.last_run_cycle_id === currentCycleId) {
      skipped.push({ guard_id: guardId, reason: 'already_ran_this_cycle' });
      continue;
    }

    const due = entry.cycles_since_last_run >= everyCycles;
    if (!due) {
      skipped.push({
        guard_id: guardId,
        reason: 'not_due',
        cycles_since_last_run: entry.cycles_since_last_run,
        every_cycles: everyCycles,
      });
      continue;
    }

    const action = normalizeAction(guard);
    if (!action) {
      skipped.push({ guard_id: guardId, reason: 'invalid_action' });
      continue;
    }

    try {
      const queued = decisionQueue.addDecisionsDetailed({
        cycleId: currentCycleId,
        actions: [action],
        analysisContext: 'exec_guard',
        metadata: { pipeline: 'agent_loop', phase: 'exec', guard: true, guard_id: guardId },
      });
      if (!queued.ids?.length) {
        entry.last_run_cycle_id = currentCycleId;
        entry.last_run_at = nowIso();
        entry.last_status = 'failed';
        skipped.push({
          guard_id: guardId,
          reason: queued.skipped?.[0]?.reason || 'queue_rejected',
        });
        continue;
      }

      const decisionId = queued.ids[0];
      decisionQueue.updateStatus?.(decisionId, 'in_progress');
      const result = await executor.execute(action);
      const summary = result?.summary
        || result?.message
        || result?.error
        || (result?.success ? 'ok' : 'failed');

      if (result?.success) {
        decisionQueue.completeDecision?.(decisionId, String(summary).slice(0, 2000));
        entry.cycles_since_last_run = 0;
        entry.last_status = 'ok';
      } else if (result?.deferred) {
        decisionQueue.updateStatus?.(decisionId, 'pending');
        entry.last_status = 'deferred';
      } else {
        decisionQueue.failDecision?.(decisionId, String(result?.error || summary).slice(0, 2000));
        entry.last_status = 'failed';
      }

      entry.last_run_cycle_id = currentCycleId;
      entry.last_run_at = nowIso();

      if (dedup) dedup.add(decisionFingerprint(action));
      if (Array.isArray(executed)) {
        executed.push({ id: decisionId, action, result, guard_id: guardId });
      }
      emitEvent?.({
        type: 'agent_loop_guard_executed',
        status: result?.success ? 'ok' : 'failed',
        guard_id: guardId,
        action_type: action.type,
        cycle_id: currentCycleId,
      });

      ran.push({
        guard_id: guardId,
        decision_id: decisionId,
        action,
        result,
        success: Boolean(result?.success),
      });
      logger?.info?.(`[exec] guard ${guardId} => ${entry.last_status}`);
    } catch (e) {
      entry.last_run_cycle_id = currentCycleId;
      entry.last_run_at = nowIso();
      entry.last_status = 'failed';
      skipped.push({
        guard_id: guardId,
        reason: e?.message || String(e),
      });
      logger?.warning?.(`[exec] guard ${guardId} failed: ${e?.message || e}`);
      emitEvent?.({
        type: 'agent_loop_guard_executed',
        status: 'failed',
        guard_id: guardId,
        action_type: action.type,
        cycle_id: currentCycleId,
        error: e?.message || String(e),
      });
    }
  }

  try {
    writeGuardState(runtimeRoot, state);
  } catch (e) {
    logger?.warning?.(`[exec] failed to persist guard state: ${e?.message || e}`);
  }

  return { ran, skipped, events };
}

export { guardStatePath, readGuardState, normalizeAction };
