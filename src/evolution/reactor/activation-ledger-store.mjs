/**
 * Derived Activation Ledger (Reactor Inbox).
 *
 * Ledger v2: hot open work in activation-ledger.json, generation-scoped
 * terminal shards, and a compact projection. One owner — daemon only reads.
 * Crash-safe mutateLedger stages the next hot ledger + filtered delta log +
 * projection, then renameSync deltas then ledger; projection follows the switch.
 * Never authority for evidence, beliefs, goals, receipts, or settlements.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ACTIVATION_LANES,
  ACTIVATION_LEDGER_STATES,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  REACTOR_CONTROL_PLANE_ROLE,
  applyActivationLedgerTransition,
  classifyActivationReappearance,
  formatActivationIdentity,
  handleContractValidation,
  isReactorControlPlaneAuthoritative,
  laneOpenCount,
  normalizeActivationIdentity,
  normalizeActivationLedgerEntry,
  reconcileLaneCounts,
  rejectControlPlanePayloads,
  validateActivationLedgerEntry,
} from '../../contracts/index.mjs';
import { EVIDENCE_BATCH_REACTORS } from '../../contracts/evidence-batch-claim.mjs';
import { readJson, withJsonLock } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import {
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  evidenceIndexDir,
  evidenceIndexJournalPath,
  evidenceIndexPath,
} from './evidence-index.mjs';
import { reactorDir } from './paths.mjs';
import {
  appendTerminalEntries,
  copyTerminalDirectory,
  findTerminalEntry,
  hydrateTerminalEntries,
  installStagedTerminal,
  iterateTerminalEntries,
  listTerminalHandledEvidenceKeys,
  listTerminalIdentityKeys,
  mergeHandledCountsIntoReactors,
  readTerminalManifest,
  terminalHasIdentity,
} from './activation-ledger-terminal.mjs';

export const ACTIVATION_LEDGER_STORE_SCHEMA_V1 = 'activation-ledger.v1';
export const ACTIVATION_LEDGER_STORE_SCHEMA = 'activation-ledger.v2';
export const ACTIVATION_LEDGER_PROJECTION_SCHEMA = 'activation-ledger-projection.v1';
export const ACTIVATION_MIGRATION_STATE_SCHEMA = 'activation-migration.v1';
export const ACTIVATION_LEDGER_FILENAME = 'activation-ledger.json';
export const ACTIVATION_LEDGER_PROJECTION_FILENAME = 'activation-ledger.projection.json';
export const ACTIVATION_LEDGER_DELTAS_FILENAME = 'activation-ledger.deltas.jsonl';
export const ACTIVATION_LEDGER_HOT_MAX_BYTES = 8 * 1024 * 1024;
export const ACTIVATION_LEDGER_FAILPOINTS = Object.freeze({
  BEFORE_SWITCH: 'before_switch',
  AFTER_SWITCH: 'after_switch',
  AFTER_DELTAS_BEFORE_PROJECTION: 'after_deltas_before_projection',
  BETWEEN_DELTA_AND_SNAPSHOT: 'between_delta_and_snapshot',
});
export {
  ACTIVATION_LEDGER_TERMINAL_DIR,
  activationLedgerTerminalDir,
} from './activation-ledger-terminal.mjs';

export const UPGRADE_MIGRATION_PHASES = Object.freeze([
  'detect',
  'inspect',
  'disk_preflight',
  'sidecar_backup',
  'stage',
  'validate',
  'atomic_switch',
  'ready',
]);

export const UPGRADE_OPERATOR_ACTIONS = Object.freeze([
  'authority_mismatch',
  'insufficient_disk',
  'unknown_identities',
  'rollback_selection',
  'policy_backfill',
]);

const PRODUCT_PHASE_ALIASES = Object.freeze({
  inspecting: 'inspect',
  building: 'stage',
  reconciling: 'inspect',
  validating: 'validate',
  backing_up: 'sidecar_backup',
  staging: 'stage',
  switching: 'atomic_switch',
  switched: 'atomic_switch',
  complete: 'ready',
  detect: 'detect',
  inspect: 'inspect',
  disk_preflight: 'disk_preflight',
  sidecar_backup: 'sidecar_backup',
  stage: 'stage',
  validate: 'validate',
  atomic_switch: 'atomic_switch',
  ready: 'ready',
});

export function toProductUpgradePhase(phase) {
  if (phase == null || phase === '') return null;
  return PRODUCT_PHASE_ALIASES[phase] ?? null;
}

const OPEN_LEDGER_STATES = Object.freeze(['ready', 'claimed', 'deferred', 'blocked']);

const MAX_HOT_DIAGNOSTICS = 256;
const REACTORS = EVIDENCE_BATCH_REACTORS;

export function activationLedgerPath(dataRoot, manifest = null) {
  if (!dataRoot && !manifest) {
    throw new Error('activationLedgerPath requires dataRoot or a generation manifest');
  }
  return join(evidenceIndexDir(dataRoot, manifest), ACTIVATION_LEDGER_FILENAME);
}

export function activationLedgerProjectionPath(dataRoot, manifest = null) {
  if (!dataRoot && !manifest) {
    throw new Error('activationLedgerProjectionPath requires dataRoot or a generation manifest');
  }
  return join(evidenceIndexDir(dataRoot, manifest), ACTIVATION_LEDGER_PROJECTION_FILENAME);
}

export function activationLedgerDeltasFile(dataRoot, manifest = null) {
  if (!dataRoot && !manifest) {
    throw new Error('activationLedgerDeltasFile requires dataRoot or a generation manifest');
  }
  return join(evidenceIndexDir(dataRoot, manifest), ACTIVATION_LEDGER_DELTAS_FILENAME);
}

export function activationMigrationStatePath(dataRoot) {
  return join(reactorDir(dataRoot), 'activation-migration.json');
}

export function emptyActivationLedgerStore({
  generation = null,
  previous_generation = null,
  activation_policy_version = INITIAL_ACTIVATION_POLICY_VERSION,
  updated_at = null,
} = {}) {
  return {
    schema_version: ACTIVATION_LEDGER_STORE_SCHEMA,
    contract_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    role: 'derived_rebuildable',
    authoritative: false,
    rebuildable: REACTOR_CONTROL_PLANE_ROLE.rebuildable,
    generation,
    previous_generation,
    activation_policy_version,
    sequence: 0,
    updated_at,
    entries: {},
    diagnostics: [],
    diagnostics_dropped: 0,
    terminal_history: [],
    terminal: null,
    handled_total: 0,
    open_total: 0,
    reactors: null,
    migrated_from: null,
  };
}

export function emptyActivationLedger(now = nowIso()) {
  return emptyActivationLedgerStore({ updated_at: now, activation_policy_version: null });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function identityKeyOf(entry) {
  if (entry?.identity_key) return entry.identity_key;
  const normalized = normalizeActivationIdentity(entry?.identity);
  return normalized.ok ? formatActivationIdentity(normalized.identity) : null;
}

export function entriesFromStore(store) {
  if (Array.isArray(store?.entries)) return store.entries.slice();
  if (store?.entries && typeof store.entries === 'object') {
    return Object.values(store.entries);
  }
  return [];
}

export function entryMapFromStore(store) {
  if (store?.entries && typeof store.entries === 'object' && !Array.isArray(store.entries)) {
    return { ...store.entries };
  }
  const map = {};
  for (const entry of asArray(store?.entries)) {
    const key = identityKeyOf(entry);
    if (key) map[key] = entry;
  }
  return map;
}

function currentGeneration(dataRoot, manifest = null) {
  const raw = manifest ?? (dataRoot ? readJson(evidenceIndexPath(dataRoot), null) : null);
  return raw?.generation ?? null;
}

function asStore(raw, extras = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyActivationLedgerStore(extras);
  }
  const sequence = Number.isInteger(raw.sequence)
    ? raw.sequence
    : (Number.isInteger(extras.sequence) ? extras.sequence : null);
  const base = emptyActivationLedgerStore({
    generation: raw.generation ?? extras.generation ?? null,
    previous_generation: raw.previous_generation ?? extras.previous_generation ?? null,
    activation_policy_version: raw.activation_policy_version ?? extras.activation_policy_version,
    updated_at: raw.updated_at ?? extras.updated_at ?? null,
  });
  return {
    ...base,
    schema_version: raw.schema_version ?? ACTIVATION_LEDGER_STORE_SCHEMA,
    contract_version: raw.contract_version ?? REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    role: 'derived_rebuildable',
    authoritative: false,
    rebuildable: true,
    sequence,
    entries: entryMapFromStore(raw),
    diagnostics: asArray(raw.diagnostics),
    diagnostics_dropped: Number(raw.diagnostics_dropped || 0),
    terminal_history: Array.isArray(raw.terminal_history) ? raw.terminal_history : [],
    terminal: raw.terminal && typeof raw.terminal === 'object' ? raw.terminal : null,
    handled_total: Number.isInteger(raw.handled_total) ? raw.handled_total : extras.handled_total ?? 0,
    open_total: Number.isInteger(raw.open_total) ? raw.open_total : extras.open_total ?? 0,
    reactors: raw.reactors && typeof raw.reactors === 'object' ? raw.reactors : extras.reactors ?? null,
    migrated_from: raw.migrated_from ?? extras.migrated_from ?? null,
  };
}

export function isActivationLedgerV2(store) {
  return store?.schema_version === ACTIVATION_LEDGER_STORE_SCHEMA;
}

export function isDeclaredActivationLedgerSchema(schemaVersion) {
  return schemaVersion === ACTIVATION_LEDGER_STORE_SCHEMA
    || schemaVersion === ACTIVATION_LEDGER_STORE_SCHEMA_V1
    || schemaVersion === REACTOR_CONTROL_PLANE_CONTRACT_VERSION;
}

export function isAcceptedActivationLedgerSchema(schemaVersion) {
  return isDeclaredActivationLedgerSchema(schemaVersion) || schemaVersion == null;
}

export function normalizeActivationLedger(raw, { now = nowIso() } = {}) {
  const store = asStore(raw, { updated_at: raw?.updated_at ?? now });
  return publicLedger(store);
}

function publicLedger(store) {
  return {
    ...store,
    role: 'derived_rebuildable',
    authoritative: isReactorControlPlaneAuthoritative('activation_ledger'),
    rebuildable: true,
    sequence: Number.isInteger(store.sequence) ? store.sequence : null,
    entries: entriesFromStore(store),
  };
}

function compactProjectionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    identity_key: entry.identity_key ?? null,
    reactor: entry.reactor ?? null,
    lane: entry.lane ?? null,
    state: entry.state ?? null,
    activation_reason: entry.activation_reason ?? null,
    priority: entry.priority ?? null,
    updated_at: entry.updated_at ?? null,
    created_at: entry.created_at ?? null,
    origin: entry.origin ?? null,
    claim: entry.claim ?? null,
    progress: entry.progress ?? null,
    hold_reason: entry.hold_reason ?? null,
    grouping: entry.grouping ?? null,
    replay_epoch_id: entry.replay_epoch_id ?? null,
    evidence_key: entry.identity?.evidence_key ?? entry.evidence_key ?? null,
  };
}

function resolveReactorCounts(store, entries) {
  const counted = countActivationWork(entries);
  const handledCounts = store?.terminal?.handled_counts;
  if (handledCounts) mergeHandledCountsIntoReactors(counted, handledCounts);
  else if (store?.reactors && typeof store.reactors === 'object') {
    for (const reactor of REACTORS) {
      for (const lane of ACTIVATION_LANES) {
        const persisted = store.reactors[reactor]?.[lane]?.handled_total;
        if (Number.isInteger(persisted) && persisted > counted[reactor][lane].handled_total) {
          counted[reactor][lane].handled_total = persisted;
        }
      }
    }
  }
  for (const reactor of REACTORS) {
    for (const lane of ACTIVATION_LANES) {
      counted[reactor][lane].open_total = laneOpenCount(counted[reactor][lane]);
      reconcileLaneCounts(counted[reactor][lane]);
    }
  }
  return counted;
}

export function buildActivationLedgerProjection(store) {
  const entries = entriesFromStore(store);
  const reactors = resolveReactorCounts(store, entries);
  const open = entries
    .filter((entry) => OPEN_LEDGER_STATES.includes(entry?.state))
    .map(compactProjectionEntry)
    .filter(Boolean);
  let openTotal = 0;
  let handledTotal = 0;
  for (const lanes of Object.values(reactors)) {
    for (const slice of Object.values(lanes || {})) {
      openTotal += Number.isInteger(slice.open_total) ? slice.open_total : 0;
      handledTotal += Number.isInteger(slice.handled_total) ? slice.handled_total : 0;
    }
  }
  if (Number.isInteger(store?.handled_total) && store.handled_total > handledTotal) {
    handledTotal = store.handled_total;
  }
  return {
    schema_version: ACTIVATION_LEDGER_PROJECTION_SCHEMA,
    generation: store?.generation ?? null,
    sequence: Number.isInteger(store?.sequence) ? store.sequence : null,
    updated_at: store?.updated_at ?? null,
    reactors,
    open_entries: open,
    open_total: openTotal,
    handled_total: handledTotal,
    ...(isActivationLedgerV2(store) ? { layout: 'v2_sharded' } : {}),
  };
}

function writeFileAtomic(filePath, body) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, filePath);
}

function writeJsonCompact(filePath, data) {
  writeFileAtomic(filePath, `${JSON.stringify(data)}\n`);
  return filePath;
}

export function writeActivationLedgerProjectionAt(ledgerFile, store) {
  if (!ledgerFile) return null;
  const path = join(dirname(ledgerFile), ACTIVATION_LEDGER_PROJECTION_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonCompact(path, buildActivationLedgerProjection(store));
  return path;
}

function peekQuotedField(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*(null|"((?:\\\\.|[^"\\\\])*)")`));
  if (!match) return null;
  return match[1] === 'null' ? null : match[2];
}

function peekLedgerMeta(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return {
      generation: null,
      sequence: null,
      schema_version: null,
      activation_policy_version: null,
      peeked: false,
    };
  }
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString('utf8');
    const generationMatch = text.match(/"generation"\s*:\s*(null|"((?:\\.|[^"\\])*)"|-?\d+)/);
    const sequenceMatch = text.match(/"sequence"\s*:\s*(null|-?\d+)/);
    let generation = null;
    if (generationMatch) {
      if (generationMatch[1] === 'null') generation = null;
      else if (generationMatch[2] != null) generation = generationMatch[2];
      else generation = Number(generationMatch[1]);
    }
    const sequence = sequenceMatch && sequenceMatch[1] !== 'null'
      ? Number(sequenceMatch[1])
      : null;
    return {
      generation,
      sequence: Number.isInteger(sequence) ? sequence : null,
      schema_version: peekQuotedField(text, 'schema_version'),
      activation_policy_version: peekQuotedField(text, 'activation_policy_version'),
      peeked: true,
    };
  } finally {
    closeSync(fd);
  }
}

function projectionMatchesLedger(projection, meta) {
  if (!projection || typeof projection !== 'object') return false;
  const projSeq = Number.isInteger(projection.sequence) ? projection.sequence : null;
  const metaSeq = Number.isInteger(meta.sequence) ? meta.sequence : null;
  if (projSeq !== metaSeq) return false;
  return (projection.generation ?? null) === (meta.generation ?? null);
}

function readProjectionFile(projPath) {
  if (!existsSync(projPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(projPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist the compact projection sidecar without rewriting identities or
 * inventing a monotonic sequence. Used on the first successful control-plane
 * read of a small pre-#233 ledger (UUID generation, sequence null, no sidecar)
 * and to recover after a crash between the ledger+delta switch and projection.
 * Large v1 monoliths stay fail-closed until the owned migrate/write.
 */
