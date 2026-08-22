/**
 * Capacity / wall-clock memory compactor (S7).
 * Checkpoint is recovery truth; memory_compaction.json is a projection.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../infra/atomic-json-write.mjs';
import { readJson } from '../../infra/json-store.mjs';
import { runtimeForSubject, nowIso } from '../../infra/runtime-paths.mjs';
import { buildEvolutionDiary } from '../../intelligence/evolution-diary-builder.mjs';
import { updateStandingMemoryWithAi } from '../../intelligence/report-builder.mjs';
import { readCarryoverDocument } from '../carryover.mjs';
import { buildCycleContext } from '../cycle-steps.mjs';
import {
  committedBeliefEffectEvents,
  settlementLedgerPath,
} from '../settlement-service.mjs';
import { readClaimLedger } from './claim-ledger.mjs';
import { consumeWakeIntent, enqueueWakeIntent } from './wake-store.mjs';
import {
  compareAndSwapBatchCheckpoint,
  readBatchCheckpoint,
  writeBatchCheckpoint,
} from './batch-checkpoint-store.mjs';
import { batchCheckpointsDir } from './batch-checkpoint-store.mjs';

const DEFAULT_MIN_HANDLED_BATCHES = 4;
const DEFAULT_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_BELIEF_CHANGES = new Set(['validate', 'refute', 'retire']);

function parseIsoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  const empty = {
    last_compacted_at: null,
    last_batch_id: null,
    last_settled_cursor: null,
    freshness: null,
  };
  if (!existsSync(file)) return empty;
  try {
    return readJson(file, empty);
  } catch {
    return empty;
  }
}

function writeMemoryCompactionProjection(runtimeRoot, {
  lastCompactedAt = nowIso(),
  batchId = null,
  lastSettledCursor = null,
  freshness = null,
} = {}) {
  writeJsonAtomic(compactionStatePath(runtimeRoot), {
    last_compacted_at: lastCompactedAt,
    last_batch_id: batchId,
    last_settled_cursor: lastSettledCursor,
    freshness,
    updated_at: lastCompactedAt,
  });
  return lastCompactedAt;
}

function reconcileCommittedMemoryProjection(runtimeRoot, committed, projection) {
  if (!committed || committed.stage !== 'committed') return projection;
  if (
    projection.last_batch_id === committed.batch_id
    && projection.last_settled_cursor === committed.last_settled_cursor
  ) {
    return projection;
  }
  writeMemoryCompactionProjection(runtimeRoot, {
    lastCompactedAt: committed.written_at,
    batchId: committed.batch_id,
    lastSettledCursor: committed.last_settled_cursor,
    freshness: committed.freshness ?? projection.freshness ?? null,
  });
  return readMemoryCompactionProjection(runtimeRoot);
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

function beliefEventCursor(event) {
  return event?.id ? `belief_events:${event.id}` : null;
}

function eventTime(event) {
  return parseIsoMs(event?.recorded_at ?? event?.occurred_at ?? event?.timestamp) ?? 0;
}

function completedSettlements(dataRoot) {
  const ledger = readJson(settlementLedgerPath(dataRoot), { settlements: {} });
  return new Set(Object.values(ledger?.settlements ?? {})
    .filter((record) => record?.status === 'completed')
    .map((record) => record.settlement_id)
    .filter(Boolean));
}

export function settledBeliefEvents(store, dataRoot) {
  const all = store?.readBeliefEvents?.({ limit: null }) ?? [];
  return committedBeliefEffectEvents(all)
    .filter((event) => (
      TERMINAL_BELIEF_CHANGES.has(String(event?.change ?? '').toLowerCase())
    ))
    .sort((a, b) => eventTime(a) - eventTime(b) || String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
}

function eventsAfterSettledCursor(events, cursor) {
  if (!cursor) return events;
  const index = events.findIndex((event) => beliefEventCursor(event) === cursor);
  // A cursor can outlive hot event retention. Replaying the retained window is
  // safe because the stable batch id and writer metadata remain idempotent.
  return index < 0 ? events : events.slice(index + 1);
}

function deterministicMemoryBatchId(previousCursor, events) {
  const canonical = JSON.stringify({
    previous_cursor: previousCursor ?? null,
    event_ids: events.map((event) => event.id),
    settlement_ids: [...new Set(events.map((event) => event.settlement_id).filter(Boolean))].sort(),
  });
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return `batch-memory-${digest}`;
}

function readRecentReports(store, limit = 6) {
  return (store?.readIntelReports?.({ limit }) ?? []).map((record) => {
    let markdown = null;
    try {
      if (record?.md_path && existsSync(record.md_path)) {
        markdown = readFileSync(record.md_path, 'utf8').slice(0, 4000);
      }
    } catch {
      markdown = null;
    }
    return {
      id: record?.cycle_id ?? record?.id ?? null,
      generated_at: record?.generated_at ?? null,
      tldr: record?.tldr ?? null,
      md_path: record?.md_path ?? null,
      markdown,
    };
  }).filter((record) => record.id);
}

function latestTerminalEventPerBelief(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.belief_id, event);
  return [...latest.values()];
}

function settlementVerifyRefs(dataRoot, events) {
  if (!dataRoot) return [];
  const ledger = readJson(settlementLedgerPath(dataRoot), { settlements: {} });
  const ids = new Set(events.map((event) => event.settlement_id).filter(Boolean));
  return [...ids].flatMap((id) => ledger?.settlements?.[id]?.evidence_refs ?? [])
    .filter((ref) => /^verify_reports?:/.test(ref))
    .map((ref) => ref.replace(/^verify_reports?:/, ''))
    .filter(Boolean);
}

function seenItem({ id, sourceType, recordedAt = null, fields = null, summary = null }) {
  return {
    id,
    kind: sourceType,
    evidence_level: 'structured_machine_record',
    fields,
    summary,
    source: {
      id,
      source_type: sourceType,
      recorded_at: recordedAt,
    },
  };
}

export function buildMemoryConsolidationInput({
  store,
  dataRoot,
  events,
  previousCursor = null,
  batchId,
} = {}) {
  const snapshotEvents = events.filter((event) => event?.after && typeof event.after === 'object');
  const terminal = latestTerminalEventPerBelief(snapshotEvents);
  const validated = [];
  const refuted = [];
  for (const event of terminal) {
    const belief = event.after;
    const item = {
      id: belief.id,
      status: belief.status,
      claim: belief.claim ?? null,
      settlement_id: event.settlement_id,
      belief_event_id: event.id,
      verify_refs: [
        ...(event.evidence_refs ?? []).filter((ref) => /^verify_reports?:/.test(ref)),
      ],
      evidence_refs: belief.evidence_refs ?? [],
    };
    if (belief.status === 'validated' && event.change === 'validate') validated.push(item);
    else refuted.push({ ...item, status: belief.status === 'retired' ? 'retired' : 'refuted' });
  }
  const verifyIds = [...new Set(settlementVerifyRefs(dataRoot, events))];
  const recentReports = readRecentReports(store);
  const lastEvent = events.at(-1) ?? null;
  const lastSettledCursor = beliefEventCursor(lastEvent) ?? previousCursor;
  const settledAt = lastEvent
    ? (lastEvent.recorded_at ?? lastEvent.occurred_at ?? lastEvent.timestamp ?? nowIso())
    : null;
  const freshness = {
    status: 'fresh',
    settled_through: settledAt,
    consolidated_at: nowIso(),
    pending_settled_count: 0,
  };
  const seen = [
    ...events.map((event) => seenItem({
      id: event.id,
      sourceType: 'belief_event',
      recordedAt: event.recorded_at ?? null,
      fields: {
        belief_id: event.belief_id,
        change: event.change,
        settlement_id: event.settlement_id,
      },
      summary: `${event.change} ${event.belief_id}`,
    })),
    ...verifyIds.map((id) => seenItem({
      id,
      sourceType: 'verify_reports',
      fields: { verification_ref: `verify_report:${id}` },
      summary: `settlement verification ${id}`,
    })),
  ];
  const remembered = recentReports.map((report) => ({
    id: report.id,
    summary: report.tldr ?? 'recent intelligence report',
    source: {
      id: report.id,
      source_type: 'intel_report',
      recorded_at: report.generated_at,
    },
  }));
  const doNotTreatAsSeen = refuted.map((belief) => ({
    id: belief.id,
    summary: `${belief.status} belief; negative history only: ${belief.claim ?? belief.id}`,
    source: {
      id: belief.belief_event_id,
      source_type: 'belief_event',
    },
  }));
  const reportContext = {
    generated_at: freshness.consolidated_at,
    current_cycle: { cycle_id: batchId, mode: 'memory_consolidation' },
    standing_memory: store?.readStandingMemory?.() ?? null,
    current_beliefs: {
      schema_version: 1,
      updated_at: settledAt,
      // Only authoritative per-event snapshots are admitted.
      beliefs: [...validated, ...refuted],
    },
    belief_events: events,
    recent_report_markdowns: recentReports,
    source_counts: {
      settled_beliefs: terminal.length,
      verified_refs: verifyIds.length,
      recent_reports: recentReports.length,
    },
    temporal_decision_brief: {
      evidence_policy: {
        precedence: ['settled_belief_event', 'verify_report', 'recent_report_as_remembered'],
      },
      seen,
      remembered,
      do_not_treat_as_seen: doNotTreatAsSeen,
    },
  };
  return {
    batch_id: batchId,
    previous_cursor: previousCursor,
    last_settled_cursor: lastSettledCursor,
    freshness,
    validated,
    refuted,
    verify_refs: verifyIds.map((id) => `verify_reports:${id}`),
    recent_reports: recentReports,
    report_context: reportContext,
    skipped_event_ids: events
      .filter((event) => !event?.after || typeof event.after !== 'object')
      .map((event) => event?.id)
      .filter(Boolean),
  };
}

function consolidationMarkdown(input) {
  const lines = [
    '# Memory Reactor consolidation',
    '',
    `- batch: ${input.batch_id}`,
    `- settled cursor: ${input.last_settled_cursor}`,
    `- validated outcomes: ${input.validated.length}`,
    `- refuted/retired outcomes: ${input.refuted.length}`,
    '',
    'Validated and refuted entries below are settlement inputs, not a parallel belief store.',
  ];
  for (const item of input.validated) {
    lines.push(`- validated ${item.id} [belief_events:${item.belief_event_id}]`);
  }
  for (const item of input.refuted) {
    lines.push(`- ${item.status} ${item.id} [belief_events:${item.belief_event_id}] (negative history only)`);
  }
  for (const ref of input.verify_refs) lines.push(`- verify [${ref}]`);
  return `${lines.join('\n')}\n`;
}

export async function runMemoryCompactionWork(ctx, {
  intelResult,
  consolidation,
  canCommit = null,
  completedEffects = {},
  onEffect = null,
  faultInjector = null,
  standingMemoryWriter = updateStandingMemoryWithAi,
} = {}) {
  const { cfg, runtime, store } = ctx;
  let memory = completedEffects.memory?.result ?? null;
  if (completedEffects.memory?.status !== 'done') {
    const artifact = store?.readStandingMemory?.() ?? null;
    if (artifact?.memory_batch_id === consolidation.batch_id) {
      memory = {
        status: 'updated',
        reused: true,
        memory_batch_id: consolidation.batch_id,
        last_settled_cursor: artifact.last_settled_cursor ?? consolidation.last_settled_cursor,
        freshness: artifact.freshness ?? consolidation.freshness,
      };
      await onEffect?.('memory', memory);
    } else {
    memory = await standingMemoryWriter({
      aiClient: cfg.aiClient,
      store,
      language: 'zh',
      reportContext: consolidation.report_context,
      reportMarkdown: consolidationMarkdown(consolidation),
      cycleId: intelResult.cycle_id,
      generatedAt: consolidation.freshness.consolidated_at,
      logger: cfg.host?.logger,
      runtimeRoot: runtime.runtimeRoot,
      extraContext: { memory_consolidation: consolidation },
      memoryMetadata: {
        producer: 'memory',
        memory_batch_id: consolidation.batch_id,
        idempotency_key: consolidation.batch_id,
        last_settled_cursor: consolidation.last_settled_cursor,
        freshness: consolidation.freshness,
        memory_policy: {
          standing_memory_role: 'durable_summary_index',
          tactical_claim_authority: 'current_beliefs',
        },
      },
    });
    if (memory?.status !== 'updated') {
      throw new Error(`standing_memory_consolidation_${memory?.reason ?? memory?.status ?? 'failed'}`);
    }
    faultInjector?.('memory_after_artifact', { batch_id: consolidation.batch_id });
    await onEffect?.('memory', memory);
    }
  }

  let diary = completedEffects.diary?.result ?? null;
  if (completedEffects.diary?.status !== 'done') {
    diary = await buildEvolutionDiary({
      aiClient: cfg.aiClient,
      intelResult: {
        ...intelResult,
        memory_consolidation: {
          last_settled_cursor: consolidation.last_settled_cursor,
          validated: consolidation.validated,
          refuted: consolidation.refuted,
          verify_refs: consolidation.verify_refs,
          recent_report_refs: consolidation.recent_reports.map((report) => `reports:${report.id}`),
        },
        standing_memory_update: memory,
      },
      runtime,
      store,
      agentContextDocs: cfg.agentContextDocs,
      logger: cfg.host?.logger,
      carryoverItems: readCarryoverDocument(runtime.runtimeRoot).items,
      canCommit,
      producer: 'memory',
      activationTargets: ['cognitive'],
    });
    await onEffect?.('diary', diary);
  }
  return { memory, diary };
}

export async function compactMemory({
  root,
  subject,
  input = {},
  runCompaction = null,
  canCommit = null,
  faultInjector = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  consumeWakeIntent(root, subject, { kind: 'memory' });
  const ledger = readClaimLedger(runtime.dataRoot);
  const committed = readLastCommittedMemoryCheckpoint(runtime.dataRoot);
  const projection = readMemoryCompactionProjection(runtime.runtimeRoot);
  const lastCompactedAt = committed?.written_at || projection.last_compacted_at;
  const ctx = await buildCycleContext(root, runtime);
  ctx.pipeline = 'reactor';
  const previousCursor = committed?.last_settled_cursor
    ?? projection.last_settled_cursor
    ?? null;
  const settledEvents = eventsAfterSettledCursor(
    settledBeliefEvents(ctx.store, runtime.dataRoot),
    previousCursor,
  );
  const gate = shouldCompactMemory(ledger, {
    minHandled: input.min_handled ?? DEFAULT_MIN_HANDLED_BATCHES,
    maxIdleMs: input.max_idle_ms ?? DEFAULT_MAX_IDLE_MS,
    lastCompactedAt,
  });
  if (!gate.due && !input.force) {
    return { skipped: true, reason: gate.reason, since_compact: gate.since_compact ?? 0 };
  }
  if (!settledEvents.length) {
    reconcileCommittedMemoryProjection(
      runtime.runtimeRoot,
      committed,
      projection,
    );
    return {
      skipped: true,
      reason: 'no_unconsolidated_settled_beliefs',
      since_compact: gate.since_compact ?? 0,
      last_settled_cursor: previousCursor,
    };
  }

  const handled = handledSinceCheckpoint(ledger, committed);
  const eventIds = handled.flatMap((claim) => claim.event_ids || []);
  const evidenceKeys = handled.flatMap((claim) => (
    claim.evidence_keys?.length
      ? claim.evidence_keys
      : (claim.event_ids || []).map((id) => `legacy:${id}`)
  ));
  const coveredBatchIds = handled.map((claim) => claim.batch_id);
  const batchId = deterministicMemoryBatchId(previousCursor, settledEvents);
  const lastSettledCursor = beliefEventCursor(settledEvents.at(-1));
  const existing = readBatchCheckpoint(runtime.dataRoot, batchId);
  if (existing?.stage === 'committed') {
    return {
      skipped: true,
      reason: 'duplicate_batch',
      batch_id: batchId,
      last_settled_cursor: existing.last_settled_cursor ?? lastSettledCursor,
      reused: true,
    };
  }
  const owner = `memory-${randomUUID()}`;
  let acquired = false;
  const claimed = compareAndSwapBatchCheckpoint(runtime.dataRoot, batchId, (current) => {
    if (current?.stage === 'committed') return current;
    const active = ['prepare', 'writing'].includes(current?.stage)
      && current?.owner
      && current.owner !== owner
      && processIsAlive(current.owner_pid);
    if (active) return current;
    acquired = true;
    return {
      ...(current ?? {}),
      batch_id: batchId,
      reactor: 'memory',
      subject,
      stage: 'prepare',
      owner,
      owner_pid: process.pid,
      claimed_at: nowIso(),
      event_ids: eventIds,
      evidence_keys: evidenceKeys,
      covered_batch_ids: coveredBatchIds,
      settlement_ids: [...new Set(settledEvents.map((event) => event.settlement_id).filter(Boolean))],
      settled_belief_event_ids: settledEvents.map((event) => event.id),
      previous_settled_cursor: previousCursor,
      last_settled_cursor: lastSettledCursor,
      idempotency_key: batchId,
      effects: current?.effects ?? {},
      attempt: (current?.attempt ?? 0) + 1,
      last_error: null,
      written_at: nowIso(),
    };
  });
  if (claimed?.stage === 'committed') {
    return {
      skipped: true,
      reason: 'duplicate_batch',
      batch_id: batchId,
      last_settled_cursor: claimed.last_settled_cursor ?? lastSettledCursor,
      reused: true,
    };
  }
  if (!acquired) {
    return {
      skipped: true,
      reason: 'batch_claimed',
      batch_id: batchId,
      owner: claimed?.owner ?? null,
    };
  }
  try {
    faultInjector?.('memory_after_prepare', { batch_id: batchId });
    compareAndSwapBatchCheckpoint(runtime.dataRoot, batchId, (current) => ({
      ...current,
      stage: 'writing',
      written_at: nowIso(),
    }));
    faultInjector?.('memory_after_writing', { batch_id: batchId });
    const consolidation = buildMemoryConsolidationInput({
      store: ctx.store,
      dataRoot: runtime.dataRoot,
      events: settledEvents,
      previousCursor,
      batchId,
    });
    if (!consolidation.validated.length && !consolidation.refuted.length) {
      const error = new Error('no_settled_belief_snapshots');
      error.code = 'missing_settled_snapshot';
      throw error;
    }
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
      memory_consolidation: consolidation,
    };
    const compactor = typeof runCompaction === 'function'
      ? runCompaction
      : runMemoryCompactionWork;
    const markEffect = async (effect, result) => {
      compareAndSwapBatchCheckpoint(runtime.dataRoot, batchId, (current) => ({
        ...current,
        stage: 'writing',
        effects: {
          ...(current?.effects ?? {}),
          [effect]: {
            status: 'done',
            completed_at: nowIso(),
            result,
          },
        },
        written_at: nowIso(),
      }));
    };
    const result = await compactor(ctx, {
      intelResult,
      consolidation,
      canCommit,
      completedEffects: existing?.effects ?? {},
      onEffect: markEffect,
      faultInjector,
    });
    if (typeof runCompaction === 'function') {
      const current = readBatchCheckpoint(runtime.dataRoot, batchId);
      if (current?.effects?.memory?.status !== 'done') await markEffect('memory', result?.memory ?? result);
      if (current?.effects?.diary?.status !== 'done') await markEffect('diary', result?.diary ?? result);
    }
    if (typeof canCommit === 'function' && !canCommit()) {
      const error = new Error('reactor_task_lease_lost');
      error.code = 'lease_lost';
      throw error;
    }
    const committedAt = nowIso();
    compareAndSwapBatchCheckpoint(runtime.dataRoot, batchId, (current) => ({
      ...current,
      batch_id: batchId,
      reactor: 'memory',
      subject,
      stage: 'committed',
      owner: null,
      owner_pid: null,
      event_ids: eventIds,
      evidence_keys: evidenceKeys,
      covered_batch_ids: coveredBatchIds,
      settlement_ids: [...new Set(settledEvents.map((event) => event.settlement_id).filter(Boolean))],
      settled_belief_event_ids: settledEvents.map((event) => event.id),
      previous_settled_cursor: previousCursor,
      last_settled_cursor: consolidation.last_settled_cursor,
      idempotency_key: batchId,
      freshness: consolidation.freshness,
      written_at: committedAt,
    }));
    faultInjector?.('memory_after_commit', { batch_id: batchId });
    writeMemoryCompactionProjection(runtime.runtimeRoot, {
      lastCompactedAt: committedAt,
      batchId,
      lastSettledCursor: consolidation.last_settled_cursor,
      freshness: consolidation.freshness,
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
      settled_beliefs: settledEvents.length,
      last_settled_cursor: consolidation.last_settled_cursor,
    };
  } catch (err) {
    compareAndSwapBatchCheckpoint(runtime.dataRoot, batchId, (current) => current?.stage === 'committed'
      ? current
      : ({
      ...current,
      batch_id: batchId,
      reactor: 'memory',
      subject,
      stage: 'failed',
      owner: null,
      owner_pid: null,
      event_ids: eventIds,
      evidence_keys: evidenceKeys,
      covered_batch_ids: coveredBatchIds,
      previous_settled_cursor: previousCursor,
      last_settled_cursor: lastSettledCursor,
      idempotency_key: batchId,
      last_error: err?.message || String(err),
      written_at: nowIso(),
    }));
    throw err;
  }
}

export async function runMemoryCompaction(args = {}) {
  return compactMemory(args);
}
