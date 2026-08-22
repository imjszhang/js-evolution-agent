import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionQueue, ExecutionPipeline } from '../src/engine/index.mjs';
import { queueAnalyzeDecideActions } from '../src/intelligence/phase1-shared.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { writeJsonFile } from '../src/infra/files.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { claimEvidenceBatch, ackBatchHandled } from '../src/evolution/reactor/claim-ledger.mjs';
import { compactMemory } from '../src/evolution/reactor/memory-compactor.mjs';
import {
  committedBeliefEffectEvents,
  settleEvidenceWindow,
} from '../src/evolution/settlement-service.mjs';
import { runClosureAudit } from '../src/intelligence/closure-audit.mjs';
import {
  beginExecIntent,
  completeExecIntent,
  markExecIntent,
  readExecIntents,
} from '../src/evolution/reactor/exec-intent-store.mjs';
import {
  readExecResult,
  writeExecResult,
} from '../src/evolution/reactor/exec-result-store.mjs';
import { runVerifyStep } from '../src/evolution/cycle-steps.mjs';

let tempDir = null;
const originalContractMode = process.env.JEA_CONTRACT_MODE;
const originalForceMock = process.env.JEA_FORCE_MOCK;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (originalContractMode === undefined) delete process.env.JEA_CONTRACT_MODE;
  else process.env.JEA_CONTRACT_MODE = originalContractMode;
  if (originalForceMock === undefined) delete process.env.JEA_FORCE_MOCK;
  else process.env.JEA_FORCE_MOCK = originalForceMock;
});

