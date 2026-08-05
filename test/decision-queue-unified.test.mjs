import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import {
  DecisionQueue,
  decisionFingerprint,
} from '../src/engine/index.mjs';

describe('unified DecisionQueue', () => {
  let tempDir;

  it('adds, deduplicates hot decisions, claims, and completes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });

    const action = { type: 'record_observation', params: { summary: 'test' } };
    const fp = decisionFingerprint(action);
    expect(fp).toContain('record_observation');

    const first = queue.addDecisionsDetailed({
      cycleId: 'cycle-test-1',
      actions: [action],
    });
    expect(first.ids).toHaveLength(1);
    expect(first.skipped).toHaveLength(0);
    expect(queue.getById(first.ids[0])?.attempts).toBe(0);
    expect(queue.getById(first.ids[0])?.max_attempts).toBeGreaterThanOrEqual(1);

    const dup = queue.addDecisionsDetailed({
      cycleId: 'cycle-test-1',
      actions: [action],
    });
    expect(dup.ids).toHaveLength(0);
    expect(dup.skipped[0]?.reason).toBe('duplicate_hot_decision');

    const claimed = queue.claimNext(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(first.ids[0]);

    queue.completeDecision(claimed[0].id, 'ok');
    expect(queue.getById(claimed[0].id)?.status).toBe('completed');
  });

  it('archives completed and retired decisions by default', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisions({
      cycleId: 'cycle-archive',
      actions: [{ type: 'record_observation', params: { summary: 'x' } }],
    });
    const [decision] = queue.claimNext(1);
    queue.completeDecision(decision.id, 'done');

    const preview = queue.archiveDecisions({ dryRun: true });
    expect(preview.archived).toHaveLength(1);
    expect(preview.statuses).toEqual(expect.arrayContaining(['completed', 'expired', 'retired', 'failed']));

    queue.archiveDecisions({ dryRun: false });
    expect(queue.readAll().decisions).toHaveLength(0);
  });

  it('assigns monotonic ids when the same cycle enqueues multiple batches', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const cycleId = 'cycle-multi-batch';

    const first = queue.addDecisionsDetailed({
      cycleId,
      actions: [
        { type: 'record_observation', params: { summary: 'a' } },
        { type: 'propose_probe', params: { probe_id: 'p1' } },
      ],
    });
    expect(first.ids).toEqual([`${cycleId}:0`, `${cycleId}:1`]);

    const [done] = queue.claimNext(1);
    queue.completeDecision(done.id, 'ok');

    const second = queue.addDecisionsDetailed({
      cycleId,
      actions: [
        { type: 'write_retrospective', params: { summary: 'b' } },
      ],
    });
    expect(second.ids).toEqual([`${cycleId}:2`]);
    expect(queue.getAll().map((d) => d.id).sort()).toEqual([
      `${cycleId}:0`,
      `${cycleId}:1`,
      `${cycleId}:2`,
    ]);
  });

  it('summarize reports backpressure signals', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    for (let i = 0; i < 3; i++) {
      queue.addDecisions({
        cycleId: `cycle-${i}`,
        actions: [{ type: 'record_observation', params: { summary: `s${i}` } }],
      });
    }
    const summary = queue.summarize({ hotLimit: 2 });
    expect(summary.hot).toBe(3);
    expect(summary.backpressure).toBe(true);
  });

  it('claimWhere filters by action type', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisions({
      cycleId: 'cycle-filter',
      actions: [
        { type: 'record_observation', params: { summary: 'mech' } },
        {
          type: 'agent_run',
          params: {
            run_spec: {
              permission_profile: 'read_only',
              primary_cwd_kind: 'subject_runtime',
              intent: 'probe',
              context: { a: 1 },
              expected_output: { summary: 'x' },
            },
          },
        },
      ],
    });

    const mechanical = queue.claimWhere({
      limit: 10,
      filter: (d) => d.action?.type !== 'agent_run',
      cycleId: 'cycle-filter',
    });
    expect(mechanical).toHaveLength(1);
    expect(mechanical[0].action.type).toBe('record_observation');
    expect(mechanical[0].last_claimed_cycle).toBe('cycle-filter');

    const agents = queue.claimWhere({
      limit: 10,
      filter: (d) => d.action?.type === 'agent_run',
    });
    expect(agents).toHaveLength(1);
    expect(agents[0].action.type).toBe('agent_run');
  });

  it('failOrBlock retries then blocks, requeue and retire work', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const ids = queue.addDecisions({
      cycleId: 'cycle-retry',
      actions: [{
        type: 'agent_run',
        max_attempts: 2,
        params: {
          run_spec: {
            permission_profile: 'read_only',
            primary_cwd_kind: 'subject_runtime',
            intent: 'x',
            context: {},
            expected_output: {},
          },
        },
      }],
    });
    const id = ids[0];
    expect(queue.getById(id)?.max_attempts).toBe(2);

    const [claimed1] = queue.claimNext(1);
    const r1 = queue.failOrBlock(claimed1.id, 'boom1');
    expect(r1).toEqual({ status: 'pending', attempts: 1, max_attempts: 2 });
    expect(queue.getById(id)?.status).toBe('pending');
    expect(queue.getById(id)?.last_error?.message).toBe('boom1');

    const [claimed2] = queue.claimNext(1);
    const r2 = queue.failOrBlock(claimed2.id, 'boom2');
    expect(r2).toEqual({ status: 'blocked', attempts: 2, max_attempts: 2 });
    expect(queue.getById(id)?.status).toBe('blocked');

    const badRequeue = queue.requeueDecision('missing');
    expect(badRequeue.ok).toBe(false);

    const requeued = queue.requeueDecision(id);
    expect(requeued).toEqual({ ok: true, status: 'pending' });
    expect(queue.getById(id)?.attempts).toBe(0);

    // force block again then retire
    const [c3] = queue.claimNext(1);
    queue.failOrBlock(c3.id, 'a');
    const [c4] = queue.claimNext(1);
    queue.failOrBlock(c4.id, 'b');
    expect(queue.getById(id)?.status).toBe('blocked');

    const retired = queue.retireDecision(id, 'no longer needed');
    expect(retired).toEqual({ ok: true, status: 'retired' });
    expect(queue.getById(id)?.retire_reason).toBe('no longer needed');

    const cannotRetire = queue.retireDecision(id, 'again');
    expect(cannotRetire.ok).toBe(false);
  });

  it('getBacklogSummary returns pending and blocked items', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisions({
      cycleId: 'cycle-backlog',
      actions: [
        { type: 'record_observation', params: { summary: 'keep' } },
        {
          type: 'agent_run',
          max_attempts: 1,
          description: 'investigate X',
          params: {
            run_spec: {
              permission_profile: 'read_only',
              primary_cwd_kind: 'subject_runtime',
              intent: 'investigate',
              context: {},
              expected_output: {},
            },
          },
        },
      ],
    });
    const agents = queue.claimWhere({
      limit: 1,
      filter: (d) => d.action?.type === 'agent_run',
    });
    queue.failOrBlock(agents[0].id, 'exhausted');

    const backlog = queue.getBacklogSummary({ limit: 10 });
    expect(backlog.pending_count).toBe(1);
    expect(backlog.blocked_count).toBe(1);
    expect(backlog.pending[0].type).toBe('record_observation');
    expect(backlog.blocked[0].type).toBe('agent_run');
    expect(backlog.blocked[0].last_error).toBe('exhausted');
    expect(backlog.blocked[0].permission_profile).toBe('read_only');
  });

  it('compatibly defaults missing v2 fields on legacy queue files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    writeFileSync(join(tempDir, 'pending_decisions.json'), JSON.stringify({
      decisions: [{
        id: 'cycle-legacy:0',
        cycle_id: 'cycle-legacy',
        created_at: new Date().toISOString(),
        status: 'pending',
        fingerprint: '{"type":"record_observation"}',
        action: { type: 'record_observation', params: { summary: 'legacy' } },
      }],
    }), 'utf-8');
    const queue = new DecisionQueue({ dataDir: tempDir });
    const d = queue.getById('cycle-legacy:0');
    expect(d.attempts).toBe(0);
    expect(d.max_attempts).toBeGreaterThanOrEqual(1);
    expect(d.last_error).toBeNull();
    expect(d.last_claimed_cycle).toBeNull();
  });

  it('cleanupExpired expires stale pending and blocked', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const oldPending = new Date(Date.now() - 80 * 3600000).toISOString();
    const oldBlocked = new Date(Date.now() - 15 * 86400000).toISOString();
    writeFileSync(join(tempDir, 'pending_decisions.json'), JSON.stringify({
      decisions: [
        {
          id: 'c:0',
          cycle_id: 'c',
          created_at: oldPending,
          status: 'pending',
          action: { type: 'record_observation', params: { summary: 'old-p' } },
        },
        {
          id: 'c:1',
          cycle_id: 'c',
          created_at: oldBlocked,
          status: 'blocked',
          attempts: 2,
          max_attempts: 2,
          action: { type: 'agent_run', params: {} },
        },
        {
          id: 'c:2',
          cycle_id: 'c',
          created_at: new Date().toISOString(),
          status: 'pending',
          action: { type: 'record_observation', params: { summary: 'fresh' } },
        },
      ],
    }), 'utf-8');

    queue.cleanupExpired(72);
    expect(queue.getById('c:0')?.status).toBe('expired');
    expect(queue.getById('c:1')?.status).toBe('expired');
    expect(queue.getById('c:2')?.status).toBe('pending');
  });

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });
});
