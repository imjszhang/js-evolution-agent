import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export function validateVerifyReport(report, path = 'verify_report') {
  const base = requirePlainObject(report, path);
  if (!base.ok) return base;
  const checks = [
    requireOptionalString(report.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
  ];
  if (report.summary != null) checks.push(requirePlainObject(report.summary, `${path}.summary`));
  if (report.actions != null) checks.push(requirePlainObject(report.actions, `${path}.actions`));
  return mergeValidationResults(checks);
}
