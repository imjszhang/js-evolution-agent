import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimEvidenceBatch,
  claimsTerminalArchivePath,
  nackBatchFailed,
  readClaimLedger,
  readTerminalClaimArchive,
  reconcileTerminalClaimStorage,
} from '../src/evolution/reactor/claim-ledger.mjs';
import {
  commitEvidenceCursor,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  refreshEvidenceIndex,
  requeueEvidenceKeys,
} from '../src/evolution/reactor/evidence-index.mjs';
import {
  classifyReactorError,
  noteRuleFailure,
  planRuleBatch,
  quarantineRuleEvidence,
  readRuleResilienceProjection,
  resolveRuleLimits,
  ruleBatchFingerprint,
  ruleQuarantinePath,
} from '../src/evolution/reactor/rule-resilience.mjs';
import { projectSubjectReadiness } from '../src/product/subject-readiness.mjs';
import { appendTerminalClaim } from '../src/evolution/reactor/claim-terminal-store.mjs';
import { peekRuleDueWindow } from '../src/evolution/reactor/rule-reactor.mjs';
import { scanWakeBacklog } from '../src/evolution/reactor/reactor-tasks.mjs';
import {
  claimNextTask,
  enqueueTask,
  pendingTasksPath,
  readTaskQueue,
} from '../src/daemon/daemon-tasks.mjs';
import { failReactorTask } from '../src/daemon/daemon-core.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempRoot = null;
let previousJeaHome;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  if (previousJeaHome === undefined) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousJeaHome;
  previousJeaHome = undefined;
});

function dataFixture(count = 1, payloadBytes = 32) {
  tempRoot = mkdtempSync(join(tmpdir(), 'jea-issue-197-'));
  const dataRoot = join(tempRoot, 'data');
  const source = join(
    dataRoot,
    'intelligence',
    'action_receipts',
    'action-receipts.jsonl',
  );
  mkdirSync(dirname(source), { recursive: true });
  const rows = Array.from({ length: count }, (_, index) => JSON.stringify({
    id: `receipt-${index}`,
    recorded_at: '2026-08-23T00:00:00.000Z',
    action_type: 'record_observation',
    producer: 'exec',
    payload_blob: 'x'.repeat(payloadBytes),
  }));
  writeFileSync(source, `${rows.join('\n')}\n`);
  return { dataRoot, source };
}

function indexedEvent(index, bytes = 100) {
  const key = `action_receipts:receipt-${index}`;
  const event = {
    id: `receipt-${index}`,
    evidence_key: key,
    kind: 'action_receipts',
    occurred_at: '2026-08-23T00:00:00.000Z',
    payload: { value: index },
  };
  Object.defineProperty(event, 'indexed_entry', {
    enumerable: false,
    value: {
      id: event.id,
      evidence_key: key,
      kind: event.kind,
      locator: { mode: 'jsonl', file: 'receipts.jsonl', offset: index * bytes, length: bytes },
    },
  });
  return event;
}

function rootFixture(count = 8) {
  tempRoot = mkdtempSync(join(tmpdir(), 'jea-issue-197-root-'));
  previousJeaHome = process.env.JEA_HOME;
  const jeaHome = join(tempRoot, '.jea');
  process.env.JEA_HOME = jeaHome;
  mkdirSync(join(tempRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempRoot, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha\n');
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  }));
  const runtime = runtimeForSubject(tempRoot, 'alpha');
  const source = join(
    runtime.dataRoot,
    'intelligence',
    'action_receipts',
    'action-receipts.jsonl',
  );
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, `${Array.from({ length: count }, (_, index) => JSON.stringify({
    id: `receipt-${index}`,
    recorded_at: '2026-08-20T00:00:00.000Z',
    action_type: 'record_observation',
    producer: 'exec',
  })).join('\n')}\n`);
  return { root: tempRoot, runtime };
}

