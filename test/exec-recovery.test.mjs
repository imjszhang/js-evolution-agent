import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionQueue, ExecutionPipeline } from '../src/engine/index.mjs';
import { beginExecIntent, markExecIntent, readExecIntents, recoverOpenExecIntents } from '../src/evolution/reactor/exec-intent-store.mjs';
import {
  claimPendingVerifyResult,
  completeVerifyResult,
  execResultFromReceipts,
  execResultQueuePath,
  latestExecResultPointerPath,
  listPendingVerifyResults,
  readExecResult,
  writeExecResult,
} from '../src/evolution/reactor/exec-result-store.mjs';
let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  delete process.env.JEA_EXEC_RATE_ONLY;
});

function agentAction(summary) {
  return {
    type: 'agent_run',
    description: summary,
    max_attempts: 2,
    params: {
      run_spec: {
        permission_profile: 'read_only',
        primary_cwd_kind: 'subject_runtime',
        intent: summary,
        context: { note: summary },
        expected_output: { summary: 'ok' },
      },
    },
  };
}

describe('per-cycle agent budget gate', () => {
  it('keeps the cycle budget even when legacy rate-only env is set', async () => {
    process.env.JEA_EXEC_RATE_ONLY = '1';
    tempDir = mkdtempSync(join(tmpdir(), 'jea-rate-only-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-rate',
      actions: [agentAction('a1'), agentAction('a2'), agentAction('a3')],
    });
    const executed = [];
    const pipeline = new ExecutionPipeline({
      projectRoot: tempDir,
      decisionQueue: queue,
      agentBudget: 1,
      agentConcurrency: 1,
      host: {
        actionHandlers: {
          agent_run: async (action) => {
            executed.push(action.description);
            return { success: true };
          },
        },
        logger: { info() {}, warning() {}, error() {} },
      },
    });
    const result = await pipeline.run({ agentBudget: 1 });
    expect(result).not.toHaveProperty('rate_only');
    expect(result.agent_budget).toBe(1);
    expect(result.remaining_agent_pending).toBe(2);
    expect(executed.length).toBe(1);
  });
});