export function ensureCompactActivationLedgerProjection(dataRoot, {
  manifest = null,
  store = null,
  path = null,
  force = false,
} = {}) {
  const file = path || (dataRoot ? activationLedgerPath(dataRoot, manifest) : null);
  if (!file) return { persisted: false, reason: 'ledger_unresolved', path: null };
  const proj = join(dirname(file), ACTIVATION_LEDGER_PROJECTION_FILENAME);
  if (!existsSync(file) && !store) {
    return { persisted: false, reason: 'ledger_missing', path: proj };
  }
  if (!force && !store && existsSync(file) && projectionMatchesLedger(readProjectionFile(proj), peekLedgerMeta(file))) {
    return { persisted: false, reason: 'already_present', path: proj };
  }
  return withJsonLock(file, () => {
    if (!force && !store && existsSync(file) && projectionMatchesLedger(readProjectionFile(proj), peekLedgerMeta(file))) {
      return { persisted: false, reason: 'already_present', path: proj };
    }
    const current = store ?? readActivationLedgerStore(dataRoot, { manifest, path: file });
    writeActivationLedgerProjectionAt(file, current);
    return {
      persisted: true,
      reason: 'persisted',
      path: proj,
      generation: current.generation ?? null,
      sequence: Number.isInteger(current.sequence) ? current.sequence : null,
    };
  });
}

