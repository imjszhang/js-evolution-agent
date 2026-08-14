/**
 * Capacity / wall-clock memory compactor (S7).
 * Checkpoint is recovery truth; memory_compaction.json is a projection.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../infra/atomic-json-write.mjs';
import { readJson } from '../../infra/json-store.mjs';
import { runtimeForSubject, nowIso } from '../../infra/runtime-paths.mjs';
import { buildEvolutionDiary } from '../../intelligence/evolution-diary-builder.mjs';
import { readCarryoverDocument } from '../carryover.mjs';
import { buildCycleContext } from '../cycle-steps.mjs';
import { readClaimLedger } from './claim-ledger.mjs';
import { consumeWakeIntent, enqueueWakeIntent } from './wake-store.mjs';
import { readBatchCheckpoint, writeBatchCheckpoint } from './batch-checkpoint-store.mjs';
import { batchCheckpointsDir } from './batch-checkpoint-store.mjs';

const DEFAULT_MIN_HANDLED_BATCHES = 4;
const DEFAULT_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

function parseIsoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function shouldCompactMemory(ledger, {
  nowMs = Date.now(),
  minHandled = DEFAULT_MIN_HANDLED_BATCHES,
  maxIdleMs = DEFAULT_MAX_IDLE_MS,
  lastCompactedAt = null,
} = {}) {
  const handled = (ledger.claims || []).filter((claim) => claim.status === 'handled');
  if (!handled.length) return { due: false, reason: 'no_handled_batches' };
  const lastHandled = handled
    .map((claim) => parseIsoMs(claim.handled_at))
    .filter((ms) => ms != null)
    .sort((a, b) => b - a)[0];
  const lastCompacted = parseIsoMs(lastCompactedAt);
  const sinceCompact = lastCompacted == null ? handled.length : handled.filter((claim) => {
    const at = parseIsoMs(claim.handled_at);
    return at != null && at > lastCompacted;
  }).length;
  if (sinceCompact >= minHandled) return { due: true, reason: 'handled_batches', since_compact: sinceCompact };
  if (lastHandled != null && nowMs - lastHandled >= maxIdleMs && sinceCompact > 0) {
    return { due: true, reason: 'wall_clock', since_compact: sinceCompact };
  }
  return { due: false, reason: 'below_threshold', since_compact: sinceCompact };
}

function compactionStatePath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'evolution', 'memory_compaction.json');
}

export function readMemoryCompactionProjection(runtimeRoot) {
  const file = compactionStatePath(runtimeRoot);
  if (!existsSync(file)) return { last_compacted_at: null, last_batch_id: null };
  try {
    return readJson(file, { last_compacted_at: null, last_batch_id: null });
  } catch {
    return { last_compacted_at: null, last_batch_id: null };
  }
}

function writeMemoryCompactionProjection(runtimeRoot, {
  lastCompactedAt = nowIso(),
  batchId = null,
} = {}) {
  writeJsonAtomic(compactionStatePath(runtimeRoot), {
    last_compacted_at: lastCompactedAt,
    last_batch_id: batchId,
    updated_at: lastCompactedAt,
  });
  return lastCompactedAt;
}

export function readLastCommittedMemoryCheckpoint(dataRoot) {
  const dir = batchCheckpointsDir(dataRoot);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.startsWith('batch-memory-') && name.endsWith('.json'));
  let latest = null;
  for (const name of files) {
    const record = readBatchCheckpoint(dataRoot, name.replace(/\.json$/, ''));
    if (record?.reactor !== 'memory' || record.stage !== 'committed') continue;
    if (!latest || String(record.written_at).localeCompare(String(latest.written_at)) > 0) {
      latest = record;
    }
  }
  return latest;
}

function handledSinceCheckpoint(ledger, checkpoint) {
  const lastAt = parseIsoMs(checkpoint?.written_at);
  return (ledger.claims || []).filter((claim) => {
    if (claim.status !== 'handled') return false;
    if (lastAt == null) return true;
    const at = parseIsoMs(claim.handled_at);
    return at != null && at > lastAt;
  });
}

function deterministicMemoryBatchId(checkpoint, handled) {
  const cursor = checkpoint?.batch_id || 'init';
  const lastHandled = handled[handled.length - 1]?.batch_id || 'none';
  return `batch-memory-${cursor}-${lastHandled}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

export async function runMemoryCompactionWork(ctx, { intelResult, canCommit = null } = {}) {
  const { cfg, runtime, store } = ctx;
  return buildEvolutionDiary({
    aiClient: cfg.aiClient,
    intelResult,
    runtime,
    store,
    agentContextDocs: cfg.agentContextDocs,
    logger: cfg.host?.logger,
    carryoverItems: readCarryoverDocument(runtime.runtimeRoot).items,
    canCommit,
    producer: 'memory',
    activationTargets: ['cognitive'],
  });
}

export async function compactMemory({
  root,
  subject,
  input = {},
  runCompaction = null,
  canCommit = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  consumeWakeIntent(root, subject, { kind: 'memory' });
  const ledger = readClaimLedger(runtime.dataRoot);
  const committed = readLastCommittedMemoryCheckpoint(runtime.dataRoot);
  const projection = readMemoryCompactionProjection(runtime.runtimeRoot);
  const lastCompactedAt = committed?.written_at || projection.last_compacted_at;
  const gate = shouldCompactMemory(ledger, {
    minHandled: input.min_handled ?? DEFAULT_MIN_HANDLED_BATCHES,
    maxIdleMs: input.max_idle_ms ?? DEFAULT_MAX_IDLE_MS,
    lastCompactedAt,
  });
  if (!gate.due && !input.force) {
    return { skipped: true, reason: gate.reason, since_compact: gate.since_compact ?? 0 };
  }

  const handled = handledSinceCheckpoint(ledger, committed);
  const eventIds = handled.flatMap((claim) => claim.event_ids || []);
  const evidenceKeys = handled.flatMap((claim) => (
    claim.evidence_keys?.length
      ? claim.evidence_keys
      : (claim.event_ids || []).map((id) => `legacy:${id}`)
  ));
  const coveredBatchIds = handled.map((claim) => claim.batch_id);
  const batchId = deterministicMemoryBatchId(committed, handled);
  writeBatchCheckpoint(runtime.dataRoot, {
    batch_id: batchId,
    reactor: 'memory',
    subject,
    stage: 'claimed',
    event_ids: eventIds,
    evidence_keys: evidenceKeys,
    covered_batch_ids: coveredBatchIds,
    written_at: nowIso(),
  });

  try {
    const ctx = await buildCycleContext(root, runtime);
    ctx.pipeline = 'reactor';
    const intelResult = {
      cycle_id: batchId,
      batch_id: batchId,
      success: true,
      producer: 'memory',
      activation_targets: ['cognitive'],
      retrospective: {
        covered_batch_ids: coveredBatchIds,
        covered_event_ids: eventIds,
      },
    };
    const compactor = typeof runCompaction === 'function'
      ? runCompaction
      : runMemoryCompactionWork;
    await compactor(ctx, { intelResult, canCommit });
    if (typeof canCommit === 'function' && !canCommit()) {
      const error = new Error('reactor_task_lease_lost');
      error.code = 'lease_lost';
      throw error;
    }
    const committedAt = nowIso();
    writeBatchCheckpoint(runtime.dataRoot, {
      batch_id: batchId,
      reactor: 'memory',
      subject,
      stage: 'committed',
      event_ids: eventIds,
      evidence_keys: evidenceKeys,
      covered_batch_ids: coveredBatchIds,
      written_at: committedAt,
    });
    writeMemoryCompactionProjection(runtime.runtimeRoot, {
      lastCompactedAt: committedAt,
      batchId,
    });
    enqueueWakeIntent(root, subject, {
      kind: 'cognitive',
      reason: 'memory_compacted',
      source: 'memory_compaction',
    });
    return {
      skipped: false,
      batch_id: batchId,
      trigger: gate.reason,
      covered_batches: handled.length,
    };
  } catch (err) {
    writeBatchCheckpoint(runtime.dataRoot, {
      batch_id: batchId,
      reactor: 'memory',
      subject,
      stage: 'failed',
      event_ids: eventIds,
      evidence_keys: evidenceKeys,
      covered_batch_ids: coveredBatchIds,
      last_error: err?.message || String(err),
      written_at: nowIso(),
    });
    throw err;
  }
}

export async function runMemoryCompaction(args = {}) {
  return compactMemory(args);
}
