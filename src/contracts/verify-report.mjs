import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireArray,
  requireOneOf,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import { EVIDENCE_PRODUCERS } from './evidence-envelope.mjs';
import { extractBeliefContext } from './belief-context.mjs';

export const EXPECTATION_COMPARISON_STATUSES = Object.freeze([
  'matched',
  'contradicted',
  'uncertain',
  'not_observed',
]);

const MAX_EXPECTED_ITEMS = 20;
const MAX_EXPECTED_ITEM_CHARS = 500;
const NARRATIVE_KEYS = new Set([
  'message',
  'summary',
  'reasoning',
  'reasoning_summary',
  'evidence_summary',
  'overall_summary',
  'raw_response',
  'raw_text',
  'agent_narrative',
  'narrative',
]);

function boundedText(value, maxChars = MAX_EXPECTED_ITEM_CHARS) {
  const text = String(value ?? '').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function normalizeExpectedOutput(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, MAX_EXPECTED_ITEMS)
    .map((item) => boundedText(item));
}

function countValue(value) {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return value == null || value === '' ? 0 : 1;
}

function compactVerifierValue(value, depth = 0) {
  if (depth > 3 || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => compactVerifierValue(item, depth + 1));
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string') return boundedText(value, 200);
    return value;
  }
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (NARRATIVE_KEYS.has(key)) continue;
    out[key] = compactVerifierValue(item, depth + 1);
  }
  return out;
}

function expectedOutputFromAction(action) {
  return action?.params?.run_spec?.expected_output
    ?? action?.params?.runSpec?.expectedOutput
    ?? action?.run_spec?.expected_output
    ?? action?.runSpec?.expectedOutput
    ?? null;
}

function comparisonStatusFromVerifier(value) {
  const candidate = value?.comparison_status
    ?? value?.expectation_status
    ?? value?.comparison?.status
    ?? null;
  return EXPECTATION_COMPARISON_STATUSES.includes(candidate) ? candidate : null;
}

function verifierForAction(entries, action, actionIndex) {
  const exact = entries.find((entry) => entry?.action === action);
  if (exact) return exact;
  const sameType = entries.filter((entry) => entry?.action?.type === action?.type);
  return sameType[actionIndex] ?? sameType[0] ?? null;
}

function observationSignals(result, mechanical, semantic) {
  const counters = {
    evidence: countValue(result?.evidence),
    writes: countValue(result?.writes),
    outputs: countValue(result?.outputs),
    created_files: countValue(result?.created_files ?? result?.createdFiles),
    modified_files: countValue(result?.modified_files ?? result?.modifiedFiles),
    test_results: countValue(result?.test_results ?? result?.testResults),
    next_actions: countValue(result?.next_actions ?? result?.nextActions),
  };
  const schemaStatus = result?.schema_status ?? result?.agent?.schema_status ?? null;
  const metric = mechanical?.metric ?? null;
  const verifierValue = compactVerifierValue(mechanical?.value);
  const sources = [];
  if (Object.values(counters).some((count) => count > 0) || schemaStatus) sources.push('exec_result');
  if (metric || mechanical?.value != null || comparisonStatusFromVerifier(mechanical)) {
    sources.push('mechanical_verifier');
  }
  if (comparisonStatusFromVerifier(semantic)) sources.push('semantic_verifier');
  return {
    counters,
    schema_status: schemaStatus,
    metric,
    verifier_value: verifierValue,
    sources,
  };
}

function criterionCategory(expected) {
  const text = expected.toLowerCase();
  if (/\b(test|tests|check|checks)\b|测试|校验/.test(text)) return 'test_results';
  if (/\b(diff|patch|write|writes|written|file|files|changed|created|modified)\b|写入|文件|变更|补丁/.test(text)) return 'writes';
  if (/\b(evidence|proof|receipt)\b|证据|回执/.test(text)) return 'evidence';
  if (/\b(output|outputs|result|results)\b|输出|结果/.test(text)) return 'outputs';
  if (/\b(json|schema)\b|结构化/.test(text)) return 'schema';
  if (/\b(next action|next actions|recommendation)\b|建议|后续动作/.test(text)) return 'next_actions';
  if (/\b(summary|report|analysis)\b|摘要|报告|分析/.test(text)) return 'narrative_only';
  return 'unknown';
}

function criterionObserved(category, signals) {
  if (category === 'test_results') return signals.counters.test_results > 0;
  if (category === 'writes') {
    return signals.counters.writes > 0
      || signals.counters.created_files > 0
      || signals.counters.modified_files > 0;
  }
  if (category === 'evidence') {
    return signals.counters.evidence > 0;
  }
  if (category === 'outputs') return signals.counters.outputs > 0;
  if (category === 'schema') return Boolean(signals.schema_status);
  if (category === 'next_actions') return signals.counters.next_actions > 0;
  return false;
}