function partitionEntries(store) {
  const open = {};
  const handled = [];
  for (const [key, entry] of Object.entries(entryMapFromStore(store))) {
    if (entry?.state === 'handled') handled.push(entry);
    else if (key) open[key] = entry;
  }
  return { open, handled };
}

function timestampForBackup() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function rejectHotPayloads(entries) {
  for (const [key, entry] of Object.entries(entries)) {
    const payload = rejectControlPlanePayloads(entry, `activation_ledger.entries.${key}`);
    if (!payload.ok) {
      const error = new Error(payload.errors.join('; '));
      error.code = 'activation_ledger_payload_rejected';
      throw error;
    }
  }
}

function materializeV2Hot(destDir, store, {
  backupV1 = false,
  migratedFrom = null,
  ledgerFile = null,
} = {}) {
  mkdirSync(destDir, { recursive: true });
  const sourceDir = store._ledger_dir || null;
  if (sourceDir && resolve(sourceDir) !== resolve(destDir)) {
    copyTerminalDirectory(sourceDir, destDir);
  }

  const { open, handled } = partitionEntries(store);
  if (handled.length) {
    appendTerminalEntries(destDir, handled, { generation: store.generation ?? null });
  }
  const terminal = readTerminalManifest(destDir);
  if (store.generation != null) terminal.generation = store.generation;
  const reactors = resolveReactorCounts({
    ...store,
    terminal,
    handled_total: terminal.entry_count,
  }, Object.values(open));

  const filePath = ledgerFile || join(destDir, ACTIVATION_LEDGER_FILENAME);
  const previousSchema = store.schema_version;
  const wasV1 = previousSchema === ACTIVATION_LEDGER_STORE_SCHEMA_V1
    || previousSchema === REACTOR_CONTROL_PLANE_CONTRACT_VERSION
    || (previousSchema !== ACTIVATION_LEDGER_STORE_SCHEMA && existsSync(filePath));
  let backupPath = store._v1_backup_path ?? null;
  if (backupV1 && wasV1 && existsSync(filePath)) {
    backupPath = `${filePath}.v1-backup-${timestampForBackup()}`;
    copyFileSync(filePath, backupPath);
  }

  rejectHotPayloads(open);
  return {
    hot: {
      schema_version: ACTIVATION_LEDGER_STORE_SCHEMA,
      contract_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
      role: 'derived_rebuildable',
      authoritative: false,
      rebuildable: true,
      generation: store.generation ?? null,
      previous_generation: store.previous_generation ?? null,
      activation_policy_version: store.activation_policy_version ?? INITIAL_ACTIVATION_POLICY_VERSION,
      sequence: Number.isInteger(store.sequence) ? store.sequence : 0,
      updated_at: store.updated_at ?? nowIso(),
      entries: open,
      diagnostics: asArray(store.diagnostics),
      diagnostics_dropped: Number(store.diagnostics_dropped || 0),
      terminal_history: Array.isArray(store.terminal_history) ? store.terminal_history : [],
      terminal,
      handled_total: terminal.entry_count,
      open_total: Object.keys(open).length,
      reactors,
      migrated_from: migratedFrom ?? store.migrated_from ?? (wasV1 ? ACTIVATION_LEDGER_STORE_SCHEMA_V1 : null),
    },
    backupPath,
  };
}

function persistV2Ledger(filePath, store, {
  backupV1 = false,
  migratedFrom = null,
} = {}) {
  if (!filePath) throw new Error('persistV2Ledger requires a ledger path');
  const destDir = dirname(filePath);
  const { hot, backupPath } = materializeV2Hot(destDir, store, {
    backupV1,
    migratedFrom,
    ledgerFile: filePath,
  });
  writeJsonCompact(filePath, hot);
  const projectionPath = writeActivationLedgerProjectionAt(filePath, hot);
  return {
    ...hot,
    _ledger_dir: destDir,
    _projection_path: projectionPath,
    _v1_backup_path: backupPath,
  };
}