describe('durable intent lifecycle in ExecutionPipeline', () => {
  it('writes intent before the real executor runs', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-life-'));
    mkdirSync(join(tempDir, 'data'), { recursive: true });
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-life',
      actions: [{ type: 'record_observation', description: 'life', params: { content: 'x' } }],
    });
    const seen = [];
    const pipeline = new ExecutionPipeline({
      projectRoot: tempDir,
      decisionQueue: queue,
      host: {
        actionHandlers: {
          record_observation: async (_action, ctx) => {
            seen.push(ctx.intentId);
            return { success: true };
          },
        },
        logger: { info() {}, warning() {}, error() {} },
      },
      onBeforeExecute: (decision) => {
        const intent = beginExecIntent(join(tempDir, 'data'), {
          executionId: 'exec-life',
          decisionId: decision.id,
          action: decision.action,
        });
        markExecIntent(join(tempDir, 'data'), intent.id, { status: 'executing' });
        return { intent };
      },
    });
    await pipeline.run({ agentBudget: 1 });
    expect(seen[0]).toMatch(/^intent-/);
  });

  it('does not mint a new intent for an uncertain key', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-uncertain-key-'));
    const dataRoot = join(tempDir, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const first = beginExecIntent(dataRoot, {
      executionId: 'exec-u',
      decisionId: 'd-u',
      action: { type: 'record_observation' },
    });
    markExecIntent(dataRoot, first.id, { status: 'uncertain', error: 'side_effect_uncertain' });
    const second = beginExecIntent(dataRoot, {
      executionId: 'exec-u',
      decisionId: 'd-u',
      action: { type: 'record_observation' },
    });
    expect(second.id).toBe(first.id);
    expect(second.blocked).toBe(true);
    expect(second.status).toBe('uncertain');
    expect(readExecIntents(dataRoot).intents.filter((item) => item.key === first.key)).toHaveLength(1);
  });

  it('does not replay uncertain intents', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-uncertain-'));
    const dataRoot = join(tempDir, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const intent = beginExecIntent(dataRoot, {
      executionId: 'exec-u',
      decisionId: 'd-u',
      action: { type: 'record_observation' },
    });
    markExecIntent(dataRoot, intent.id, { status: 'executing' });
    const blocked = [];
    const recovery = recoverOpenExecIntents(dataRoot, {
      store: { readActionReceipts: () => [] },
      decisionQueue: {
        updateStatus(id, status) { blocked.push({ id, status }); },
      },
    });
    expect(recovery.uncertain).toHaveLength(1);
    expect(blocked[0]).toEqual({ id: 'd-u', status: 'blocked' });
  });

  it('releases prepared intents because no side effect started', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-prepared-'));
    const dataRoot = join(tempDir, 'data');
    mkdirSync(dataRoot, { recursive: true });
    beginExecIntent(dataRoot, {
      executionId: 'exec-p',
      decisionId: 'd-p',
      action: { type: 'record_observation' },
    });
    const statuses = [];
    const recovery = recoverOpenExecIntents(dataRoot, {
      store: { readActionReceipts: () => [] },
      decisionQueue: {
        updateStatus(id, status) { statuses.push({ id, status }); },
      },
    });
    expect(recovery.retryable).toHaveLength(1);
    expect(statuses).toEqual([{ id: 'd-p', status: 'pending' }]);
  });

  it('completes an executing intent when its receipt already exists', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-receipt-'));
    const dataRoot = join(tempDir, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const intent = beginExecIntent(dataRoot, {
      executionId: 'exec-r',
      decisionId: 'd-r',
      action: { type: 'record_observation' },
    });
    markExecIntent(dataRoot, intent.id, { status: 'executing' });
    const completed = [];
    const recovery = recoverOpenExecIntents(dataRoot, {
      store: {
        readActionReceipts: () => [{
          id: 'receipt-r',
          decision_id: 'd-r',
          exec_cycle_id: 'exec-r',
        }],
      },
      decisionQueue: {
        completeDecision(id) { completed.push(id); },
      },
    });
    expect(recovery.recovered).toHaveLength(1);
    expect(completed).toEqual(['d-r']);
  });

  it('reuses the original key only for explicitly idempotent actions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-idempotent-'));
    const dataRoot = join(tempDir, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const intent = beginExecIntent(dataRoot, {
      executionId: 'exec-i',
      decisionId: 'd-i',
      attempt: 2,
      action: { type: 'safe_action' },
      causalIdentity: {
        producer_batch_id: 'batch-origin',
        reaction_id: 'reaction-origin',
        belief_id: 'belief-origin',
      },
    });
    markExecIntent(dataRoot, intent.id, { status: 'executing' });
    const statuses = [];
    const recovery = recoverOpenExecIntents(dataRoot, {
      store: { readActionReceipts: () => [] },
      decisionQueue: {
        updateStatus(id, status) { statuses.push({ id, status }); },
      },
      recoveryPolicies: {
        safe_action: { idempotent: true },
      },
    });
    expect(recovery.retryable[0].key).toBe('d-i#2');
    expect(recovery.retryable[0]).toMatchObject({
      decision_id: 'd-i',
      execution_id: 'exec-i',
      producer_batch_id: 'batch-origin',
      reaction_id: 'reaction-origin',
      belief_id: 'belief-origin',
    });
    const resumed = beginExecIntent(dataRoot, {
      executionId: 'exec-next-worker',
      decisionId: 'd-i',
      attempt: 2,
      action: { type: 'safe_action' },
      causalIdentity: {
        producer_batch_id: 'batch-other',
        reaction_id: 'reaction-other',
      },
    });
    expect(resumed).toMatchObject({
      id: intent.id,
      execution_id: 'exec-i',
      producer_batch_id: 'batch-origin',
      reaction_id: 'reaction-origin',
      belief_id: 'belief-origin',
    });
    expect(statuses).toEqual([{ id: 'd-i', status: 'pending' }]);
  });
});