describe('Issue #197 terminal claim recovery', () => {
  it('archives before requeue and keeps hot recovery state until restart succeeds', () => {
    const { dataRoot } = dataFixture();
    const claimed = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 1,
      kinds: ['action_receipts'],
    });
    expect(claimed.events).toHaveLength(1);

    const lockPath = `${evidenceIndexPath(dataRoot)}.lock`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '');
    const release = lockfile.lockSync(lockPath);
    try {
      expect(() => nackBatchFailed(dataRoot, claimed.batch_id, {
        error: 'injected settlement failure',
      })).toThrow(/locked/);
    } finally {
      release();
    }

    expect(readTerminalClaimArchive(dataRoot).claims).toEqual([
      expect.objectContaining({ batch_id: claimed.batch_id, status: 'failed' }),
    ]);
    expect(readClaimLedger(dataRoot).claims).toEqual([
      expect.objectContaining({ batch_id: claimed.batch_id, status: 'failed' }),
    ]);
    expect(readFileSync(claimsTerminalArchivePath(dataRoot), 'utf8').trim().split('\n')).toHaveLength(1);

    expect(reconcileTerminalClaimStorage(dataRoot)).toMatchObject({
      archived: 1,
      requeued: 1,
      pruned: 1,
    });
    expect(readClaimLedger(dataRoot).claims).toHaveLength(0);
    expect(readFileSync(claimsTerminalArchivePath(dataRoot), 'utf8').trim().split('\n')).toHaveLength(1);

    const recovered = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 1,
      kinds: ['action_receipts'],
    });
    expect(recovered.events.map((event) => event.id)).toEqual(['receipt-0']);
  });

  it('requeues 256 keys from a sparse 700 MB journal without a full reader', () => {
    const { dataRoot } = dataFixture(256);
    refreshEvidenceIndex(dataRoot, { kinds: ['action_receipts'] });
    const keys = Array.from({ length: 256 }, (_, index) => `action_receipts:receipt-${index}`);
    commitEvidenceCursor(dataRoot, 'rule', 0, { consumedKeys: keys });
    truncateSync(evidenceIndexJournalPath(dataRoot), 700 * 1024 * 1024);

    const rssBefore = process.memoryUsage().rss;
    const stats = {};
    expect(requeueEvidenceKeys(dataRoot, 'rule', keys, { stats })).toBe(256);
    const rssGrowth = process.memoryUsage().rss - rssBefore;

    expect(stats.targeted_lookup_files_read).toBe(256);
    expect(stats.index_entries_parsed ?? 0).toBe(0);
    expect(stats.index_bytes_read).toBeLessThan(2 * 1024 * 1024);
    expect(rssGrowth).toBeLessThan(50 * 1024 * 1024);
  }, 30_000);

  it('deduplicates exact terminal replay while retaining conflicting audit rows', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-terminal-idempotency-'));
    const path = join(tempRoot, 'claims.jsonl');
    const canonical = {
      batch_id: 'batch-idempotent',
      reactor: 'rule',
      status: 'failed',
      event_ids: ['event-1'],
      evidence_keys: ['action_receipts:event-1'],
    };
    expect(appendTerminalClaim(path, canonical)).toMatchObject({
      appended: true,
      conflict: false,
    });
    expect(appendTerminalClaim(path, canonical)).toMatchObject({
      appended: false,
      conflict: false,
    });
    expect(appendTerminalClaim(path, { ...canonical, last_error: 'different' })).toMatchObject({
      appended: true,
      conflict: true,
    });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('Issue #197 Rule budgets and poison circuit', () => {
  it('bounds event and hydrated byte plans and recursively splits capacity failures', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-rule-plan-'));
    const dataRoot = join(tempRoot, 'data');
    const events = Array.from({ length: 8 }, (_, index) => indexedEvent(index, 100));
    expect(resolveRuleLimits({}, {}).maxEvents).toBe(32);
    const limits = resolveRuleLimits({
      max_events: 8,
      max_payload_bytes: 450,
      max_wall_ms: 1000,
      max_consecutive_failures: 3,
    }, {});
    const initial = planRuleBatch(dataRoot, events, limits);
    expect(initial.events).toHaveLength(4);
    expect(initial.payload_bytes).toBe(400);

    noteRuleFailure(dataRoot, {
      fingerprint: initial.fingerprint,
      evidenceKeys: initial.evidence_keys,
      error: new RangeError('Invalid string length'),
      eventCount: initial.events.length,
      limits,
    });
    const split = planRuleBatch(dataRoot, events, limits);
    expect(split.events).toHaveLength(2);
  });

  it('opens a durable circuit after the transient failure budget and classifies capacity errors', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-rule-circuit-'));
    const dataRoot = join(tempRoot, 'data');
    const events = [indexedEvent(0)];
    const limits = resolveRuleLimits({ max_consecutive_failures: 2 }, {});
    const fingerprint = ruleBatchFingerprint(events);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      noteRuleFailure(dataRoot, {
        fingerprint,
        evidenceKeys: [events[0].evidence_key],
        error: new Error('temporary network failure'),
        eventCount: 1,
        limits,
      });
    }
    expect(readRuleResilienceProjection(dataRoot)).toMatchObject({
      blocked: true,
      block_reason: 'rule_poison_batch_circuit_open',
      blocked_batches: 1,
    });
    expect(classifyReactorError(new RangeError('Invalid string length'))).toMatchObject({
      retryable: false,
      category: 'deterministic_capacity',
    });
    expect(classifyReactorError(new Error('ECONNRESET'))).toMatchObject({
      retryable: true,
      category: 'transient',
    });
  });

  it('blocks exhausted operator budgets without splitting or quarantining evidence', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-rule-operator-budget-'));
    const dataRoot = join(tempRoot, 'data');
    const events = Array.from({ length: 8 }, (_, index) => indexedEvent(index));
    const limits = resolveRuleLimits({ max_events: 8 }, {});
    const initial = planRuleBatch(dataRoot, events, limits);
    const failure = noteRuleFailure(dataRoot, {
      fingerprint: initial.fingerprint,
      evidenceKeys: initial.evidence_keys,
      error: Object.assign(
        new Error('llm_token_budget_exhausted for alpha'),
        { code: 'llm_token_budget_exhausted', retryable: false },
      ),
      eventCount: initial.events.length,
      limits,
    });

    expect(failure).toMatchObject({
      classification: 'operator_budget',
      status: 'circuit_open',
      action: 'block',
      block_reason: 'rule_llm_budget_exhausted',
      retryable: false,
    });
    expect(planRuleBatch(dataRoot, events, limits)).toMatchObject({
      blocked: true,
      block_reason: 'rule_llm_budget_exhausted',
      events: { length: 8 },
    });
    expect(readRuleResilienceProjection(dataRoot)).toMatchObject({
      blocked: true,
      block_reason: 'rule_llm_budget_exhausted',
      quarantined_evidence: 0,
    });
  });

  it('persists an auditable single-evidence quarantine idempotently', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-rule-quarantine-'));
    const dataRoot = join(tempRoot, 'data');
    const event = indexedEvent(0, 8 * 1024 * 1024);
    const fingerprint = ruleBatchFingerprint([event]);
    const first = quarantineRuleEvidence(dataRoot, {
      fingerprint,
      event,
      error: new RangeError('payload exceeds configured limit'),
      batchId: 'batch-poison',
    });
    quarantineRuleEvidence(dataRoot, {
      fingerprint,
      event,
      error: new RangeError('payload exceeds configured limit'),
      batchId: 'batch-poison',
    });
    expect(first.quarantine_id).toBe(`rule-quarantine:${fingerprint}`);
    expect(readFileSync(ruleQuarantinePath(dataRoot), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readRuleResilienceProjection(dataRoot).quarantined_evidence).toBe(1);
  });

  it('does not let backlog scanning recreate a circuit-open deterministic batch', () => {
    const { root, runtime } = rootFixture();
    const due = peekRuleDueWindow(runtime.dataRoot, { minEvents: 8 });
    expect(due.plan.events).toHaveLength(8);
    noteRuleFailure(runtime.dataRoot, {
      fingerprint: due.plan.fingerprint,
      evidenceKeys: due.plan.evidence_keys,
      error: Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' }),
      eventCount: due.plan.events.length,
      limits: { ...due.plan.limits, maxConsecutiveFailures: 1 },
    });

    const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask });
    expect(scanned.rule).toMatchObject({
      blocked: true,
      pause_reason: 'rule_poison_batch_circuit_open',
    });
    expect(readTaskQueue(root, 'alpha').tasks.some((task) => task.type === 'rule_reaction')).toBe(false);
  });

  it('pauses Rule backlog on its independent catch-up budget', () => {
    const { root } = rootFixture();
    const env = {
      JEA_RULE_CATCHUP_MAX_BATCHES: '1',
      JEA_RULE_CATCHUP_MAX_WALL_MS: '600000',
    };
    const first = scanWakeBacklog(root, 'alpha', { enqueueTask, env });
    expect(first.enqueued.some((item) => item.task?.type === 'rule_reaction')).toBe(true);
    expect(first.rule_catch_up).toMatchObject({
      paused: true,
      reason: 'rule_catch_up_budget',
    });

    const queue = readTaskQueue(root, 'alpha');
    queue.tasks = queue.tasks.filter((task) => task.type !== 'rule_reaction');
    writeFileSync(pendingTasksPath(root, 'alpha'), `${JSON.stringify(queue, null, 2)}\n`);
    const second = scanWakeBacklog(root, 'alpha', { enqueueTask, env });
    expect(second.enqueued.some((item) => item.task?.type === 'rule_reaction')).toBe(false);
    expect(second.rule.pause_reason).toBe('rule_catch_up_budget');
  });

  it('does not retry deterministic daemon failures but still bounds transient retries', () => {
    const { root } = rootFixture(0);
    enqueueTask(root, 'alpha', {
      type: 'rule_reaction',
      idempotencyKey: 'deterministic',
      input: { retries: 3 },
    });
    const deterministic = claimNextTask(root, 'alpha', { workerId: 'test-worker' }).task;
    const blocked = failReactorTask(root, 'alpha', deterministic, {
      code: 'rule_capacity_payload_exceeded',
      reason: 'payload exceeded',
      message: 'payload exceeded',
      retryable: false,
    });
    expect(blocked).toMatchObject({
      ok: false,
      retryable: false,
      task: { status: 'failed', attempts: 1 },
    });

    enqueueTask(root, 'alpha', {
      type: 'rule_reaction',
      idempotencyKey: 'transient',
      input: { retries: 3 },
    });
    const transient = claimNextTask(root, 'alpha', { workerId: 'test-worker' }).task;
    const retried = failReactorTask(root, 'alpha', transient, {
      code: 'ECONNRESET',
      reason: 'temporary',
      message: 'temporary',
      retryable: true,
    });
    expect(retried).toMatchObject({
      ok: false,
      retryable: true,
      task: { status: 'pending', attempts: 1 },
    });
  });
});