export function lookupActivationIdentity(storeOrDir, identityKey) {
  if (!identityKey) return null;
  if (storeOrDir && typeof storeOrDir === 'object' && !Array.isArray(storeOrDir)) {
    const hot = storeOrDir.entries?.[identityKey];
    if (hot) return hot;
    return findTerminalEntry(storeOrDir._ledger_dir, identityKey);
  }
  return findTerminalEntry(storeOrDir, identityKey);
}

export function hasStoredActivationIdentity(store, identityKey) {
  if (!identityKey || !store) return false;
  if (store.entries?.[identityKey]) return true;
  return terminalHasIdentity(store._ledger_dir, identityKey);
}

export function listActivationIdentityKeys(dataRoot, options = {}) {
  const store = readActivationLedgerStore(dataRoot, options);
  const keys = new Set(Object.keys(store.entries || {}));
  for (const key of listTerminalIdentityKeys(store._ledger_dir)) keys.add(key);
  return [...keys];
}

export function inspectActivationLedgerLayout(dataRoot, {
  manifest = null,
  path = null,
} = {}) {
  const file = path || (dataRoot ? activationLedgerPath(dataRoot, manifest) : null);
  if (!file || !existsSync(file)) {
    return {
      layout: 'missing',
      schema_version: null,
      generation: null,
      sequence: null,
      projection_present: false,
      file_bytes: null,
      open_count: 0,
      handled_count: 0,
      terminal_shards: 0,
      needs_migration: false,
    };
  }
  const raw = readJson(file, null);
  const dir = dirname(file);
  const projectionFile = join(dir, ACTIVATION_LEDGER_PROJECTION_FILENAME);
  const v2 = raw?.schema_version === ACTIVATION_LEDGER_STORE_SCHEMA;
  const terminal = v2 ? readTerminalManifest(dir) : null;
  const map = entryMapFromStore(raw);
  let openCount = 0;
  let handledInFile = 0;
  for (const entry of Object.values(map)) {
    if (entry?.state === 'handled') handledInFile += 1;
    else if (OPEN_LEDGER_STATES.includes(entry?.state)) openCount += 1;
  }
  const handledCount = v2
    ? Number(raw?.handled_total ?? terminal?.entry_count ?? handledInFile)
    : handledInFile;
  const sequence = Number.isInteger(raw?.sequence) ? raw.sequence : null;
  return {
    layout: v2 ? 'v2_sharded' : 'v1_monolith',
    schema_version: raw?.schema_version ?? null,
    generation: raw?.generation ?? null,
    sequence,
    projection_present: existsSync(projectionFile),
    file_bytes: (() => {
      try {
        return statSync(file).size;
      } catch {
        return null;
      }
    })(),
    open_count: v2 ? Number(raw?.open_total ?? openCount) : openCount,
    handled_count: handledCount,
    terminal_shards: terminal?.shard_count ?? 0,
    needs_migration: !v2 || !existsSync(projectionFile),
    authority_mutated: false,
  };
}

export function migrateActivationLedgerToV2(dataRoot, {
  now = nowIso(),
  dryRun = false,
  manifest = null,
  path = null,
} = {}) {
  if (!dataRoot && !path) throw new Error('migrateActivationLedgerToV2 requires dataRoot or path');
  const file = path || activationLedgerPath(dataRoot, manifest);
  const inspection = inspectActivationLedgerLayout(dataRoot, { manifest, path: file });
  if (inspection.layout === 'missing') {
    return {
      migrated: false,
      already_v2: false,
      dry_run: dryRun,
      reason: 'activation_ledger_unresolved',
      inspection,
      authority_mutated: false,
      identities_invented: 0,
    };
  }
  if (inspection.layout === 'v2_sharded' && inspection.projection_present) {
    return {
      migrated: false,
      already_v2: true,
      dry_run: dryRun,
      reason: 'already_v2',
      inspection,
      authority_mutated: false,
      identities_invented: 0,
    };
  }
  if (dryRun) {
    return {
      migrated: false,
      already_v2: false,
      dry_run: true,
      reason: 'would_migrate',
      inspection,
      authority_mutated: false,
      identities_invented: 0,
    };
  }

  const persisted = withJsonLock(file, () => {
    const raw = readJson(file, null);
    const store = asStore(raw, {
      generation: currentGeneration(dataRoot, manifest),
      updated_at: typeof now === 'string' ? now : nowIso(),
    });
    store._ledger_dir = dirname(file);
    if (!Number.isInteger(raw?.sequence)) store.sequence = 0;
    store.updated_at = typeof now === 'string' ? now : nowIso();
    return persistV2Ledger(file, store, {
      backupV1: inspection.layout === 'v1_monolith',
      migratedFrom: inspection.layout === 'v1_monolith' ? ACTIVATION_LEDGER_STORE_SCHEMA_V1 : null,
    });
  });

  return {
    migrated: true,
    already_v2: false,
    dry_run: false,
    reason: 'migrated',
    inspection,
    after: inspectActivationLedgerLayout(dataRoot, { manifest, path: file }),
    backup_path: persisted._v1_backup_path ?? null,
    projection_path: persisted._projection_path ?? null,
    generation: persisted.generation ?? null,
    sequence: persisted.sequence,
    open_count: persisted.open_total,
    handled_count: persisted.handled_total,
    authority_mutated: false,
    identities_invented: 0,
  };
}

function inferDeltaKind(from, to) {
  if (from == null) return 'insert';
  if (to === 'handled') return 'handle';
  if (to === 'claimed') return 'claim';
  if (to === 'deferred') return 'defer';
  if (to === 'blocked') return 'block';
  if (to === 'ready' && from === 'claimed') return 'release';
  if (to === 'ready' && from === 'deferred') return 'undefer';
  if (to === 'ready' && from === 'blocked') return 'unblock';
  return 'transition';
}

function collectLedgerDeltas(beforeMap, afterStore, sequence, now) {
  const deltas = [];
  const afterMap = afterStore.entries && typeof afterStore.entries === 'object' && !Array.isArray(afterStore.entries)
    ? afterStore.entries
    : entryMapFromStore(afterStore);
  for (const [key, after] of Object.entries(afterMap || {})) {
    const before = beforeMap[key];
    if (!before) {
      deltas.push({
        sequence,
        identity_key: key,
        reactor: after.reactor ?? null,
        lane: after.lane ?? null,
        from: null,
        to: after.state ?? 'ready',
        kind: 'insert',
        updated_at: after.updated_at ?? now,
        generation: afterStore.generation ?? null,
        claim: after.claim ?? null,
        progress: after.progress ?? null,
        hold_reason: after.hold_reason ?? null,
      });
      continue;
    }
    if (
      before.state === after.state
      && before.updated_at === after.updated_at
      && JSON.stringify(before.claim ?? null) === JSON.stringify(after.claim ?? null)
      && JSON.stringify(before.hold_reason ?? null) === JSON.stringify(after.hold_reason ?? null)
    ) {
      continue;
    }
    deltas.push({
      sequence,
      identity_key: key,
      reactor: after.reactor ?? before.reactor ?? null,
      lane: after.lane ?? before.lane ?? null,
      from: before.state ?? null,
      to: after.state ?? null,
      kind: inferDeltaKind(before.state, after.state),
      updated_at: after.updated_at ?? now,
      generation: afterStore.generation ?? null,
      claim: after.claim ?? null,
      progress: after.progress ?? null,
      hold_reason: after.hold_reason ?? null,
    });
  }
  return deltas;
}

