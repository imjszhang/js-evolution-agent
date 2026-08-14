import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DecisionQueue } from '../src/engine/index.mjs';
import { normalizeAnalyzeDecision, normalizeQueueOps } from '../src/intelligence/decide-json.mjs';
import {
  applyQueueOps,
  formatDecisionBacklogForPrompt,
  queueAnalyzeDecideActions,
  validateQueuedAction,
} from '../src/intelligence/phase1-shared.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { actionHandlers } from '../src/actions/handlers/builtin.mjs';
import { REQUIRED_ACTION_PARAMS } from '../src/actions/registry.mjs';

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

  it('normalizeAnalyzeDecision drops non-object actions without coercing strings', () => {
    const n = normalizeAnalyzeDecision({
      actions: [
        'propose_probe: verify_reports file-level for cycle-x',
        null,
        { type: 'record_observation', description: 'keep' },
        { type: '' },
        { description: 'no type' },
        ['propose_probe'],
      ],
    });
    expect(n.actions).toEqual([{ type: 'record_observation', description: 'keep' }]);
    expect(n.decision).toBe('execute');
  });

  it('normalizeAnalyzeDecision defers when only invalid actions remain', () => {
    const n = normalizeAnalyzeDecision({
      actions: ['propose_probe: leftover string'],
    });
    expect(n.actions).toEqual([]);
    expect(n.decision).toBe('defer');
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

describe('validateQueuedAction + mixed enqueue', () => {
  let tempDir;
  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  it('rejects string, empty object, and missing type; accepts recording actions', () => {
    expect(validateQueuedAction('propose_probe: verify_reports').valid).toBe(false);
    expect(validateQueuedAction({}).valid).toBe(false);
    expect(validateQueuedAction({ description: 'no type' }).valid).toBe(false);
    expect(validateQueuedAction({ type: '' }).valid).toBe(false);
    expect(validateQueuedAction({
      type: 'record_observation',
      description: 'ok',
      params: { content: 'n' },
    }).valid).toBe(true);
  });

  it('queueAnalyzeDecideActions skips string actions and does not persist them', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-qops-shape-'));
    const runtimeRoot = join(tempDir, 'runtime');
    mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
    const decisionQueue = createHostDecisionQueue({
      dataDir: join(runtimeRoot, 'data', 'evolution'),
    });
    const result = await queueAnalyzeDecideActions({
      projectRoot: runtimeRoot,
      runtime: { runtimeRoot, subject: 'demo' },
      decisionQueue,
      cycleId: 'cycle-shape',
      timestamp: new Date().toISOString(),
      analysis: { deferred: [] },
      actions: [
        'propose_probe: verify_reports file-level for cycle-x',
        { type: 'record_observation', description: 'keep', params: { content: 'keep' } },
        { description: 'missing type' },
      ],
      pipeline: 'reactor',
    });
    expect(result.decisions_queued).toHaveLength(1);
    expect(result.decisions_skipped).toHaveLength(2);
    expect(result.decisions_skipped.every((s) => s.reason === 'invalid_action')).toBe(true);

    const queuePath = join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
    const queued = JSON.parse(readFileSync(queuePath, 'utf8'));
    expect(queued.decisions).toHaveLength(1);
    expect(queued.decisions[0].action).toEqual(expect.objectContaining({
      type: 'record_observation',
    }));
    expect(queued.decisions.every((d) => d.action && typeof d.action === 'object' && !Array.isArray(d.action))).toBe(true);
  });

  it('rejects recording actions missing required params; accepts params or top-level fields', () => {
    expect(validateQueuedAction({
      type: 'record_observation',
      description: 'no content',
    }).valid).toBe(false);
    expect(validateQueuedAction({
      type: 'record_observation',
      description: 'no content',
    }).errors[0]).toContain('content');
    expect(validateQueuedAction({
      type: 'propose_probe',
      params: { hypothesis: 'h' },
    }).valid).toBe(false);
    expect(validateQueuedAction({
      type: 'record_observation',
      content: 'top-level ok',
    }).valid).toBe(true);
    expect(validateQueuedAction({
      type: 'write_retrospective',
      params: { summary: 's' },
    }).valid).toBe(true);
    const malformedRun = validateQueuedAction({
      type: 'agent_run',
      description: 'malformed expected_output',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          intent: 'inspect',
          context: { why_now: 'test' },
          expected_output: { summary: 'not-an-array' },
        },
      },
    });
    expect(malformedRun.valid).toBe(false);
    expect(malformedRun.errors.join('\n')).toMatch(/some is not a function|expected_output/);
  });
});

describe('required params table matches handlers', () => {
  for (const [type, fields] of Object.entries(REQUIRED_ACTION_PARAMS)) {
    it(`${type} gate and handler reject the same missing fields`, async () => {
      const action = { type, description: 'incomplete', params: {} };
      const gate = validateQueuedAction(action);
      expect(gate.valid).toBe(false);
      expect(gate.errors[0]).toBe(`missing required field(s): ${fields.join(', ')}`);
      await expect(actionHandlers[type](action, {})).rejects.toThrow(
        `missing required field(s): ${fields.join(', ')}`,
      );
    });
  }
});