describe('Issue #197 readiness isolation', () => {
  it('shows a stable Rule blocker while Channel remains running', () => {
    const projected = projectSubjectReadiness({
      subject: 'alpha',
      generatedAt: '2026-08-23T00:00:00.000Z',
      hostKind: 'electron',
      webHost: { running: true, pid: process.pid },
      cycleWorker: { running: true, pid: process.pid, status: 'running' },
      cycleHealth: {
        status: 'blocked',
        reasons: ['rule_llm_budget_exhausted'],
      },
      channelWorker: { running: true, pid: process.pid, status: 'running' },
      channelHealth: { status: 'healthy', ok: true },
      model: { mode: 'mock', configured: true },
      desktopChannelEnabled: true,
      ownership: { mode: 'managed', domain: 'all' },
      automation: { mode: 'automatic', mapped_from: 'default' },
      pendingEvidence: 8,
      catchUp: { paused: false },
    });
    expect(projected.cycle).toMatchObject({
      state: 'blocked',
      reasons: expect.arrayContaining(['rule_llm_budget_exhausted']),
    });
    expect(projected.channel.state).toBe('running');
    expect(projected.automation.blocker).toBe('rule_llm_budget_exhausted');
    expect(projected.reasons).toContain('rule_llm_budget_exhausted');
  });

  it('keeps Channel running for evidence journal due and blocked Cycle health', () => {
    for (const [status, reason, expectedCycle] of [
      ['idle', 'evidence_journal_maintenance_due', 'running'],
      ['blocked', 'evidence_journal_maintenance_blocked', 'blocked'],
    ]) {
      const projected = projectSubjectReadiness({
        subject: 'alpha',
        generatedAt: '2026-08-23T00:00:00.000Z',
        hostKind: 'electron',
        webHost: { running: true, pid: process.pid },
        cycleWorker: { running: true, pid: process.pid, status: 'running' },
        cycleHealth: { status, reasons: [reason] },
        channelWorker: { running: true, pid: process.pid, status: 'running' },
        channelHealth: { status: 'healthy', ok: true, reasons: [] },
        model: { mode: 'mock', configured: true },
        desktopChannelEnabled: true,
        ownership: { mode: 'managed', domain: 'all' },
        automation: { mode: 'automatic', mapped_from: 'default' },
        pendingEvidence: 0,
        catchUp: { paused: false },
      });
      expect(projected.cycle.state).toBe(expectedCycle);
      expect(projected.channel).toMatchObject({
        state: 'running',
        reasons: ['channel_running'],
      });
      expect(projected.channel.reasons).not.toContain(reason);
    }
  });
});
