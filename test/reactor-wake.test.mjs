import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { enqueueWakeIntent, listPendingWakes } from '../src/evolution/reactor/wake-store.mjs';
import { enqueueReactorTask, runVerifyBatchTask, scanWakeBacklog } from '../src/evolution/reactor/reactor-tasks.mjs';
import { enqueueTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { RULE_EVIDENCE_KINDS, shouldRunRuleReaction } from '../src/evolution/reactor/rule-reactor.mjs';
import {
  compactMemory,
  readLastCommittedMemoryCheckpoint,
  readMemoryCompactionProjection,
  shouldCompactMemory,
} from '../src/evolution/reactor/memory-compactor.mjs';
import { patchBatchCheckpoint, writeBatchCheckpoint, readBatchCheckpoint } from '../src/evolution/reactor/batch-checkpoint-store.mjs';
import {
  claimPendingVerifyResult,
  completeVerifyResult,
  listPendingVerifyResults,
  writeExecResult,
} from '../src/evolution/reactor/exec-result-store.mjs';
import { beginExecIntent, completeExecIntent, listOpenExecIntents, markExecIntent, recoverOpenExecIntents } from '../src/evolution/reactor/exec-intent-store.mjs';
import { peekRuleDueWindow } from '../src/evolution/reactor/rule-reactor.mjs';
import { claimEvidenceBatch, releaseBatchClaim } from '../src/evolution/reactor/claim-ledger.mjs';
import { isEligibleForReactor } from '../src/evolution/reactor/eligibility.mjs';
import { eventsAfterCursor, writeRuleCursors, readRuleCursors } from '../src/evolution/reactor/rule-cursors.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-reactor-wake-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(tempDir, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n\nTest authority.', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'authority', 'GUIDE.md'), '# Guide\n\nTest guide.', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('durable wake intents', () => {
  it('merges same-kind wakes into one pending intent', () => {
    const root = makeRoot();
    const first = enqueueWakeIntent(root, 'alpha', { kind: 'cognitive', reason: 'brief' });
    const second = enqueueWakeIntent(root, 'alpha', { kind: 'cognitive', reason: 'receipt' });
    expect(first.created).toBe(true);
    expect(second.merged).toBe(true);
    expect(second.intent.id).toBe(first.intent.id);
    expect(listPendingWakes(root, 'alpha')).toHaveLength(1);
  });

  it('enqueues a single active daemon task per reactor kind', () => {
    const root = makeRoot();
    const first = enqueueReactorTask(root, 'alpha', 'cognitive', {
      reason: 'brief',
      enqueueTask,
    });
    const second = enqueueReactorTask(root, 'alpha', 'cognitive', {
      reason: 'receipt',
      enqueueTask,
    });
    expect(first.task_created).toBe(true);
    expect(second.task_created).toBe(false);
    const queue = readTaskQueue(root, 'alpha');
    const active = queue.tasks.filter((task) => task.type === 'cognitive_reaction' && ['pending', 'running'].includes(task.status));
    expect(active).toHaveLength(1);
  });

  it('backlog scan creates a wake when evidence-wake is enabled', () => {
    const root = makeRoot();
    enqueueWakeIntent(root, 'alpha', { kind: 'exec', reason: 'decisions' });
    const previous = process.env.JEA_EVIDENCE_WAKE;
    process.env.JEA_EVIDENCE_WAKE = '1';
    try {
      const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask });
      expect(scanned.scanned).toBe(true);
      expect(scanned.enqueued.length).toBeGreaterThan(0);
    } finally {
      if (previous == null) delete process.env.JEA_EVIDENCE_WAKE;
      else process.env.JEA_EVIDENCE_WAKE = previous;
    }
  });

  it('does not wake cognitive for a tagged cognitive output', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const dir = join(runtime.dataRoot, 'intelligence', 'evolution_events');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'evolution-events.jsonl'), `${JSON.stringify({
      id: 'evt-cognitive-self',
      type: 'reactor_pipeline',
      recorded_at: new Date().toISOString(),
      producer: 'cognitive',
      activation_targets: [],
    })}\n`);
    const previous = process.env.JEA_EVIDENCE_WAKE;
    process.env.JEA_EVIDENCE_WAKE = '1';
    try {
      const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask });
      const queue = readTaskQueue(root, 'alpha');
      expect(scanned.scanned).toBe(true);
      expect(queue.tasks.some((task) => task.type === 'cognitive_reaction')).toBe(false);
    } finally {
      if (previous == null) delete process.env.JEA_EVIDENCE_WAKE;
      else process.env.JEA_EVIDENCE_WAKE = previous;
    }
  });
});