describe('mock causal identity chain', () => {
  it('preserves params.context belief identity for non-agent probes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-probe-identity-'));
    const dataRoot = join(tempDir, 'data');
    const queue = new DecisionQueue({ dataDir: join(dataRoot, 'evolution') });
    const store = createIntelligenceStore({ baseDir: join(dataRoot, 'intelligence') });
    const action = {
      type: 'propose_probe',
      description: 'bounded non-agent probe',
      serves_goal: 'goal-probe',
      params: {
        hypothesis: 'probe context is retained',
        success_signal: 'identity present',
        failure_signal: 'identity missing',
        death_boundary: 'one attempt',
        context: {
          belief_id: 'belief-probe',
          belief_relation: 'test_belief',
          expected_belief_update: 'validate identity propagation',
        },
      },
    };
    const [decisionId] = queue.addDecisionsDetailed({
      cycleId: 'reaction-probe',
      actions: [action],
      metadata: {
        producer_batch_id: 'batch-probe',
        reaction_id: 'reaction-probe',
      },
    }).ids;
    expect(queue.getById(decisionId).metadata.belief_id).toBe('belief-probe');

    const pipeline = new ExecutionPipeline({
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'execution-probe',
      host: {
        actionHandlers: {
          propose_probe: async (executedAction, ctx) => {
            const result = { success: true, status: 'completed' };
            store.recordActionReceipt(executedAction, result, ctx);
            return result;
          },
        },
        logger: { info() {}, warning() {}, warn() {}, error() {} },
      },
    });
    const executed = await pipeline.run();
    expect(executed.executed[0].beliefId).toBe('belief-probe');
    expect(store.readActionReceipts({ limit: 1 })[0].belief_id).toBe('belief-probe');
  });

  it('carries reactor batch identity through verify and belief/goal events', async () => {
    process.env.JEA_CONTRACT_MODE = 'strict';
    process.env.JEA_FORCE_MOCK = '1';
    tempDir = mkdtempSync(join(tmpdir(), 'jea-causal-chain-'));
    mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
    mkdirSync(join(tempDir, 'policies', 'authority'), { recursive: true });
    writeFileSync(
      join(tempDir, 'policies', 'subjects', 'alpha.md'),
      '# alpha\n\n## Subject\nalpha\n',
    );
    writeFileSync(join(tempDir, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n');
    writeFileSync(join(tempDir, 'policies', 'authority', 'GUIDE.md'), '# Guide\n');
    writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
      active: 'alpha',
      policy: 'subjects/alpha.md',
      data_namespace: 'alpha',
    });
    const runtime = runtimeForSubject(tempDir, 'alpha');
    const dataRoot = runtime.dataRoot;
    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    store.recordEvolutionEvent({
      id: 'evt-evidence-production-shape',
      type: 'exec_pipeline',
      status: 'ok',
      cycle_id: 'cycle-before-reaction',
      producer: 'exec',
    });
    const claim = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 10,
    });
    expect(claim.events.map((event) => event.id)).toContain('evt-evidence-production-shape');
    const reportPath = join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', 'reaction-causal.md');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports'), { recursive: true });
    writeFileSync(reportPath, [
      '# Production-shaped mock report',
      '',
      '## Seen',
      '- [evolution_events:evt-evidence-production-shape] execution evidence',
      '',
      '## Inferred',
      '- exercise the belief-bound action',
      '',
    ].join('\n'));
    store.recordIntelReport({
      cycle_id: 'reaction-causal',
      md_path: reportPath,
      producer: 'cognitive',
      producer_batch_id: claim.batch_id,
      reaction_id: 'reaction-causal',
    });
    store.recordCurrentBeliefs({
      schema_version: 1,
      updated_at: new Date().toISOString(),
      beliefs: [{
        id: 'belief-causal',
        goal_id: 'goal-causal',
        claim: 'machine-verifiable execution evidence closes the loop',
        status: 'active',
        confidence: 'medium',
        evidence_refs: ['evolution_events:evt-evidence-production-shape'],
        next_test: 'execute the production-shaped mock action',
      }],
    });
    const queue = new DecisionQueue({ dataDir: join(dataRoot, 'evolution') });
    const action = {
      type: 'agent_run',
      description: 'mock causal action',
      serves_goal: 'goal-causal',
      params: {
        run_spec: {
          permission_profile: 'read_only',
          primary_cwd_kind: 'subject_runtime',
          primary_cwd: runtime.runtimeRoot,
          intent: 'produce machine-verifiable causal evidence',
          expected_output: ['evidence'],
          context: {
            belief_id: 'belief-causal',
            belief_relation: 'test_belief',
            expected_belief_update: 'validate when expected evidence is observed',
          },
        },
      },
    };
    const queued = await queueAnalyzeDecideActions({
      projectRoot: tempDir,
      host: {
        sourceRoot: tempDir,
        runtimeRoot: runtime.runtimeRoot,
        dataRoot,
        logger: { info() {}, warning() {}, warn() {}, error() {} },
      },
      runtime,
      decisionQueue: queue,
      cycleId: 'reaction-causal',
      timestamp: '2026-08-22T00:00:00.000Z',
      analysis: { decision: 'execute', actions: [action] },
      actions: [action],
      pipeline: 'reactor',
      batchId: claim.batch_id,
      beliefDecisionContext: {
        current_beliefs: {
          active: store.readCurrentBeliefs().beliefs,
          validated: [],
          refuted: [],
        },
      },
    });
    expect(
      queued.decisions_queued,
      JSON.stringify(queued.decisions_skipped),
    ).toHaveLength(1);
    const decision = queue.getById(queued.decisions_queued[0]);
    expect(decision.metadata).toMatchObject({
      producer: 'cognitive',
      producer_batch_id: claim.batch_id,
      reaction_id: 'reaction-causal',
      belief_id: 'belief-causal',
    });

    const pipeline = new ExecutionPipeline({
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'execution-causal',
      host: {
        actionHandlers: {
          agent_run: async (executedAction, ctx) => {
            const result = {
              success: true,
              status: 'completed',
              evidence: [{ ref: 'probe:production-shape' }],
            };
            store.recordActionReceipt(executedAction, result, ctx);
            return result;
          },
        },
        logger: { info() {}, warning() {}, warn() {}, error() {} },
      },
      onBeforeExecute: (claimed) => {
        const intent = beginExecIntent(dataRoot, {
          executionId: 'execution-causal',
          decisionId: claimed.id,
          action: claimed.action,
          causalIdentity: claimed.metadata,
        });
        markExecIntent(dataRoot, intent.id, { status: 'executing' });
        return { intent };
      },
      onAfterExecute: (_claimed, _result, lifecycle) => {
        completeExecIntent(dataRoot, lifecycle.intent.id);
      },
    });
    const executed = await pipeline.run();
    const execResult = writeExecResult(dataRoot, 'execution-causal', executed);
    const receipt = store.readActionReceipts({ limit: 10 })[0];
    const intent = readExecIntents(dataRoot).intents[0];
    for (const artifact of [intent, receipt, execResult]) {
      expect(artifact).toMatchObject({
        producer_batch_id: claim.batch_id,
        reaction_id: 'reaction-causal',
        decision_id: decision.id,
        execution_id: 'execution-causal',
        belief_id: 'belief-causal',
      });
    }

    const verify = await runVerifyStep({
      projectRoot: tempDir,
      cfg: {
        aiClient: null,
        host: { logger: { info() {}, warning() {}, warn() {}, error() {} } },
      },
      runtime,
      store,
    }, {
      intelResult: { cycle_id: 'reaction-causal' },
      execResult,
    });
    const report = JSON.parse(readFileSync(verify.reportPath, 'utf-8'));
    expect(report).toMatchObject({
      producer: 'verify',
      producer_batch_id: claim.batch_id,
      reaction_id: 'reaction-causal',
      decision_id: decision.id,
      execution_id: 'execution-causal',
      belief_id: 'belief-causal',
    });
    expect(report.decision_ids).toEqual([decision.id]);
    expect(readExecResult(dataRoot, 'execution-causal').decision_ids).toEqual([decision.id]);

    const identity = {
      producer_batch_id: report.producer_batch_id,
      reaction_id: report.reaction_id,
      decision_id: report.decision_id,
      execution_id: report.execution_id,
    };

    const settlementHandlers = {
      belief: async ({ settlement, receipts, verification }) => {
        const evidenceRefs = [
          ...receipts.map((item) => `action_receipt:${item.id}`),
          `verify_report:${verification.execution_id}`,
        ];
        const currentBeliefs = {
          schema_version: 1,
          updated_at: new Date().toISOString(),
          beliefs: [{
            id: 'belief-causal',
            goal_id: 'goal-causal',
            claim: 'production-shaped mock closes the expected-output loop',
            status: 'validated',
            confidence: 'high',
            evidence_refs: evidenceRefs,
            next_test: 'repeat without duplicate side effects',
          }],
        };
        const event = {
          belief_id: 'belief-causal',
          change: 'validate',
          evidence_refs: evidenceRefs,
          after: currentBeliefs.beliefs[0],
          settlement_id: settlement.settlement_id,
          settlement_effect: 'belief',
          ...identity,
        };
        store.commitBeliefEffect({
          settlement,
          prepare: () => ({
            currentBeliefs,
            events: [event],
            effectResult: {
              source: 'mock',
              result: { status: 'updated', updates: [{ belief_id: 'belief-causal' }] },
            },
          }),
        });
        return {
          beliefUpdateResult: {
            result: { status: 'updated', updates: [{ belief_id: 'belief-causal' }] },
            eventsWritten: 1,
          },
        };
      },
      goalAssess: async ({ settlement }) => {
        const event = {
          type: 'settled',
          goal_id: 'goal-causal',
          cycle_id: 'reaction-causal',
          settlement_id: settlement.settlement_id,
          settlement_effect: 'goal_assess',
          ...identity,
        };
        store.recordGoalEvent(event);
        return {
          goalsAssessResult: {
            assessment: { status: 'keep', evidence_refs: settlement.evidence_refs },
            event,
          },
        };
      },
      goalCalibrate: async () => ({
        goalsCalibrateResult: { status: 'skipped', reason: 'already_aligned' },
      }),
    };
    const settlementArgs = {
      intelResult: { cycle_id: 'reaction-causal' },
      execResult,
      verification: report,
      reportPath: verify.reportPath,
      receipts: [receipt],
      handlers: settlementHandlers,
    };
    const settled = await settleEvidenceWindow({
      runtime,
      store,
    }, settlementArgs);
    const retriedSettlement = await settleEvidenceWindow({
      runtime,
      store,
    }, settlementArgs);
    expect(report.comparison.status).toBe('matched');
    expect(retriedSettlement).toMatchObject({
      settlement_id: settled.settlement_id,
      reused: true,
    });
    expect(committedBeliefEffectEvents(
      store.readBeliefEvents({ limit: null }),
      settled.settlement_id,
    )).toHaveLength(1);
    expect(store.readGoalEvents({ limit: 50 }).filter((event) => (
      event.settlement_id === settled.settlement_id
    ))).toHaveLength(1);

    ackBatchHandled(dataRoot, claim.batch_id);
    const memory = await compactMemory({
      root: tempDir,
      subject: 'alpha',
      input: { force: true },
      runCompaction: async (_ctx, { consolidation, onEffect }) => {
        const standing = {
          updated_at: consolidation.freshness.consolidated_at,
          last_settled_cursor: consolidation.last_settled_cursor,
          freshness: consolidation.freshness,
          current_state: ['belief-causal validated'],
        };
        writeJsonFile(
          join(dataRoot, 'intelligence', 'memory', 'standing_memory.json'),
          standing,
        );
        await onEffect('memory', { status: 'updated' });
        await onEffect('diary', { source: 'mock' });
        return { memory: { status: 'updated' }, diary: { source: 'mock' } };
      },
    });
    expect(memory).toMatchObject({
      skipped: false,
      settled_beliefs: 1,
    });
    const duplicateMemory = await compactMemory({
      root: tempDir,
      subject: 'alpha',
      input: { force: true },
      runCompaction: async () => {
        throw new Error('duplicate memory compaction must not execute');
      },
    });
    expect(duplicateMemory).toMatchObject({
      skipped: true,
      reason: 'no_unconsolidated_settled_beliefs',
    });

    const audit = runClosureAudit({
      root: tempDir,
      subject: 'alpha',
      namespace: 'alpha',
      runtimeRoot: runtime.runtimeRoot,
      dataRoot,
    });
    expect(audit.metrics.decision_coverage).toMatchObject({
      belief_binding: { bound: 1, legacy_unknown: 0 },
      expected_output: { covered: 1, legacy_unknown: 0 },
    });
    expect(audit.metrics.causal_correlation.decisions.reopenable).toBe(1);
    expect(audit.metrics.causal_correlation.receipts.reopenable).toBe(1);
    expect(
      audit.metrics.causal_correlation.verify_reports.reopenable,
      JSON.stringify(audit.metrics.causal_correlation.verify_reports),
    ).toBe(1);
    expect(audit.metrics.causal_correlation.settlement_events).toMatchObject({
      total: 2,
      reopenable: 2,
      partial: 0,
      legacy_unknown: 0,
    });
    expect(audit.metrics.duplicate_settlement_candidates.duplicate_event_count).toBe(0);
    expect(audit.metrics.standing_memory_freshness).toMatchObject({
      status: 'fresh',
      cursor_status: 'current',
    });
  });
});
