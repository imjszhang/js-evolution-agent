/**
 * Derived Activation Ledger (Reactor Inbox).
 *
 * One module, generation-scoped so handled identities survive journal rebuild.
 * Persistence is an identity-keyed map; every public read/write speaks contract
 * entries. Never authority for evidence, beliefs, goals, receipts, or settlements.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { readJson, updateJson, writeJson } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import {
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  evidenceIndexDir,
  evidenceIndexJournalPath,
  evidenceIndexPath,
} from './evidence-index.mjs';
import { reactorDir } from './paths.mjs';

export const ACTIVATION_LEDGER_STORE_SCHEMA = 'activation-ledger.v1';
export const ACTIVATION_LEDGER_PROJECTION_SCHEMA = 'activation-ledger-projection.v1';
export const ACTIVATION_MIGRATION_STATE_SCHEMA = 'activation-migration.v1';
export const ACTIVATION_LEDGER_FILENAME = 'activation-ledger.json';
export const ACTIVATION_LEDGER_PROJECTION_FILENAME = 'activation-ledger.projection.json';
export const ACTIVATION_LEDGER_DELTAS_FILENAME = 'activation-ledger.deltas.jsonl';

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
    : (Number.isInteger(extras.sequence) ? extras.sequence : 0);
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
  };
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
    sequence: Number.isInteger(store.sequence) ? store.sequence : 0,
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

export function buildActivationLedgerProjection(store) {
  const entries = entriesFromStore(store);
  const reactors = countActivationWork(entries);
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
  return {
    schema_version: ACTIVATION_LEDGER_PROJECTION_SCHEMA,
    generation: store?.generation ?? null,
    sequence: Number.isInteger(store?.sequence) ? store.sequence : 0,
    updated_at: store?.updated_at ?? null,
    reactors,
    open_entries: open,
    open_total: openTotal,
    handled_total: handledTotal,
  };
}

export function writeActivationLedgerProjectionAt(ledgerFile, store) {
  if (!ledgerFile) return null;
  const path = join(dirname(ledgerFile), ACTIVATION_LEDGER_PROJECTION_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, buildActivationLedgerProjection(store));
  return path;
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

function appendLedgerDeltas(dataRoot, deltas, manifest = null) {
  if (!dataRoot || !deltas.length) return;
  const file = activationLedgerDeltasFile(dataRoot, manifest);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${deltas.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

export function readActivationLedgerStore(dataRoot, {
  manifest = null,
  path = null,
} = {}) {
  const file = path || (dataRoot ? activationLedgerPath(dataRoot, manifest) : null);
  if (!file) return emptyActivationLedgerStore();
  return asStore(readJson(file, null), {
    generation: currentGeneration(dataRoot, manifest),
  });
}

export function writeActivationLedgerStore(filePath, store) {
  mkdirSync(dirname(filePath), { recursive: true });
  const next = asStore(store);
  next.authoritative = false;
  if (!Number.isInteger(next.sequence)) next.sequence = 0;
  for (const [key, entry] of Object.entries(next.entries)) {
    const payload = rejectControlPlanePayloads(entry, `activation_ledger.entries.${key}`);
    if (!payload.ok) {
      const error = new Error(payload.errors.join('; '));
      error.code = 'activation_ledger_payload_rejected';
      throw error;
    }
  }
  writeJson(filePath, next);
  writeActivationLedgerProjectionAt(filePath, next);
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
  const next = updateJson(file, () => {
    const store = asStore(ledger, {
      generation: currentGeneration(dataRoot, manifest),
      updated_at: stamp,
    });
    store.updated_at = stamp;
    store.authoritative = false;
    if (!Number.isInteger(store.sequence)) store.sequence = 0;
    return store;
  }, { fallback: emptyActivationLedgerStore({ updated_at: stamp }) });
  writeActivationLedgerProjectionAt(file, next);
  return next;
}

export function listActivationLedgerEntries(dataRoot, {
  reactor = null,
  lane = null,
  state = null,
  evidence_key = null,
} = {}) {
  return readActivationLedger(dataRoot).entries.filter((entry) => {
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
  return store.entries[key] ?? Object.values(store.entries).find((entry) => (
    entry.identity_key === key
    || (entry.identity && formatActivationIdentity(entry.identity) === key)
  )) ?? null;
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

function mutateLedger(dataRoot, updater, {
  now = nowIso(),
  manifest = null,
} = {}) {
  const file = activationLedgerPath(dataRoot, manifest);
  mkdirSync(dirname(file), { recursive: true });
  let pendingDeltas = [];
  const store = updateJson(file, (raw) => {
    const generation = currentGeneration(dataRoot, manifest);
    const next = asStore(raw, {
      generation,
      updated_at: now,
    });
    const beforeMap = { ...next.entries };
    const prevSequence = Number.isInteger(next.sequence) ? next.sequence : 0;
    const result = updater(next, now);
    result.authoritative = false;
    result.updated_at = now;
    result.generation = result.generation ?? generation;
    const deltas = collectLedgerDeltas(beforeMap, result, prevSequence + 1, now);
    if (deltas.length) {
      result.sequence = prevSequence + 1;
      pendingDeltas = deltas;
    } else {
      result.sequence = prevSequence;
    }
    return result;
  }, { fallback: emptyActivationLedgerStore({
    generation: currentGeneration(dataRoot, manifest),
    updated_at: now,
  }) });
  if (pendingDeltas.length) {
    appendLedgerDeltas(dataRoot, pendingDeltas, manifest);
  }
  writeActivationLedgerProjectionAt(file, store);
  return store;
}

/**
 * Insert ledger entries keyed by activation identity. Existing identities are
 * left unchanged (same evidence + same policy = no duplicate work).
 */
