import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, updateJson } from '../infra/json-store.mjs';
import { nowIso } from '../infra/runtime-paths.mjs';
import { extractBeliefContext } from '../contracts/belief-context.mjs';
import {
  runBeliefUpdateStep,
  runGoalsAssessStep,
  runGoalsCalibrateStep,
} from './cycle-steps.mjs';
import { readExecResult } from './reactor/exec-result-store.mjs';
import { reactorDir } from './reactor/paths.mjs';

const EFFECTS = Object.freeze(['belief', 'goal_assess', 'goal_calibrate']);
const SETTLEMENT_LEASE_MS = 5 * 60 * 1000;
const inFlight = new Map();

function compactResult(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function ledgerEffectResult(effect, value) {
  if (effect === 'belief') {
    return value ? {
      skipped: value.skipped ?? false,
      failed: value.failed ?? false,
      error: value.error ?? null,
      beliefUpdateResult: value.beliefUpdateResult ? {
        source: value.beliefUpdateResult.source ?? null,
        result: value.beliefUpdateResult.result ? {
          status: value.beliefUpdateResult.result.status ?? null,
          reason: value.beliefUpdateResult.result.reason ?? null,
          updates_count: value.beliefUpdateResult.result.updates?.length ?? 0,
          operator_fact_digestions_count:
            value.beliefUpdateResult.result.operator_fact_digestions?.length ?? 0,
        } : null,
        eventsWritten: value.beliefUpdateResult.eventsWritten ?? 0,
      } : null,
    } : null;
  }
  if (effect === 'goal_assess') {
    return value ? {
      skipped: value.skipped ?? false,
      failed: value.failed ?? false,
      error: value.error ?? null,
      goalsAssessResult: value.goalsAssessResult ? {
        assessment: value.goalsAssessResult.assessment ?? null,
        event: value.goalsAssessResult.event ?? null,
        source: value.goalsAssessResult.source ?? null,
        report: value.goalsAssessResult.report ? {
          cycle_id: value.goalsAssessResult.report.cycle_id ?? null,
        } : null,
      } : null,
    } : null;
  }
  return value ? {
    skipped: value.skipped ?? false,
    failed: value.failed ?? false,
    error: value.error ?? null,
    goalsCalibrateResult: value.goalsCalibrateResult ?? null,
  } : null;
}

function ledgerSettlementResult(result) {
  return {
    settlement_id: result.settlement_id,
    execution_id: result.execution_id,
    evidence_refs: result.evidence_refs,
    belief: ledgerEffectResult('belief', result.belief),
    goals: ledgerEffectResult('goal_assess', result.goals),
    calibrate: ledgerEffectResult('goal_calibrate', result.calibrate),
  };
}

function readReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function readAll(store, method) {
  if (typeof store?.[method] !== 'function') return [];
  return store[method]({ limit: null }) ?? [];
}

function eventIdDigest(ids) {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function completeBeliefCommit(marker, byId) {
  const expected = Array.isArray(marker?.expected_event_ids) ? marker.expected_event_ids : null;
  return expected != null
    && marker?.expected_event_digest === eventIdDigest(expected)
    && expected.every((id) => byId.has(id));
}

export function committedBeliefEffectEvents(events = [], settlementId = null) {
  const byId = new Map(events.filter((event) => event?.id).map((event) => [event.id, event]));
  const commits = events.filter((event) => (
    event?.type === 'settlement_commit'
    && event?.settlement_effect === 'belief'
    && (!settlementId || event.settlement_id === settlementId)
  ));
  const committed = [];
  for (const marker of commits) {
    const expected = marker.expected_event_ids;
    if (!completeBeliefCommit(marker, byId)) continue;
    committed.push(...expected.map((id) => byId.get(id)));
  }
  return [...new Map(committed.map((event) => [event.id, event])).values()];
}

function receiptExecutionId(receipt) {
  return receipt?.execution_id ?? receipt?.exec_cycle_id ?? receipt?.cycle_id ?? null;
}

export function settlementLedgerPath(dataRoot) {
  return join(reactorDir(dataRoot), 'settlements.json');
}

export function exactSettlementRefs({
  executionId,
  reportPath = null,
  receipts = [],
  includeExecResult = false,
} = {}) {
  const refs = [];
  if (includeExecResult && executionId) refs.push(`exec_result:${executionId}`);
  if (reportPath && executionId) refs.push(`verify_report:${executionId}`);
  for (const receipt of receipts) {
    if (receipt?.id) refs.push(`action_receipt:${receipt.id}`);
  }
  return uniqueSorted(refs);
}

export function buildSettlementIdentity({
  executionId,
  reportPath = null,
  receipts = [],
  evidenceRefs = null,
} = {}) {
  if (!executionId) throw new Error('settlement requires execution_id');
  const refs = uniqueSorted(evidenceRefs ?? exactSettlementRefs({
    executionId,
    reportPath,
    receipts,
  }));
  const canonical = JSON.stringify({
    execution_id: String(executionId),
    evidence_refs: refs,
  });
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return {
    settlement_id: `settlement-${digest}`,
    execution_id: String(executionId),
    evidence_refs: refs,
  };
}

function emptyLedger() {
  return { settlements: {}, updated_at: null };
}

function patchSettlement(dataRoot, settlementId, updater) {
  let result = null;
  updateJson(settlementLedgerPath(dataRoot), (raw) => {
    const ledger = {
      settlements: raw?.settlements && typeof raw.settlements === 'object'
        ? raw.settlements
        : {},
      updated_at: raw?.updated_at ?? null,
    };
    const current = ledger.settlements[settlementId] ?? null;
    result = updater(current);
    ledger.settlements[settlementId] = result;
    ledger.updated_at = nowIso();
    return ledger;
  }, { fallback: emptyLedger() });
  return result;
}

export function readSettlement(dataRoot, settlementId) {
  return readJson(settlementLedgerPath(dataRoot), emptyLedger())?.settlements?.[settlementId] ?? null;
}

function resultFromGoalEvent(event) {
  if (!event) return null;
  return {
    event,
    assessment: event.assessment ?? {
      status: event.assessment_status ?? 'insufficient_evidence',
      reason: event.reason ?? 'Recovered from authoritative goal event.',
      evidence_refs: event.evidence_refs ?? [],
      proposed_goal: event.proposed_goal ?? null,
      goal_patches: event.goal_patches ?? [],
    },
    report: { cycle_id: event.cycle_id ?? null },
    source: event.source ?? 'recovered',
    written: 0,
  };
}

function rebuildEffectsFromAuthority(store, settlementId) {
  const beliefEvents = readAll(store, 'readBeliefEvents');
  const goalEvents = readAll(store, 'readGoalEvents');
  const beliefById = new Map(beliefEvents.filter((event) => event?.id).map((event) => [event.id, event]));
  const belief = committedBeliefEffectEvents(beliefEvents, settlementId);
  const beliefCommit = beliefEvents.find((event) => (
    event?.type === 'settlement_commit'
    && event?.settlement_effect === 'belief'
    && event?.settlement_id === settlementId
    && completeBeliefCommit(event, beliefById)
  ));
  const assessment = goalEvents.find((event) => (
    event?.settlement_id === settlementId
    && event?.settlement_effect === 'goal_assess'
  ));
  const calibration = goalEvents.find((event) => (
    event?.settlement_id === settlementId
    && event?.settlement_effect === 'goal_calibrate'
  ));
  return {
    ...(beliefCommit ? {
      belief: {
        status: 'done',
        authoritative_event_ids: belief.map((event) => event.id).filter(Boolean),
        expected_event_ids: beliefCommit.expected_event_ids,
        expected_event_digest: beliefCommit.expected_event_digest,
        result: beliefCommit.effect_result ?? null,
        recovered: true,
      },
    } : {}),
    ...(assessment ? {
      goal_assess: {
        status: 'done',
        authoritative_event_ids: [assessment.id].filter(Boolean),
        result: { goalsAssessResult: resultFromGoalEvent(assessment) },
        recovered: true,
      },
    } : {}),
    ...(calibration ? {
      goal_calibrate: {
        status: 'done',
        authoritative_event_ids: [calibration.id].filter(Boolean),
        recovered: true,
      },
    } : {}),
  };
}

function correlatedReceipts(store, executionId, supplied = null) {
  const source = [
    ...(Array.isArray(supplied) ? supplied : []),
    ...(store?.readActionReceipts?.({ limit: null }) ?? []),
  ];
  const byId = new Map();
  for (const receipt of source) {
    if (receiptExecutionId(receipt) !== executionId) continue;
    const key = receipt?.id ?? JSON.stringify(receipt);
    byId.set(key, receipt);
  }
  return [...byId.values()];
}

function comparisonForBootstrap(receipt, receiptIndex, report) {
  const actions = Array.isArray(report?.comparison?.actions)
    ? report.comparison.actions
    : [];
  const beliefContext = extractBeliefContext(receipt?.action);
  return actions.find((item) => (
    receipt?.decision_id
    && item?.decision_id === receipt.decision_id
  )) ?? actions.find((item) => (
    beliefContext.belief_id
    && item?.belief_id === beliefContext.belief_id
    && item?.belief_relation === 'create_belief'
  )) ?? actions.find((item) => item?.action_index === receiptIndex) ?? null;
}

export function selectMechanicalBeliefBootstrap(receipts = [], report = null) {
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const context = extractBeliefContext(receipt?.action);
    if (context.belief_relation !== 'create_belief') continue;
    const comparison = comparisonForBootstrap(receipt, index, report);
    if (
      receipt?.result?.success !== true
      || !comparison
      || comparison.execution_success !== true
      || comparison.status !== 'matched'
    ) {
      continue;
    }
    const beliefId = String(context.belief_id ?? '').trim();
    const claim = String(context.expected_belief_claim ?? '').trim();
    if (!beliefId || !claim) continue;
    return {
      belief_id: beliefId,
      goal_id: receipt?.action?.serves_goal ?? null,
      claim,
      next_test: String(context.expected_belief_update ?? '').trim() || null,
      receipt,
      comparison,
    };
  }
  return null;
}

function commitMechanicalBeliefBootstrap(store, candidate, settlement) {
  if (!candidate || typeof store?.commitBeliefEffect !== 'function') return null;
  const effectSettlement = { ...settlement, settlement_effect: 'belief' };
  const committed = store.commitBeliefEffect({
    settlement: effectSettlement,
    prepare: (currentBeliefs = {}) => {
      const beliefs = Array.isArray(currentBeliefs?.beliefs)
        ? JSON.parse(JSON.stringify(currentBeliefs.beliefs))
        : [];
      const existing = beliefs.find((belief) => belief?.id === candidate.belief_id);
      const changedAt = nowIso();
      const after = existing ?? {
        id: candidate.belief_id,
        goal_id: candidate.goal_id,
        claim: candidate.claim,
        status: 'active',
        confidence: 'medium',
        evidence_refs: settlement.evidence_refs,
        next_test: candidate.next_test,
        recheck_trigger: null,
        origin: 'mechanical_bootstrap',
        origin_verification: `verify_report:${settlement.execution_id}`,
        last_change: {
          cycle_id: settlement.execution_id,
          change: 'create',
          reason: 'Successful create_belief action with matched expected output settled mechanically.',
          changed_at: changedAt,
        },
      };
      if (!existing) beliefs.push(after);
      const event = existing ? [] : [{
        producer_batch_id: candidate.receipt?.producer_batch_id ?? null,
        reaction_id: candidate.receipt?.reaction_id ?? null,
        decision_id: candidate.receipt?.decision_id ?? null,
        execution_id: settlement.execution_id,
        settlement_id: settlement.settlement_id,
        settlement_effect: 'belief',
        cycle_id: settlement.execution_id,
        belief_id: candidate.belief_id,
        goal_id: candidate.goal_id,
        change: 'create',
        reason: 'Successful create_belief action with matched expected output settled mechanically.',
        evidence_refs: settlement.evidence_refs,
        source: 'settlement_bootstrap',
        producer: 'rule',
        activation_targets: ['cognitive'],
        before: null,
        after,
      }];
      return {
        currentBeliefs: {
          ...currentBeliefs,
          schema_version: currentBeliefs?.schema_version ?? 1,
          updated_at: changedAt,
          source_cycle_id: settlement.execution_id,
          beliefs,
        },
        events: event,
        effectResult: {
          source: 'mechanical_bootstrap',
          result: {
            status: existing ? 'skipped' : 'updated',
            reason: existing
              ? `Belief ${candidate.belief_id} already exists.`
              : `Created belief ${candidate.belief_id} from verified bootstrap action.`,
            updates: existing ? [] : [{
              belief_id: candidate.belief_id,
              change: 'create',
              goal_id: candidate.goal_id,
              claim: candidate.claim,
              next_test: candidate.next_test,
              evidence_refs: settlement.evidence_refs,
            }],
          },
        },
      };
    },
  });
  return {
    beliefUpdateResult: {
      ...(committed?.result ?? {}),
      currentBeliefs: committed?.currentBeliefs ?? null,
      eventsWritten: committed?.eventsWritten ?? 0,
      reused: committed?.reused ?? false,
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function effectFailed(result) {
  return result?.failed === true
    || result?.beliefUpdateResult?.result?.status === 'failed'
    || result?.goalsAssessResult?.assessment?.status === 'failed'
    || result?.goalsCalibrateResult?.status === 'failed';
}

function effectError(effect, result) {
  return result?.error
    ?? result?.beliefUpdateResult?.result?.reason
    ?? result?.goalsCalibrateResult?.reason
    ?? `${effect}_failed`;
}

/**
 * Shared sync/async settlement transaction coordinator.
 *
 * The sidecar only coordinates retries. Belief/goal events carrying
 * settlement_id remain authoritative and can reconstruct committed effects.
 */
export async function settleEvidenceWindow(ctx, {
  intelResult,
  execResult,
  verification = null,
  reportPath = null,
  receipts = null,
  intelReportReady = true,
  recordState = null,
  canCommit = null,
  producer = 'rule',
  activationTargets = ['cognitive'],
  useLatestReport = false,
  handlers = {},
} = {}) {
  const dataRoot = ctx?.runtime?.dataRoot;
  if (!dataRoot) throw new Error('settlement requires runtime.dataRoot');
  const report = verification ?? readReport(reportPath);
  const executionId = report?.execution_id
    ?? execResult?.execution_id
    ?? execResult?.cycle_id
    ?? null;
  if (!executionId) throw new Error('settlement requires execution evidence');
  const exactReceipts = correlatedReceipts(ctx.store, executionId, receipts);
  const identity = buildSettlementIdentity({
    executionId,
    reportPath,
    receipts: exactReceipts,
  });
  const flightKey = `${settlementLedgerPath(dataRoot)}:${identity.settlement_id}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);

  const task = (async () => {
    const authority = rebuildEffectsFromAuthority(ctx.store, identity.settlement_id);
    const owner = `settler-${randomUUID()}`;
    let record;
    for (;;) {
      let acquired = false;
      record = patchSettlement(dataRoot, identity.settlement_id, (current) => {
        if (current?.status === 'completed') return current;
        const claimedAt = Date.parse(current?.claimed_at ?? '');
        const activeClaim = current?.status === 'running'
          && current?.owner
          && (
            processIsAlive(current?.owner_pid)
            || (Number.isFinite(claimedAt) && Date.now() - claimedAt < SETTLEMENT_LEASE_MS)
          );
        if (activeClaim && current.owner !== owner) return current;
        acquired = true;
        return {
          settlement_id: identity.settlement_id,
          execution_id: identity.execution_id,
          evidence_refs: identity.evidence_refs,
          status: 'running',
          owner,
          owner_pid: process.pid,
          claimed_at: nowIso(),
          producer: current?.producer ?? producer,
          created_at: current?.created_at ?? nowIso(),
          updated_at: nowIso(),
          attempts: (current?.attempts ?? 0) + 1,
          effects: {
            ...(current?.effects ?? {}),
            ...authority,
          },
          result: current?.result ?? null,
          last_error: null,
        };
      });
      if (record.status === 'completed') {
        return { ...record.result, settlement_id: identity.settlement_id, reused: true };
      }
      if (acquired) break;
      await delay(50);
    }
    const refreshedAuthority = rebuildEffectsFromAuthority(ctx.store, identity.settlement_id);
    if (Object.keys(refreshedAuthority).length) {
      record = patchSettlement(dataRoot, identity.settlement_id, (current) => ({
        ...current,
        effects: {
          ...(current?.effects ?? {}),
          ...refreshedAuthority,
        },
        updated_at: nowIso(),
      }));
    }

    const settlement = {
      ...identity,
      settlement_effect: null,
    };
    const hasMechanicalBootstrapIntent = exactReceipts.some((receipt) => (
      extractBeliefContext(receipt?.action).belief_relation === 'create_belief'
    ));
    const mechanicalBootstrap = selectMechanicalBeliefBootstrap(exactReceipts, report);
    let belief = record.effects?.belief?.result ?? null;
    let goals = record.effects?.goal_assess?.result ?? null;
    let calibrate = record.effects?.goal_calibrate?.result ?? null;

    const runEffect = async (effect, operation) => {
      const fresh = readSettlement(dataRoot, identity.settlement_id);
      if (fresh?.effects?.[effect]?.status === 'done') {
        return fresh.effects[effect].result ?? null;
      }
      try {
        const value = await operation();
        if (effectFailed(value)) throw new Error(effectError(effect, value));
        patchSettlement(dataRoot, identity.settlement_id, (current) => ({
          ...current,
          updated_at: nowIso(),
          effects: {
            ...(current?.effects ?? {}),
            [effect]: {
              status: 'done',
              completed_at: nowIso(),
              result: compactResult(ledgerEffectResult(effect, value)),
            },
          },
        }));
        return value;
      } catch (error) {
        patchSettlement(dataRoot, identity.settlement_id, (current) => ({
          ...current,
          status: 'failed',
          owner: null,
          owner_pid: null,
          updated_at: nowIso(),
          last_error: error?.message ?? String(error),
          effects: {
            ...(current?.effects ?? {}),
            [effect]: {
              ...(current?.effects?.[effect] ?? {}),
              status: 'failed',
              failed_at: nowIso(),
              error: error?.message ?? String(error),
            },
          },
        }));
        throw error;
      }
    };

    belief = await runEffect('belief', () => {
      const bootstrapped = commitMechanicalBeliefBootstrap(
        ctx.store,
        mechanicalBootstrap,
        settlement,
      );
      if (bootstrapped) return bootstrapped;
      if (hasMechanicalBootstrapIntent) {
        return {
          beliefUpdateResult: {
            source: 'mechanical_bootstrap_guard',
            result: {
              status: 'skipped',
              reason: 'create_belief requires a successful execution with an explicitly matched expected-output comparison.',
              updates: [],
            },
            currentBeliefs: ctx.store?.readCurrentBeliefs?.() ?? null,
            eventsWritten: 0,
            reused: false,
          },
        };
      }
      return handlers.belief?.({
        settlement,
        receipts: exactReceipts,
        verification: report,
      })
      ?? runBeliefUpdateStep(ctx, {
        intelResult,
        execResult: { ...execResult, execution_id: executionId },
        verification: report,
        reportPath,
        recordState,
        canCommit,
        producer,
        activationTargets,
        receipts: exactReceipts,
        evidenceRefs: identity.evidence_refs,
        settlement: { ...settlement, settlement_effect: 'belief' },
      });
    });

    goals = await runEffect('goal_assess', () => (
      handlers.goalAssess?.({
        settlement,
        receipts: exactReceipts,
        verification: report,
      })
      ?? runGoalsAssessStep(ctx, {
        intelResult,
        reportPath,
        intelReportReady,
        recordState,
        canCommit,
        producer,
        activationTargets,
        useLatestReport,
        evidenceRefs: identity.evidence_refs,
        settlement: { ...settlement, settlement_effect: 'goal_assess' },
        receipts: exactReceipts,
      })
    ));

    calibrate = await runEffect('goal_calibrate', () => {
      if (!goals?.goalsAssessResult) {
        return { skipped: true, goalsCalibrateResult: null };
      }
      return handlers.goalCalibrate?.({
        settlement,
        goals,
        receipts: exactReceipts,
        verification: report,
      }) ?? runGoalsCalibrateStep(ctx, {
        intelResult,
        goalsAssessResult: goals.goalsAssessResult,
        store: ctx.store,
        recordState,
        canCommit,
        producer,
        activationTargets,
        evidenceRefs: identity.evidence_refs,
        settlement: { ...settlement, settlement_effect: 'goal_calibrate' },
      });
    });

    const result = {
      settlement_id: identity.settlement_id,
      execution_id: executionId,
      evidence_refs: identity.evidence_refs,
      belief,
      goals,
      calibrate,
      reused: false,
    };
    record = patchSettlement(dataRoot, identity.settlement_id, (current) => ({
      ...current,
      status: 'completed',
      owner: null,
      owner_pid: null,
      completed_at: nowIso(),
      updated_at: nowIso(),
      last_error: null,
      result: compactResult(ledgerSettlementResult(result)),
    }));
    return result;
  })();

  inFlight.set(flightKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(flightKey);
  }
}

export function settlementWindowsFromEvents(dataRoot, events = []) {
  const byExecution = new Map();
  for (const event of events) {
    const payload = event?.payload ?? event ?? {};
    const executionId = payload.execution_id
      ?? payload.exec_cycle_id
      ?? (event?.kind === 'verify_reports' ? event.id : null)
      ?? null;
    if (!executionId) continue;
    if (!byExecution.has(executionId)) {
      byExecution.set(executionId, {
        executionId,
        events: [],
        receipts: [],
        verification: null,
        reportPath: null,
      });
    }
    const window = byExecution.get(executionId);
    window.events.push(event);
    if (event?.kind === 'action_receipts') window.receipts.push(payload);
    if (event?.kind === 'verify_reports') {
      window.verification = payload;
      window.reportPath = event?.provenance?.file
        ? join(dataRoot, event.provenance.file)
        : join(dataRoot, 'evolution', 'verify_reports', `${executionId}.json`);
    }
  }
  return [...byExecution.values()].map((window) => ({
    ...window,
    execResult: readExecResult(dataRoot, window.executionId) ?? {
      execution_id: window.executionId,
      cycle_id: window.executionId,
    },
  }));
}

export function settlementEffects() {
  return [...EFFECTS];
}
