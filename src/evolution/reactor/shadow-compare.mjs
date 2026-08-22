/**
 * Compare shadow reactor decisions against a train cycle's Decide output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionFingerprint } from '../../intelligence/decision-queue.mjs';
import { extractBeliefContext } from '../../contracts/belief-context.mjs';
import { readJson } from '../../infra/json-store.mjs';
import { readShadowDecisions } from './shadow-store.mjs';

function loadTrainDecisions(dataRoot, cycleId) {
  const evolutionDir = join(dataRoot, 'evolution');
  const pendingPath = join(evolutionDir, 'pending_decisions.json');
  const archivePath = join(evolutionDir, 'archived_decisions.json');
  const rows = [];

  for (const file of [pendingPath, archivePath]) {
    if (!existsSync(file)) continue;
    const raw = readJson(file, null);
    const list = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.decisions) ? raw.decisions : []);
    for (const decision of list) {
      const id = String(decision?.id || '');
      const cycle = decision?.cycle_id
        || (id.includes(':') ? id.split(':')[0] : null);
      if (cycleId && cycle !== cycleId) continue;
      rows.push(decision);
    }
  }
  return rows;
}

function actionKey(action = {}) {
  return decisionFingerprint(action);
}

function actionSemantics(action = {}) {
  const runSpec = action?.params?.run_spec ?? action?.run_spec ?? {};
  const context = extractBeliefContext(action);
  const beliefId = context.belief_id ?? null;
  const beliefRelation = context.belief_relation ?? null;
  const noBeliefReason = context.no_belief_reason
    ?? context.mechanical_reason
    ?? context.belief_exemption_reason
    ?? (action.origin === 'mechanical_guard' ? 'mechanical_guard' : null);
  const expectedOutput = runSpec.expected_output
    ?? runSpec.expectedOutput
    ?? action?.params?.expected_output
    ?? action?.params?.expectedOutput
    ?? null;
  return {
    belief_binding: beliefId || beliefRelation === 'create_belief'
      ? {
        status: 'bound',
        belief_id: beliefId,
        relation: beliefRelation,
      }
      : noBeliefReason
        ? { status: 'exempt', reason: noBeliefReason }
        : { status: 'legacy_unknown' },
    expected_output: {
      present: Array.isArray(expectedOutput)
        ? expectedOutput.length > 0
        : Boolean(expectedOutput && Object.keys(expectedOutput).length),
    },
  };
}

function summarizeAction(action = {}) {
  return {
    type: action.type ?? null,
    serves_goal: action.serves_goal ?? null,
    description: action.description ?? action.params?.description ?? null,
    ...actionSemantics(action),
  };
}

/**
 * @param {string} dataRoot
 * @param {{ cycleId: string, batchId?: string|null }} opts
 */
export function compareShadowAgainstCycle(dataRoot, { cycleId, batchId = null } = {}) {
  if (!cycleId) throw new Error('compareShadowAgainstCycle requires cycleId');

  const train = loadTrainDecisions(dataRoot, cycleId);
  let shadow = readShadowDecisions(dataRoot).decisions || [];
  if (batchId) {
    shadow = shadow.filter((d) => d.batch_id === batchId);
  }

  const trainByFp = new Map();
  for (const decision of train) {
    const fp = actionKey(decision.action || decision);
    if (!trainByFp.has(fp)) trainByFp.set(fp, []);
    trainByFp.get(fp).push(decision);
  }

  const shadowByFp = new Map();
  for (const decision of shadow) {
    const fp = decision.fingerprint || actionKey(decision.action);
    if (!shadowByFp.has(fp)) shadowByFp.set(fp, []);
    shadowByFp.get(fp).push(decision);
  }

  const matched = [];
  const shadowOnly = [];
  const trainOnly = [];

  for (const [fp, shadowRows] of shadowByFp.entries()) {
    const trainRows = trainByFp.get(fp) || [];
    const pairCount = Math.min(shadowRows.length, trainRows.length);
    for (let i = 0; i < pairCount; i += 1) {
      matched.push({
        fingerprint: fp,
        action: summarizeAction(shadowRows[i].action),
        shadow_id: shadowRows[i].id,
        train_id: trainRows[i].id,
        shadow_identity: {
          producer_batch_id: shadowRows[i].producer_batch_id
            ?? shadowRows[i].metadata?.producer_batch_id
            ?? shadowRows[i].batch_id
            ?? null,
          reaction_id: shadowRows[i].reaction_id
            ?? shadowRows[i].metadata?.reaction_id
            ?? null,
        },
        train_identity: {
          producer_batch_id: trainRows[i].producer_batch_id
            ?? trainRows[i].metadata?.producer_batch_id
            ?? null,
          reaction_id: trainRows[i].reaction_id
            ?? trainRows[i].metadata?.reaction_id
            ?? null,
        },
      });
    }
    for (let i = pairCount; i < shadowRows.length; i += 1) {
      shadowOnly.push({
        fingerprint: fp,
        action: summarizeAction(shadowRows[i].action),
        shadow_id: shadowRows[i].id,
        batch_id: shadowRows[i].batch_id,
      });
    }
  }

  for (const [fp, trainRows] of trainByFp.entries()) {
    const shadowRows = shadowByFp.get(fp) || [];
    for (let i = shadowRows.length; i < trainRows.length; i += 1) {
      trainOnly.push({
        fingerprint: fp,
        action: summarizeAction(trainRows[i].action || trainRows[i]),
        train_id: trainRows[i].id,
      });
    }
  }

  const denom = Math.max(train.length, 1);
  const coverage = matched.length / denom;
  const allActions = [...train, ...shadow].map((row) => row.action ?? row);
  const boundOrExempt = allActions.filter((action) => (
    actionSemantics(action).belief_binding.status !== 'legacy_unknown'
  )).length;
  const expectedOutput = allActions.filter((action) => (
    actionSemantics(action).expected_output.present
  )).length;

  return {
    cycle_id: cycleId,
    batch_id: batchId,
    train_count: train.length,
    shadow_count: shadow.length,
    matched,
    shadow_only: shadowOnly,
    train_only: trainOnly,
    coverage,
    summary: {
      matched: matched.length,
      shadow_only: shadowOnly.length,
      train_only: trainOnly.length,
      coverage,
      semantics: {
        actions_total: allActions.length,
        belief_binding_known: boundOrExempt,
        expected_output_present: expectedOutput,
      },
    },
  };
}

/** Best-effort: read cycle id from a pending decisions file marker or latest intel report. */
export function guessLatestTrainCycleId(dataRoot) {
  const indexPath = join(dataRoot, 'intelligence', 'reports', 'index.jsonl');
  if (!existsSync(indexPath)) return null;
  try {
    const lines = readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const row = JSON.parse(lines[i]);
        if (row?.cycle_id) return row.cycle_id;
      } catch {
        // skip
      }
    }
  } catch {
    return null;
  }
  return null;
}
