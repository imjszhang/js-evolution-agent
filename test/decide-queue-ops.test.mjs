import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DecisionQueue } from '../src/engine/index.mjs';
import { normalizeAnalyzeDecision, normalizeQueueOps } from '../src/intelligence/decide-json.mjs';
import {
  applyQueueOps,
  formatDecisionBacklogForPrompt,
  queueAnalyzeDecideActions,
} from '../src/intelligence/phase1-shared.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';

describe('queue_ops normalize', () => {
  it('keeps only requeue/retire with ids', () => {
    expect(normalizeQueueOps([
      { op: 'requeue', id: 'c:1', reason: 'retry' },
      { op: 'retire', decision_id: 'c:2' },
      { op: 'delete', id: 'c:3' },
      { op: 'requeue' },
      null,
    ])).toEqual([
      { op: 'requeue', id: 'c:1', reason: 'retry' },
      { op: 'retire', id: 'c:2', reason: null },
    ]);
  });

  it('normalizeAnalyzeDecision attaches queue_ops', () => {
    const n = normalizeAnalyzeDecision({
      actions: [{ type: 'record_observation' }],
      queue_ops: [{ op: 'retire', id: 'x:0', reason: 'done' }],
    });
    expect(n.queue_ops).toEqual([{ op: 'retire', id: 'x:0', reason: 'done' }]);
  });
});

describe('applyQueueOps + backlog prompt', () => {
  let tempDir;
  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  it('applies requeue/retire with guards and emits events', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-qops-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const ids = queue.addDecisions({
      cycleId: 'cycle-ops',
      actions: [
        { type: 'record_observation', params: { summary: 'a' } },
        {
          type: 'agent_run',
          max_attempts: 1,
          params: {
            run_spec: {
              permission_profile: 'read_only',
              primary_cwd_kind: 'subject_runtime',
              intent: 'x',
              context: {},
              expected_output: {},
            },
          },
        },
      ],
    });
    const [claimed] = queue.claimWhere({
      limit: 1,
      filter: (d) => d.action?.type === 'agent_run',
    });
    queue.failOrBlock(claimed.id, 'exhausted');
    expect(queue.getById(claimed.id)?.status).toBe('blocked');

    const events = [];
    const result = applyQueueOps(queue, [
      { op: 'requeue', id: claimed.id, reason: 'retry later' },
      { op: 'retire', id: ids[0], reason: 'obsolete' },
      { op: 'requeue', id: 'missing', reason: 'nope' },
      { op: 'requeue', id: ids[0], reason: 'already retired' },
    ], {
      cycleId: 'cycle-ops',
      emitEvent: (e) => events.push(e),
    });

    expect(result.applied).toEqual([
      { op: 'requeue', id: claimed.id, status: 'pending', reason: 'retry later' },
      { op: 'retire', id: ids[0], status: 'retired', reason: 'obsolete' },
    ]);
    expect(result.skipped.some((s) => s.id === 'missing')).toBe(true);
    expect(result.skipped.some((s) => s.id === ids[0] && s.reason === 'not_blocked')).toBe(true);
    expect(queue.getById(claimed.id)?.status).toBe('pending');
    expect(queue.getById(claimed.id)?.attempts).toBe(0);
    expect(queue.getById(ids[0])?.status).toBe('retired');
    expect(events.filter((e) => e.type === 'decide_queue_op')).toHaveLength(2);

    const text = formatDecisionBacklogForPrompt(queue.getBacklogSummary());
    expect(text).toContain('Decision Backlog');
    expect(text).toContain(claimed.id);
  });

  it('queueAnalyzeDecideActions applies queue_ops before enqueue', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-qops-queue-'));
    const runtimeRoot = join(tempDir, 'runtime');
    mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
    const decisionQueue = createHostDecisionQueue({
      dataDir: join(runtimeRoot, 'data', 'evolution'),
    });
    const existing = decisionQueue.addDecisions({
      cycleId: 'cycle-old',
      actions: [{
        type: 'agent_run',
        max_attempts: 1,
        params: {
          run_spec: {
            permission_profile: 'read_only',
            primary_cwd_kind: 'subject_runtime',
            intent: 'old',
            context: {},
            expected_output: {},
          },
        },
      }],
    });
    const [claimed] = decisionQueue.claimNext(1);
    decisionQueue.failOrBlock(claimed.id, 'fail');
    expect(decisionQueue.getById(existing[0])?.status).toBe('blocked');

    const analysis = normalizeAnalyzeDecision({
      decision: 'execute',
      actions: [{ type: 'record_observation', description: 'new', params: { content: 'n' } }],
      queue_ops: [{ op: 'retire', id: existing[0], reason: 'replaced' }],
    });
    const result = await queueAnalyzeDecideActions({
      projectRoot: runtimeRoot,
      runtime: { runtimeRoot, subject: 'demo' },
      decisionQueue,
      cycleId: 'cycle-new',
      timestamp: new Date().toISOString(),
      analysis,
      actions: analysis.actions,
      pipeline: 'agent_loop',
    });
    expect(result.queue_ops_applied).toHaveLength(1);
    expect(decisionQueue.getById(existing[0])?.status).toBe('retired');
    expect(result.decisions_queued).toHaveLength(1);
  });
});