describe('rule evidence kinds and cursors', () => {
  it('uses plural evidence-stream kinds', () => {
    expect(RULE_EVIDENCE_KINDS).toEqual([
      'action_receipts',
      'verify_reports',
      'belief_events',
      'goal_events',
    ]);
  });

  it('advances per-goal cursors past the last event', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeRuleCursors(runtime.dataRoot, {
      lastEventId: 'evt-1',
      batchId: 'batch-rule-1',
      goalIds: ['goal-a'],
    });
    const cursors = readRuleCursors(runtime.dataRoot);
    expect(cursors.global_cursor).toBe('evt-1');
    expect(cursors.goals['goal-a'].last_batch_id).toBe('batch-rule-1');
    expect(eventsAfterCursor([
      { id: 'evt-1' },
      { id: 'evt-2' },
    ], cursors.global_cursor).map((item) => item.id)).toEqual(['evt-2']);
  });

  it('stores independent evidence-key cursors per goal', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeRuleCursors(runtime.dataRoot, {
      batchId: 'batch-rule-keys',
      goalIds: ['goal-a', 'goal-b'],
      goalCursors: {
        'goal-a': { evidenceKey: 'action_receipts:shared', eventId: 'shared' },
        'goal-b': { evidenceKey: 'verify_reports:shared', eventId: 'shared' },
      },
    });
    const cursors = readRuleCursors(runtime.dataRoot);
    expect(cursors.goals['goal-a'].last_evidence_key).toBe('action_receipts:shared');
    expect(cursors.goals['goal-b'].last_evidence_key).toBe('verify_reports:shared');
    expect(cursors.global_cursor).toBeNull();
    const afterA = eventsAfterCursor([
      { id: 'shared', kind: 'action_receipts' },
      { id: 'shared', kind: 'verify_reports' },
      { id: 'later', kind: 'action_receipts' },
    ], cursors.goals['goal-a'].last_evidence_key);
    expect(afterA.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'verify_reports:shared',
      'action_receipts:later',
    ]);
  });
});

describe('durable exec intent', () => {
  it('keeps prepared actions open until completed', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const intent = beginExecIntent(runtime.dataRoot, {
      executionId: 'exec-1',
      decisionId: 'd1',
      action: { id: 'a1', type: 'record_observation' },
    });
    expect(intent.status).toBe('prepared');
    expect(intent.key).toBe('d1#1');
    expect(listOpenExecIntents(runtime.dataRoot)).toHaveLength(1);
    completeExecIntent(runtime.dataRoot, intent.id, { status: 'completed' });
    expect(listOpenExecIntents(runtime.dataRoot)).toHaveLength(0);
  });
});

describe('rule and memory gates', () => {
  it('does not run rule reaction below evidence/wall-clock thresholds', () => {
    const gate = shouldRunRuleReaction([
      { id: 'evt-1', occurred_at: new Date().toISOString() },
    ], { minEvents: 8, maxIdleMs: 48 * 3600_000 });
    expect(gate.due).toBe(false);
    expect(gate.reason).toBe('below_threshold');
  });

  it('wakes memory from backlog scan when compaction is due', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true });
    writeJsonFile(join(runtime.dataRoot, 'evolution', 'reactor', 'claims.json'), {
      claims: Array.from({ length: 4 }, (_, i) => ({
        batch_id: `batch-${i}`,
        reactor: 'cognitive',
        claimed_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        event_ids: [`evt-${i}`],
        status: 'handled',
        handled_at: new Date().toISOString(),
      })),
      updated_at: new Date().toISOString(),
    });
    const previous = process.env.JEA_EVIDENCE_WAKE;
    process.env.JEA_EVIDENCE_WAKE = '1';
    try {
      const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask });
      expect(scanned.enqueued.some((item) => item.intent?.kind === 'memory' || item.task?.type === 'memory_compaction')).toBe(true);
    } finally {
      if (previous == null) delete process.env.JEA_EVIDENCE_WAKE;
      else process.env.JEA_EVIDENCE_WAKE = previous;
    }
  });

  it('runs memory compaction after enough handled batches', () => {
    const now = Date.now();
    const ledger = {
      claims: Array.from({ length: 4 }, (_, i) => ({
        status: 'handled',
        handled_at: new Date(now - i * 1000).toISOString(),
        batch_id: `batch-${i}`,
        event_ids: [`evt-${i}`],
      })),
    };
    const gate = shouldCompactMemory(ledger, { minHandled: 4, nowMs: now });
    expect(gate.due).toBe(true);
    expect(gate.reason).toBe('handled_batches');
  });

  it('does not compact batches already covered by last_compacted_at', () => {
    const now = Date.now();
    const ledger = {
      claims: Array.from({ length: 4 }, (_, i) => ({
        status: 'handled',
        handled_at: new Date(now - 60_000).toISOString(),
        batch_id: `batch-${i}`,
        event_ids: [`evt-${i}`],
      })),
    };
    const gate = shouldCompactMemory(ledger, {
      minHandled: 4,
      nowMs: now,
      lastCompactedAt: new Date(now - 1000).toISOString(),
    });
    expect(gate.due).toBe(false);
    expect(gate.since_compact).toBe(0);
  });

  it('retries failed memory compaction without advancing its cursor', async () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true });
    writeJsonFile(join(runtime.dataRoot, 'evolution', 'reactor', 'claims.json'), {
      claims: [{
        batch_id: 'batch-source-1',
        reactor: 'cognitive',
        claimed_at: new Date().toISOString(),
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        event_ids: ['evt-source-1'],
        evidence_keys: ['evolution_events:evt-source-1'],
        status: 'handled',
        handled_at: new Date().toISOString(),
      }],
      updated_at: new Date().toISOString(),
    });
    await expect(compactMemory({
      root,
      subject: 'alpha',
      input: { force: true },
      runCompaction: async () => { throw new Error('compaction-crash'); },
    })).rejects.toThrow('compaction-crash');
    expect(readLastCommittedMemoryCheckpoint(runtime.dataRoot)).toBeNull();
    expect(readMemoryCompactionProjection(runtime.runtimeRoot).last_compacted_at).toBeNull();

    const retried = await compactMemory({
      root,
      subject: 'alpha',
      input: { force: true },
      runCompaction: async () => ({ ok: true }),
    });
    expect(retried.covered_batches).toBe(1);
    expect(readLastCommittedMemoryCheckpoint(runtime.dataRoot)?.stage).toBe('committed');
    const idle = await compactMemory({
      root,
      subject: 'alpha',
      runCompaction: async () => ({ ok: true }),
    });
    expect(idle.skipped).toBe(true);
    expect(idle.since_compact).toBe(0);
  });
});

