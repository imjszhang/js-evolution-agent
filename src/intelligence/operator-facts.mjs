function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function timestampOf(record) {
  const raw = record?.recorded_at
    ?? record?.generated_at
    ?? record?.updated_at
    ?? record?.created_at
    ?? record?.timestamp;
  return Date.parse(raw || '') || 0;
}

function newestFirst(records) {
  return asArray(records)
    .slice()
    .sort((a, b) => timestampOf(b) - timestampOf(a));
}

export function isOperatorFact(record) {
  return record?.kind === 'operator_fact' || record?.source === 'operator_fact';
}

export function isHighConfidenceOperatorFact(record) {
  return !record?.confidence || record.confidence === 'high';
}

/** @param {unknown} value */
export function normalizeSupersedes(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Collect ids superseded by operator facts in the observation set.
 * Only operator_fact records' `supersedes` fields are honored.
 */
export function buildSupersededIds(observations) {
  const superseded = new Set();
  for (const record of asArray(observations)) {
    if (!isOperatorFact(record)) continue;
    for (const id of normalizeSupersedes(record.supersedes)) {
      superseded.add(id);
    }
  }
  return superseded;
}

export function isSupersededOperatorFact(record, supersededIds) {
  const id = record?.id;
  return id != null && supersededIds.has(id);
}

/**
 * Active operator facts: high-confidence, not superseded, newest first.
 * @param {object[]} observations
 * @param {{ limit?: number }} [opts]
 */
export function selectActiveOperatorFacts(observations, { limit } = {}) {
  const supersededIds = buildSupersededIds(observations);
  let active = newestFirst(observations).filter(
    (record) => isOperatorFact(record)
      && isHighConfidenceOperatorFact(record)
      && !isSupersededOperatorFact(record, supersededIds),
  );
  if (limit != null && limit > 0) {
    active = active.slice(0, limit);
  }
  return active;
}

/**
 * For context summaries: active operator facts first, then other observations.
 * Superseded operator facts are omitted from the prioritized list.
 */
export function prioritizeActiveOperatorFacts(records, limit = 20) {
  const all = asArray(records);
  const supersededIds = buildSupersededIds(all);
  const sorted = newestFirst(all);
  const activeFacts = sorted.filter(
    (record) => isOperatorFact(record)
      && isHighConfidenceOperatorFact(record)
      && !isSupersededOperatorFact(record, supersededIds),
  );
  const others = sorted.filter((record) => !isOperatorFact(record));
  return [...activeFacts, ...others].slice(0, limit);
}
