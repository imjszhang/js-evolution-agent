/**
 * Control-plane readiness for Cycle admission.
 *
 * Fresh subjects may start Cycle (the router pump creates an empty ledger).
 * Upgraded subjects with a missing, degraded, oversized, or incomplete
 * Activation Ledger / migration must not auto-start Cycle. Channel stays up.
 */
import { existsSync, statSync } from 'node:fs';
import { readJson } from '../../infra/json-store.mjs';
import {
  activationLedgerPath,
  activationLedgerProjectionPath,
  readActivationMigrationState,
  resumeActivationMigration,
} from './activation-ledger-store.mjs';
import {
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  readEvidenceJournalState,
} from './evidence-index.mjs';

const DEFAULT_LEDGER_MAX_BYTES = 64 * 1024 * 1024;

export const FRESH_JOURNAL_ENTRY_BUDGET = 64;
export const FRESH_JOURNAL_BYTES_BUDGET = 256 * 1024;

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
]);

function journalManifest(dataRoot) {
  try {
    return readJson(evidenceIndexPath(dataRoot), null);
  } catch {
    return null;
  }
}

function journalLineEstimate(dataRoot, manifest) {
  const state = readEvidenceJournalState(dataRoot);
  const lines = Number(state?.journal_lines ?? state?.unique_evidence_keys ?? 0);
  if (Number.isFinite(lines) && lines > 0) return lines;
  const path = evidenceIndexJournalPath(dataRoot);
  if (!existsSync(path)) return 0;
  try {
    const bytes = statSync(path).size;
    if (bytes > FRESH_JOURNAL_BYTES_BUDGET && lines === 0) return Number.POSITIVE_INFINITY;
    return 0;
  } catch {
    return manifest?.journal_size ? Number.POSITIVE_INFINITY : 0;
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

/**
 * @param {{ dataRoot: string, env?: NodeJS.ProcessEnv, readLedger?: Function }} options
 */
export function inspectControlPlaneReadiness({
  dataRoot,
  env = process.env,
  readLedger = null,
} = {}) {
  if (!dataRoot) {
    return {
      ready: false,
      fresh_subject: false,
      allow_pump: false,
      reason: 'activation_ledger_unresolved',
      migration: null,
      ledger: null,
    };
  }

  const resumed = resumeActivationMigration(dataRoot);
  const migration = readActivationMigrationState(dataRoot);
  const manifest = journalManifest(dataRoot);
  const journalPath = existsSync(evidenceIndexJournalPath(dataRoot));
  const hasJournal = Boolean(
    manifest?.generation
    && (journalPath || manifest.schema_version === EVIDENCE_INDEX_GENERATION_SCHEMA),
  );
  const ledgerFile = ledgerFileState(dataRoot);

  if (migration?.phase && INCOMPLETE_MIGRATION.has(migration.phase)) {
    return {
      ready: false,
      fresh_subject: false,
      allow_pump: false,
      reason: 'migration_required',
      migration,
      resumed: resumed.resumed === true,
      ledger: null,
    };
  }

  let ledgerSnapshot = null;
  if (typeof readLedger === 'function') {
    ledgerSnapshot = readLedger(dataRoot, { env });
  }

  if (!hasJournal && !ledgerFile.exists) {
    return {
      ready: true,
      fresh_subject: true,
      allow_pump: true,
      reason: null,
      migration,
      ledger: ledgerSnapshot,
    };
  }

  const lines = journalLineEstimate(dataRoot, manifest);
  const freshBudget = lines <= FRESH_JOURNAL_ENTRY_BUDGET;

  if (!ledgerFile.exists) {
    if (migration?.phase === 'complete' || migration?.phase === 'switched') {
      return {
        ready: false,
        fresh_subject: false,
        allow_pump: false,
        reason: 'activation_ledger_unresolved',
        migration,
        resumed: resumed.resumed === true,
        ledger: null,
      };
    }
    if (!migration?.phase && freshBudget) {
      return {
        ready: true,
        fresh_subject: true,
        allow_pump: true,
        reason: null,
        migration,
        ledger: null,
      };
    }
    return {
      ready: false,
      fresh_subject: false,
      allow_pump: false,
      reason: 'migration_required',
      migration,
      ledger: null,
    };
  }

  const configuredMax = Number(env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES);
  const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_LEDGER_MAX_BYTES;
  let hasProjection = false;
  try {
    hasProjection = existsSync(activationLedgerProjectionPath(dataRoot));
  } catch {
    hasProjection = false;
  }

  if (ledgerFile.bytes != null && ledgerFile.bytes > maxBytes && !hasProjection) {
    return {
      ready: false,
      fresh_subject: false,
      allow_pump: false,
      reason: 'activation_ledger_oversized',
      migration,
      ledger: ledgerSnapshot,
    };
  }

  if (!ledgerSnapshot && typeof readLedger === 'function') {
    ledgerSnapshot = readLedger(dataRoot, { env });
  } else if (ledgerFile.exists && !ledgerSnapshot) {
    const raw = readJson(ledgerFile.path, null);
    if (raw == null && !hasProjection) {
      return {
        ready: false,
        fresh_subject: false,
        allow_pump: false,
        reason: 'activation_ledger_degraded',
        migration,
        ledger: null,
      };
    }
  }

  if (ledgerSnapshot) {
    const classified = classifyLedgerRead(ledgerSnapshot);
    if (!classified.ok) {
      return {
        ready: false,
        fresh_subject: false,
        allow_pump: false,
        reason: LEDGER_BLOCK_REASONS.has(classified.reason)
          ? classified.reason
          : 'activation_ledger_degraded',
        migration,
        ledger: ledgerSnapshot,
      };
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
