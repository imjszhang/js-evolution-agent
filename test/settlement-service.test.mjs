import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSettlementIdentity,
  committedBeliefEffectEvents,
  readSettlement,
  selectMechanicalBeliefBootstrap,
  settleEvidenceWindow,
  settlementLedgerPath,
  settlementWindowsFromEvents,
} from '../src/evolution/settlement-service.mjs';
import { shouldRunRuleReaction } from '../src/evolution/reactor/rule-reactor.mjs';
import { updateBeliefsWithAi } from '../src/intelligence/belief-updater.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function fixture() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-settlement-'));
  const dataRoot = join(tempDir, 'data');
  const receipts = [{
    id: 'receipt-target',
    execution_id: 'exec-1',
    result: { status: 'ok' },
  }, {
    id: 'receipt-unrelated',
    execution_id: 'exec-other',
    result: { status: 'failed' },
  }];
  const store = {
    readActionReceipts: () => receipts,
    readBeliefEvents: () => [],
    readGoalEvents: () => [],
  };
  return {
    dataRoot,
    ctx: {
      runtime: { dataRoot, runtimeRoot: tempDir },
      store,
    },
    receipts,
    args: {
      intelResult: { cycle_id: 'reaction-1' },
      execResult: { execution_id: 'exec-1', cycle_id: 'exec-1' },
      verification: { execution_id: 'exec-1' },
      reportPath: join(dataRoot, 'evolution', 'verify_reports', 'exec-1.json'),
      intelReportReady: true,
    },
  };
}

function successfulHandlers(calls = {}) {
  return {
    belief: async ({ receipts, settlement }) => {
      calls.belief = (calls.belief ?? 0) + 1;
      calls.receipts = receipts;
      calls.refs = settlement.evidence_refs;
      return { beliefUpdateResult: { result: { status: 'updated' } } };
    },
    goalAssess: async () => {
      calls.goalAssess = (calls.goalAssess ?? 0) + 1;
      return {
        goalsAssessResult: {
          assessment: { status: 'keep', evidence_refs: [] },
          event: { cycle_id: 'reaction-1' },
        },
      };
    },
    goalCalibrate: async () => {
      calls.goalCalibrate = (calls.goalCalibrate ?? 0) + 1;
      return { goalsCalibrateResult: { status: 'skipped', reason: 'not_actionable' } };
    },
  };
}

