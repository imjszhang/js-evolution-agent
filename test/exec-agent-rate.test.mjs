import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentRateLedger,
  DecisionQueue,
  ExecutionPipeline,
  agentRateLedgerPath,
  parseExecAgentRateFromEnv,
} from '../src/engine/index.mjs';
import { validateAgentRateLedger } from '../src/contracts/index.mjs';

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

function makeHost(order = []) {
  return {
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
}

describe('parseExecAgentRateFromEnv', () => {
  afterEach(() => {
    delete process.env.JEA_EXEC_AGENT_RATE;
    delete process.env.JEA_EXEC_AGENT_RATE_WINDOW_MS;
  });

  it('returns null when unset', () => {
    delete process.env.JEA_EXEC_AGENT_RATE;
    expect(parseExecAgentRateFromEnv()).toBeNull();
  });

  it('parses limit and optional window', () => {
    process.env.JEA_EXEC_AGENT_RATE = '12';
    process.env.JEA_EXEC_AGENT_RATE_WINDOW_MS = '60000';
    expect(parseExecAgentRateFromEnv()).toEqual({ limit: 12, windowMs: 60_000 });
  });
});

describe('AgentRateLedger', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tempDir = null;
    }
  });

  it('prunes expired entries and recovers from corrupt files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-ledger-'));
    const filePath = join(tempDir, 'agent-rate-ledger.json');
    let now = 1_000_000;
    const ledger = new AgentRateLedger({
      filePath,
      limit: 3,
      windowMs: 1000,
      now: () => now,
    });
    ledger.record([{ id: 'a' }, { id: 'b' }], { cycleId: 'c1' });
    expect(ledger.remaining()).toBe(1);

    now = 1_000_000 + 1001;
    expect(ledger.remaining()).toBe(3);

    writeFileSync(filePath, '{not-json', 'utf-8');
    const warnings = [];
    const recovered = new AgentRateLedger({
      filePath,
      limit: 2,
      windowMs: 1000,
      now: () => now,
      logFn: (m) => warnings.push(m),
    });
    expect(recovered.remaining()).toBe(2);
    expect(warnings.some((m) => /resetting|failed to read/.test(m))).toBe(true);
    expect(validateAgentRateLedger(recovered.toJSON()).ok).toBe(true);
  });
});

