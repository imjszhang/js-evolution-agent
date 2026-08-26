/**
 * Derived Activation Ledger (Reactor Inbox).
 *
 * One module, generation-scoped so handled identities survive journal rebuild.
 * Persistence is an identity-keyed map; every public read/write speaks contract
 * entries. Never authority for evidence, beliefs, goals, receipts, or settlements.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { evidenceIndexDir, evidenceIndexPath } from './evidence-index.mjs';
import { reactorDir } from './paths.mjs';

export const ACTIVATION_LEDGER_STORE_SCHEMA = 'activation-ledger.v1';
export const ACTIVATION_MIGRATION_STATE_SCHEMA = 'activation-migration.v1';
export const ACTIVATION_LEDGER_FILENAME = 'activation-ledger.json';

const MAX_HOT_DIAGNOSTICS = 256;
const REACTORS = EVIDENCE_BATCH_REACTORS;

export function activationLedgerPath(dataRoot, manifest = null) {
  if (!dataRoot && !manifest) {
    throw new Error('activationLedgerPath requires dataRoot or a generation manifest');
  }
  return join(evidenceIndexDir(dataRoot, manifest), ACTIVATION_LEDGER_FILENAME);
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
    entries: entriesFromStore(store),
  };
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
  const payload = rejectControlPlanePayloads(next, 'activation_ledger');
  if (!payload.ok) {
    const error = new Error(payload.errors.join('; '));
    error.code = 'activation_ledger_payload_rejected';
    throw error;
  }
  writeJson(filePath, next);
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
  return updateJson(file, () => {
    const next = asStore(ledger, {
      generation: currentGeneration(dataRoot, manifest),
      updated_at: stamp,
    });
    next.updated_at = stamp;
    next.authoritative = false;
    return next;
  }, { fallback: emptyActivationLedgerStore({ updated_at: stamp }) });
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
  return updateJson(file, (raw) => {
    const next = asStore(raw, {
      generation: currentGeneration(dataRoot, manifest),
      updated_at: now,
    });
    const result = updater(next, now);
    result.authoritative = false;
    result.updated_at = now;
    return result;
  }, { fallback: emptyActivationLedgerStore({
    generation: currentGeneration(dataRoot, manifest),
    updated_at: now,
  }) });
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

export function readActivationMigrationState(dataRoot) {
  return readJson(activationMigrationStatePath(dataRoot), {
    schema_version: ACTIVATION_MIGRATION_STATE_SCHEMA,
    phase: null,
    operation: null,
    generation: null,
    updated_at: null,
  });
}

export function writeActivationMigrationState(dataRoot, patch = {}) {
  const current = readActivationMigrationState(dataRoot);
  const next = {
    schema_version: ACTIVATION_MIGRATION_STATE_SCHEMA,
    phase: patch.phase ?? current.phase ?? null,
    operation: patch.operation ?? current.operation ?? null,
    generation: patch.generation ?? current.generation ?? null,
    previous_generation: patch.previous_generation ?? current.previous_generation ?? null,
    updated_at: patch.updated_at ?? new Date().toISOString(),
    resumed_at: patch.resumed_at ?? current.resumed_at ?? null,
  };
  writeJson(activationMigrationStatePath(dataRoot), next);
  return next;
}

/**
 * After an atomic generation switch, leftover phase=switched is completed
 * without rewriting authority or inventing identities.
 */
export function resumeActivationMigration(dataRoot) {
  const state = readActivationMigrationState(dataRoot);
  const manifest = readJson(evidenceIndexPath(dataRoot), null);
  if (state.phase === 'switched' && state.generation && state.generation === manifest?.generation) {
    const ledger = readActivationLedgerStore(dataRoot, { manifest });
    const next = writeActivationMigrationState(dataRoot, {
      ...state,
      phase: 'complete',
      resumed_at: new Date().toISOString(),
    });
    return {
      resumed: true,
      generation: state.generation,
      handled: countLedgerWork(ledger).handled,
      state: next,
    };
  }
  return {
    resumed: false,
    phase: state.phase ?? null,
    generation: state.generation ?? manifest?.generation ?? null,
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
