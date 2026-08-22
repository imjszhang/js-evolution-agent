/**
 * Persist exec outcomes so verify can claim them independently of the cycle train.
 * latest.json is an observation pointer, not work truth.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  handleContractValidation,
  validateExecResult,
} from '../../contracts/index.mjs';
import { writeJsonAtomic } from '../../infra/atomic-json-write.mjs';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { retentionPolicy, terminalArchiveCandidates } from '../../infra/sidecar-retention.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import { reactorDir } from './paths.mjs';

export function execResultsDir(dataRoot) {
  return join(reactorDir(dataRoot), 'exec-results');
}

export function execResultPath(dataRoot, executionId) {
  return join(execResultsDir(dataRoot), `${executionId}.json`);
}

export function latestExecResultPointerPath(dataRoot) {
  return join(execResultsDir(dataRoot), 'latest.json');
}

export function execResultQueuePath(dataRoot) {
  return join(execResultsDir(dataRoot), 'queue.json');
}

export function execResultsArchiveDir(dataRoot) {
  return join(reactorDir(dataRoot), 'archive', 'exec-results');
}

function emptyQueue() {
  return { items: [], updated_at: null };
}

function readQueue(dataRoot) {
  const raw = readJson(execResultQueuePath(dataRoot), emptyQueue());
  return {
    items: Array.isArray(raw?.items) ? raw.items : [],
    updated_at: raw?.updated_at ?? null,
  };
}

function writeQueue(dataRoot, updater) {
  mkdirSync(execResultsDir(dataRoot), { recursive: true });
  const file = execResultQueuePath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  return updateJson(file, (raw) => {
    const queue = {
      items: Array.isArray(raw?.items) ? raw.items : [],
      updated_at: raw?.updated_at ?? null,
    };
    const next = updater(queue) ?? queue;
    next.updated_at = nowIso();
    return next;
  }, { fallback: emptyQueue() });
}

function persistResultFile(dataRoot, record) {
  handleContractValidation('exec_result', validateExecResult(record));
  writeJsonAtomic(execResultPath(dataRoot, record.execution_id), record);
  return record;
}

function uniqueValues(items, picker) {
  return [...new Set((items || []).map(picker).filter(Boolean))];
}

function singleValue(items, picker) {
  const values = uniqueValues(items, picker);
  return values.length === 1 ? values[0] : null;
}

export function writeExecResult(dataRoot, executionId, execResult = {}, {
  faultInjector = null,
} = {}) {
  if (!dataRoot || !executionId) {
    throw new Error('writeExecResult requires dataRoot and executionId');
  }
  mkdirSync(execResultsDir(dataRoot), { recursive: true });
  const existing = readExecResult(dataRoot, executionId);
  const executed = Array.isArray(execResult.executed) ? execResult.executed : (existing?.executed || []);
  const decisionIds = uniqueValues(executed, (item) => item?.decision_id ?? item?.id);
  const record = {
    execution_id: executionId,
    producer: 'exec',
    written_at: existing?.written_at || nowIso(),
    cycle_id: execResult.cycle_id || existing?.cycle_id || executionId,
    success: execResult.success !== false,
    executed,
    decision_ids: execResult.decision_ids ?? existing?.decision_ids ?? decisionIds,
    decision_id: execResult.decision_id
      ?? existing?.decision_id
      ?? (decisionIds.length === 1 ? decisionIds[0] : null),
    producer_batch_id: execResult.producer_batch_id
      ?? existing?.producer_batch_id
      ?? singleValue(executed, (item) => item?.producer_batch_id ?? item?.producerBatchId),
    reaction_id: execResult.reaction_id
      ?? existing?.reaction_id
      ?? singleValue(executed, (item) => item?.reaction_id ?? item?.reactionId),
    belief_id: execResult.belief_id
      ?? existing?.belief_id
      ?? singleValue(executed, (item) => item?.belief_id ?? item?.beliefId),
    journal: execResult.journal ?? existing?.journal ?? null,
    mechanical: execResult.mechanical ?? existing?.mechanical ?? null,
    agent_waves: execResult.agent_waves ?? existing?.agent_waves ?? [],
    remaining_agent_pending: execResult.remaining_agent_pending ?? existing?.remaining_agent_pending ?? 0,
    error: execResult.error ?? existing?.error ?? null,
    verify_status: existing?.verify_status || 'pending_verify',
    report_path: existing?.report_path ?? null,
    last_error: existing?.last_error ?? null,
  };
  persistResultFile(dataRoot, record);
  faultInjector?.('exec_result_after_result', { execution_id: executionId });
  writeJsonAtomic(latestExecResultPointerPath(dataRoot), {
    execution_id: executionId,
    written_at: record.written_at,
  });
  faultInjector?.('exec_result_after_latest', { execution_id: executionId });
  writeQueue(dataRoot, (queue) => {
    const item = queue.items.find((entry) => entry.execution_id === executionId);
    if (item) {
      item.written_at = record.written_at;
      if (!item.verify_status || item.verify_status === 'pending_verify') {
        item.verify_status = record.verify_status;
      }
    } else {
      queue.items.push({
        execution_id: executionId,
        written_at: record.written_at,
        verify_status: record.verify_status,
      });
    }
    return queue;
  });
  faultInjector?.('exec_result_after_queue', { execution_id: executionId });
  return record;
}

export function readExecResult(dataRoot, executionId) {
  if (!dataRoot || !executionId) return null;
  const filePath = execResultPath(dataRoot, executionId);
  if (!existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

export function readLatestExecResult(dataRoot) {
  const pointer = existsSync(latestExecResultPointerPath(dataRoot))
    ? readJson(latestExecResultPointerPath(dataRoot), null)
    : null;
  if (pointer?.execution_id) {
    const latest = readExecResult(dataRoot, pointer.execution_id);
    if (latest) return latest;
  }
  if (!existsSync(execResultsDir(dataRoot))) return null;
  const files = readdirSync(execResultsDir(dataRoot))
    .filter((name) => name.endsWith('.json') && name !== 'latest.json' && name !== 'queue.json')
    .sort();
  if (!files.length) return null;
  return readJson(join(execResultsDir(dataRoot), files[files.length - 1]), null);
}

export function recoverOrphanedExecResults(dataRoot) {
  if (!existsSync(execResultsDir(dataRoot))) return { recovered: [] };
  const records = readdirSync(execResultsDir(dataRoot))
    .filter((name) => name.endsWith('.json') && name !== 'latest.json' && name !== 'queue.json')
    .map((name) => readJson(join(execResultsDir(dataRoot), name), null))
    .filter((record) => record?.execution_id);
  const queuedBefore = new Set(readQueue(dataRoot).items.map((item) => item.execution_id));
  const orphans = records.filter((record) => !queuedBefore.has(record.execution_id));
  if (!orphans.length) return { recovered: [] };
  const recovered = [];
  writeQueue(dataRoot, (queue) => {
    const queued = new Set(queue.items.map((item) => item.execution_id));
    for (const record of orphans) {
      if (queued.has(record.execution_id)) continue;
      queue.items.push({
        execution_id: record.execution_id,
        written_at: record.written_at,
        verify_status: record.verify_status ?? 'pending_verify',
      });
      queued.add(record.execution_id);
      recovered.push(record.execution_id);
    }
    return queue;
  });
  return { recovered };
}

export function listPendingVerifyResults(dataRoot) {
  recoverOrphanedExecResults(dataRoot);
  const queue = readQueue(dataRoot);
  return queue.items
    .filter((item) => (
      item.verify_status === 'pending_verify'
      || (item.verify_status === 'verify_failed' && (item.verify_attempts ?? 0) < 3)
    ))
    .sort((a, b) => String(a.written_at).localeCompare(String(b.written_at)))
    .map((item) => readExecResult(dataRoot, item.execution_id))
    .filter(Boolean);
}

export function claimPendingVerifyResult(dataRoot) {
  if (!dataRoot) throw new Error('claimPendingVerifyResult requires dataRoot');
  recoverOrphanedExecResults(dataRoot);
  let claimed = { skipped: 'no_pending_verify' };
  writeQueue(dataRoot, (queue) => {
    for (const item of queue.items) {
      if (item.verify_status === 'verified') continue;
      const record = readExecResult(dataRoot, item.execution_id);
      const reportPath = record?.report_path
        || join(dataRoot, 'evolution', 'verify_reports', `${item.execution_id}.json`);
      if (existsSync(reportPath)) {
        item.verify_status = 'verified';
        item.completed_at = nowIso();
        item.report_path = reportPath;
        if (record) {
          persistResultFile(dataRoot, {
            ...record,
            verify_status: 'verified',
            report_path: reportPath,
            last_error: null,
          });
        }
        continue;
      }
      if (item.verify_status !== 'verifying') continue;
      const claimedAt = Date.parse(item.claimed_at ?? '');
      if (Number.isFinite(claimedAt) && Date.now() - claimedAt >= 5 * 60 * 1000) {
        item.verify_status = 'pending_verify';
        item.last_error = 'verify_claim_expired';
        if (record) {
          persistResultFile(dataRoot, {
            ...record,
            verify_status: 'pending_verify',
            last_error: 'verify_claim_expired',
          });
        }
      }
    }
    const next = queue.items
      .filter((item) => (
        item.verify_status === 'pending_verify'
        || (item.verify_status === 'verify_failed' && (item.verify_attempts ?? 0) < 3)
      ))
      .sort((a, b) => String(a.written_at).localeCompare(String(b.written_at)))[0];
    if (!next) {
      claimed = { skipped: 'no_pending_verify' };
      return queue;
    }
    next.verify_status = 'verifying';
    next.claimed_at = nowIso();
    next.verify_attempts = (next.verify_attempts ?? 0) + 1;
    const record = readExecResult(dataRoot, next.execution_id);
    if (!record) {
      next.verify_status = 'verify_failed';
      next.last_error = 'exec_result_missing';
      claimed = { skipped: 'exec_result_missing', execution_id: next.execution_id };
      return queue;
    }
    const updated = persistResultFile(dataRoot, {
      ...record,
      verify_status: 'verifying',
    });
    claimed = { execution_id: next.execution_id, result: updated };
    return queue;
  });
  return claimed;
}

export function completeVerifyResult(dataRoot, executionId, {
  status = 'verified',
  reportPath = null,
  error = null,
} = {}) {
  if (!dataRoot || !executionId) return null;
  const verifyStatus = status === 'verify_failed' ? 'verify_failed' : 'verified';
  let updated = null;
  writeQueue(dataRoot, (queue) => {
    const item = queue.items.find((entry) => entry.execution_id === executionId);
    if (item) {
      item.verify_status = verifyStatus;
      item.completed_at = nowIso();
      item.last_error = error;
      item.report_path = reportPath;
    }
    const record = readExecResult(dataRoot, executionId);
    if (record) {
      updated = persistResultFile(dataRoot, {
        ...record,
        verify_status: verifyStatus,
        report_path: reportPath ?? record.report_path,
        last_error: error,
      });
    }
    return queue;
  });
  return updated;
}

/**
 * Remove verified work from the hot verify queue and archive its result file.
 * Pending/verifying/failed verification records are never selected.
 */
