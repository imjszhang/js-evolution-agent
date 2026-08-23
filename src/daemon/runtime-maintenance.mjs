import { join } from 'node:path';
import { cleanupChannelEventQueue } from '../channel/event-queue.mjs';
import { cleanupChannelTaskQueue } from '../channel/task-queue.mjs';
import { cleanupTaskQueue } from './daemon-tasks.mjs';
import {
  cleanupBatchCheckpoints,
} from '../evolution/reactor/batch-checkpoint-store.mjs';
import { cleanupClaimLedger } from '../evolution/reactor/claim-ledger.mjs';
import { cleanupVerifiedExecResults } from '../evolution/reactor/exec-result-store.mjs';
import { cleanupWakeStore } from '../evolution/reactor/wake-store.mjs';
import {
  assessEvidenceJournalMaintenance,
} from '../evolution/reactor/evidence-journal-maintenance.mjs';
import { readJson, updateJson } from '../infra/json-store.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { createIntelligenceStore } from '../intelligence/store.mjs';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function enabled(env) {
  const raw = String(env.JEA_RUNTIME_MAINTENANCE ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function intervalMs(options, env) {
  const parsed = Number(options.intervalMs ?? env.JEA_RUNTIME_MAINTENANCE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_INTERVAL_MS;
}

export function runtimeMaintenanceStatePath(dataRoot) {
  return join(dataRoot, 'evolution', 'reactor', 'maintenance.json');
}

/**
 * Run bounded sidecar and configured intelligence retention. Each component is
 * isolated: one failed archive is audited and retried next maintenance run.
 */
export function runRuntimeMaintenance(root, subject, {
  now = Date.now(),
  force = false,
  env = process.env,
  retention = {},
  intervalMs: intervalOverride,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const statePath = runtimeMaintenanceStatePath(runtime.dataRoot);
  if (!enabled(env)) return { ran: false, reason: 'disabled', state: readJson(statePath, null) };
  const state = readJson(statePath, null);
  const interval = intervalMs({ intervalMs: intervalOverride }, env);
  const lastRun = Date.parse(state?.completed_at || '');
  if (!force && Number.isFinite(lastRun) && now - lastRun < interval) {
    return { ran: false, reason: 'not_due', state };
  }

  const results = {};
  const errors = {};
  const run = (name, fn) => {
    try {
      results[name] = fn();
    } catch (error) {
      errors[name] = {
        code: error?.code ?? 'maintenance_failed',
        message: error?.message || String(error),
      };
    }
  };

  run('claims', () => cleanupClaimLedger(runtime.dataRoot, {
    now,
    ...(retention.claims || {}),
  }));
  run('tasks', () => cleanupTaskQueue(root, subject, {
    now,
    ...(retention.tasks || {}),
  }));
  run('checkpoints', () => cleanupBatchCheckpoints(runtime.dataRoot, {
    now,
    ...(retention.checkpoints || {}),
  }));
  run('exec_results', () => cleanupVerifiedExecResults(runtime.dataRoot, {
    now,
    ...(retention.execResults || {}),
  }));
  run('wakes', () => cleanupWakeStore(runtime.dataRoot, {
    now,
    ...(retention.wakes || {}),
  }));
  // Projection-only: a live daemon never rewrites the journal. It records a
  // bounded due/blocked state for an operator-run stopped rebuild.
  run('evidence_journal', () => assessEvidenceJournalMaintenance(runtime.dataRoot, { env }));
  run('channel_tasks', () => cleanupChannelTaskQueue(root, subject, {
    now,
    ...(retention.channelTasks || {}),
  }));
  run('channel_events', () => cleanupChannelEventQueue(root, subject, {
    now,
    ...(retention.channelEvents || {}),
  }));
  run('intelligence', () => createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
  }).cleanup());

  const completedAt = new Date(now).toISOString();
  const next = updateJson(statePath, (current) => ({
    ...(current || {}),
    schema_version: 1,
    subject,
    completed_at: completedAt,
    interval_ms: interval,
    status: Object.keys(errors).length ? 'partial' : 'ok',
    results,
    errors,
  }), { fallback: {} });
  return {
    ran: true,
    status: next.status,
    results,
    errors,
    state: next,
  };
}
