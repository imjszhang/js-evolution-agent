import { readJson, updateJson } from './json-store.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNonNegative(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function retentionPolicy(name, options = {}, env = process.env) {
  const prefix = `JEA_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return {
    retentionDays: finiteNonNegative(
      options.retentionDays ?? env[`${prefix}_RETENTION_DAYS`] ?? env.JEA_SIDECAR_RETENTION_DAYS,
      30,
    ),
    maxTerminal: Math.floor(finiteNonNegative(
      options.maxTerminal ?? env[`${prefix}_HOT_MAX`] ?? env.JEA_SIDECAR_HOT_MAX,
      1000,
    )),
  };
}

export function terminalArchiveCandidates(records, {
  now = Date.now(),
  retentionDays = 30,
  maxTerminal = 1000,
  isTerminal,
  timestamp,
} = {}) {
  const terminal = records
    .filter((record) => isTerminal(record))
    .sort((a, b) => String(timestamp(b) || '').localeCompare(String(timestamp(a) || '')));
  const keep = new Set(terminal.slice(0, Math.max(0, maxTerminal)));
  const cutoff = now - Math.max(0, retentionDays) * DAY_MS;
  return terminal.filter((record) => {
    const parsed = Date.parse(timestamp(record) || '');
    const old = Number.isFinite(parsed) && parsed <= cutoff;
    return old || !keep.has(record);
  });
}

/**
 * Append records to an auditable JSON archive with idempotent keys.
 * The archive write is atomic and locked. Call this before pruning hot state.
 */
export function archiveJsonRecords(filePath, records, {
  collection = 'records',
  idOf = (record) => record?.id,
  now = new Date().toISOString(),
} = {}) {
  if (!records.length) return { archived: 0, total: 0 };
  let added = 0;
  const next = updateJson(filePath, (raw) => {
    const existing = Array.isArray(raw?.[collection]) ? raw[collection] : [];
    const ids = new Set(existing.map(idOf).filter(Boolean));
    const merged = [...existing];
    for (const record of records) {
      const id = idOf(record);
      if (id && ids.has(id)) continue;
      merged.push(record);
      if (id) ids.add(id);
      added += 1;
    }
    return {
      ...raw,
      [collection]: merged,
      updated_at: now,
    };
  }, { fallback: { [collection]: [], updated_at: null } });
  return { archived: added, total: next[collection].length };
}

export function readArchive(filePath, collection = 'records') {
  const raw = readJson(filePath, { [collection]: [] });
  return Array.isArray(raw?.[collection]) ? raw[collection] : [];
}
