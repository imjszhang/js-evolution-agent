/**
 * Product-visible upgrade / activation-migration state machine.
 *
 * detect → inspect → disk_preflight → sidecar_backup → stage → validate
 * → atomic_switch → ready
 *
 * Derived from the existing evidence-journal / activation-migration lifecycle.
 * Persists only through activation-migration.json. Never a second ledger store.
 * Never auto-rebuilds, silent-backfills, or picks a rollback backup.
 */
import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { STREAM_PATHS } from '../../intelligence/evidence-stream.mjs';
import { readJson } from '../../infra/json-store.mjs';
import {
  INITIAL_ACTIVATION_POLICY_VERSION,
  evaluateActivationPolicyChange,
} from '../../contracts/index.mjs';
import {
  UPGRADE_MIGRATION_PHASES,
  UPGRADE_OPERATOR_ACTIONS,
  hasMatchingGenerationJournal,
  inspectActivationLedgerFile,
  readActivationLedgerStore,
  readActivationMigrationState,
  resumeActivationMigration,
  toProductUpgradePhase,
  writeActivationMigrationState,
} from './activation-ledger-store.mjs';
import {
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  evidenceIndexBackupsDir,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  evidenceSourceFileState,
  jsonDirectoryDescriptors,
  sourceDescriptors,
} from './evidence-index.mjs';

export {
  UPGRADE_MIGRATION_PHASES,
  UPGRADE_OPERATOR_ACTIONS,
  toProductUpgradePhase,
};

export const UPGRADE_MIGRATION_SCHEMA = 'upgrade_migration.v1';
export const DISK_PREFLIGHT_MULTIPLIER = 3;

const REBUILD_IN_FLIGHT = new Set([
  'inspecting',
  'building',
  'reconciling',
  'validating',
  'backing_up',
  'switching',
  'staging',
  'sidecar_backup',
  'stage',
  'validate',
  'atomic_switch',
  'disk_preflight',
]);

const TERMINAL_READY = new Set(['complete', 'ready']);

function journalManifest(dataRoot) {
  try {
    return readJson(evidenceIndexPath(dataRoot), null);
  } catch {
    return null;
  }
}

function journalFileState(dataRoot) {
  try {
    const path = evidenceIndexJournalPath(dataRoot);
    if (!existsSync(path)) return { exists: false, bytes: 0, path };
    return { exists: true, bytes: statSync(path).size, path };
  } catch {
    return { exists: false, bytes: 0, path: null };
  }
}

export function estimateAuthorityBytes(dataRoot) {
  if (!dataRoot) return 0;
  let bytes = 0;
  try {
    for (const kind of Object.keys(STREAM_PATHS)) {
      for (const descriptor of sourceDescriptors(dataRoot, kind)) {
        const state = evidenceSourceFileState(join(dataRoot, descriptor.rel));
        if (state?.size > 0) bytes += state.size;
      }
      for (const directory of jsonDirectoryDescriptors(kind)) {
        const absDir = join(dataRoot, directory.rel);
        if (!existsSync(absDir)) continue;
        let names;
        try {
          names = readdirSync(absDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const state = evidenceSourceFileState(join(absDir, name));
          if (state?.size > 0) bytes += state.size;
        }
      }
    }
  } catch {
    return bytes;
  }
  return bytes;
}

export function inspectDiskPreflight(dataRoot, {
  journalBytes = 0,
  authorityBytes = 0,
} = {}) {
  const required_bytes = Math.max(0, (Number(journalBytes) + Number(authorityBytes)) * DISK_PREFLIGHT_MULTIPLIER);
  if (!dataRoot) {
    return { ok: true, unknown: true, available_bytes: null, required_bytes };
  }
  try {
    const info = statfsSync(dataRoot);
    const available_bytes = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(available_bytes) || available_bytes < 0) {
      return { ok: true, unknown: true, available_bytes: null, required_bytes };
    }
    return {
      ok: required_bytes === 0 || available_bytes >= required_bytes,
      unknown: false,
      available_bytes,
      required_bytes,
    };
  } catch {
    return { ok: true, unknown: true, available_bytes: null, required_bytes };
  }
}