function ledgerFailpointError(failpoint) {
  const error = new Error(`Injected activation ledger failure: ${failpoint}`);
  error.code = 'injected_failure';
  error.failpoint = failpoint;
  return error;
}

function readExistingDeltaLines(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function filterDeltaLinesThrough(lines, maxSequence) {
  const kept = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (Number.isInteger(row.sequence) && row.sequence <= maxSequence) {
        kept.push(JSON.stringify(row));
      }
    } catch {
      // Drop unreadable trailing garbage left by a previous crash.
    }
  }
  return kept;
}

export function readActivationLedgerStore(dataRoot, {
  manifest = null,
  path = null,
  includeTerminal = false,
} = {}) {
  const file = path || (dataRoot ? activationLedgerPath(dataRoot, manifest) : null);
  if (!file) return emptyActivationLedgerStore();
  const store = asStore(readJson(file, null), {
    generation: currentGeneration(dataRoot, manifest),
  });
  store._ledger_dir = dirname(file);
  if (includeTerminal && isActivationLedgerV2(store)) {
    hydrateTerminalEntries(store, store._ledger_dir);
  }
  return store;
}

export function writeActivationLedgerStore(filePath, store) {
  mkdirSync(dirname(filePath), { recursive: true });
  const next = asStore(store);
  next.authoritative = false;
  if (!Number.isInteger(next.sequence)) next.sequence = 0;
  next._ledger_dir = store?._ledger_dir ?? next._ledger_dir ?? null;
  persistV2Ledger(filePath, next);
  return filePath;
}

export function readActivationLedger(dataRoot, options = {}) {
  if (!dataRoot) throw new Error('readActivationLedger requires dataRoot');
  return publicLedger(readActivationLedgerStore(dataRoot, options));
}

export function writeActivationLedger(dataRoot, ledger, { now = null, manifest = null } = {}) {
  if (!dataRoot) throw new Error('writeActivationLedger requires dataRoot');
  const stamp = typeof now === 'string' ? now : nowIso();
  const file = activationLedgerPath(dataRoot, manifest);
  mkdirSync(dirname(file), { recursive: true });
  return withJsonLock(file, () => {
    const store = asStore(ledger, {
      generation: currentGeneration(dataRoot, manifest),
      updated_at: stamp,
    });
    store.updated_at = stamp;
    store.authoritative = false;
    if (!Number.isInteger(store.sequence)) store.sequence = 0;
    store._ledger_dir = dirname(file);
    return persistV2Ledger(file, store);
  });
}

export function listActivationLedgerEntries(dataRoot, {
  reactor = null,
  lane = null,
  state = null,
  evidence_key = null,
  includeTerminal = false,
} = {}) {
  const store = readActivationLedgerStore(dataRoot, {
    includeTerminal: includeTerminal || state === 'handled',
  });
  const entries = includeTerminal || state === 'handled'
    ? entriesFromStore(store)
    : entriesFromStore(store).filter((entry) => entry?.state !== 'handled');
  return entries.filter((entry) => {
    if (reactor && entry.reactor !== reactor) return false;
    if (lane && entry.lane !== lane) return false;
    if (state && entry.state !== state) return false;
    if (evidence_key && entry.identity?.evidence_key !== evidence_key) return false;
    return true;
  });
}

export function listActivationEntries(dataRoot) {
  return listActivationLedgerEntries(dataRoot);
}

export function getActivationLedgerEntry(dataRoot, identity) {
  const key = typeof identity === 'string'
    ? identity
    : (() => {
      const normalized = normalizeActivationIdentity(identity);
      return normalized.ok ? formatActivationIdentity(normalized.identity) : null;
    })();
  if (!key) return null;
  const store = readActivationLedgerStore(dataRoot);
  return lookupActivationIdentity(store, key)
    ?? Object.values(store.entries || {}).find((entry) => (
      entry.identity_key === key
      || (entry.identity && formatActivationIdentity(entry.identity) === key)
    ))
    ?? null;
}

export function findActivationEntry(dataRoot, identityKey) {
  return getActivationLedgerEntry(dataRoot, identityKey);
}

function retainDiagnostics(existing, incoming) {
  const merged = [...existing, ...incoming];
  if (merged.length <= MAX_HOT_DIAGNOSTICS) {
    return { diagnostics: merged, dropped: 0 };
  }
  const dropped = merged.length - MAX_HOT_DIAGNOSTICS;
  return {
    diagnostics: merged.slice(dropped),
    dropped,
  };
}

function prepareEntry(input, { now }) {
  const entry = normalizeActivationLedgerEntry({
    ...input,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  });
  const payload = rejectControlPlanePayloads(entry, 'activation_ledger_entry');
  if (!payload.ok) {
    return { ok: false, errors: payload.errors, entry: null, identity_key: identityKeyOf(entry) };
  }
  const validation = validateActivationLedgerEntry(entry);
  handleContractValidation('activation_ledger_entry', validation);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, entry: null, identity_key: identityKeyOf(entry) };
  }
  return { ok: true, errors: [], entry, identity_key: entry.identity_key };
}

/**
 * Crash-safe ledger mutation: stage v2 hot ledger JSON + complete deltas +
 * projection, and stage terminal shard updates. Switch terminal, then deltas,
 * then ledger. Projection is a derived write after the switch. A crash before
 * switch leaves the old pair; a crash after switch still has matching
 * sequence, deltas, and sharded handled identities.
 */