describe('ExecutionPipeline agent rate gate', () => {
  let tempDir;
  const prevRate = process.env.JEA_EXEC_AGENT_RATE;
  const prevWindow = process.env.JEA_EXEC_AGENT_RATE_WINDOW_MS;

  afterEach(() => {
    if (prevRate === undefined) delete process.env.JEA_EXEC_AGENT_RATE;
    else process.env.JEA_EXEC_AGENT_RATE = prevRate;
    if (prevWindow === undefined) delete process.env.JEA_EXEC_AGENT_RATE_WINDOW_MS;
    else process.env.JEA_EXEC_AGENT_RATE_WINDOW_MS = prevWindow;
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      tempDir = null;
    }
  });

  it('leaves agent_rate null when no ledger (zero behavior change)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-off-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-off',
      actions: [
        agentAction('read_only', 'a1'),
        agentAction('read_only', 'a2'),
        agentAction('read_only', 'a3'),
      ],
    });
    const order = [];
    const pipeline = new ExecutionPipeline({
      host: makeHost(order),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-off',
      agentBudget: 2,
      agentConcurrency: 1,
    });
    const result = await pipeline.run();
    expect(result.success).toBe(true);
    expect(result.agent_rate).toBeNull();
    expect(result.remaining_agent_pending).toBe(1);
    expect(order.filter((x) => x.startsWith('agent:'))).toHaveLength(2);
  });

  it('rate=2 with 5 pending agents and budget=8 executes only 2', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-limit-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-rate',
      actions: [
        agentAction('read_only', 'a1'),
        agentAction('read_only', 'a2'),
        agentAction('read_only', 'a3'),
        agentAction('read_only', 'a4'),
        agentAction('read_only', 'a5'),
      ],
    });
    const order = [];
    const ledger = new AgentRateLedger({
      filePath: agentRateLedgerPath(tempDir),
      limit: 2,
      windowMs: 60_000,
    });
    const pipeline = new ExecutionPipeline({
      host: makeHost(order),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-rate',
      agentBudget: 8,
      agentConcurrency: 1,
      agentRateLedger: ledger,
    });
    const result = await pipeline.run();
    expect(result.success).toBe(true);
    expect(result.agent_rate).toMatchObject({
      limit: 2,
      window_ms: 60_000,
      used_in_window: 2,
      rate_limited: true,
    });
    expect(order.filter((x) => x.startsWith('agent:'))).toHaveLength(2);
    expect(result.remaining_agent_pending).toBe(3);
    expect(validateAgentRateLedger(ledger.toJSON()).ok).toBe(true);
  });

  it('persists across pipeline restart', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-persist-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-p1',
      actions: [
        agentAction('read_only', 'a1'),
        agentAction('read_only', 'a2'),
        agentAction('read_only', 'a3'),
      ],
    });
    const filePath = agentRateLedgerPath(tempDir);
    const ledger1 = new AgentRateLedger({ filePath, limit: 2, windowMs: 60_000 });
    const r1 = await new ExecutionPipeline({
      host: makeHost(),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-p1',
      agentBudget: 8,
      agentConcurrency: 1,
      agentRateLedger: ledger1,
    }).run();
    expect(r1.agent_rate.used_in_window).toBe(2);
    expect(r1.remaining_agent_pending).toBe(1);

    const ledger2 = new AgentRateLedger({ filePath, limit: 2, windowMs: 60_000 });
    expect(ledger2.remaining()).toBe(0);
    const r2 = await new ExecutionPipeline({
      host: makeHost(),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-p2',
      agentBudget: 8,
      agentConcurrency: 1,
      agentRateLedger: ledger2,
    }).run();
    expect(r2.agent_rate.rate_limited).toBe(true);
    expect(r2.executed.filter((e) => e.action?.type === 'agent_run')).toHaveLength(0);
    expect(r2.remaining_agent_pending).toBe(1);
  });

  it('recovers capacity after window slides', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-slide-'));
    const filePath = agentRateLedgerPath(tempDir);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: [
        { ts: 1, cycle_id: 'old', decision_id: 'd1' },
        { ts: 2, cycle_id: 'old', decision_id: 'd2' },
      ],
    }, null, 2), 'utf-8');

    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-slide',
      actions: [agentAction('read_only', 'fresh')],
    });
    const ledger = new AgentRateLedger({
      filePath,
      limit: 2,
      windowMs: 1000,
      now: () => 10_000,
    });
    expect(ledger.remaining()).toBe(2);
    const result = await new ExecutionPipeline({
      host: makeHost(),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-slide',
      agentBudget: 8,
      agentConcurrency: 1,
      agentRateLedger: ledger,
    }).run();
    expect(result.executed).toHaveLength(1);
    expect(result.agent_rate.used_in_window).toBe(1);
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0].decision_id).toBeTruthy();
  });

  it('caps wave width by remaining rate independently of concurrency', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-width-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-width',
      actions: [
        agentAction('read_only', 'p1'),
        agentAction('read_only', 'p2'),
        agentAction('read_only', 'p3'),
      ],
    });
    const ledger = new AgentRateLedger({
      filePath: agentRateLedgerPath(tempDir),
      limit: 1,
      windowMs: 60_000,
    });
    const result = await new ExecutionPipeline({
      host: makeHost(),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-width',
      agentBudget: 8,
      agentConcurrency: 3,
      agentRateLedger: ledger,
    }).run();
    expect(result.agent_waves).toHaveLength(1);
    expect(result.agent_waves[0].width).toBe(1);
    expect(result.remaining_agent_pending).toBe(2);
    expect(result.agent_rate.rate_limited).toBe(true);
  });

  it('does not rate-limit mechanical channel when agent rate is exhausted', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-mech-'));
    const filePath = agentRateLedgerPath(tempDir);
    const seeded = new AgentRateLedger({ filePath, limit: 1, windowMs: 60_000 });
    seeded.record([{ id: 'seed' }], { cycleId: 'seed' });
    expect(seeded.remaining()).toBe(0);

    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-mech',
      actions: [
        { type: 'record_observation', description: 'm1', params: { summary: 'm1' } },
        { type: 'record_observation', description: 'm2', params: { summary: 'm2' } },
        agentAction('read_only', 'blocked-by-rate'),
      ],
    });
    const order = [];
    const ledger = new AgentRateLedger({ filePath, limit: 1, windowMs: 60_000 });
    const result = await new ExecutionPipeline({
      host: makeHost(order),
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-mech',
      agentBudget: 8,
      agentConcurrency: 1,
      agentRateLedger: ledger,
    }).run();
    expect(result.mechanical.executed).toBe(2);
    expect(order.filter((x) => x.startsWith('mech:'))).toEqual(['mech:m1', 'mech:m2']);
    expect(order.filter((x) => x.startsWith('agent:'))).toHaveLength(0);
    expect(result.agent_rate.rate_limited).toBe(true);
    expect(result.remaining_agent_pending).toBe(1);
  });
});
