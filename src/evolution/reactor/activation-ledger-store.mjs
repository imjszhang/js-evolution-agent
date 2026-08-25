/**
 * Derived Activation Ledger persistence. Survives journal generation changes
 * because identity is (reactor, evidence_key, activation_policy_version).
 * Never authority for evidence, beliefs, goals, receipts, or settlements.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  formatActivationIdentity,
} from '../../contracts/activation-identity.mjs';
import { validateActivationLedgerEntry } from '../../contracts/activation-ledger.mjs';
import { readJson, writeJson } from '../../infra/json-store.mjs';
import { evidenceIndexDir, evidenceIndexPath } from './evidence-index.mjs';
import { reactorDir } from './paths.mjs';

export const ACTIVATION_LEDGER_STORE_SCHEMA = 'activation-ledger.v1';
export const ACTIVATION_MIGRATION_STATE_SCHEMA = 'activation-migration.v1';
export const ACTIVATION_LEDGER_FILENAME = 'activation-ledger.json';

const REACTORS = Object.freeze(['cognitive', 'rule', 'memory']);

export function activationLedgerPath(dataRoot, manifest = null) {
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
    generation,
    previous_generation,
    activation_policy_version,
    updated_at,
    entries: {},
    terminal_history: [],
  };
}

function asStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyActivationLedgerStore();
  }
  return {
    ...emptyActivationLedgerStore(raw),
    schema_version: raw.schema_version ?? ACTIVATION_LEDGER_STORE_SCHEMA,
    contract_version: raw.contract_version ?? REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    entries: raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
      ? raw.entries
      : {},
    terminal_history: Array.isArray(raw.terminal_history) ? raw.terminal_history : [],
  };
}

export function readActivationLedgerStore(dataRoot, {
  manifest = null,
  path = null,
} = {}) {
  const file = path || (dataRoot ? activationLedgerPath(dataRoot, manifest) : null);
  if (!file) return emptyActivationLedgerStore();
  return asStore(readJson(file, null));
}

export function writeActivationLedgerStore(filePath, store) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeJson(filePath, store);
  return filePath;
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
  for (const entry of Object.values(store?.entries || {})) {
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
  for (const entry of Object.values(store?.entries || {})) {
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
  for (const [key, entry] of Object.entries(store.entries || {})) {
    const validation = validateActivationLedgerEntry(entry, `${path}.entries.${key}`);
    if (!validation.ok) errors.push(...validation.errors);
    const expected = entry?.identity ? formatActivationIdentity(entry.identity) : null;
    if (expected && key !== expected) {
      errors.push(`${path}.entries key ${key} must equal canonical identity ${expected}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}
