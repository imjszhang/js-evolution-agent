/**
 * Derived Activation Ledger (Reactor Inbox) store.
 *
 * Crash-safe atomic JSON. Control-plane only: never authority for evidence,
 * beliefs, goals, receipts, or settlements. Dedup key is activation identity.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  classifyActivationReappearance,
  formatActivationIdentity,
  handleContractValidation,
  isReactorControlPlaneAuthoritative,
  normalizeActivationIdentity,
  normalizeActivationLedgerEntry,
  rejectControlPlanePayloads,
  validateActivationLedgerEntry,
} from '../../contracts/index.mjs';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import { activationLedgerPath, reactorDir } from './paths.mjs';

export { activationLedgerPath };

export const ACTIVATION_LEDGER_STORE_SCHEMA = REACTOR_CONTROL_PLANE_CONTRACT_VERSION;
const MAX_HOT_DIAGNOSTICS = 256;

export function emptyActivationLedger(now = nowIso()) {
  return {
    schema_version: ACTIVATION_LEDGER_STORE_SCHEMA,
    role: 'derived_rebuildable',
    authoritative: false,
    activation_policy_version: null,
    updated_at: now,
    entries: [],
    diagnostics: [],
    diagnostics_dropped: 0,
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeActivationLedger(raw, { now = nowIso() } = {}) {
  return {
    schema_version: raw?.schema_version ?? ACTIVATION_LEDGER_STORE_SCHEMA,
    role: 'derived_rebuildable',
    authoritative: false,
    activation_policy_version: raw?.activation_policy_version ?? null,
    updated_at: raw?.updated_at ?? now,
    entries: asArray(raw?.entries),
    diagnostics: asArray(raw?.diagnostics),
    diagnostics_dropped: Number(raw?.diagnostics_dropped || 0),
  };
}

export function readActivationLedger(dataRoot) {
  if (!dataRoot) throw new Error('readActivationLedger requires dataRoot');
  return normalizeActivationLedger(readJson(activationLedgerPath(dataRoot), emptyActivationLedger()));
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

export function getActivationLedgerEntry(dataRoot, identity) {
  const normalized = normalizeActivationIdentity(identity);
  if (!normalized.ok) return null;
  const key = formatActivationIdentity(normalized.identity);
  return readActivationLedger(dataRoot).entries.find((entry) => entry.identity_key === key) ?? null;
}

function identityKeyOf(entry) {
  if (entry?.identity_key) return entry.identity_key;
  const normalized = normalizeActivationIdentity(entry?.identity);
  return normalized.ok ? formatActivationIdentity(normalized.identity) : null;
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
 * Insert ledger entries keyed by activation identity. Existing identities are
 * left unchanged (same evidence + same policy = no duplicate work).
 */
export function insertActivationLedgerEntries(dataRoot, entries = [], {
  now = nowIso(),
  diagnostics = [],
  activation_policy_version = null,
} = {}) {
  if (!dataRoot) throw new Error('insertActivationLedgerEntries requires dataRoot');
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  const file = activationLedgerPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });

  let created = [];
  let reused = [];
  let rejected = [];

  const store = updateJson(file, (raw) => {
    const next = normalizeActivationLedger(raw, { now });
    const byIdentity = new Map(
      next.entries.map((entry) => [entry.identity_key, entry]),
    );
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
      const existing = byIdentity.get(prepared.identity_key);
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
      byIdentity.set(prepared.identity_key, prepared.entry);
      next.entries.push(prepared.entry);
      created.push(prepared.entry);
    }

    const retained = retainDiagnostics(next.diagnostics, asArray(diagnostics));
    next.diagnostics = retained.diagnostics;
    next.diagnostics_dropped += retained.dropped;
    if (activation_policy_version) {
      next.activation_policy_version = activation_policy_version;
    }
    next.updated_at = now;
    next.authoritative = isReactorControlPlaneAuthoritative('activation_ledger');
    return next;
  }, { fallback: emptyActivationLedger(now) });

  return {
    store,
    created,
    reused,
    rejected,
  };
}