function isGenericCriterion(expected, category) {
  const text = expected.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const generic = {
    test_results: /^(test|tests|test results?|tests pass|checks?|测试结果|测试通过|校验结果)$/,
    writes: /^(diff|diff summary|patch|writes?|written files?|changed files?|created files?|modified files?|文件变更|补丁摘要)$/,
    evidence: /^(evidence|proof|receipt|evidence receipt|证据|回执)$/,
    outputs: /^(output|outputs|result|results|输出|结果)$/,
    schema: /^(json|json receipt|strict json receipt|schema|structured receipt|结构化回执)$/,
    next_actions: /^(next action|next actions|recommendation|recommendations|建议|后续动作)$/,
  };
  return generic[category]?.test(text) ?? false;
}

function structuredResultText(result) {
  try {
    return JSON.stringify({
      evidence: result?.evidence ?? null,
      writes: result?.writes ?? null,
      outputs: result?.outputs ?? null,
      created_files: result?.created_files ?? result?.createdFiles ?? null,
      modified_files: result?.modified_files ?? result?.modifiedFiles ?? null,
      test_results: result?.test_results ?? result?.testResults ?? null,
      schema_status: result?.schema_status ?? result?.agent?.schema_status ?? null,
      next_actions: result?.next_actions ?? result?.nextActions ?? null,
    }).toLowerCase();
  } catch {
    return '';
  }
}

function criterionMatched(expected, category, signals, result) {
  if (!criterionObserved(category, signals)) return false;
  if (isGenericCriterion(expected, category)) return true;
  const expectedText = expected.toLowerCase().trim();
  return expectedText.length >= 3 && structuredResultText(result).includes(expectedText);
}

function hasFailedTest(result) {
  const tests = result?.test_results ?? result?.testResults;
  if (!Array.isArray(tests)) return false;
  return tests.some((item) => {
    if (item === false) return true;
    const status = typeof item === 'string'
      ? item
      : item?.status ?? item?.result ?? null;
    return /^(fail|failed|error|regressed)$/i.test(String(status ?? '').trim());
  });
}

function mechanicalContradiction(result, mechanical, expectedCategories) {
  if (comparisonStatusFromVerifier(mechanical) === 'contradicted') return true;
  if (result?.acceptance_status === 'failed' || result?.acceptance_status === 'contradicted') return true;
  if (expectedCategories.includes('test_results') && hasFailedTest(result)) return true;
  if (
    expectedCategories.includes('writes')
    && mechanical?.metric === 'file_outcomes'
    && Number(mechanical?.value?.files_missing) > 0
  ) return true;
  return false;
}

function aggregateComparisonStatus(actions) {
  const statuses = actions.map((item) => item.status);
  if (statuses.includes('contradicted')) return 'contradicted';
  if (statuses.every((status) => status === 'matched')) return 'matched';
  if (statuses.every((status) => status === 'not_observed')) return 'not_observed';
  return 'uncertain';
}

/**
 * Compare declared run_spec.expected_output with structured receipt/result evidence.
 * Narrative fields are intentionally excluded from observations.
 */