export function insertActivationLedgerEntries(dataRoot, entries = [], {
  now = nowIso(),
  diagnostics = [],
  activation_policy_version = null,
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
      const existing = next.entries[prepared.identity_key];
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
  }, { now });

  return {
    store: publicLedger(store),
    created,
    reused,
    rejected,
  };
}

export function upsertActivationLedgerEntry(dataRoot, input, { now = null } = {}) {
  const stamp = typeof now === 'string' ? now : nowIso();
  const prepared = prepareEntry(input, { now: stamp });
  if (!prepared.ok) return { ...prepared, entry: null };

  let stored = null;
  mutateLedger(dataRoot, (next) => {
    stored = { ...prepared.entry, updated_at: stamp };
    next.entries[prepared.identity_key] = stored;
    return next;
  }, { now: stamp });

  return { ok: true, errors: [], entry: stored };
}

export function upsertActivationEntry(dataRoot, input, options = {}) {
  return upsertActivationLedgerEntry(dataRoot, input, options);
}

export function applyLedgerTransition(dataRoot, identity, command, { now = null } = {}) {
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
  }, { now: stamp });

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

export function reclaimExpiredActivationLeases(dataRoot, { now = null, nowMs = null } = {}) {
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
  }, { now: stamp });

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
  for (const entry of Object.values(store.entries || {})) {
    if (entry?.state !== 'handled') continue;
    if (reactor && entry.reactor !== reactor) continue;
    const version = entry.identity?.activation_policy_version
      ?? entry.activation_policy_version;
    if (policyVersion && version !== policyVersion) continue;
    const key = entry.identity?.evidence_key ?? entry.evidence_key;
    if (key) keys.push(key);
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
  const handled = REACTORS.reduce((sum, reactor) => sum + byReactor[reactor].handled, 0);
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
  writeJson(activationMigrationStatePath(dataRoot), next);
  return next;
}

export function inspectActivationLedgerFile(dataRoot, { manifest = null } = {}) {
  let file;
  try {
    file = dataRoot ? activationLedgerPath(dataRoot, manifest) : null;
  } catch {
    return {
      exists: false,
      empty: false,
      readable: false,
      bytes: null,
      generation: null,
      entry_count: 0,
      path: null,
    };
  }
  if (!file) {
    return {
      exists: false,
      empty: false,
      readable: false,
      bytes: null,
      generation: null,
      entry_count: 0,
      path: null,
    };
  }
  try {
    if (!existsSync(file)) {
      return {
        exists: false,
        empty: false,
        readable: false,
        bytes: null,
        generation: null,
        entry_count: 0,
        path: file,
      };
    }
    const bytes = statSync(file).size;
    if (bytes === 0) {
      return {
        exists: true,
        empty: true,
        readable: true,
        bytes: 0,
        generation: null,
        entry_count: 0,
        path: file,
      };
    }
    const raw = readJson(file, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        exists: true,
        empty: true,
        readable: false,
        bytes,
        generation: null,
        entry_count: 0,
        path: file,
      };
    }
    const generation = raw.generation ?? null;
    const entry_count = entriesFromStore(raw).length;
    // A real activation-ledger.v1 store is never "empty" even with no
    // generation and zero entries (fresh pump / test seed). Only a leftover
    // placeholder (`{}`, no schema) next to authority is the #237 hole.
    const empty = raw.schema_version !== ACTIVATION_LEDGER_STORE_SCHEMA
      && !generation
      && entry_count === 0;
    return {
      exists: true,
      empty,
      readable: true,
      bytes,
      generation,
      entry_count,
      path: file,
    };
  } catch {
    return {
      exists: true,
      empty: true,
      readable: false,
      bytes: null,
      generation: null,
      entry_count: 0,
      path: file,
    };
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
  for (const entry of entriesFromStore(store)) {
    if (entry?.state !== 'handled') continue;
    const reactor = entry.reactor;
    const key = entry.identity?.evidence_key ?? entry.evidence_key;
    if (!REACTORS.includes(reactor) || !key) continue;
    writeConsumedMarkerAt(activeDir, reactor, key);
    written += 1;
  }
  return written;
}

export function validateActivationLedgerStore(store, path = 'activation_ledger') {
  const errors = [];
  if (!store || typeof store !== 'object') {
    return { ok: false, errors: [`${path} must be an object`] };
  }
  if (store.schema_version !== ACTIVATION_LEDGER_STORE_SCHEMA) {
    errors.push(`${path}.schema_version must be ${ACTIVATION_LEDGER_STORE_SCHEMA}`);
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