describe('durable verify crash recovery', () => {
  it.each([
    ['exec_result_after_result', false, false],
    ['exec_result_after_latest', true, false],
    ['exec_result_after_queue', true, true],
  ])('recovers result/latest/queue persistence after %s', (boundary, hasLatest, hasQueueEntry) => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-result-three-write-'));
    const dataRoot = join(tempDir, 'data');
    expect(() => writeExecResult(dataRoot, `exec-${boundary}`, {
      executed: [{
        id: 'd1',
        action: { type: 'record_observation' },
        result: { success: true },
      }],
    }, {
      faultInjector: (point) => {
        if (point === boundary) throw new Error(`injected:${boundary}`);
      },
    })).toThrow(`injected:${boundary}`);

    expect(readExecResult(dataRoot, `exec-${boundary}`)).not.toBeNull();
    expect(existsSync(latestExecResultPointerPath(dataRoot))).toBe(hasLatest);
    const queueBeforeRecovery = existsSync(execResultQueuePath(dataRoot))
      ? JSON.parse(readFileSync(execResultQueuePath(dataRoot), 'utf8'))
      : { items: [] };
    expect(queueBeforeRecovery.items.some((item) => item.execution_id === `exec-${boundary}`))
      .toBe(hasQueueEntry);
    expect(listPendingVerifyResults(dataRoot).map((item) => item.execution_id))
      .toContain(`exec-${boundary}`);
    const queueAfterRecovery = JSON.parse(readFileSync(execResultQueuePath(dataRoot), 'utf8'));
    expect(queueAfterRecovery.items.filter((item) => (
      item.execution_id === `exec-${boundary}`
    ))).toHaveLength(1);
  });

  it('keeps a written exec result pending until verify claims it', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-result-pending-'));
    const dataRoot = join(tempDir, 'data');
    writeExecResult(dataRoot, 'exec-result', {
      executed: [{ id: 'd1', action: { type: 'record_observation' }, result: { success: true } }],
    });
    expect(listPendingVerifyResults(dataRoot).map((item) => item.execution_id))
      .toEqual(['exec-result']);
  });

  it('finishes a crashed verifying claim from an existing report', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-verify-report-'));
    const dataRoot = join(tempDir, 'data');
    writeExecResult(dataRoot, 'exec-verified', {
      executed: [{ id: 'd1', action: { type: 'record_observation' }, result: { success: true } }],
    });
    expect(claimPendingVerifyResult(dataRoot).execution_id).toBe('exec-verified');
    const reportDir = join(dataRoot, 'evolution', 'verify_reports');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'exec-verified.json'), JSON.stringify({
      execution_id: 'exec-verified',
      verified: [],
      pending: [],
    }));

    expect(claimPendingVerifyResult(dataRoot).skipped).toBe('no_pending_verify');
    expect(readExecResult(dataRoot, 'exec-verified').verify_status).toBe('verified');
  });

  it('recovers a written receipt when exec result was never persisted', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-receipt-only-'));
    const dataRoot = join(tempDir, 'data');
    mkdirSync(dataRoot, { recursive: true });
    const recovered = execResultFromReceipts([{
      id: 'receipt-late',
      decision_id: 'd-late',
      exec_cycle_id: 'exec-late',
      action: { type: 'record_observation' },
      result: { success: true },
    }], 'exec-late');
    expect(recovered.executed).toHaveLength(1);
    writeExecResult(dataRoot, 'exec-late', recovered);
    expect(listPendingVerifyResults(dataRoot).map((item) => item.execution_id))
      .toEqual(['exec-late']);
  });

  it('retries a verify_failed result until the attempt cap', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-verify-retry-'));
    const dataRoot = join(tempDir, 'data');
    writeExecResult(dataRoot, 'exec-retry', {
      executed: [{ id: 'd1', action: { type: 'record_observation' }, result: { success: true } }],
    });
    expect(claimPendingVerifyResult(dataRoot).execution_id).toBe('exec-retry');
    completeVerifyResult(dataRoot, 'exec-retry', { status: 'verify_failed', error: 'boom' });
    expect(readExecResult(dataRoot, 'exec-retry').verify_status).toBe('verify_failed');
    expect(claimPendingVerifyResult(dataRoot).execution_id).toBe('exec-retry');
  });
});