describe('shared settlement service', () => {
  it.each([
    ['matched', true, true, true],
    ['uncertain', true, true, false],
    ['not_observed', true, true, false],
    ['contradicted', true, true, false],
    ['matched', false, true, false],
    ['matched', true, false, false],
  ])(
    'selects bootstrap only for matched successful evidence (%s, receipt=%s, comparison=%s)',
    (status, receiptSuccess, executionSuccess, selected) => {
      const action = {
        type: 'agent_run',
        serves_goal: 'goal-bootstrap',
        params: {
          run_spec: {
            context: {
              belief_id: 'belief-bootstrap',
              belief_relation: 'create_belief',
              expected_belief_claim: 'bootstrap evidence is reproducible',
              expected_belief_update: 'retest independently',
            },
          },
        },
      };
      const receipts = [{
        id: 'receipt-bootstrap',
        decision_id: 'decision-bootstrap',
        action,
        result: { success: receiptSuccess },
      }];
      const verification = {
        comparison: {
          actions: [{
            action_index: 0,
            decision_id: 'decision-bootstrap',
            belief_id: 'belief-bootstrap',
            belief_relation: 'create_belief',
            execution_success: executionSuccess,
            status,
          }],
        },
      };

      const candidate = selectMechanicalBeliefBootstrap(receipts, verification);
      if (selected) {
        expect(candidate).toMatchObject({
          belief_id: 'belief-bootstrap',
          claim: 'bootstrap evidence is reproducible',
        });
      } else {
        expect(candidate).toBeNull();
      }
    },
  );

  it('does not delegate an unmatched bootstrap to the model belief updater', async () => {
    const { ctx, args } = fixture();
    const action = {
      type: 'agent_run',
      serves_goal: 'goal-bootstrap',
      params: {
        run_spec: {
          context: {
            belief_id: 'belief-bootstrap',
            belief_relation: 'create_belief',
            expected_belief_claim: 'bootstrap evidence is reproducible',
            expected_belief_update: 'retest independently',
          },
        },
      },
    };
    ctx.store.readActionReceipts = () => [{
      id: 'receipt-bootstrap',
      execution_id: 'exec-1',
      decision_id: 'decision-bootstrap',
      action,
      result: { success: true },
    }];
    const calls = {};
    const handlers = successfulHandlers(calls);
    handlers.belief = vi.fn(async () => ({
      beliefUpdateResult: {
        result: {
          status: 'updated',
          updates: [{ belief_id: 'belief-bootstrap', change: 'create' }],
        },
      },
    }));

    const result = await settleEvidenceWindow(ctx, {
      ...args,
      verification: {
        execution_id: 'exec-1',
        comparison: {
          actions: [{
            decision_id: 'decision-bootstrap',
            belief_id: 'belief-bootstrap',
            belief_relation: 'create_belief',
            execution_success: true,
            status: 'uncertain',
          }],
        },
      },
      handlers,
    });

    expect(handlers.belief).not.toHaveBeenCalled();
    expect(result.belief).toMatchObject({
      beliefUpdateResult: {
        source: 'mechanical_bootstrap_guard',
        result: { status: 'skipped', updates: [] },
        eventsWritten: 0,
      },
    });
  });

  it('commits one result for repeated calls and only exposes correlated evidence', async () => {
    const { ctx, args } = fixture();
    const calls = {};
    const first = await settleEvidenceWindow(ctx, {
      ...args,
      handlers: successfulHandlers(calls),
    });
    const second = await settleEvidenceWindow(ctx, {
      ...args,
      handlers: successfulHandlers(calls),
    });

    expect(first.reused).toBe(false);
    expect(second).toMatchObject({
      settlement_id: first.settlement_id,
      reused: true,
    });
    expect(calls).toMatchObject({
      belief: 1,
      goalAssess: 1,
      goalCalibrate: 1,
    });
    expect(calls.receipts.map((receipt) => receipt.id)).toEqual(['receipt-target']);
    expect(calls.refs).toEqual([
      'action_receipt:receipt-target',
      'verify_report:exec-1',
    ]);
  });

  it('converges concurrent attempts on the same in-flight transaction', async () => {
    const { ctx, args } = fixture();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = {};
    const handlers = successfulHandlers(calls);
    handlers.belief = vi.fn(async () => {
      await gate;
      return { beliefUpdateResult: { result: { status: 'updated' } } };
    });

    const first = settleEvidenceWindow(ctx, { ...args, handlers });
    const second = settleEvidenceWindow(ctx, { ...args, handlers });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.settlement_id).toBe(b.settlement_id);
    expect(handlers.belief).toHaveBeenCalledTimes(1);
    expect(calls.goalAssess).toBe(1);
    expect(calls.goalCalibrate).toBe(1);
  });

  it('resumes after partial failure without replaying a committed effect', async () => {
    const { ctx, args, dataRoot } = fixture();
    const calls = {};
    const handlers = successfulHandlers(calls);
    let failOnce = true;
    handlers.goalAssess = async () => {
      calls.goalAssess = (calls.goalAssess ?? 0) + 1;
      if (failOnce) {
        failOnce = false;
        throw new Error('injected_goal_failure');
      }
      return {
        goalsAssessResult: {
          assessment: { status: 'keep' },
          event: { cycle_id: 'reaction-1' },
        },
      };
    };

    await expect(settleEvidenceWindow(ctx, { ...args, handlers }))
      .rejects.toThrow('injected_goal_failure');
    const identity = buildSettlementIdentity({
      executionId: 'exec-1',
      reportPath: args.reportPath,
      receipts: [ctx.store.readActionReceipts()[0]],
    });
    expect(readSettlement(dataRoot, identity.settlement_id)).toMatchObject({
      status: 'failed',
      effects: {
        belief: { status: 'done' },
        goal_assess: { status: 'failed' },
      },
    });

    const recovered = await settleEvidenceWindow(ctx, { ...args, handlers });
    expect(recovered.reused).toBe(false);
    expect(calls).toMatchObject({
      belief: 1,
      goalAssess: 2,
      goalCalibrate: 1,
    });
    expect(readSettlement(dataRoot, identity.settlement_id).status).toBe('completed');
  });

  it('rebuilds a done belief effect when authority committed before the sidecar marker', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-settlement-authority-gap-'));
    const dataRoot = join(tempDir, 'data');
    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
    });
    store.recordCurrentBeliefs({
      schema_version: 1,
      beliefs: [{
        id: 'belief-authority',
        goal_id: 'goal-authority',
        claim: 'authority events survive a sidecar gap',
        status: 'active',
        confidence: 'medium',
        evidence_refs: [],
        next_test: 'resume settlement',
      }],
    });
    store.recordActionReceipt({
      type: 'record_observation',
      description: 'authority gap action',
      params: { content: 'evidence' },
    }, {
      success: true,
      evidence: [{ ref: 'authority-gap' }],
    }, {
      executionId: 'exec-authority-gap',
      decisionId: 'decision-authority-gap',
    });
    const args = {
      intelResult: { cycle_id: 'reaction-authority-gap' },
      execResult: { execution_id: 'exec-authority-gap', cycle_id: 'exec-authority-gap' },
      verification: { execution_id: 'exec-authority-gap' },
      reportPath: join(dataRoot, 'evolution', 'verify_reports', 'exec-authority-gap.json'),
    };
    let beliefCalls = 0;
    const handlers = successfulHandlers({});
    handlers.belief = async ({ settlement }) => {
      beliefCalls += 1;
      const after = {
        ...store.readCurrentBeliefs().beliefs[0],
        status: 'validated',
        confidence: 'high',
      };
      store.commitBeliefEffect({
        settlement,
        prepare: () => ({
          currentBeliefs: { schema_version: 1, beliefs: [after] },
          events: [{
            belief_id: after.id,
            change: 'validate',
            after,
            evidence_refs: settlement.evidence_refs,
          }],
          effectResult: { result: { status: 'updated' } },
        }),
      });
      throw new Error('injected_after_authority_commit');
    };

    await expect(settleEvidenceWindow({
      runtime: { dataRoot, runtimeRoot: tempDir },
      store,
    }, { ...args, handlers })).rejects.toThrow('injected_after_authority_commit');
    const identity = buildSettlementIdentity({
      executionId: 'exec-authority-gap',
      reportPath: args.reportPath,
      receipts: store.readActionReceipts({ limit: null }),
    });
    expect(readSettlement(dataRoot, identity.settlement_id)).toMatchObject({
      status: 'failed',
      effects: { belief: { status: 'failed' } },
    });
    expect(committedBeliefEffectEvents(
      store.readBeliefEvents({ limit: null }),
      identity.settlement_id,
    )).toHaveLength(1);

    const resumedHandlers = successfulHandlers({});
    resumedHandlers.belief = async () => {
      throw new Error('authority_effect_must_not_replay');
    };
    const resumed = await settleEvidenceWindow({
      runtime: { dataRoot, runtimeRoot: tempDir },
      store,
    }, { ...args, handlers: resumedHandlers });
    expect(resumed.reused).toBe(false);
    expect(beliefCalls).toBe(1);
    expect(readSettlement(dataRoot, identity.settlement_id)).toMatchObject({
      status: 'completed',
      effects: { belief: { status: 'done' } },
    });
  });

  it.each([
    ['goal_assess', 'goalAssess'],
    ['goal_calibrate', 'goalCalibrate'],
  ])('does not replay %s when its authoritative event precedes the sidecar marker', async (
    effect,
    handlerName,
  ) => {
    tempDir = mkdtempSync(join(tmpdir(), `jea-${effect}-authority-gap-`));
    const dataRoot = join(tempDir, 'data');
    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
    });
    store.recordActionReceipt({
      type: 'record_observation',
      description: `${effect} authority gap action`,
      params: { content: 'settlement evidence' },
    }, {
      success: true,
      evidence: [{ ref: `${effect}-authority-gap` }],
    }, {
      executionId: `exec-${effect}-authority-gap`,
      decisionId: `decision-${effect}-authority-gap`,
    });
    const args = {
      intelResult: { cycle_id: `reaction-${effect}-authority-gap` },
      execResult: {
        execution_id: `exec-${effect}-authority-gap`,
        cycle_id: `exec-${effect}-authority-gap`,
      },
      verification: { execution_id: `exec-${effect}-authority-gap` },
      reportPath: join(
        dataRoot,
        'evolution',
        'verify_reports',
        `exec-${effect}-authority-gap.json`,
      ),
    };
    const identity = buildSettlementIdentity({
      executionId: args.execResult.execution_id,
      reportPath: args.reportPath,
      receipts: store.readActionReceipts({ limit: null }),
    });
    const markerId = `goal-event-${identity.settlement_id}-${effect}`;
    const calls = {};
    const handlers = successfulHandlers(calls);
    handlers[handlerName] = async () => {
      calls[handlerName] = (calls[handlerName] ?? 0) + 1;
      store.recordGoalEvent({
        id: markerId,
        type: effect === 'goal_assess' ? 'assessment' : 'patched',
        cycle_id: args.intelResult.cycle_id,
        execution_id: identity.execution_id,
        settlement_id: identity.settlement_id,
        settlement_effect: effect,
        reason: `authoritative ${effect} event`,
        evidence_refs: identity.evidence_refs,
        ...(effect === 'goal_assess' ? {
          assessment: {
            status: 'keep',
            reason: 'goal remains valid',
            evidence_refs: identity.evidence_refs,
          },
          source: 'fault_injection',
        } : {
          previous_goal: { id: 'goal-authority' },
          next_goal: { id: 'goal-authority' },
        }),
      });
      throw new Error(`injected_after_${effect}_authority`);
    };

    await expect(settleEvidenceWindow({
      runtime: { dataRoot, runtimeRoot: tempDir },
      store,
    }, { ...args, handlers })).rejects.toThrow(`injected_after_${effect}_authority`);
    expect(readSettlement(dataRoot, identity.settlement_id)).toMatchObject({
      status: 'failed',
      effects: {
        [effect]: { status: 'failed' },
      },
    });

    const resumedHandlers = successfulHandlers(calls);
    resumedHandlers[handlerName] = async () => {
      throw new Error(`${effect}_authority_effect_must_not_replay`);
    };
    const resumed = await settleEvidenceWindow({
      runtime: { dataRoot, runtimeRoot: tempDir },
      store,
    }, { ...args, handlers: resumedHandlers });
    const authoritative = store.readGoalEvents({ limit: null }).filter((event) => (
      event.settlement_id === identity.settlement_id
      && event.settlement_effect === effect
    ));

    expect(resumed.reused).toBe(false);
    expect(calls[handlerName]).toBe(1);
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]).toMatchObject({
      id: markerId,
      execution_id: identity.execution_id,
      settlement_id: identity.settlement_id,
      settlement_effect: effect,
    });
    expect(readSettlement(dataRoot, identity.settlement_id)).toMatchObject({
      status: 'completed',
      effects: {
        [effect]: {
          status: 'done',
          authoritative_event_ids: [markerId],
          recovered: true,
        },
      },
    });
  });

  it('uses the same identity for synchronous inputs and projected async events', async () => {
    const { dataRoot, receipts, args } = fixture();
    mkdirSync(join(dataRoot, 'evolution', 'verify_reports'), { recursive: true });
    writeFileSync(args.reportPath, JSON.stringify({
      execution_id: 'exec-1',
      comparison: { status: 'matched' },
    }), 'utf8');
    const events = [{
      id: 'exec-1',
      kind: 'verify_reports',
      provenance: { file: 'evolution/verify_reports/exec-1.json' },
      payload: { execution_id: 'exec-1', comparison: { status: 'matched' } },
    }, {
      id: 'receipt-target',
      kind: 'action_receipts',
      payload: receipts[0],
    }];
    const [window] = settlementWindowsFromEvents(dataRoot, events);
    const sync = buildSettlementIdentity({
      executionId: 'exec-1',
      reportPath: args.reportPath,
      receipts: [receipts[0]],
    });
    const asyncIdentity = buildSettlementIdentity({
      executionId: window.executionId,
      reportPath: window.reportPath,
      receipts: window.receipts,
    });

    expect(asyncIdentity).toEqual(sync);
    expect(settlementLedgerPath(dataRoot)).toContain('reactor/settlements.json');
  });

  it('treats contradicted verify evidence as immediately due despite duplicate wakes', () => {
    const contradicted = {
      id: 'exec-contradicted',
      kind: 'verify_reports',
      occurred_at: new Date().toISOString(),
      payload: {
        comparison: { status: 'contradicted' },
        settlement_signal: { reason: 'expected_output_contradicted' },
      },
    };
    expect(shouldRunRuleReaction([contradicted], { minEvents: 8 })).toEqual({
      due: true,
      reason: 'expected_output_contradicted',
    });
    expect(shouldRunRuleReaction([contradicted, { ...contradicted }], { minEvents: 8 })).toEqual({
      due: true,
      reason: 'expected_output_contradicted',
    });
  });

  it('forces validate/refute/reopen events to cite the exact settlement refs', async () => {
    const recorded = [];
    const exactRefs = ['action_receipt:receipt-exact', 'verify_report:exec-exact'];
    const current = {
      beliefs: [{
        id: 'belief-exact',
        goal_id: 'goal-exact',
        claim: 'old claim',
        status: 'active',
        confidence: 'medium',
        evidence_refs: [],
        next_test: 'check',
      }],
    };
    const result = await updateBeliefsWithAi({
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'updated',
          reason: 'contradicted',
          updates: [{
            belief_id: 'belief-exact',
            change: 'refute',
            reason: 'exact contradiction',
            evidence_refs: ['action_receipt:unrelated'],
          }],
        }),
      },
      activeGoals: { id: 'goal-exact', children: [] },
      execResult: { cycle_id: 'exec-exact', execution_id: 'exec-exact' },
      verification: { execution_id: 'exec-exact' },
      receipts: [{
        id: 'receipt-exact',
        execution_id: 'exec-exact',
        result: { status: 'failed' },
      }],
      evidenceRefs: exactRefs,
      settlement: {
        settlement_id: 'settlement-exact',
        settlement_effect: 'belief',
        execution_id: 'exec-exact',
      },
      store: {
        readCurrentBeliefs: () => current,
        recordCurrentBeliefs: vi.fn(),
        recordBeliefEvent: (event) => {
          recorded.push(event);
          return 1;
        },
      },
    });

    expect(result.eventsWritten).toBe(1);
    expect(recorded[0]).toMatchObject({
      belief_id: 'belief-exact',
      change: 'refute',
      evidence_refs: exactRefs,
      settlement_id: 'settlement-exact',
      settlement_effect: 'belief',
      execution_id: 'exec-exact',
    });
  });

  it.each([
    'belief_after_prepare',
    'belief_after_event',
    'belief_after_projection',
    'belief_after_commit',
  ])('recovers the authoritative multi-event belief effect after %s', async (boundary) => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-belief-effect-'));
    const store = createIntelligenceStore({
      baseDir: join(tempDir, boundary, 'data', 'intelligence'),
    });
    store.recordCurrentBeliefs({
      schema_version: 1,
      beliefs: ['a', 'b'].map((suffix) => ({
        id: `belief-${suffix}`,
        goal_id: 'goal-1',
        claim: `claim ${suffix}`,
        status: 'active',
        confidence: 'medium',
        evidence_refs: [],
        next_test: 'verify',
      })),
    });
    let aiCalls = 0;
    const args = {
      aiClient: {
        chat: async () => {
          aiCalls += 1;
          return JSON.stringify({
            status: 'updated',
            reason: 'verified',
            updates: ['a', 'b'].map((suffix) => ({
              belief_id: `belief-${suffix}`,
              change: 'validate',
              reason: `validated ${suffix}`,
              evidence_refs: ['verify_report:exec-fault'],
            })),
          });
        },
      },
      activeGoals: { id: 'goal-1', children: [] },
      execResult: { cycle_id: 'exec-fault', execution_id: 'exec-fault' },
      verification: { execution_id: 'exec-fault' },
      evidenceRefs: ['verify_report:exec-fault'],
      settlement: {
        settlement_id: `settlement-${boundary}`,
        settlement_effect: 'belief',
        execution_id: 'exec-fault',
      },
      store,
    };
    let injected = false;
    await expect(updateBeliefsWithAi({
      ...args,
      faultInjector: (point) => {
        if (!injected && point === boundary) {
          injected = true;
          throw new Error(`injected:${boundary}`);
        }
      },
    })).rejects.toThrow(`injected:${boundary}`);

    const resumed = await updateBeliefsWithAi({
      ...args,
      aiClient: { chat: async () => { throw new Error('model_must_not_replay'); } },
    });
    const all = store.readBeliefEvents({ limit: null });
    const authoritative = committedBeliefEffectEvents(all, args.settlement.settlement_id);
    expect(resumed.reused).toBe(true);
    expect(aiCalls).toBe(1);
    expect(authoritative).toHaveLength(2);
    expect(new Set(authoritative.map((event) => event.id)).size).toBe(2);
    expect(store.readCurrentBeliefs().beliefs.map((belief) => belief.status))
      .toEqual(['validated', 'validated']);
  });
});
