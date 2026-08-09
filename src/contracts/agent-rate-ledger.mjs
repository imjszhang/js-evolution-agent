import {
  fail,
  mergeValidationResults,
  ok,
  requireArray,
  requireOptionalString,
  requirePlainObject,
} from './validation.mjs';

/**
 * Wall-clock agent_run rate ledger (subject runtime).
 * Required: version (number), entries (array of { ts: number, ... }).
 */
export function validateAgentRateLedger(ledger, path = 'agent_rate_ledger') {
  const base = requirePlainObject(ledger, path);
  if (!base.ok) return base;

  if (typeof ledger.version !== 'number' || !Number.isFinite(ledger.version)) {
    return fail(`${path}.version must be a finite number`);
  }

  const entriesCheck = requireArray(ledger.entries, `${path}.entries`);
  if (!entriesCheck.ok) return entriesCheck;

  const entryResults = [];
  for (let i = 0; i < ledger.entries.length; i += 1) {
    const entry = ledger.entries[i];
    const ep = `${path}.entries[${i}]`;
    const obj = requirePlainObject(entry, ep);
    if (!obj.ok) {
      entryResults.push(obj);
      continue;
    }
    if (typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) {
      entryResults.push(fail(`${ep}.ts must be a finite number`));
      continue;
    }
    entryResults.push(mergeValidationResults([
      requireOptionalString(entry.cycle_id, `${ep}.cycle_id`, { allowEmpty: true }),
      requireOptionalString(entry.decision_id, `${ep}.decision_id`, { allowEmpty: true }),
    ]));
  }
  return mergeValidationResults(entryResults);
}
