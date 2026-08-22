import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DecisionQueue,
  ExecutionPipeline,
} from '../src/engine/index.mjs';
import {
  classifyAgentRunScope,
  computeAgentWaveWidth,
  isExclusiveAgentDecision,
} from '../src/engine/act/scope.mjs';

function agentAction(profile, summary) {
  return {
    type: 'agent_run',
    description: summary,
    max_attempts: 2,
    params: {
      run_spec: {
        permission_profile: profile,
        primary_cwd_kind: 'subject_runtime',
        intent: summary,
        context: { note: summary },
        expected_output: { summary: 'ok' },
      },
    },
  };
}

describe('agent run scope', () => {
  it('classifies read_only as parallel and write profiles as exclusive', () => {
    expect(classifyAgentRunScope({
      action: agentAction('read_only', 'r'),
    })).toMatchObject({ exclusive: false, parallel: true, profile: 'read_only' });
    expect(isExclusiveAgentDecision({
      action: agentAction('workspace_write', 'w'),
    })).toBe(true);
    expect(isExclusiveAgentDecision({
      action: { type: 'agent_run', params: {} },
    })).toBe(true);
  });

  it('computeAgentWaveWidth collapses on exclusive and backpressure', () => {
    const reads = [
      { id: 'c:0', action: agentAction('read_only', 'a') },
      { id: 'c:1', action: agentAction('read_only', 'b') },
      { id: 'c:2', action: agentAction('workspace_write', 'w') },
    ];
    expect(computeAgentWaveWidth({ pendingAgents: reads, cap: 3 }).width).toBe(2);

    const writeFirst = [
      { id: 'c:0', action: agentAction('workspace_write', 'w') },
      { id: 'c:1', action: agentAction('read_only', 'a') },
    ];
    expect(computeAgentWaveWidth({ pendingAgents: writeFirst, cap: 3 })).toMatchObject({
      width: 1,
      exclusive: true,
    });

    expect(computeAgentWaveWidth({
      pendingAgents: reads,
      cap: 4,
      lastWaveHadFailure: true,
    }).width).toBe(2); // min(4, 2 demand, floor(4/2)=2)

    expect(computeAgentWaveWidth({
      pendingAgents: reads,
      cap: 4,
      blockedThisCycle: 3,
    }).width).toBe(1);
  });
});

describe('ExecutionPipeline dual-channel', () => {
  let tempDir;
  const prevRateOnly = process.env.JEA_EXEC_RATE_ONLY;

  beforeEach(() => {
    process.env.JEA_EXEC_RATE_ONLY = '0';
  });

  afterEach(() => {
    if (prevRateOnly === undefined) delete process.env.JEA_EXEC_RATE_ONLY;
    else process.env.JEA_EXEC_RATE_ONLY = prevRateOnly;
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  it('runs mechanical actions before agent_run and respects agent budget', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-dual-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-dual',
      actions: [
        { type: 'record_observation', description: 'm1', params: { summary: 'm1' } },
        { type: 'record_observation', description: 'm2', params: { summary: 'm2' } },
        agentAction('read_only', 'a1'),
        agentAction('read_only', 'a2'),
        agentAction('read_only', 'a3'),
      ],
    });

    const order = [];
    const host = {
      basePath: tempDir,
      actionHandlers: {
        record_observation: async (action) => {
          order.push(`mech:${action.description}`);
          return { success: true, status: 'completed', message: 'ok' };
        },
        agent_run: async (action) => {
          order.push(`agent:${action.description}`);
          return { success: true, status: 'completed', message: 'ok' };
        },
      },
    };

    const pipeline = new ExecutionPipeline({
      host,
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-dual',
      agentBudget: 2,
      agentConcurrency: 1,
    });
    const result = await pipeline.run();
    expect(result.success).toBe(true);
    expect(result.mechanical.claimed).toBe(2);
    expect(result.agent_waves.length).toBe(2);
    expect(result.remaining_agent_pending).toBe(1);
    expect(order.slice(0, 2)).toEqual(['mech:m1', 'mech:m2']);
    expect(order.filter((x) => x.startsWith('agent:'))).toHaveLength(2);
    expect(queue.getPending().filter((d) => d.action?.type === 'agent_run')).toHaveLength(1);
  });

  it('failOrBlock retries agent_run then blocks', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-dual-fail-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-fail',
      actions: [agentAction('read_only', 'boom')],
    });
    const host = {
      basePath: tempDir,
      actionHandlers: {
        agent_run: async () => ({ success: false, error: 'nope' }),
      },
    };
    const pipeline = new ExecutionPipeline({
      host,
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-fail',
      agentBudget: 5,
      agentConcurrency: 1,
    });
    // first attempt → pending
    let result = await pipeline.run();
    expect(result.success).toBe(true);
    const id = result.executed[0].id;
    expect(queue.getById(id)?.status).toBe('pending');
    expect(queue.getById(id)?.attempts).toBe(1);

    // second attempt → blocked
    result = await pipeline.run();
    expect(queue.getById(id)?.status).toBe('blocked');
    expect(queue.getById(id)?.attempts).toBe(2);
  });

  it('runs parallel read_only agent_run waves when concurrency > 1', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-dual-par-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-par',
      actions: [
        agentAction('read_only', 'p1'),
        agentAction('read_only', 'p2'),
        agentAction('workspace_write', 'w1'),
      ],
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const host = {
      basePath: tempDir,
      actionHandlers: {
        agent_run: async (action) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight -= 1;
          return { success: true, message: action.description };
        },
      },
    };
    const events = [];
    const pipeline = new ExecutionPipeline({
      host,
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-par',
      agentBudget: 8,
      agentConcurrency: 2,
      emitEvent: (e) => events.push(e),
    });
    const result = await pipeline.run();
    expect(result.success).toBe(true);
    expect(result.executed).toHaveLength(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(result.agent_waves[0].width).toBe(2);
    expect(result.agent_waves.some((w) => w.width === 1)).toBe(true);
    expect(events.some((e) => e.type === 'exec_wave')).toBe(true);
  });
});
