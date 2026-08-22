import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import {
  DecisionQueue,
  decisionFingerprint,
} from '../src/engine/index.mjs';

describe('unified DecisionQueue', () => {
  let tempDir;
  const originalDisableCycleTtl = process.env.JEA_QUEUE_DISABLE_CYCLE_TTL;

  it('fails closed when the sidecar lock cannot be acquired', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const lockSpy = vi.spyOn(lockfile, 'lockSync').mockImplementation(() => {
      throw new Error('busy');
    });
    let called = false;

    expect(() => queue._withLock(() => {
      called = true;
    })).toThrow(/Decision queue lock acquisition failed/);
    expect(called).toBe(false);
    lockSpy.mockRestore();
  });

  it('retries through brief sidecar lock contention', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const lockPath = join(tempDir, 'pending_decisions.lock');
    writeFileSync(lockPath, '', 'utf-8');
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "import lockfile from 'proper-lockfile';",
        "const path = process.argv[1];",
        'const release = lockfile.lockSync(path);',
        "process.stdout.write('locked\\n');",
        'setTimeout(() => { release(); process.exit(0); }, 80);',
      ].join(' '),
      lockPath,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', resolve);
    });

    expect(queue.getAll()).toEqual([]);
    await childExited;
  });

  it('does not replace a corrupt active queue with an empty queue', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queuePath = join(tempDir, 'pending_decisions.json');
    writeFileSync(queuePath, '{"decisions":', 'utf-8');
    const queue = new DecisionQueue({ dataDir: tempDir });

    expect(() => queue.addDecisions({
      cycleId: 'cycle-corrupt',
      actions: [{ type: 'record_observation', params: { summary: 'must not write' } }],
    })).toThrow(/Decision queue JSON is invalid/);
    expect(readFileSync(queuePath, 'utf-8')).toBe('{"decisions":');
  });

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

  it('gates every construction path and illegal transitions in strict mode', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const previous = process.env.JEA_CONTRACT_MODE;
    process.env.JEA_CONTRACT_MODE = 'strict';
    try {
      const queue = new DecisionQueue({ dataDir: tempDir });
      expect(() => queue.addDecisions({
        cycleId: 'cycle-invalid',
        actions: [{}],
      })).toThrow(/decision contract invalid/);

      const [id] = queue.addDecisions({
        cycleId: 'cycle-valid',
        actions: [{ type: 'record_observation' }],
      });
      queue.claimNext(1);
      queue.completeDecision(id, 'done');
      expect(() => queue.updateStatus(id, 'pending'))
        .toThrow(/decision_transition contract invalid/);
    } finally {
      if (previous === undefined) delete process.env.JEA_CONTRACT_MODE;
      else process.env.JEA_CONTRACT_MODE = previous;
    }
  });

  it('deduplicates volatile report context while preserving belief intent', () => {
    const actionFor = (beliefId, reportPath) => ({
      type: 'agent_run',
      serves_goal: 'goal-belief',
      params: {
        run_spec: {
          intent: 'test bounded signal',
          context: {
            belief_id: beliefId,
            belief_relation: 'test_belief',
            expected_belief_update: 'validate or refute',
            phase1_report_path: reportPath,
            phase1_report_markdown: `report at ${reportPath}`,
            analysis_context: `analysis at ${reportPath}`,
          },
        },
      },
    });

    expect(decisionFingerprint(actionFor('belief-a', '/cycle/one.md')))
      .toBe(decisionFingerprint(actionFor('belief-a', '/cycle/two.md')));
    expect(decisionFingerprint(actionFor('belief-a', '/cycle/one.md')))
      .not.toBe(decisionFingerprint(actionFor('belief-b', '/cycle/one.md')));
    const paramsContextAction = actionFor('belief-a', '/cycle/one.md');
    paramsContextAction.params.context = paramsContextAction.params.run_spec.context;
    delete paramsContextAction.params.run_spec.context;
    expect(decisionFingerprint(paramsContextAction))
      .toBe(decisionFingerprint(actionFor('belief-a', '/cycle/one.md')));

    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    expect(queue.addDecisionsDetailed({
      cycleId: 'cycle-one',
      actions: [actionFor('belief-a', '/cycle/one.md')],
    }).ids).toHaveLength(1);
    expect(queue.addDecisionsDetailed({
      cycleId: 'cycle-two',
      actions: [actionFor('belief-a', '/cycle/two.md')],
    }).skipped[0]?.reason).toBe('duplicate_hot_decision');
    expect(queue.addDecisionsDetailed({
      cycleId: 'cycle-two',
      actions: [actionFor('belief-b', '/cycle/two.md')],
    }).ids).toHaveLength(1);
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

    const beforeRequeue = queue.runQueueMaintenance({ pendingTtlCycles: 100, blockedTtlCycles: 100 });
    expect(beforeRequeue.incremented).toBe(1);
    expect(queue.getById(id)?.cycles_seen).toBe(1);

    const requeued = queue.requeueDecision(id);
    expect(requeued).toEqual({ ok: true, status: 'pending' });
    expect(queue.getById(id)?.attempts).toBe(0);
    expect(queue.getById(id)?.cycles_seen).toBe(0);

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
    expect(d.cycles_seen).toBe(0);
  });

  it('wall-clock age alone does not expire when cycles_seen is below TTL', () => {
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
          cycles_seen: 2,
          action: { type: 'record_observation', params: { summary: 'old-p' } },
        },
        {
          id: 'c:1',
          cycle_id: 'c',
          created_at: oldBlocked,
          status: 'blocked',
          attempts: 2,
          max_attempts: 2,
          cycles_seen: 3,
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

    const result = queue.cleanupExpired({
      pendingTtlCycles: 5,
      blockedTtlCycles: 10,
      wallclockTtlDays: 30,
    });
    expect(result.expired).toHaveLength(0);
    expect(queue.getById('c:0')?.status).toBe('pending');
    expect(queue.getById('c:1')?.status).toBe('blocked');
    expect(queue.getById('c:2')?.status).toBe('pending');
  });

  it('runQueueMaintenance increments cycles_seen and expires by cycle TTL', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const ids = queue.addDecisions({
      cycleId: 'cycle-ttl',
      actions: [{ type: 'record_observation', params: { summary: 'linger' } }],
    });
    const id = ids[0];
    expect(queue.getById(id)?.cycles_seen).toBe(0);

    for (let i = 0; i < 6; i += 1) {
      const mid = queue.runQueueMaintenance({
        cycleId: `tick-${i}`,
        pendingTtlCycles: 5,
        blockedTtlCycles: 10,
        wallclockTtlDays: 30,
      });
      expect(mid.incremented).toBe(i < 6 ? 1 : 0);
      expect(mid.expired).toHaveLength(i === 5 ? 1 : 0);
      expect(queue.getById(id)?.status).toBe(i === 5 ? 'expired' : 'pending');
      expect(queue.getById(id)?.cycles_seen).toBe(i + 1);
    }
  });

  it('runQueueMaintenance expires blocked items by cycle TTL', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    writeFileSync(join(tempDir, 'pending_decisions.json'), JSON.stringify({
      decisions: [{
        id: 'b:0',
        cycle_id: 'b',
        created_at: new Date().toISOString(),
        status: 'blocked',
        attempts: 2,
        max_attempts: 2,
        cycles_seen: 0,
        action: { type: 'agent_run', params: {} },
      }],
    }), 'utf-8');

    for (let i = 0; i < 11; i += 1) {
      const mid = queue.runQueueMaintenance({
        cycleId: `blocked-cycle-${i}`,
        pendingTtlCycles: 5,
        blockedTtlCycles: 10,
        wallclockTtlDays: 30,
      });
      expect(mid.expired).toHaveLength(i === 10 ? 1 : 0);
      expect(queue.getById('b:0')?.status).toBe(i === 10 ? 'expired' : 'blocked');
      expect(queue.getById('b:0')?.cycles_seen).toBe(i + 1);
    }
  });

  it('supports explicitly disabling cycle TTL', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    process.env.JEA_QUEUE_DISABLE_CYCLE_TTL = '1';
    const queue = new DecisionQueue({ dataDir: tempDir });
    const [id] = queue.addDecisions({
      cycleId: 'cycle-ttl-disabled',
      actions: [{ type: 'record_observation', params: { summary: 'linger' } }],
    });

    for (let i = 0; i < 3; i += 1) {
      const result = queue.runQueueMaintenance({
        cycleId: `disabled-${i}`,
        pendingTtlCycles: 1,
        wallclockTtlDays: 30,
      });
      expect(result.incremented).toBe(0);
      expect(result.expired).toHaveLength(0);
    }
    expect(queue.getById(id)).toMatchObject({ status: 'pending', cycles_seen: 0 });
  });

  it('counts a maintenance cycle only once', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const [id] = queue.addDecisions({
      cycleId: 'cycle-distinct',
      actions: [{ type: 'record_observation', params: { summary: 'x' } }],
    });

    expect(queue.runQueueMaintenance({ cycleId: 'exec-1' }).incremented).toBe(1);
    expect(queue.runQueueMaintenance({ cycleId: 'exec-1' }).incremented).toBe(0);
    expect(queue.getById(id)?.cycles_seen).toBe(1);
  });

  it('cleanupExpired wallclock fallback expires ancient decisions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const ancient = new Date(Date.now() - 40 * 86400000).toISOString();
    writeFileSync(join(tempDir, 'pending_decisions.json'), JSON.stringify({
      decisions: [{
        id: 'w:0',
        cycle_id: 'w',
        created_at: ancient,
        status: 'pending',
        cycles_seen: 1,
        action: { type: 'record_observation', params: { summary: 'ancient' } },
      }],
    }), 'utf-8');

    const result = queue.cleanupExpired({
      pendingTtlCycles: 5,
      blockedTtlCycles: 10,
      wallclockTtlDays: 30,
    });
    expect(result.expired).toEqual([{ id: 'w:0', expire_reason: 'wallclock' }]);
    expect(queue.getById('w:0')?.status).toBe('expired');
    expect(queue.getById('w:0')?.expire_reason).toBe('wallclock');
    expect(queue.getById('w:0')?.cycles_seen).toBe(1);
  });

  it('getBacklogSummary includes cycles_seen', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisions({
      cycleId: 'cycle-backlog-cycles',
      actions: [{ type: 'record_observation', params: { summary: 'x' } }],
    });
    queue.runQueueMaintenance({
      pendingTtlCycles: 100,
      blockedTtlCycles: 100,
      wallclockTtlDays: 30,
    });
    const backlog = queue.getBacklogSummary({ limit: 10 });
    expect(backlog.pending[0].cycles_seen).toBe(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDisableCycleTtl === undefined) delete process.env.JEA_QUEUE_DISABLE_CYCLE_TTL;
    else process.env.JEA_QUEUE_DISABLE_CYCLE_TTL = originalDisableCycleTtl;
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });
});
