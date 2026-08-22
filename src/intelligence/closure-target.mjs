import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CLOSURE_TARGET_SCHEMA = 'closure-target.v1';
export const CLOSURE_TARGET_ID = '0.2.0-belief-loop';
export const CLOSURE_TARGET_PATH = 'policies/release/closure-target-0.2.0.json';

export const FROZEN_CLOSURE_TARGET = Object.freeze({
  schema_version: CLOSURE_TARGET_SCHEMA,
  target_id: CLOSURE_TARGET_ID,
  release: '0.2.0',
  audit_schema_version: 'closure-audit.v1',
  legacy_policy: 'report_separately_non_blocking',
  record_classification: Object.freeze({
    new_if: 'schema_version_or_any_correlation_metadata_present',
    legacy_unknown_if: 'all_required_metadata_absent_and_no_schema_version',
  }),
  required_sources: Object.freeze([
    'decision_queue',
    'claim_ledger',
    'current_beliefs',
    'standing_memory',
    'daemon_tasks',
    'action_receipts',
    'belief_events',
    'goal_events',
    'verify_reports',
  ]),
  required_metrics: Object.freeze({
    numeric: Object.freeze([
      'decision_coverage.belief_binding.failed',
      'decision_coverage.belief_binding.legacy_unknown',
      'decision_coverage.expected_output.failed',
      'decision_coverage.expected_output.legacy_unknown',
      'causal_correlation.decisions.partial',
      'causal_correlation.decisions.legacy_unknown',
      'causal_correlation.receipts.partial',
      'causal_correlation.receipts.legacy_unknown',
      'causal_correlation.verify_reports.partial',
      'causal_correlation.verify_reports.legacy_unknown',
      'causal_correlation.settlement_events.partial',
      'causal_correlation.settlement_events.legacy_unknown',
      'duplicate_settlement_candidates.candidate_groups',
      'duplicate_settlement_candidates.legacy_unknown',
    ]),
    status: 'standing_memory_freshness.status',
  }),
  checks: Object.freeze({
    new_record_belief_binding: Object.freeze({ metric: 'decision_coverage.belief_binding.failed', equals: 0 }),
    new_record_expected_output: Object.freeze({ metric: 'decision_coverage.expected_output.failed', equals: 0 }),
    causal_correlation: Object.freeze({ metric: 'causal_correlation.*.partial', equals: 0 }),
    duplicate_settlement: Object.freeze({ metric: 'duplicate_settlement_candidates.candidate_groups', equals: 0 }),
    memory_freshness: Object.freeze({ allowed_statuses: Object.freeze(['fresh', 'empty', 'not_applicable']) }),
  }),
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function validateFrozenClosureTarget(target) {
  const expected = JSON.stringify(stable(FROZEN_CLOSURE_TARGET));
  const actual = JSON.stringify(stable(target));
  return {
    ok: actual === expected,
    schema_version: target?.schema_version ?? null,
    target_id: target?.target_id ?? null,
    expected_target_id: CLOSURE_TARGET_ID,
  };
}

export function readFrozenClosureTarget(repoRoot) {
  const path = resolve(repoRoot, CLOSURE_TARGET_PATH);
  if (!existsSync(path)) {
    return { ok: false, path, target: null, reason: 'closure_target_missing' };
  }
  try {
    const target = JSON.parse(readFileSync(path, 'utf8'));
    const validation = validateFrozenClosureTarget(target);
    return {
      ...validation,
      path,
      target,
      reason: validation.ok ? 'closure_target_valid' : 'closure_target_changed',
    };
  } catch {
    return { ok: false, path, target: null, reason: 'closure_target_invalid_json' };
  }
}

function valueAt(value, path) {
  let current = value;
  for (const part of String(path).split('.')) current = current?.[part];
  return current;
}

function checkRequiredNumber(id, actual, expected = 0) {
  const valid = typeof actual === 'number' && Number.isFinite(actual);
  return {
    id,
    ok: valid && actual === expected,
    actual,
    expected,
    ...(valid ? {} : { reason: 'required_metric_invalid' }),
  };
}

export function evaluateClosureTarget(audit, target = FROZEN_CLOSURE_TARGET) {
  const metrics = audit?.metrics;
  const causal = metrics?.causal_correlation;
  const schemaChecks = (target.required_metrics?.numeric ?? []).map((path) => {
    const actual = valueAt(metrics, path);
    const valid = typeof actual === 'number' && Number.isFinite(actual);
    return {
      id: `required_metric.${path}`,
      ok: valid,
      actual,
      expected: 'finite_number',
      ...(valid ? {} : { reason: 'required_metric_invalid' }),
    };
  });
  const statusPath = target.required_metrics?.status;
  const memoryStatus = valueAt(metrics, statusPath);
  schemaChecks.push({
    id: `required_metric.${statusPath}`,
    ok: typeof memoryStatus === 'string' && memoryStatus.length > 0,
    actual: memoryStatus,
    expected: 'non_empty_string',
    ...(typeof memoryStatus === 'string' && memoryStatus.length > 0
      ? {}
      : { reason: 'required_metric_invalid' }),
  });
  const checks = [
    ...schemaChecks,
    checkRequiredNumber(
      'new_record_belief_binding',
      metrics?.decision_coverage?.belief_binding?.failed,
    ),
    checkRequiredNumber(
      'new_record_expected_output',
      metrics?.decision_coverage?.expected_output?.failed,
    ),
    ...['decisions', 'receipts', 'verify_reports', 'settlement_events'].map((name) => checkRequiredNumber(
      `causal_correlation.${name}`,
      causal?.[name]?.partial,
    )),
    checkRequiredNumber(
      'duplicate_settlement',
      metrics?.duplicate_settlement_candidates?.candidate_groups,
    ),
  ];
  const memoryAllowed = target.checks?.memory_freshness?.allowed_statuses;
  checks.push({
    id: 'memory_freshness',
    ok: Array.isArray(memoryAllowed) && memoryAllowed.includes(memoryStatus),
    actual: memoryStatus,
    expected: memoryAllowed,
  });
  const diagnostics = audit?.diagnostics;
  const requiredSources = target.required_sources;
  const sourceFailures = [];
  if (!Array.isArray(diagnostics) || !Array.isArray(requiredSources)) {
    sourceFailures.push({
      source: 'diagnostics',
      state: 'missing',
      reason: 'required_diagnostics_missing',
    });
  } else {
    for (const source of requiredSources) {
      const diagnostic = diagnostics.find((item) => item?.source === source);
      if (!diagnostic || diagnostic.state !== 'ok') {
        sourceFailures.push({
          source,
          state: diagnostic?.state ?? 'missing',
          reason: diagnostic?.reason ?? 'required_source_missing',
        });
      }
    }
    for (const diagnostic of diagnostics) {
      if (diagnostic?.state === 'corrupt' && !sourceFailures.some((item) => item.source === diagnostic.source)) {
        sourceFailures.push({
          source: diagnostic.source,
          state: 'corrupt',
          reason: diagnostic.reason ?? 'source_corrupt',
        });
      }
    }
  }
  checks.push({
    id: 'source_integrity',
    ok: sourceFailures.length === 0,
    actual: sourceFailures,
    expected: [],
  });
  const failures = checks.filter((item) => !item.ok);
  return {
    schema_version: CLOSURE_TARGET_SCHEMA,
    target_id: target.target_id,
    release: target.release,
    status: failures.length ? 'failed' : 'passed',
    ok: failures.length === 0,
    checks,
    failures,
    legacy_unknown: {
      belief_binding: metrics?.decision_coverage?.belief_binding?.legacy_unknown ?? null,
      expected_output: metrics?.decision_coverage?.expected_output?.legacy_unknown ?? null,
      causal: Object.fromEntries(
        ['decisions', 'receipts', 'verify_reports', 'settlement_events']
          .map((name) => [name, causal?.[name]?.legacy_unknown ?? null]),
      ),
      duplicate_settlement: metrics?.duplicate_settlement_candidates?.legacy_unknown ?? null,
      memory: memoryStatus === 'legacy_unknown' ? 1 : 0,
    },
  };
}