export function cleanupVerifiedExecResults(dataRoot, {
  now = Date.now(),
  ...options
} = {}) {
  const policy = retentionPolicy('exec_result', options);
  const latest = readJson(latestExecResultPointerPath(dataRoot), null)?.execution_id ?? null;
  const removeAfterCommit = [];
  let retained = 0;
  writeQueue(dataRoot, (queue) => {
    const candidates = terminalArchiveCandidates(queue.items, {
      now,
      ...policy,
      isTerminal: (item) => item.verify_status === 'verified' && item.execution_id !== latest,
      timestamp: (item) => item.completed_at || item.written_at,
    });
    const archiveDir = execResultsArchiveDir(dataRoot);
    if (candidates.length) mkdirSync(archiveDir, { recursive: true });
    const archivedIds = new Set();
    for (const item of candidates) {
      const record = readExecResult(dataRoot, item.execution_id);
      if (!record) {
        // A prior crash may have archived the file before queue compaction.
        const archivedPath = join(archiveDir, `${item.execution_id}.json`);
        if (existsSync(archivedPath)) archivedIds.add(item.execution_id);
        continue;
      }
      const archivedPath = join(archiveDir, `${item.execution_id}.json`);
      if (!existsSync(archivedPath)) writeJsonAtomic(archivedPath, record);
      archivedIds.add(item.execution_id);
      removeAfterCommit.push(execResultPath(dataRoot, item.execution_id));
    }
    queue.items = queue.items.filter((item) => !archivedIds.has(item.execution_id));
    retained = queue.items.length;
    return queue;
  });
  for (const filePath of removeAfterCommit) {
    try { rmSync(filePath, { force: true }); } catch {}
  }
  return { archived: removeAfterCommit.length, retained };
}

