/**
 * Event-driven reactor task runners (S3–S7).
 * Daemon claims a mergeable task, then these handlers do the work in-process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeForSubject } from '../../infra/runtime-paths.mjs';
import { buildCycleContext, runExecStep, runVerifyStep } from '../cycle-steps.mjs';
import { runCognitiveLiveReaction } from './cognitive-reactor.mjs';
import { peekRuleDueWindow, runRuleReaction } from './rule-reactor.mjs';
import { compactMemory, readMemoryCompactionProjection, shouldCompactMemory } from './memory-compactor.mjs';
import { consumeWakeIntent, enqueueWakeIntent, listPendingWakes } from './wake-store.mjs';
import { patchBatchCheckpoint, readBatchCheckpoint } from './batch-checkpoint-store.mjs';
import { isEvidenceWakeEnabled } from './feature-gates.mjs';
import { listEligibleEvidence, readClaimLedger } from './claim-ledger.mjs';
import { listOpenExecIntents } from './exec-intent-store.mjs';
import {
  claimPendingVerifyResult,
  completeVerifyResult,
  execResultFromReceipts,
  listPendingVerifyResults,
  writeExecResult,
} from './exec-result-store.mjs';
import { readLastCommittedMemoryCheckpoint } from './memory-compactor.mjs';

export const REACTOR_DAEMON_TASK_TYPES = Object.freeze([
  'cognitive_reaction',
  'exec_queue',
  'verify_batch',
  'rule_reaction',
  'memory_compaction',
]);

export function isReactorTaskType(type) {
  return REACTOR_DAEMON_TASK_TYPES.includes(type);
}

function assertCommitLease(canCommit) {
  if (typeof canCommit === 'function' && !canCommit()) {
    const error = new Error('reactor_task_lease_lost');
    error.code = 'lease_lost';
    throw error;
  }
}

export function enqueueReactorTask(root, subject, kind, {
  reason = kind,
  source = null,
  enqueueTask,
} = {}) {
  const wake = enqueueWakeIntent(root, subject, { kind, reason, source });
  if (typeof enqueueTask !== 'function') {
    return { ...wake, task: null, task_created: false };
  }
  const type = {
    cognitive: 'cognitive_reaction',
    exec: 'exec_queue',
    verify: 'verify_batch',
    rule: 'rule_reaction',
    memory: 'memory_compaction',
  }[kind];
  const queued = enqueueTask(root, subject, {
    type,
    priority: kind === 'cognitive' ? 40 : kind === 'exec' ? 50 : 70,
    idempotencyKey: `${subject}:${type}`,
    input: { reason, source, wake_id: wake.intent.id },
  });
  return { ...wake, task: queued.task, task_created: queued.created };
}

export function scanWakeBacklog(root, subject, { enqueueTask } = {}) {
  if (!isEvidenceWakeEnabled()) {
    return { scanned: false, enqueued: [] };
  }
  const runtime = runtimeForSubject(root, subject);
  const enqueued = [];
  for (const intent of listPendingWakes(root, subject)) {
    const result = enqueueReactorTask(root, subject, intent.kind, {
      reason: intent.reason || 'backlog_scan',
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  const pendingDecisions = countPendingDecisions(runtime.runtimeRoot);
  if (pendingDecisions > 0) {
    const result = enqueueReactorTask(root, subject, 'exec', {
      reason: 'decision_backlog',
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  const cognitivePending = listEligibleEvidence(runtime.dataRoot, { reactor: 'cognitive' });
  if (cognitivePending.length > 0) {
    const result = enqueueReactorTask(root, subject, 'cognitive', {
      reason: 'evidence_backlog',
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  const ruleDue = peekRuleDueWindow(runtime.dataRoot);
  if (ruleDue.due.length > 0) {
    const result = enqueueReactorTask(root, subject, 'rule', {
      reason: ruleDue.due[0].reason || 'rule_evidence_backlog',
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  const retryableIntents = listOpenExecIntents(runtime.dataRoot)
    .filter((intent) => intent.status === 'prepared' || intent.status === 'intended');
  if (retryableIntents.length > 0 && pendingDecisions > 0) {
    const result = enqueueReactorTask(root, subject, 'exec', {
      reason: 'retryable_exec_intents',
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  if (listPendingVerifyResults(runtime.dataRoot).length > 0) {
    const result = enqueueReactorTask(root, subject, 'verify', {
      reason: 'pending_verify',
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  const ledger = readClaimLedger(runtime.dataRoot);
  const committed = readLastCommittedMemoryCheckpoint(runtime.dataRoot);
  const projection = readMemoryCompactionProjection(runtime.runtimeRoot);
  const memoryGate = shouldCompactMemory(ledger, {
    lastCompactedAt: committed?.written_at || projection.last_compacted_at,
  });
  if (memoryGate.due) {
    const result = enqueueReactorTask(root, subject, 'memory', {
      reason: memoryGate.reason,
      source: 'backlog_scan',
      enqueueTask,
    });
    if (result.task_created) enqueued.push(result);
  }

  return { scanned: true, enqueued };
}

function countPendingDecisions(runtimeRoot) {
  const file = join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
  if (!existsSync(file)) return 0;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    return (raw.decisions || []).filter((d) => d.status === 'pending').length;
  } catch {
    return 0;
  }
}

export async function runReactorDaemonTask(root, subject, task, flags = {}) {
  const type = task?.type;
  const input = task?.input || {};
  if (type === 'cognitive_reaction') {
    return runCognitiveReactionTask(root, subject, input, flags);
  }
  if (type === 'exec_queue') {
    return runExecQueueTask(root, subject, input, flags);
  }
  if (type === 'verify_batch') {
    return runVerifyBatchTask(root, subject, input, flags);
  }
  if (type === 'rule_reaction') {
    return runRuleReaction({ root, subject, input, canCommit: flags.canCommit });
  }
  if (type === 'memory_compaction') {
    return compactMemory({ root, subject, input, canCommit: flags.canCommit });
  }
  throw new Error(`Unsupported reactor task type: ${type}`);
}

export async function runCognitiveReactionTask(root, subject, input = {}, flags = {}) {
  const runtime = runtimeForSubject(root, subject);
  const ctx = await buildCycleContext(root, runtime);
  ctx.pipeline = 'reactor';
  const reactionId = input.reaction_id || input.cycle_id || `reaction-${Date.now()}`;
  consumeWakeIntent(root, subject, { kind: 'cognitive' });
  const result = await runCognitiveLiveReaction(ctx, {
    cycleId: reactionId,
    canCommit: flags.canCommit,
    skipInvestigate: input.skip_investigate === true
      || flags['skip-investigate'] === true
      || process.env.JEA_REACTOR_SKIP_INVESTIGATE === '1',
  });
  if (result?.batch_id) {
    const existing = readBatchCheckpoint(runtime.dataRoot, result.batch_id);
    patchBatchCheckpoint(runtime.dataRoot, result.batch_id, {
      reactor: 'cognitive',
      subject,
      stage: result.skipped ? 'failed' : 'committed',
      event_ids: result.event_ids?.length ? result.event_ids : existing?.event_ids,
      evidence_keys: result.evidence_keys?.length
        ? result.evidence_keys
        : existing?.evidence_keys,
      queued_decision_ids: result.decisions_queued || existing?.queued_decision_ids || [],
      honesty: result.honesty || existing?.honesty || null,
      cycle_id: reactionId,
      last_error: result.skipped ? (result.reason || 'skipped') : null,
    });
  }
  if (!result?.skipped && (result?.decisions_queued?.length || 0) > 0) {
    enqueueWakeIntent(root, subject, {
      kind: 'exec',
      reason: 'decisions_queued',
      source: 'cognitive_reaction',
    });
  }
  const ok = !result?.skipped || result?.reason === 'no_pending_evidence';
  return {
    ok,
    reason: result?.reason || null,
    result,
  };
}

export async function runExecQueueTask(root, subject, input = {}) {
  const runtime = runtimeForSubject(root, subject);
  const ctx = await buildCycleContext(root, runtime);
  ctx.pipeline = 'reactor';
  const executionId = input.execution_id
    || input.cycle_id
    || (input.wake_id ? `exec-${input.wake_id}` : `exec-${Date.now()}`);
  consumeWakeIntent(root, subject, { kind: 'exec' });
  let execResult = null;
  let execError = null;
  try {
    ({ execResult } = await runExecStep(ctx, {
      stateCycleId: executionId,
    }));
  } catch (err) {
    execError = err;
    const receipts = ctx.store?.readActionReceipts?.({ limit: 500 }) || [];
    const recovered = execResultFromReceipts(receipts, executionId);
    if (recovered.executed.length) {
      execResult = {
        ...recovered,
        success: false,
        error: err?.message || String(err),
      };
    }
  } finally {
    if (execResult) {
      writeExecResult(runtime.dataRoot, executionId, {
        ...execResult,
        execution_id: executionId,
      });
    }
  }
  const executedCount = execResult?.executed?.length ?? 0;
  if (executedCount > 0) {
    enqueueWakeIntent(root, subject, {
      kind: 'verify',
      reason: 'receipts_written',
      source: 'exec_queue',
    });
    enqueueWakeIntent(root, subject, {
      kind: 'rule',
      reason: 'receipts_written',
      source: 'exec_queue',
    });
  }
  if (execError) throw execError;
  return {
    ok: Boolean(execResult?.success ?? true),
    result: execResult,
    execution_id: executionId,
  };
}

export async function runVerifyBatchTask(root, subject, input = {}, flags = {}) {
  const runtime = runtimeForSubject(root, subject);
  consumeWakeIntent(root, subject, { kind: 'verify' });
  const verified = [];
  let claimed = claimPendingVerifyResult(runtime.dataRoot);
  if (claimed.skipped && input.execution_id) {
    return {
      ok: true,
      skipped: true,
      reason: claimed.skipped,
      result: { verification: { verified: [], pending: [] }, reportPath: null },
    };
  }
  if (claimed.skipped) {
    return {
      ok: true,
      skipped: true,
      reason: claimed.skipped,
      result: { verification: { verified: [], pending: [] }, reportPath: null },
    };
  }

  while (!claimed.skipped) {
    const execResult = claimed.result;
    const cycleId = execResult.cycle_id || execResult.execution_id;
    try {
      const ctx = await buildCycleContext(root, runtime);
      ctx.pipeline = 'reactor';
      const verify = await runVerifyStep(ctx, {
        intelResult: { cycle_id: cycleId },
        execResult: {
          ...execResult,
          execution_id: execResult.execution_id,
          cycle_id: cycleId,
        },
      });
      assertCommitLease(flags.canCommit);
      completeVerifyResult(runtime.dataRoot, execResult.execution_id, {
        status: 'verified',
        reportPath: verify.reportPath,
      });
      verified.push({
        execution_id: execResult.execution_id,
        report_path: verify.reportPath,
      });
    } catch (err) {
      completeVerifyResult(runtime.dataRoot, execResult.execution_id, {
        status: 'verify_failed',
        error: err?.message || String(err),
      });
      throw err;
    }
    claimed = claimPendingVerifyResult(runtime.dataRoot);
  }

  if (verified.length) {
    assertCommitLease(flags.canCommit);
    enqueueWakeIntent(root, subject, {
      kind: 'cognitive',
      reason: 'verify_report',
      source: 'verify_batch',
    });
    enqueueWakeIntent(root, subject, {
      kind: 'rule',
      reason: 'verify_report',
      source: 'verify_batch',
    });
  }
  if (listPendingVerifyResults(runtime.dataRoot).length > 0) {
    enqueueWakeIntent(root, subject, {
      kind: 'verify',
      reason: 'pending_verify_remaining',
      source: 'verify_batch',
    });
  }
  return {
    ok: true,
    result: { verified },
    execution_id: verified[0]?.execution_id || null,
  };
}