function mutateLedger(dataRoot, updater, {
  now = nowIso(),
  manifest = null,
  failpoint = null,
} = {}) {
  const file = activationLedgerPath(dataRoot, manifest);
  const deltasFile = activationLedgerDeltasFile(dataRoot, manifest);
  mkdirSync(dirname(file), { recursive: true });
  return withJsonLock(file, () => {
    const generation = currentGeneration(dataRoot, manifest);
    const raw = readJson(file, null);
    const next = asStore(raw, {
      generation,
      updated_at: now,
    });
    const liveDir = dirname(file);
    next._ledger_dir = liveDir;
    const beforeMap = { ...next.entries };
    const originalSequence = Number.isInteger(raw?.sequence)
      ? raw.sequence
      : (Number.isInteger(next.sequence) ? next.sequence : null);
    const prevSequence = Number.isInteger(originalSequence) ? originalSequence : 0;
    const result = updater(next, now);
    result.authoritative = false;
    result.updated_at = now;
    result.generation = result.generation ?? generation;
    result._ledger_dir = liveDir;
    const deltas = collectLedgerDeltas(beforeMap, result, prevSequence + 1, now);
    if (deltas.length) {
      result.sequence = prevSequence + 1;
    } else {
      result.sequence = originalSequence ?? (raw ? null : 0);
    }

    const stagingDir = join(liveDir, `.activation-ledger-next.${process.pid}.${randomUUID()}`);
    mkdirSync(stagingDir, { recursive: true });
    try {
      copyTerminalDirectory(liveDir, stagingDir);
      const { hot } = materializeV2Hot(stagingDir, {
        ...result,
        _ledger_dir: stagingDir,
      }, { ledgerFile: join(stagingDir, ACTIVATION_LEDGER_FILENAME) });

      const stagedLedger = join(stagingDir, ACTIVATION_LEDGER_FILENAME);
      const stagedDeltas = join(stagingDir, ACTIVATION_LEDGER_DELTAS_FILENAME);
      const stagedProjection = join(stagingDir, ACTIVATION_LEDGER_PROJECTION_FILENAME);
      writeJsonCompact(stagedLedger, hot);

      const keptDeltas = filterDeltaLinesThrough(readExistingDeltaLines(deltasFile), prevSequence);
      const nextDeltaLines = keptDeltas.concat(deltas.map((row) => JSON.stringify(row)));
      writeFileSync(
        stagedDeltas,
        nextDeltaLines.length ? `${nextDeltaLines.join('\n')}\n` : '',
        'utf8',
      );
      writeJsonCompact(stagedProjection, buildActivationLedgerProjection(hot));

      if (failpoint === ACTIVATION_LEDGER_FAILPOINTS.BEFORE_SWITCH) {
        throw ledgerFailpointError(failpoint);
      }

      installStagedTerminal(stagingDir, liveDir);
      renameSync(stagedDeltas, deltasFile);
      renameSync(stagedLedger, file);

      if (failpoint === ACTIVATION_LEDGER_FAILPOINTS.AFTER_SWITCH) {
        throw ledgerFailpointError(failpoint);
      }
      if (
        failpoint === ACTIVATION_LEDGER_FAILPOINTS.AFTER_DELTAS_BEFORE_PROJECTION
        || failpoint === ACTIVATION_LEDGER_FAILPOINTS.BETWEEN_DELTA_AND_SNAPSHOT
      ) {
        throw ledgerFailpointError(failpoint);
      }

      renameSync(stagedProjection, join(liveDir, ACTIVATION_LEDGER_PROJECTION_FILENAME));
      return {
        ...hot,
        _ledger_dir: liveDir,
      };
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
}

/**
 * Insert ledger entries keyed by activation identity. Existing identities are
 * left unchanged (same evidence + same policy = no duplicate work).
 */
export function insertActivationLedgerEntries(dataRoot, entries = [], {
  now = nowIso(),
  diagnostics = [],
  activation_policy_version = null,
  failpoint = null,
} = {}) {
  if (!dataRoot) throw new Error('insertActivationLedgerEntries requires dataRoot');

  let created = [];
  let reused = [];
  let rejected = [];

  const store = mutateLedger(dataRoot, (next) => {
    created = [];
    reused = [];
    rejected = [];
    for (const input of entries) {
      const prepared = prepareEntry(input, { now });
      if (!prepared.ok) {
        rejected.push({
          identity_key: prepared.identity_key,
          errors: prepared.errors,
        });
        continue;
      }
      const existing = next.entries[prepared.identity_key]
        || lookupActivationIdentity(next, prepared.identity_key);
      if (existing) {
        reused.push({
          identity_key: prepared.identity_key,
          reappearance: classifyActivationReappearance({
            previous_identity: existing.identity,
            next_identity: prepared.entry.identity,
          }),
        });
        continue;
      }
      next.entries[prepared.identity_key] = prepared.entry;
      created.push(prepared.entry);
    }
    const retained = retainDiagnostics(next.diagnostics, asArray(diagnostics));
    next.diagnostics = retained.diagnostics;
    next.diagnostics_dropped += retained.dropped;
    if (activation_policy_version) {
      next.activation_policy_version = activation_policy_version;
    }
    return next;
  }, { now, failpoint });

  return {
    store: publicLedger(store),
    created,
    reused,
    rejected,
  };
}

export function upsertActivationLedgerEntry(dataRoot, input, { now = null, failpoint = null } = {}) {
  const stamp = typeof now === 'string' ? now : nowIso();
  const prepared = prepareEntry(input, { now: stamp });
  if (!prepared.ok) return { ...prepared, entry: null };

  let stored = null;
  mutateLedger(dataRoot, (next) => {
    const terminal = lookupActivationIdentity(next, prepared.identity_key);
    if (terminal?.state === 'handled' && prepared.entry.state !== 'handled') {
      stored = terminal;
      return next;
    }
    stored = { ...prepared.entry, updated_at: stamp };
    next.entries[prepared.identity_key] = stored;
    return next;
  }, { now: stamp, failpoint });

  return { ok: true, errors: [], entry: stored };
}

export function upsertActivationEntry(dataRoot, input, options = {}) {
  return upsertActivationLedgerEntry(dataRoot, input, options);
}

export function applyLedgerTransition(dataRoot, identity, command, { now = null, failpoint = null } = {}) {
  const stamp = typeof now === 'string' ? now : (command.updated_at || nowIso());
  const key = typeof identity === 'string'
    ? identity
    : (normalizeActivationIdentity(identity).ok
      ? formatActivationIdentity(normalizeActivationIdentity(identity).identity)
      : null);
  let result = { ok: false, errors: [`activation not found: ${key}`], entry: null };

  mutateLedger(dataRoot, (next) => {
    const current = key ? next.entries[key] : null;
    if (!current) return next;
    const applied = applyActivationLedgerTransition(current, {
      ...command,
      now: command.now ?? stamp,
      updated_at: command.updated_at ?? stamp,
    }, { now: stamp });
    result = applied.ok
      ? { ok: true, errors: [], entry: applied.entry, kind: applied.kind }
      : { ...applied, entry: current };
    if (applied.ok) next.entries[key] = applied.entry;
    return next;
  }, { now: stamp, failpoint });

  return result;
}

export function transitionActivationEntry(dataRoot, identityKey, command, options = {}) {
  return applyLedgerTransition(dataRoot, identityKey, command, options);
}

export function parseTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isActivationLeaseExpired(entry, nowMs) {
  if (entry?.state !== 'claimed') return false;
  const expires = parseTimeMs(entry.claim?.lease_expires_at);
  return expires != null && Number.isFinite(nowMs) && nowMs > expires;
}

export function reclaimExpiredActivationLeases(dataRoot, { now = null, nowMs = null, failpoint = null } = {}) {
  const stamp = typeof now === 'string' ? now : nowIso();
  const clock = Number.isFinite(nowMs) ? nowMs : parseTimeMs(stamp);
  const reclaimed = [];

  mutateLedger(dataRoot, (next) => {
    for (const [key, entry] of Object.entries(next.entries)) {
      if (!isActivationLeaseExpired(entry, clock)) continue;
      const applied = applyActivationLedgerTransition(entry, {
        to: 'ready',
        kind: 'reclaim_lease_expired',
        now: stamp,
        updated_at: stamp,
      }, { now: stamp });
      if (!applied.ok) continue;
      next.entries[key] = applied.entry;
      reclaimed.push(applied.entry);
    }
    return next;
  }, { now: stamp, failpoint });

  return reclaimed;
}

function emptyLaneSlice() {
  return {
    ready: 0,
    claimed: 0,
    deferred: 0,
    blocked: 0,
    handled_total: 0,
    open_total: 0,
  };
}

export function countActivationWork(entries = []) {
  const list = Array.isArray(entries) ? entries : entriesFromStore(entries);
  const reactors = {};
  for (const reactor of REACTORS) {
    reactors[reactor] = {
      realtime: emptyLaneSlice(),
      replay: emptyLaneSlice(),
    };
  }
  for (const entry of list) {
    if (!REACTORS.includes(entry.reactor)) continue;
    if (!ACTIVATION_LANES.includes(entry.lane)) continue;
    if (!ACTIVATION_LEDGER_STATES.includes(entry.state)) continue;
    const slice = reactors[entry.reactor][entry.lane];
    if (entry.state === 'handled') slice.handled_total += 1;
    else if (slice[entry.state] != null) slice[entry.state] += 1;
  }
  for (const reactor of REACTORS) {
    for (const lane of ACTIVATION_LANES) {
      const slice = reactors[reactor][lane];
      slice.open_total = laneOpenCount(slice);
      reconcileLaneCounts(slice);
    }
  }
  return reactors;
}

export function listHandledEvidenceKeys(dataRoot, {
  reactor = null,
  policyVersion = null,
  path = null,
} = {}) {
  if (!dataRoot && !path) return [];
  let store;
  try {
    store = readActivationLedgerStore(dataRoot, { path });
  } catch {
    return [];
  }
  const keys = [];
  const seen = new Set();
  const add = (key) => {
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  };
  for (const entry of Object.values(store.entries || {})) {
    if (entry?.state !== 'handled') continue;
    if (reactor && entry.reactor !== reactor) continue;
    const version = entry.identity?.activation_policy_version
      ?? entry.activation_policy_version;
    if (policyVersion && version !== policyVersion) continue;
    add(entry.identity?.evidence_key ?? entry.evidence_key);
  }
  for (const key of listTerminalHandledEvidenceKeys(store._ledger_dir, { reactor, policyVersion })) {
    add(key);
  }
  return keys;
}

export function countLedgerWork(store) {
  const byReactor = Object.fromEntries(REACTORS.map((reactor) => [reactor, {
    ready: 0,
    claimed: 0,
    deferred: 0,
    blocked: 0,
    handled: 0,
  }]));
  for (const entry of entriesFromStore(store)) {
    const reactor = REACTORS.includes(entry?.reactor) ? entry.reactor : null;
    const state = entry?.state;
    if (!reactor || !byReactor[reactor] || byReactor[reactor][state] == null) continue;
    byReactor[reactor][state] += 1;
  }
  const ready = REACTORS.reduce((sum, reactor) => sum + byReactor[reactor].ready, 0);
  let handled = REACTORS.reduce((sum, reactor) => sum + byReactor[reactor].handled, 0);
  if (handled === 0 && Number.isInteger(store?.handled_total)) {
    handled = store.handled_total;
  }
  return { ready, handled, by_reactor: byReactor };
}

function emptyMigrationState() {
  return {
    schema_version: ACTIVATION_MIGRATION_STATE_SCHEMA,
    phase: null,
    product_phase: null,
    operation: null,
    generation: null,
    previous_generation: null,
    updated_at: null,
    resumed_at: null,
    operator_action: null,
    block_reason: null,
  };
}

export function readActivationMigrationState(dataRoot) {
  const raw = readJson(activationMigrationStatePath(dataRoot), emptyMigrationState());
  if (!raw || typeof raw !== 'object') return emptyMigrationState();
  return {
    ...emptyMigrationState(),
    ...raw,
    schema_version: ACTIVATION_MIGRATION_STATE_SCHEMA,
    product_phase: raw.product_phase ?? toProductUpgradePhase(raw.phase),
    operator_action: UPGRADE_OPERATOR_ACTIONS.includes(raw.operator_action)
      ? raw.operator_action
      : null,
  };
}

export function writeActivationMigrationState(dataRoot, patch = {}) {
  const current = readActivationMigrationState(dataRoot);
  const phase = patch.phase ?? current.phase ?? null;
  const next = {
    schema_version: ACTIVATION_MIGRATION_STATE_SCHEMA,
    phase,
    product_phase: patch.product_phase
      ?? toProductUpgradePhase(phase)
      ?? current.product_phase
      ?? null,
    operation: patch.operation ?? current.operation ?? null,
    generation: patch.generation ?? current.generation ?? null,
    previous_generation: patch.previous_generation ?? current.previous_generation ?? null,
    updated_at: patch.updated_at ?? new Date().toISOString(),
    resumed_at: patch.resumed_at ?? current.resumed_at ?? null,
    operator_action: patch.operator_action !== undefined
      ? patch.operator_action
      : current.operator_action ?? null,
    block_reason: patch.block_reason !== undefined
      ? patch.block_reason
      : current.block_reason ?? null,
  };
  writeJsonCompact(activationMigrationStatePath(dataRoot), next);
  return next;
}

function emptyLedgerInspection(extras = {}) {
  return {
    exists: false,
    empty: false,
    readable: false,
    bytes: null,
    generation: null,
    entry_count: 0,
    schema_version: null,
    sequence: null,
    activation_policy_version: null,
    projection_present: false,
    needs_owned_migration: false,
    path: null,
    ...extras,
  };
}

export function inspectActivationLedgerFile(dataRoot, { manifest = null } = {}) {
  let file;
  try {
    file = dataRoot ? activationLedgerPath(dataRoot, manifest) : null;
  } catch {
    return emptyLedgerInspection();
  }
  if (!file) {
    return emptyLedgerInspection();
  }
  try {
    if (!existsSync(file)) {
      return emptyLedgerInspection({ path: file });
    }
    const bytes = statSync(file).size;
    const projectionPresent = existsSync(join(dirname(file), ACTIVATION_LEDGER_PROJECTION_FILENAME));
    if (bytes === 0) {
      return emptyLedgerInspection({
        exists: true,
        empty: true,
        readable: true,
        bytes: 0,
        path: file,
        projection_present: projectionPresent,
      });
    }

    // Product startup must not parse a large pre-#233 monolith or terminal
    // history. Peek the header only; large files without a compact projection
    // stay fail-closed until an owned migrate (#242).
    if (bytes > ACTIVATION_LEDGER_HOT_MAX_BYTES) {
      const meta = peekLedgerMeta(file);
      const declared = isDeclaredActivationLedgerSchema(meta.schema_version);
      return {
        exists: true,
        empty: !declared && !meta.generation,
        readable: meta.peeked === true,
        bytes,
        generation: meta.generation ?? null,
        entry_count: null,
        schema_version: meta.schema_version ?? null,
        sequence: meta.sequence ?? null,
        activation_policy_version: meta.activation_policy_version ?? null,
        projection_present: projectionPresent,
        needs_owned_migration: projectionPresent !== true,
        path: file,
      };
    }

    const raw = readJson(file, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return emptyLedgerInspection({
        exists: true,
        empty: true,
        readable: false,
        bytes,
        path: file,
        projection_present: projectionPresent,
      });
    }
    const generation = raw.generation ?? null;
    const entry_count = entriesFromStore(raw).length;
    // A real v1/v2 store is never "empty" even with no generation and zero
    // entries (fresh pump / test seed). Only a leftover placeholder (`{}`,
    // no declared schema) next to authority is the #237 hole.
    const empty = !isDeclaredActivationLedgerSchema(raw.schema_version)
      && !generation
      && entry_count === 0;
    return {
      exists: true,
      empty,
      readable: true,
      bytes,
      generation,
      entry_count,
      schema_version: raw.schema_version ?? null,
      sequence: Number.isInteger(raw.sequence) ? raw.sequence : null,
      activation_policy_version: raw.activation_policy_version ?? null,
      projection_present: projectionPresent,
      needs_owned_migration: false,
      path: file,
    };
  } catch {
    return emptyLedgerInspection({
      exists: true,
      empty: true,
      readable: false,
      path: file,
    });
  }
}

export function hasMatchingGenerationJournal(dataRoot, manifest = null) {
  const raw = manifest ?? (dataRoot ? readJson(evidenceIndexPath(dataRoot), null) : null);
  if (
    !raw?.generation
    || raw.schema_version !== EVIDENCE_INDEX_GENERATION_SCHEMA
  ) {
    return false;
  }
  try {
    return existsSync(evidenceIndexJournalPath(dataRoot));
  } catch {
    return false;
  }
}

/**
 * A leftover phase=switched may complete only when the switched generation
 * still has a matching journal and a non-empty, generation-matched ledger.
 * Never invent identities or pick a rollback backup here.
 */
export function validateSwitchedActivationGeneration(dataRoot, {
  state = null,
  manifest = null,
} = {}) {
  const migration = state ?? readActivationMigrationState(dataRoot);
  const index = manifest ?? (dataRoot ? readJson(evidenceIndexPath(dataRoot), null) : null);
  const productPhase = toProductUpgradePhase(migration.phase);
  if (migration.phase !== 'switched' && productPhase !== 'atomic_switch') {
    return { ok: false, reason: 'not_switched', generation: migration.generation ?? null };
  }
  if (!migration.generation || migration.generation !== index?.generation) {
    return { ok: false, reason: 'generation_mismatch', generation: migration.generation ?? null };
  }
  if (index?.schema_version !== EVIDENCE_INDEX_GENERATION_SCHEMA) {
    return { ok: false, reason: 'journal_schema_mismatch', generation: migration.generation };
  }
  if (!hasMatchingGenerationJournal(dataRoot, index)) {
    return { ok: false, reason: 'journal_missing', generation: migration.generation };
  }
  const ledger = inspectActivationLedgerFile(dataRoot, { manifest: index });
  if (!ledger.exists || ledger.empty || !ledger.readable) {
    return { ok: false, reason: 'ledger_empty_or_unreadable', generation: migration.generation };
  }
  if (ledger.generation && ledger.generation !== migration.generation) {
    return { ok: false, reason: 'ledger_generation_mismatch', generation: migration.generation };
  }
  let store;
  try {
    store = readActivationLedgerStore(dataRoot, { manifest: index });
  } catch {
    return { ok: false, reason: 'ledger_unreadable', generation: migration.generation };
  }
  const validation = validateActivationLedgerStore(store);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'ledger_invalid',
      generation: migration.generation,
      errors: validation.errors,
    };
  }
  return { ok: true, reason: null, generation: migration.generation, store };
}

/**
 * After an atomic generation switch, leftover phase=switched is completed
 * only when that generation still validates. Never rewrite authority.
 */
export function resumeActivationMigration(dataRoot) {
  const state = readActivationMigrationState(dataRoot);
  const manifest = readJson(evidenceIndexPath(dataRoot), null);
  const validation = validateSwitchedActivationGeneration(dataRoot, { state, manifest });
  if (validation.ok) {
    const next = writeActivationMigrationState(dataRoot, {
      ...state,
      phase: 'complete',
      product_phase: 'ready',
      operator_action: null,
      block_reason: null,
      resumed_at: new Date().toISOString(),
    });
    return {
      resumed: true,
      generation: state.generation,
      handled: countLedgerWork(validation.store).handled,
      state: next,
    };
  }
  return {
    resumed: false,
    phase: state.phase ?? null,
    generation: state.generation ?? manifest?.generation ?? null,
    reason: validation.reason ?? null,
  };
}

function markerFile(activeDir, category, key, reactor = null) {
  const hex = createHash('sha256').update(String(key)).digest('hex');
  return join(activeDir, category, ...(reactor ? [reactor] : []), hex.slice(0, 2), hex);
}

export function hasConsumedMarkerAt(activeDir, reactor, evidenceKey) {
  return Boolean(activeDir) && existsSync(markerFile(activeDir, 'consumed', evidenceKey, reactor));
}

export function writeConsumedMarkerAt(activeDir, reactor, evidenceKey) {
  const path = markerFile(activeDir, 'consumed', evidenceKey, reactor);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '');
  return path;
}