describe('batch checkpoint', () => {
  it('persists a valid cognitive checkpoint', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const record = writeBatchCheckpoint(runtime.dataRoot, {
      batch_id: 'batch-cp-1',
      reactor: 'cognitive',
      subject: 'alpha',
      stage: 'committed',
      event_ids: ['evt-1'],
      queued_decision_ids: ['d1'],
      honesty: { status: 'ok' },
    });
    expect(record.batch_id).toBe('batch-cp-1');
    expect(readBatchCheckpoint(runtime.dataRoot, 'batch-cp-1').stage).toBe('committed');
  });

  it('does not wipe event_ids when a later patch omits them', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeBatchCheckpoint(runtime.dataRoot, {
      batch_id: 'batch-cp-2',
      reactor: 'cognitive',
      subject: 'alpha',
      stage: 'claimed',
      event_ids: ['evt-keep'],
    });
    patchBatchCheckpoint(runtime.dataRoot, 'batch-cp-2', {
      stage: 'failed',
      last_error: 'boom',
      event_ids: [],
    });
    const record = readBatchCheckpoint(runtime.dataRoot, 'batch-cp-2');
    expect(record.stage).toBe('failed');
    expect(record.event_ids).toEqual(['evt-keep']);
    expect(record.last_error).toBe('boom');
  });
});

describe('verify batch recovery', () => {
  it('skips when no exec result exists', async () => {
    const root = makeRoot();
    const outcome = await runVerifyBatchTask(root, 'alpha', { execution_id: 'exec-missing' });
    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBe('no_pending_verify');
  });

  it('loads persisted exec results for verify', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const record = writeExecResult(runtime.dataRoot, 'exec-1', {
      cycle_id: 'exec-1',
      success: true,
      executed: [{ action: { type: 'record_observation' }, result: { success: true } }],
    });
    expect(record.executed).toHaveLength(1);
    expect(record.verify_status).toBe('pending_verify');
  });

  it('claims oldest pending verify and does not use latest as work truth', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeExecResult(runtime.dataRoot, 'exec-old', {
      cycle_id: 'exec-old',
      executed: [{ id: 'd1', action: { type: 'record_observation' }, result: { success: true } }],
    });
    writeExecResult(runtime.dataRoot, 'exec-new', {
      cycle_id: 'exec-new',
      executed: [{ id: 'd2', action: { type: 'record_observation' }, result: { success: true } }],
    });
    expect(listPendingVerifyResults(runtime.dataRoot)).toHaveLength(2);
    const first = claimPendingVerifyResult(runtime.dataRoot);
    expect(first.execution_id).toBe('exec-old');
    completeVerifyResult(runtime.dataRoot, 'exec-old', { status: 'verified' });
    const second = claimPendingVerifyResult(runtime.dataRoot);
    expect(second.execution_id).toBe('exec-new');
    expect(listPendingVerifyResults(runtime.dataRoot)).toHaveLength(0);
  });
});