export function listSidecarBackupIds(dataRoot) {
  const root = dataRoot ? evidenceIndexBackupsDir(dataRoot) : null;
  if (!root || !existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function detectPolicyBackfill(dataRoot, manifest) {
  const ledger = inspectActivationLedgerFile(dataRoot, { manifest });
  if (!ledger.exists || ledger.empty || !ledger.readable || !ledger.generation) {
    return false;
  }
  let store;
  try {
    store = readActivationLedgerStore(dataRoot, { manifest });
  } catch {
    return false;
  }
  const from = store.activation_policy_version;
  if (!from || from === INITIAL_ACTIVATION_POLICY_VERSION) return false;
  const decision = evaluateActivationPolicyChange({
    from_activation_policy_version: from,
    to_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    replay_epoch: null,
  });
  return decision.action === 'require_replay_epoch';
}

function persistIfChanged(dataRoot, next, persist) {
  if (!persist || !dataRoot) return next;
  const current = readActivationMigrationState(dataRoot);
  const same = current.phase === next.phase
    && current.product_phase === next.product_phase
    && current.operator_action === next.operator_action
    && current.block_reason === next.block_reason
    && current.generation === next.generation;
  if (same) return current;
  return writeActivationMigrationState(dataRoot, {
    phase: next.phase,
    product_phase: next.product_phase,
    operation: next.operation ?? current.operation ?? 'upgrade',
    generation: next.generation,
    previous_generation: next.previous_generation ?? current.previous_generation,
    operator_action: next.operator_action,
    block_reason: next.block_reason,
  });
}

function view({
  phase,
  ready,
  reason,
  operator_action = null,
  generation = null,
  previous_generation = null,
  resumed = false,
  disk = null,
  cycle_blocked = null,
}) {
  const product = toProductUpgradePhase(phase) ?? phase;
  return {
    schema: UPGRADE_MIGRATION_SCHEMA,
    phase: product,
    ready: ready === true,
    cycle_blocked: cycle_blocked == null ? ready !== true : cycle_blocked,
    channel_available: true,
    operator_action: UPGRADE_OPERATOR_ACTIONS.includes(operator_action) ? operator_action : null,
    reason: reason ?? null,
    generation,
    previous_generation,
    resumed: resumed === true,
    disk,
  };
}

/**
 * @param {{
 *   dataRoot: string,
 *   history?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   persist?: boolean,
 * }} options
 */
export function inspectUpgradeMigration({
  dataRoot,
  history = false,
  persist = true,
} = {}) {
  if (!dataRoot) {
    return view({
      phase: 'detect',
      ready: false,
      reason: 'activation_ledger_unresolved',
    });
  }

  const resumed = resumeActivationMigration(dataRoot);
  const migration = readActivationMigrationState(dataRoot);
  const manifest = journalManifest(dataRoot);
  const matchingJournal = hasMatchingGenerationJournal(dataRoot, manifest);
  const journal = journalFileState(dataRoot);
  const ledger = inspectActivationLedgerFile(dataRoot, { manifest });
  const backups = listSidecarBackupIds(dataRoot);
  const authorityBytes = history ? estimateAuthorityBytes(dataRoot) : 0;
  const disk = inspectDiskPreflight(dataRoot, {
    journalBytes: journal.bytes,
    authorityBytes,
  });

  if (resumed.resumed === true) {
    persistIfChanged(dataRoot, {
      phase: 'complete',
      product_phase: 'ready',
      generation: resumed.generation,
      operator_action: null,
      block_reason: null,
    }, persist);
    return view({
      phase: 'ready',
      ready: true,
      reason: null,
      generation: resumed.generation,
      previous_generation: migration.previous_generation,
      resumed: true,
      disk,
    });
  }

  const storedOperator = UPGRADE_OPERATOR_ACTIONS.includes(migration.operator_action)
    ? migration.operator_action
    : null;
  const storedPhase = toProductUpgradePhase(migration.phase);
  const inFlight = REBUILD_IN_FLIGHT.has(migration.phase) || REBUILD_IN_FLIGHT.has(storedPhase);

  if (inFlight) {
    let operator_action = storedOperator;
    let phase = storedPhase || 'inspect';
    if (disk.ok === false && ['detect', 'inspect', 'disk_preflight'].includes(phase)) {
      operator_action = 'insufficient_disk';
      phase = 'disk_preflight';
    }
    if (
      (migration.phase === 'switched' || storedPhase === 'atomic_switch')
      && !operator_action
      && backups.length > 0
    ) {
      operator_action = 'rollback_selection';
    }
    persistIfChanged(dataRoot, {
      phase: migration.phase,
      product_phase: phase,
      generation: migration.generation ?? manifest?.generation ?? null,
      previous_generation: migration.previous_generation,
      operator_action,
      block_reason: migration.block_reason || 'migration_required',
    }, persist);
    return view({
      phase,
      ready: false,
      reason: migration.block_reason || 'migration_required',
      operator_action,
      generation: migration.generation ?? manifest?.generation ?? null,
      previous_generation: migration.previous_generation,
      resumed: false,
      disk,
    });
  }

  if (migration.phase === 'blocked' || migration.phase === 'failed') {
    const operator_action = storedOperator
      || (backups.length > 0 ? 'rollback_selection' : null);
    return view({
      phase: storedPhase || 'inspect',
      ready: false,
      reason: migration.block_reason || 'migration_required',
      operator_action,
      generation: migration.generation ?? manifest?.generation ?? null,
      previous_generation: migration.previous_generation,
      disk,
    });
  }

  const needsHistoryMigration = history && (
    !matchingJournal
    || !ledger.exists
    || ledger.empty
    || (ledger.generation && manifest?.generation && ledger.generation !== manifest.generation)
  );
  const needsJournalLedger = matchingJournal && !ledger.exists;

  if (needsHistoryMigration || needsJournalLedger) {
    let phase = 'detect';
    let operator_action = storedOperator;
    if (disk.ok === false) {
      phase = 'disk_preflight';
      operator_action = 'insufficient_disk';
    } else if (storedOperator) {
      phase = storedOperator === 'insufficient_disk' ? 'disk_preflight' : 'inspect';
    } else if (ledger.exists || matchingJournal) {
      phase = 'inspect';
    }
    persistIfChanged(dataRoot, {
      phase,
      product_phase: phase,
      operation: 'upgrade',
      generation: manifest?.generation ?? migration.generation ?? null,
      operator_action,
      block_reason: 'migration_required',
    }, persist);
    return view({
      phase,
      ready: false,
      reason: 'migration_required',
      operator_action,
      generation: manifest?.generation ?? migration.generation ?? null,
      previous_generation: migration.previous_generation,
      disk,
    });
  }

  if (TERMINAL_READY.has(migration.phase) || storedPhase === 'ready') {
    if (history && (!matchingJournal || ledger.empty || !ledger.exists)) {
      persistIfChanged(dataRoot, {
        phase: 'detect',
        product_phase: 'detect',
        operation: 'upgrade',
        generation: manifest?.generation ?? null,
        operator_action: storedOperator,
        block_reason: 'migration_required',
      }, persist);
      return view({
        phase: 'detect',
        ready: false,
        reason: 'migration_required',
        operator_action: storedOperator,
        generation: manifest?.generation ?? null,
        disk,
      });
    }
  }

  if (history && matchingJournal && ledger.exists && !ledger.empty) {
    if (detectPolicyBackfill(dataRoot, manifest)) {
      persistIfChanged(dataRoot, {
        phase: 'inspect',
        product_phase: 'inspect',
        operation: 'upgrade',
        generation: manifest?.generation ?? null,
        operator_action: 'policy_backfill',
        block_reason: 'policy_backfill',
      }, persist);
      return view({
        phase: 'inspect',
        ready: false,
        reason: 'policy_backfill',
        operator_action: 'policy_backfill',
        generation: manifest?.generation ?? null,
        disk,
      });
    }
  }

  return view({
    phase: 'ready',
    ready: true,
    reason: null,
    generation: manifest?.generation ?? migration.generation ?? null,
    previous_generation: migration.previous_generation,
    resumed: false,
    disk,
  });
}
