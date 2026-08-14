import {
  DIGESTION_OUTCOMES,
  markOperatorFactsDigested,
  readPendingOperatorFacts,
  selectInjectedOperatorFacts,
} from './operator-facts.mjs';
import { openOperatorQuestion } from './operator-questions.mjs';
import { applyBeliefUpdates } from './belief-updater.mjs';
import { normalizeCurrentBeliefs } from './beliefs.mjs';

/**
 * Normalize LLM-produced per-assertion digestion rows.
 * Missing/invalid outcomes default to untested (never silently drop).
 */
export function normalizeOperatorFactDigestions(rawDigestions = [], pendingFacts = []) {
  const byId = new Map();
  for (const row of Array.isArray(rawDigestions) ? rawDigestions : []) {
    const factId = row?.fact_id ?? row?.id ?? null;
    if (!factId) continue;
    const outcome = DIGESTION_OUTCOMES.has(row?.outcome) ? row.outcome : 'untested';
    byId.set(factId, {
      fact_id: factId,
      outcome,
      reason: String(row?.reason || '').trim() || defaultReason(outcome),
      goal_id: row?.goal_id ?? null,
      claim: row?.claim ?? null,
      next_test: row?.next_test ?? null,
      evidence_refs: Array.isArray(row?.evidence_refs) ? row.evidence_refs.map(String) : [],
      question: row?.question ?? null,
    });
  }

  // Mechanical fill for any injected fact the LLM omitted.
  for (const fact of pendingFacts) {
    if (!fact?.id || byId.has(fact.id)) continue;
    byId.set(fact.id, {
      fact_id: fact.id,
      outcome: 'untested',
      reason: 'LLM omitted digestion; host defaulted to untested.',
      goal_id: null,
      claim: fact.content ?? fact.summary ?? null,
      next_test: null,
      evidence_refs: [],
      question: null,
    });
  }

  return [...byId.values()];
}

function defaultReason(outcome) {
  if (outcome === 'supported') return 'Supported by this cycle evidence.';
  if (outcome === 'contradicted') return 'Contradicted by this cycle evidence.';
  return 'Not tested in this cycle; retained as high-confidence operator seed belief.';
}

/**
 * Apply digestion outcomes: create beliefs / open questions / move facts to digested/.
 */
