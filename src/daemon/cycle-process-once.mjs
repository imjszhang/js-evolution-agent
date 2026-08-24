/**
 * Bounded Cycle one-shot recovery. Scans wake backlog, then claims at most
 * one Cycle-domain task. Does not start continuous evolution and does not
 * touch Channel worker state.
 */
import { enqueueTask, readTaskQueue } from './daemon-tasks.mjs';
import { buildDaemonProjection } from './daemon-projection.mjs';
import { recordDaemonEvent, storeForSubject } from './daemon-events.mjs';
import { readChannelWorkerState } from '../channel/worker-state.mjs';
import { listEligibleEvidence, readClaimLedger } from '../evolution/reactor/claim-ledger.mjs';
import { listBatchCheckpoints } from '../evolution/reactor/batch-checkpoint-store.mjs';
import {
  runCognitiveReactionTask,
  scanWakeBacklog,
} from '../evolution/reactor/reactor-tasks.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { isEvolutionPaused } from '../product/evolution-state.mjs';

const CYCLE_TASK_TYPES = new Set([
  'cognitive_reaction',
  'exec_queue',
  'verify_batch',
  'rule_reaction',
  'memory_compaction',
]);

function envFlagOn(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function snapshotChannel(root, subject) {
  const raw = readChannelWorkerState(root, subject);
  if (!raw) {
    return { pid: null, status: null, heartbeat_at: null, worker_id: null, stop_requested_at: null };
  }
  return {
    pid: raw.pid ?? null,
    status: raw.status ?? null,
    heartbeat_at: raw.heartbeat_at ?? null,
    worker_id: raw.worker_id ?? null,
    stop_requested_at: raw.stop_requested_at ?? null,
  };
}

function channelUnchanged(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function pendingEvidenceCount(root, subject, { ignoreAfterMs = null } = {}) {
  const runtime = runtimeForSubject(root, subject);
  return listEligibleEvidence(runtime.dataRoot, { reactor: 'cognitive' })
    .filter((envelope) => {
      if (ignoreAfterMs == null) return true;
      const occurred = Date.parse(envelope.occurred_at ?? envelope.created_at ?? '');
      return !(Number.isFinite(occurred) && occurred >= ignoreAfterMs);
    })
    .length;
}

function snapshotCycleHealth(root, subject) {
  const projection = buildDaemonProjection(root, subject, { eventLimit: 10 });
  return {
    health: projection.health?.status ?? null,
    health_ok: projection.health?.ok ?? null,
    reactor_status: projection.reactor?.status ?? null,
    pending_count: projection.reactor?.evidence?.pending_count ?? 0,
    eligible_unclaimed_count: projection.reactor?.evidence?.eligible_unclaimed_count
      ?? projection.reactor?.evidence?.pending_count
      ?? 0,
    reasons: projection.health?.reasons ?? [],
    suggestions: projection.health?.suggestions ?? [],
    worker: projection.worker
      ? {
        running: Boolean(projection.worker.running),
        stale: Boolean(projection.worker.stale),
        zombie: Boolean(projection.worker.zombie),
        pid: projection.worker.pid ?? null,
      }
      : null,
  };
}

function latestCognitiveClaim(dataRoot) {
  const ledger = readClaimLedger(dataRoot);
  const claims = (ledger.claims || []).filter((claim) => claim.reactor === 'cognitive');
  return claims.length ? claims[claims.length - 1] : null;
}

function latestCognitiveCheckpoint(dataRoot) {
  const checkpoints = listBatchCheckpoints(dataRoot, { reactor: 'cognitive' })
    .filter((record) => record?.batch_id)
    .sort((a, b) => String(b.written_at || '').localeCompare(String(a.written_at || '')));
  return checkpoints[0] ?? null;
}

function recentCycleEvents(root, subject, sinceMs) {
  const store = storeForSubject(root, subject);
  return (store.readEvolutionEvents?.({ limit: 80 }) ?? [])
    .filter((event) => !event.subject || event.subject === subject)
    .filter((event) => {
      const recorded = Date.parse(event.recorded_at ?? event.ts ?? '');
      return Number.isFinite(recorded) ? recorded >= sinceMs - 1000 : true;
    })
    .slice(0, 20)
    .map((event) => ({
      id: event.id ?? null,
      type: event.type ?? null,
      status: event.status ?? null,
      task_id: event.task_id ?? null,
      batch_id: event.batch_id ?? event.producer_batch_id ?? null,
      recorded_at: event.recorded_at ?? null,
      error_code: event.error_code ?? null,
    }));
}

function pendingCycleTask(root, subject) {
  const queue = readTaskQueue(root, subject);
  return (queue.tasks || []).find((task) => (
    task.status === 'pending' && CYCLE_TASK_TYPES.has(task.type)
  )) ?? null;
}

function applyMockEnv(flags = {}) {
  const previous = {
    JEA_FORCE_MOCK: process.env.JEA_FORCE_MOCK,
    JEA_REACTOR_SKIP_INVESTIGATE: process.env.JEA_REACTOR_SKIP_INVESTIGATE,
  };
  const mock = Boolean(flags.mock) || envFlagOn(process.env.JEA_FORCE_MOCK);
  const skipInvestigate = flags['skip-investigate'] !== false
    && (Boolean(flags['skip-investigate']) || mock || envFlagOn(process.env.JEA_REACTOR_SKIP_INVESTIGATE));
  if (mock) process.env.JEA_FORCE_MOCK = '1';
  if (skipInvestigate) process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';
  return {
    mock,
    skipInvestigate,
    restore() {
      if (previous.JEA_FORCE_MOCK == null) delete process.env.JEA_FORCE_MOCK;
      else process.env.JEA_FORCE_MOCK = previous.JEA_FORCE_MOCK;
      if (previous.JEA_REACTOR_SKIP_INVESTIGATE == null) delete process.env.JEA_REACTOR_SKIP_INVESTIGATE;
      else process.env.JEA_REACTOR_SKIP_INVESTIGATE = previous.JEA_REACTOR_SKIP_INVESTIGATE;
    },
  };
}

function classifyResult({ work, injectFailure, pendingBefore, pendingAfter, paused = false }) {
  if (injectFailure) {
    return {
      status: 'retryable',
      reason: work?.reason || work?.code || 'reactor_task_lease_lost',
    };
  }
  if (work?.lockError) {
    return { status: 'blocked', reason: 'subject_lock_held' };
  }
  if (!work?.worked) {
    if (paused && (pendingBefore ?? 0) > 0) {
      return { status: 'idle', reason: 'evolution_paused' };
    }
    if ((pendingBefore ?? 0) === 0) {
      return { status: 'idle', reason: 'no_pending_evidence' };
    }
    return { status: 'idle', reason: 'no_cycle_work' };
  }
  if (work.ok === false) {
    const reason = work.code
      || work.reason
      || work.failure?.code
      || work.result?.reason
      || 'reactor_task_failed';
    return {
      status: work.retryable === false ? 'blocked' : 'retryable',
      reason,
    };
  }
  if ((pendingAfter ?? 0) < (pendingBefore ?? 0) || work.result?.result?.batch_id || work.result?.batch_id) {
    return { status: 'ok', reason: 'evidence_processed' };
  }
  if (work.result?.result?.skipped && work.result?.result?.reason === 'no_pending_evidence') {
    return { status: 'idle', reason: 'no_pending_evidence' };
  }
  return { status: 'ok', reason: 'cycle_work_completed' };
}

/**
 * @param {string|object} root
 * @param {string} subject
 * @param {{
 *   mock?: boolean,
 *   'skip-investigate'?: boolean,
 *   injectFailure?: boolean,
 *   worker?: string,
 * }} [flags]
 */
export async function processCycleOnce(root, subject, flags = {}) {
  const startedMs = Date.now();
  const channelBefore = snapshotChannel(root, subject);
  const healthBefore = snapshotCycleHealth(root, subject);
  const pendingBefore = pendingEvidenceCount(root, subject);
  const env = applyMockEnv(flags);
  const paused = isEvolutionPaused(root, subject);

  let scanned = { scanned: false, enqueued: [] };
  let work = null;
  try {
    scanned = scanWakeBacklog(root, subject, { enqueueTask, ignoreBudget: true });
    const queued = pendingCycleTask(root, subject);

    if (pendingBefore === 0 && !queued) {
      work = { worked: false, task: null };
    } else if (paused && !queued) {
      work = { worked: false, task: null };
    } else if (flags.injectFailure) {
      try {
        const outcome = await runCognitiveReactionTask(root, subject, {
          skip_investigate: env.skipInvestigate,
          reason: 'process_cycle_once',
        }, {
          'skip-investigate': env.skipInvestigate,
          canCommit: () => false,
        });
        work = {
          worked: true,
          ok: outcome?.ok !== false,
          retryable: true,
          reason: outcome?.reason || 'reactor_task_lease_lost',
          result: outcome,
        };
      } catch (err) {
        const reason = err?.code === 'lease_lost' || err?.message === 'reactor_task_lease_lost'
          ? 'lease_lost'
          : (err?.code || err?.message || 'lease_lost');
        work = {
          worked: true,
          ok: false,
          retryable: true,
          code: reason,
          reason,
          result: null,
        };
      }
    } else {
      const { workOnce } = await import('./daemon-core.mjs');
      const type = (!paused && pendingBefore > 0) ? 'cognitive_reaction' : (queued?.type ?? null);
      work = await workOnce(root, subject, {
        mock: env.mock,
        'skip-investigate': env.skipInvestigate,
        worker: flags.worker || `cycle-once-${process.pid}`,
        type,
        'subject-lock-held': Boolean(flags['subject-lock-held']),
      });
    }
  } finally {
    env.restore();
  }

  const channelAfter = snapshotChannel(root, subject);
  const healthAfter = snapshotCycleHealth(root, subject);
  const pendingAfter = pendingEvidenceCount(root, subject, { ignoreAfterMs: startedMs });
  const runtime = runtimeForSubject(root, subject);
  const classified = classifyResult({
    work,
    injectFailure: Boolean(flags.injectFailure),
    pendingBefore,
    pendingAfter,
    paused,
  });

  recordDaemonEvent(root, subject, {
    type: 'cycle_process_once',
    status: classified.status,
    reason: classified.reason,
    pending_before: pendingBefore,
    pending_after: pendingAfter,
    task_id: work?.task?.task_id ?? null,
    task_type: work?.task?.type ?? null,
  });

  const claim = latestCognitiveClaim(runtime.dataRoot);
  const checkpoint = latestCognitiveCheckpoint(runtime.dataRoot);
  const events = recentCycleEvents(root, subject, startedMs);

  return {
    subject,
    status: classified.status,
    reason: classified.reason,
    scanned: {
      scanned: Boolean(scanned.scanned),
      enqueued_count: scanned.enqueued?.length ?? 0,
    },
    backlog: {
      before: pendingBefore,
      after: pendingAfter,
    },
    health: {
      before: healthBefore,
      after: healthAfter,
    },
    claim,
    checkpoint,
    events,
    channel: {
      before: channelBefore,
      after: channelAfter,
      unchanged: channelUnchanged(channelBefore, channelAfter),
    },
    work: work
      ? {
        worked: Boolean(work.worked),
        ok: work.ok ?? null,
        retryable: work.retryable ?? null,
        task_id: work.task?.task_id ?? null,
        task_type: work.task?.type ?? null,
        result: work.result ?? null,
      }
      : null,
  };
}

export function processOnceSucceeded(status) {
  return status === 'ok' || status === 'idle';
}

export function processOnceCommandExitCode(status) {
  return processOnceSucceeded(status) ? 0 : 1;
}