export function seedConsumedMarkersFromLedger(activeDir, store) {
  let written = 0;
  const seed = (entry) => {
    if (entry?.state !== 'handled') return;
    const reactor = entry.reactor;
    const key = entry.identity?.evidence_key ?? entry.evidence_key;
    if (!REACTORS.includes(reactor) || !key) return;
    writeConsumedMarkerAt(activeDir, reactor, key);
    written += 1;
  };
  for (const entry of entriesFromStore(store)) seed(entry);
  if (store?._ledger_dir) {
    iterateTerminalEntries(store._ledger_dir, seed);
  }
  return written;
}

export function validateActivationLedgerStore(store, path = 'activation_ledger') {
  const errors = [];
  if (!store || typeof store !== 'object') {
    return { ok: false, errors: [`${path} must be an object`] };
  }
  if (store.schema_version !== ACTIVATION_LEDGER_STORE_SCHEMA
    && store.schema_version !== ACTIVATION_LEDGER_STORE_SCHEMA_V1
    && store.schema_version !== REACTOR_CONTROL_PLANE_CONTRACT_VERSION) {
    errors.push(`${path}.schema_version must be ${ACTIVATION_LEDGER_STORE_SCHEMA} or ${ACTIVATION_LEDGER_STORE_SCHEMA_V1}`);
  }
  if (store.contract_version !== REACTOR_CONTROL_PLANE_CONTRACT_VERSION) {
    errors.push(`${path}.contract_version must be ${REACTOR_CONTROL_PLANE_CONTRACT_VERSION}`);
  }
  const map = entryMapFromStore(store);
  for (const [key, entry] of Object.entries(map)) {
    const validation = validateActivationLedgerEntry(entry, `${path}.entries.${key}`);
    if (!validation.ok) errors.push(...validation.errors);
    const expected = entry?.identity ? formatActivationIdentity(entry.identity) : null;
    if (expected && key !== expected) {
      errors.push(`${path}.entries key ${key} must equal canonical identity ${expected}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
