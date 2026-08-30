/**
 * Control-plane readiness for Cycle admission.
 *
 * Fresh subjects may start Cycle (the router pump creates an empty ledger).
 * Fresh means: no generation journal, no ledger, and no historical authority
 * evidence. A journal without a ready ledger is always a migration problem.
 * Upgraded subjects must not auto-start Cycle. Channel stays up.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_PATHS } from '../../intelligence/evidence-stream.mjs';
import { readJson } from '../../infra/json-store.mjs';
import {
  ACTIVATION_LEDGER_HOT_MAX_BYTES,
  ACTIVATION_LEDGER_PROJECTION_SCHEMA,
  activationLedgerPath,
  activationLedgerProjectionPath,
  ensureCompactActivationLedgerProjection,
  readActivationMigrationState,
  resumeActivationMigration,
} from './activation-ledger-store.mjs';
import {
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  evidenceSourceFileState,
  jsonDirectoryDescriptors,
  sourceDescriptors,
} from './evidence-index.mjs';

const DEFAULT_LEDGER_MAX_BYTES = 64 * 1024 * 1024;

const INCOMPLETE_MIGRATION = new Set([
  'inspecting',
  'building',
  'reconciling',
  'validating',
  'backing_up',
  'switching',
  'blocked',
  'failed',
]);

const LEDGER_BLOCK_REASONS = new Set([
  'migration_required',
  'activation_ledger_unresolved',
  'activation_ledger_degraded',
  'activation_ledger_oversized',
  'activation_ledger_unreadable',
  'activation_ledger_invalid',
  'activation_ledger_schema_mismatch',
  'activation_ledger_needs_migration',
]);

function journalManifest(dataRoot) {
  try {
    return readJson(evidenceIndexPath(dataRoot), null);
  } catch {
    return null;
  }
}

function ledgerFileState(dataRoot) {
  try {
    const file = activationLedgerPath(dataRoot);
    if (!existsSync(file)) {
      return { exists: false, bytes: null, readable: false };
    }
    const bytes = statSync(file).size;
    return { exists: true, bytes, readable: true, path: file };
  } catch {
    return { exists: false, bytes: null, readable: false };
  }
}

function classifyLedgerRead(snapshot) {
  if (!snapshot) return { ok: false, reason: 'activation_ledger_unresolved' };
  if (snapshot.status === 'ok') return { ok: true, reason: null, snapshot };
  if (snapshot.reason === 'activation_ledger_oversized') {
    return { ok: false, reason: 'activation_ledger_oversized', snapshot };
  }
  if (snapshot.status === 'degraded') {
    return { ok: false, reason: snapshot.reason || 'activation_ledger_degraded', snapshot };
  }
  return { ok: false, reason: snapshot.reason || 'activation_ledger_unresolved', snapshot };
}

function snapshotFromProjection(projection) {
  return {
    status: 'ok',
    reason: null,
    source: 'projection',
    generation: projection.generation ?? null,
    sequence: Number.isInteger(projection.sequence) ? projection.sequence : null,
    updated_at: projection.updated_at ?? null,
    reactors: projection.reactors ?? null,
    entries: Array.isArray(projection.open_entries) ? projection.open_entries : [],
  };
}

function readCompactProjection(dataRoot) {
  try {
    const file = activationLedgerProjectionPath(dataRoot);
    if (!existsSync(file)) return null;
    const raw = readJson(file, null);
    if (!raw || typeof raw !== 'object') return null;
    if (raw.schema_version != null && raw.schema_version !== ACTIVATION_LEDGER_PROJECTION_SCHEMA) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

const BOOTSTRAP_JSONL_KINDS = new Set(['intel_observations', 'evolution_events']);

function isBootstrapOnlyJsonl(absPath, kind) {
  if (!BOOTSTRAP_JSONL_KINDS.has(kind)) return false;
  try {
    const text = readFileSync(absPath, 'utf8');
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return true;
    return lines.every((line) => {
      const row = JSON.parse(line);
      if (kind === 'evolution_events') {
        return row?.type === 'data_initialized' || row?.source === 'jea data init';
      }
      const tags = Array.isArray(row?.tags) ? row.tags : [];
      return row?.source === 'jea data init'
        || tags.includes('init')
        || tags.includes('bootstrap');
    });
  } catch {
    return false;
  }
}

/**
 * True when STREAM_PATHS already hold non-bootstrap authority records.
 * Does not project envelopes or invent identities. `jea data init` seed
 * observations / data_initialized events alone do not count as history.
 */