describe('eligibility and rule peek', () => {
  it('does not let cognitive consume its own reports or events', () => {
    expect(isEligibleForReactor({
      id: 'evt-1',
      kind: 'evolution_events',
      type: 'reactor_pipeline',
      producer: 'cognitive',
    }, 'cognitive')).toBe(false);
    expect(isEligibleForReactor({
      id: 'evt-2',
      kind: 'evolution_events',
      type: 'exec_pipeline',
      producer: 'exec',
    }, 'cognitive')).toBe(true);
    expect(isEligibleForReactor({
      id: 'evt-3',
      kind: 'evolution_events',
      type: 'external_event',
      producer: 'external',
      activation_targets: [],
    }, 'cognitive')).toBe(false);
  });

  it('does not claim rule evidence below threshold', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    mkdirSync(join(runtime.dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
    writeFileSync(join(runtime.dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), `${JSON.stringify({
      id: 'receipt-one',
      action_type: 'record_observation',
      recorded_at: new Date().toISOString(),
      action: { type: 'record_observation' },
      result: { success: true },
    })}\n`);
    const peeked = peekRuleDueWindow(runtime.dataRoot, { minEvents: 8 });
    expect(peeked.due).toHaveLength(0);
    expect(peeked.eligible.length).toBeGreaterThan(0);
  });

  it('accumulates rule evidence across scans until the count threshold', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const dir = join(runtime.dataRoot, 'intelligence', 'action_receipts');
    const file = join(dir, 'action-receipts.jsonl');
    mkdirSync(dir, { recursive: true });
    const receipt = (index) => ({
      id: `receipt-acc-${index}`,
      action_type: 'record_observation',
      recorded_at: new Date(Date.now() + index).toISOString(),
      action: { type: 'record_observation', serves_goal: 'goal-a' },
      result: { success: true },
    });
    writeFileSync(file, `${JSON.stringify(receipt(0))}\n`);
    expect(peekRuleDueWindow(runtime.dataRoot, { minEvents: 8 }).due).toHaveLength(0);
    writeFileSync(
      file,
      `${Array.from({ length: 8 }, (_, index) => JSON.stringify(receipt(index))).join('\n')}\n`,
    );
    const due = peekRuleDueWindow(runtime.dataRoot, { minEvents: 8 }).due;
    expect(due).toHaveLength(1);
    expect(due[0].goalId).toBe('goal-a');
    expect(due[0].reason).toBe('evidence_count');
  });

  it('makes a small rule window due by wall clock without mixing goals', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const dir = join(runtime.dataRoot, 'intelligence', 'action_receipts');
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, 'action-receipts.jsonl'), [
      {
        id: 'receipt-goal-a',
        action_type: 'record_observation',
        recorded_at: old,
        action: { type: 'record_observation', serves_goal: 'goal-a' },
        result: { success: true },
      },
      {
        id: 'receipt-goal-b',
        action_type: 'record_observation',
        recorded_at: new Date().toISOString(),
        action: { type: 'record_observation', serves_goal: 'goal-b' },
        result: { success: true },
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const due = peekRuleDueWindow(runtime.dataRoot, {
      minEvents: 8,
      maxIdleMs: 30_000,
    }).due;
    expect(due.map((item) => item.goalId)).toEqual(['goal-a']);
    expect(due[0].reason).toBe('wall_clock');
  });

  it('released claims do not cover evidence', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    mkdirSync(join(runtime.dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
    writeFileSync(join(runtime.dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), `${JSON.stringify({
      id: 'receipt-rel',
      action_type: 'record_observation',
      recorded_at: new Date().toISOString(),
      action: { type: 'record_observation' },
      result: { success: true },
    })}\n`);
    const claimed = claimEvidenceBatch(runtime.dataRoot, { reactor: 'rule', limit: 1 });
    releaseBatchClaim(runtime.dataRoot, claimed.batch_id, { reason: 'below_threshold' });
    const again = claimEvidenceBatch(runtime.dataRoot, { reactor: 'rule', limit: 1 });
    expect(again.skipped).toBeUndefined();
    expect(again.events[0].id).toBe('receipt-rel');
  });
});

describe('exec intent recovery', () => {
  it('marks executing intents without receipts as uncertain', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const intent = beginExecIntent(runtime.dataRoot, {
      executionId: 'exec-crash',
      decisionId: 'd-crash',
      action: { type: 'record_observation' },
    });
    markExecIntent(runtime.dataRoot, intent.id, { status: 'executing' });
    const recovery = recoverOpenExecIntents(runtime.dataRoot, {
      store: { readActionReceipts: () => [] },
      decisionQueue: { updateStatus() {} },
    });
    expect(recovery.uncertain).toHaveLength(1);
    expect(listOpenExecIntents(runtime.dataRoot)).toHaveLength(0);
  });
});