export function buildExpectedOutputComparison({
  execResult,
  mechanicalVerification = null,
  semanticVerification = null,
} = {}) {
  const executed = Array.isArray(execResult?.executed) ? execResult.executed : [];
  const mechanicalEntries = [
    ...(mechanicalVerification?.verified ?? []),
    ...(mechanicalVerification?.pending ?? []),
  ];
  const semanticEntries = semanticVerification?.status === 'ok'
    && Array.isArray(semanticVerification?.result?.semantic_verified)
    ? semanticVerification.result.semantic_verified
    : [];
  const actions = [];

  for (let index = 0; index < executed.length; index += 1) {
    const item = executed[index] ?? {};
    const action = item.action ?? {};
    const expectedItems = normalizeExpectedOutput(expectedOutputFromAction(action));
    if (!expectedItems.length) continue;
    const mechanical = verifierForAction(mechanicalEntries, action, index);
    const semantic = semanticEntries[index] ?? null;
    const actionResult = item.result ?? {};
    const signals = observationSignals(actionResult, mechanical, semantic);
    const categories = expectedItems.map(criterionCategory);
    const observedCriteria = categories.map((category) => criterionObserved(category, signals));
    const matchedCriteria = expectedItems.map((expected, criterionIndex) => criterionMatched(
      expected,
      categories[criterionIndex],
      signals,
      actionResult,
    ));
    const semanticStatus = comparisonStatusFromVerifier(semantic);
    const mechanicalStatus = comparisonStatusFromVerifier(mechanical);
    const hasStructuredContradiction = mechanicalContradiction(
      actionResult,
      mechanical,
      categories,
    );
    const explicitStatus = semanticStatus ?? mechanicalStatus;
    const observedCriteriaCount = observedCriteria.filter(Boolean).length;
    const domainVerifierObserved = categories.includes('unknown')
      && signals.sources.includes('mechanical_verifier');
    let status;
    if (
      hasStructuredContradiction
      || mechanicalStatus === 'contradicted'
      || semanticStatus === 'contradicted'
    ) {
      status = 'contradicted';
    } else {
      status = explicitStatus;
      if (!status && matchedCriteria.every(Boolean)) {
        status = 'matched';
      } else if (!status && (observedCriteriaCount > 0 || domainVerifierObserved)) {
        status = 'uncertain';
      } else if (!status) {
        status = 'not_observed';
      }
    }
    const executionId = execResult?.execution_id ?? execResult?.cycle_id ?? null;
    const receiptId = item.result?.receipt_id ?? item.result?.receiptId ?? null;
    const evidenceRefs = [
      executionId ? `exec_result:${executionId}#executed/${index}` : null,
      receiptId ? `action_receipt:${receiptId}` : null,
    ].filter(Boolean);
    const beliefContext = extractBeliefContext(action);
    actions.push({
      action_index: index,
      action_type: action?.type ?? null,
      status,
      execution_success: item.result?.success === true,
      expected: {
        source: 'run_spec.expected_output',
        items: expectedItems,
      },
      observed: {
        available: Boolean(
          explicitStatus
          || observedCriteriaCount > 0
          || domainVerifierObserved
          || status === 'contradicted',
        ),
        sources: signals.sources,
        evidence_refs: evidenceRefs,
        counters: signals.counters,
        schema_status: signals.schema_status,
        metric: signals.metric,
        verifier_value: signals.verifier_value,
      },
      reason: status === 'not_observed'
        ? 'No structured receipt/result or verifier observation was available; agent narrative is not observation.'
        : 'Execution success and expectation match are evaluated independently.',
      decision_id: item.decision_id ?? item.id ?? execResult?.decision_id ?? null,
      execution_id: executionId,
      producer_batch_id: item.producer_batch_id ?? item.producerBatchId ?? execResult?.producer_batch_id ?? null,
      reaction_id: item.reaction_id ?? item.reactionId ?? execResult?.reaction_id ?? null,
      belief_id: item.belief_id
        ?? item.beliefId
        ?? beliefContext.belief_id
        ?? execResult?.belief_id
        ?? null,
      belief_relation: beliefContext.belief_relation ?? null,
      expected_belief_claim: beliefContext.expected_belief_claim ?? null,
      expected_belief_update: beliefContext.expected_belief_update ?? null,
    });
  }

  if (!actions.length) return null;
  const status = aggregateComparisonStatus(actions);
  return {
    schema_version: 1,
    status,
    execution_success: execResult?.success === true,
    semantics: 'execution_success_does_not_imply_expectation_match',
    actions,
    settlement_signal: status === 'contradicted'
      ? {
        trigger: true,
        target: 'rule',
        reason: 'expected_output_contradicted',
      }
      : null,
  };
}

function validateComparison(comparison, path) {
  const base = requirePlainObject(comparison, path);
  if (!base.ok) return base;
  const checks = [
    requireOneOf(comparison.status, `${path}.status`, EXPECTATION_COMPARISON_STATUSES),
    requireArray(comparison.actions, `${path}.actions`),
  ];
  if (Array.isArray(comparison.actions)) {
    for (let index = 0; index < comparison.actions.length; index += 1) {
      const item = comparison.actions[index];
      checks.push(requirePlainObject(item, `${path}.actions[${index}]`));
      if (isPlainObject(item)) {
        checks.push(requireOneOf(
          item.status,
          `${path}.actions[${index}].status`,
          EXPECTATION_COMPARISON_STATUSES,
        ));
        checks.push(requirePlainObject(item.expected, `${path}.actions[${index}].expected`));
        checks.push(requirePlainObject(item.observed, `${path}.actions[${index}].observed`));
      }
    }
  }
  return mergeValidationResults(checks);
}

export function validateVerifyReport(report, path = 'verify_report') {
  const base = requirePlainObject(report, path);
  if (!base.ok) return base;
  const checks = [
    requireOptionalString(report.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(report.execution_id, `${path}.execution_id`, { allowEmpty: true }),
    requireOptionalString(report.producer_batch_id, `${path}.producer_batch_id`, { allowEmpty: true }),
    requireOptionalString(report.reaction_id, `${path}.reaction_id`, { allowEmpty: true }),
    requireOptionalString(report.decision_id, `${path}.decision_id`, { allowEmpty: true }),
    requireOptionalString(report.belief_id, `${path}.belief_id`, { allowEmpty: true }),
  ];
  if (report.summary != null) checks.push(requirePlainObject(report.summary, `${path}.summary`));
  if (report.actions != null) checks.push(requirePlainObject(report.actions, `${path}.actions`));
  if (report.comparison != null) {
    checks.push(validateComparison(report.comparison, `${path}.comparison`));
  }
  if (report.decision_ids != null) {
    checks.push(requireArray(report.decision_ids, `${path}.decision_ids`));
    if (Array.isArray(report.decision_ids)
      && !report.decision_ids.every((item) => typeof item === 'string' && item.trim())) {
      checks.push(fail(`${path}.decision_ids must be an array of non-empty strings`));
    }
  }
  if (report.producer != null && !EVIDENCE_PRODUCERS.includes(report.producer)) {
    checks.push(fail(`${path}.producer must be one of: ${EVIDENCE_PRODUCERS.join(', ')}`));
  }
  return mergeValidationResults(checks);
}