export function applyOperatorFactDigestions({
  runtimeRoot,
  store = null,
  cycleId = null,
  batchId = null,
  digestions = [],
  pendingFacts = null,
  currentBeliefs = null,
  requireRelevantEvidence = false,
} = {}) {
  if (!runtimeRoot) {
    return {
      digested: [],
      beliefs_created: [],
      questions_opened: [],
      failed: [],
      currentBeliefs: normalizeCurrentBeliefs(currentBeliefs),
      eventsWritten: 0,
    };
  }

  const pending = pendingFacts ?? readPendingOperatorFacts(runtimeRoot, { limit: 10_000 }).facts;
  const injected = selectInjectedOperatorFacts(pending);
  const injectedById = new Map(injected.map((f) => [f.id, f]));
  const normalized = normalizeOperatorFactDigestions(digestions, injected);

  const beliefUpdates = [];
  const questionPlans = [];
  const toDigest = [];
  const failed = [];

  for (const row of normalized) {
    const fact = injectedById.get(row.fact_id);
    if (!fact) {
      failed.push({ fact_id: row.fact_id, reason: 'not_in_injected_pending' });
      continue;
    }
    const hasRelevantEvidence = (row.evidence_refs || []).length > 0
      || row.outcome === 'supported'
      || row.outcome === 'contradicted';
    const gated = requireRelevantEvidence || Boolean(fact.activation_batch_id);
    if (gated && row.outcome === 'untested' && !hasRelevantEvidence) {
      continue;
    }

    const claim = String(row.claim || fact.content || fact.summary || '').trim();
    if (row.outcome === 'contradicted') {
      questionPlans.push({
        fact,
        digestion: row,
        questionText: String(row.question || '').trim()
          || `Operator assertion appears contradicted. Please confirm or withdraw: ${claim}`,
      });
      toDigest.push({
        ...fact,
        digestion_outcome: 'contradicted',
        digestion_reason: row.reason,
      });
      continue;
    }

    const status = row.outcome === 'supported' ? 'validated' : 'active';
    const beliefId = `belief-operator-${fact.id}`;
    beliefUpdates.push({
      belief_id: beliefId,
      change: 'create',
      goal_id: row.goal_id,
      claim,
      confidence: 'high',
      status,
      next_test: row.next_test
        || (row.outcome === 'untested'
          ? 'Re-test this operator seed when relevant evidence appears.'
          : null),
      recheck_trigger: row.outcome === 'untested' ? 'operator_seed_untested' : null,
      reason: row.reason,
      evidence_refs: row.evidence_refs.length
        ? row.evidence_refs
        : [`operator_fact:${fact.id}`],
      origin: 'operator',
      origin_fact_id: fact.id,
      origin_verification: row.outcome === 'supported' ? 'supported' : 'untested',
    });
    toDigest.push({
      ...fact,
      digestion_outcome: row.outcome,
      digestion_reason: row.reason,
      resulting_belief_id: beliefId,
    });
  }

  let beliefsDoc = normalizeCurrentBeliefs(
    currentBeliefs ?? store?.readCurrentBeliefs?.() ?? null,
  );
  let eventsWritten = 0;
  const beliefsCreated = [];

  if (beliefUpdates.length) {
    // Upsert: if belief already exists, strengthen/validate instead of create.
    const existingIds = new Set((beliefsDoc.beliefs || []).map((b) => b.id));
    const adjusted = beliefUpdates.map((update) => {
      if (!existingIds.has(update.belief_id)) return update;
      return {
        ...update,
        change: update.status === 'validated' ? 'validate' : 'strengthen',
      };
    });
    const applied = applyBeliefUpdates(beliefsDoc, adjusted, {
      cycleId,
      source: 'operator_fact_digestion',
    });
    // Stamp origin fields (applyBeliefUpdates create path may not copy custom fields).
    beliefsDoc = {
      ...applied.currentBeliefs,
      beliefs: (applied.currentBeliefs.beliefs || []).map((belief) => {
        const update = beliefUpdates.find((u) => u.belief_id === belief.id);
        if (!update) return belief;
        return {
          ...belief,
          origin: update.origin ?? belief.origin ?? null,
          origin_fact_id: update.origin_fact_id ?? belief.origin_fact_id ?? null,
          origin_verification: update.origin_verification ?? belief.origin_verification ?? null,
        };
      }),
    };
    if (store?.recordCurrentBeliefs) {
      store.recordCurrentBeliefs(beliefsDoc);
    }
    if (store?.recordBeliefEvent) {
      for (const event of applied.events) {
        eventsWritten += store.recordBeliefEvent(event);
      }
    }
    for (const update of beliefUpdates) {
      beliefsCreated.push({
        belief_id: update.belief_id,
        fact_id: update.origin_fact_id,
        status: update.status,
        outcome: update.origin_verification,
      });
    }
  }

  const questionsOpened = [];
  for (const plan of questionPlans) {
    try {
      const { question } = openOperatorQuestion(runtimeRoot, {
        question: plan.questionText,
        reason: plan.digestion.reason,
        trigger: 'operator_fact_contradicted',
        origin_fact_id: plan.fact.id,
        origin_fact_content: plan.fact.content,
        cycle_id: cycleId,
        created_by: 'operator_fact_digestion',
      });
      questionsOpened.push({
        question_id: question.id,
        fact_id: plan.fact.id,
      });
      const idx = toDigest.findIndex((f) => f.id === plan.fact.id);
      if (idx >= 0) {
        toDigest[idx] = {
          ...toDigest[idx],
          resulting_question_id: question.id,
        };
      }
    } catch (e) {
      failed.push({
        fact_id: plan.fact.id,
        reason: `question_open_failed: ${e?.message || String(e)}`,
      });
    }
  }

  // Move facts one-by-one so per-fact outcome metadata is preserved.
  const digested = [];
  for (const fact of toDigest) {
    const moved = markOperatorFactsDigested(runtimeRoot, [fact], {
      cycleId,
      batchId,
      outcome: fact.digestion_outcome || 'untested',
      reason: fact.digestion_reason,
      resultingBeliefId: fact.resulting_belief_id ?? null,
      resultingQuestionId: fact.resulting_question_id ?? null,
    });
    digested.push(...moved.moved);
    failed.push(...moved.failed);
  }

  if (store?.recordEvolutionEvent) {
    store.recordEvolutionEvent({
      type: 'operator_fact_digested',
      status: failed.length && !digested.length ? 'failed' : 'ok',
      cycle_id: cycleId,
      digested_count: digested.length,
      beliefs_created: beliefsCreated.length,
      questions_opened: questionsOpened.length,
      failed_count: failed.length,
      outcomes: digested.map((d) => ({ id: d.id, outcome: d.outcome })),
    });
  }

  return {
    digested,
    beliefs_created: beliefsCreated,
    questions_opened: questionsOpened,
    failed,
    currentBeliefs: beliefsDoc,
    eventsWritten,
  };
}

/**
 * Load pending facts that should be digested for this cycle.
 */
export function loadDigestibleOperatorFacts(runtimeRoot, { factIds = null } = {}) {
  const pending = readPendingOperatorFacts(runtimeRoot, { limit: 10_000 }).facts;
  const injected = selectInjectedOperatorFacts(pending);
  if (!Array.isArray(factIds) || !factIds.length) return injected;
  const allow = new Set(factIds);
  return injected.filter((f) => allow.has(f.id));
}