export function hasHistoricalAuthorityEvidence(dataRoot) {
  if (!dataRoot) return false;
  try {
    for (const kind of Object.keys(STREAM_PATHS)) {
      for (const descriptor of sourceDescriptors(dataRoot, kind)) {
        const abs = join(dataRoot, descriptor.rel);
        const state = evidenceSourceFileState(abs);
        if (!state || state.size <= 0) continue;
        if (isBootstrapOnlyJsonl(abs, kind)) continue;
        return true;
      }
      for (const directory of jsonDirectoryDescriptors(kind)) {
        const absDir = join(dataRoot, directory.rel);
        if (!existsSync(absDir)) continue;
        let names;
        try {
          names = readdirSync(absDir);
        } catch {
          return true;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const state = evidenceSourceFileState(join(absDir, name));
          if (state && state.size > 0) return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

function blocked(reason, extras = {}) {
  return {
    ready: false,
    fresh_subject: false,
    allow_pump: false,
    reason,
    ...extras,
  };
}

/**
 * @param {{ dataRoot: string, env?: NodeJS.ProcessEnv, readLedger?: Function }} options
 */
export function inspectControlPlaneReadiness({
  dataRoot,
  env = process.env,
  readLedger = null,
} = {}) {
  if (!dataRoot) {
    return blocked('activation_ledger_unresolved', { migration: null, ledger: null });
  }

  const resumed = resumeActivationMigration(dataRoot);
  const migration = readActivationMigrationState(dataRoot);
  const manifest = journalManifest(dataRoot);
  let journalPath = false;
  try {
    journalPath = existsSync(evidenceIndexJournalPath(dataRoot));
  } catch {
    journalPath = false;
  }
  const hasJournal = Boolean(
    manifest?.generation
    && (journalPath || manifest.schema_version === EVIDENCE_INDEX_GENERATION_SCHEMA),
  );
  const ledgerFile = ledgerFileState(dataRoot);

  if (migration?.phase && INCOMPLETE_MIGRATION.has(migration.phase)) {
    return blocked('migration_required', {
      migration,
      resumed: resumed.resumed === true,
      ledger: null,
    });
  }

  if (hasJournal && !ledgerFile.exists) {
    const reason = migration?.phase === 'complete' || migration?.phase === 'switched'
      ? 'activation_ledger_unresolved'
      : 'migration_required';
    return blocked(reason, {
      migration,
      resumed: resumed.resumed === true,
      ledger: null,
    });
  }

  if (!hasJournal && !ledgerFile.exists) {
    if (hasHistoricalAuthorityEvidence(dataRoot)) {
      return blocked('migration_required', { migration, ledger: null });
    }
    return {
      ready: true,
      fresh_subject: true,
      allow_pump: true,
      reason: null,
      migration,
      ledger: null,
    };
  }

  const configuredMax = Number(env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES);
  const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_LEDGER_MAX_BYTES;
  const projection = readCompactProjection(dataRoot);
  if (!projection && ledgerFile.bytes != null && ledgerFile.bytes > ACTIVATION_LEDGER_HOT_MAX_BYTES) {
    return blocked(
      ledgerFile.bytes > maxBytes
        ? 'activation_ledger_oversized'
        : 'activation_ledger_needs_migration',
      { migration, ledger: null },
    );
  }
  if (ledgerFile.exists && (ledgerFile.bytes == null || ledgerFile.bytes <= maxBytes)) {
    ensureCompactActivationLedgerProjection(dataRoot);
  }
  const latestProjection = readCompactProjection(dataRoot);

  let ledgerSnapshot = null;
  if (latestProjection) {
    ledgerSnapshot = snapshotFromProjection(latestProjection);
  } else if (typeof readLedger === 'function') {
    ledgerSnapshot = readLedger(dataRoot, { env });
  } else if (ledgerFile.bytes != null && ledgerFile.bytes > maxBytes) {
    return blocked('activation_ledger_oversized', {
      migration,
      ledger: null,
    });
  }

  if (ledgerSnapshot) {
    const classified = classifyLedgerRead(ledgerSnapshot);
    if (!classified.ok) {
      return blocked(
        LEDGER_BLOCK_REASONS.has(classified.reason)
          ? classified.reason
          : 'activation_ledger_degraded',
        {
          migration,
          ledger: ledgerSnapshot,
        },
      );
    }
  }

  return {
    ready: true,
    fresh_subject: false,
    allow_pump: true,
    reason: null,
    migration,
    resumed: resumed.resumed === true,
    ledger: ledgerSnapshot,
  };
}

export function isControlPlaneBlockReason(reason) {
  return LEDGER_BLOCK_REASONS.has(reason);
}