export function execResultFromReceipts(receipts = [], executionId) {
  const matched = (receipts || []).filter((receipt) => (
    receipt?.cycle_id === executionId
    || receipt?.exec_cycle_id === executionId
    || receipt?.intel_cycle_id === executionId
  ));
  const decisionIds = uniqueValues(matched, (receipt) => receipt?.decision_id);
  return {
    execution_id: executionId,
    cycle_id: executionId,
    success: true,
    executed: matched.map((receipt) => ({
      id: receipt.decision_id || receipt.action_id || receipt.id || null,
      action: receipt.action || { type: receipt.action_type, id: receipt.action_id },
      result: receipt.result || {},
      producer_batch_id: receipt.producer_batch_id ?? null,
      reaction_id: receipt.reaction_id ?? null,
      belief_id: receipt.belief_id ?? null,
    })),
    decision_ids: decisionIds,
    decision_id: decisionIds.length === 1 ? decisionIds[0] : null,
    producer_batch_id: singleValue(matched, (receipt) => receipt?.producer_batch_id),
    reaction_id: singleValue(matched, (receipt) => receipt?.reaction_id),
    belief_id: singleValue(matched, (receipt) => receipt?.belief_id),
    recovered_from: 'action_receipts',
    written_at: nowIso(),
    verify_status: 'pending_verify',
  };
}
