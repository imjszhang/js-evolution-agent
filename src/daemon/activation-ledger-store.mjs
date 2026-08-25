/**
 * Derived Activation Ledger persistence. Schema is the #210 contract;
 * this module only stores and transitions entries.
 */
import { join } from 'node:path';
import { readJson, updateJson } from '../infra/json-store.mjs';
import { nowIso } from '../infra/runtime-paths.mjs';
import {
  ACTIVATION_LANES,
  ACTIVATION_LEDGER_STATES,
  applyActivationLedgerTransition,
  normalizeActivationLedgerEntry,
  validateActivationLedgerEntry,
} from '../contracts/activation-ledger.mjs';
import {
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  REACTOR_CONTROL_PLANE_ROLE,
  formatActivationIdentity,
} from '../contracts/activation-identity.mjs';
import { EVIDENCE_BATCH_REACTORS } from '../contracts/evidence-batch-claim.mjs';
import { laneOpenCount, reconcileLaneCounts } from '../contracts/reactor-progress-projection.mjs';

export function activationLedgerPath(dataRoot) {
  return join(dataRoot, 'evolution', 'reactor', 'activation-ledger.json');
}

function emptyLedger() {
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    role: 'derived',
    rebuildable: REACTOR_CONTROL_PLANE_ROLE.rebuildable,
    updated_at: null,
    entries: [],
  };
}

export function readActivationLedger(dataRoot) {
  const raw = readJson(activationLedgerPath(dataRoot), emptyLedger());
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return {
    ...emptyLedger(),
    ...(raw && typeof raw === 'object' ? raw : {}),
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    entries,
  };
}

export function writeActivationLedger(dataRoot, ledger, { now = null } = {}) {
  const stamp = typeof now === 'string' ? now : nowIso();
  return updateJson(activationLedgerPath(dataRoot), () => ({
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    role: 'derived',
    rebuildable: true,
    updated_at: stamp,
    entries: Array.isArray(ledger?.entries) ? ledger.entries : [],
  }), { fallback: emptyLedger() });
}

export function listActivationEntries(dataRoot) {
  return readActivationLedger(dataRoot).entries.slice();
}

export function findActivationEntry(dataRoot, identityKey) {
  const key = String(identityKey || '').trim();
  return listActivationEntries(dataRoot).find((entry) => (
    entry.identity_key === key
    || (entry.identity && formatActivationIdentity(entry.identity) === key)
  )) ?? null;
}

export function upsertActivationEntry(dataRoot, input, { now = null } = {}) {
  const stamp = typeof now === 'string' ? now : nowIso();
  const normalized = normalizeActivationLedgerEntry({
    ...input,
    created_at: input.created_at || stamp,
    updated_at: input.updated_at || stamp,
  });
  const validated = validateActivationLedgerEntry(normalized);
  if (!validated.ok) return { ...validated, entry: null };

  let stored = null;
  updateJson(activationLedgerPath(dataRoot), (raw) => {
    const ledger = {
      ...emptyLedger(),
      ...(raw && typeof raw === 'object' ? raw : {}),
      entries: Array.isArray(raw?.entries) ? raw.entries.slice() : [],
    };
    const key = normalized.identity_key;
    const index = ledger.entries.findIndex((entry) => entry.identity_key === key);
    stored = { ...normalized, updated_at: stamp };
    if (index >= 0) ledger.entries[index] = stored;
    else ledger.entries.push(stored);
    ledger.updated_at = stamp;
    return ledger;
  }, { fallback: emptyLedger() });

  return { ok: true, errors: [], entry: stored };
}

export function transitionActivationEntry(dataRoot, identityKey, command, { now = null } = {}) {
  const stamp = typeof now === 'string' ? now : (command.updated_at || nowIso());
  let result = { ok: false, errors: [`activation not found: ${identityKey}`], entry: null };

  updateJson(activationLedgerPath(dataRoot), (raw) => {
    const ledger = {
      ...emptyLedger(),
      ...(raw && typeof raw === 'object' ? raw : {}),
      entries: Array.isArray(raw?.entries) ? raw.entries.slice() : [],
    };
    const index = ledger.entries.findIndex((entry) => (
      entry.identity_key === identityKey
      || (entry.identity && formatActivationIdentity(entry.identity) === identityKey)
    ));
    if (index < 0) return ledger;
    const applied = applyActivationLedgerTransition(ledger.entries[index], {
      ...command,
      now: command.now ?? stamp,
      updated_at: command.updated_at ?? stamp,
    }, { now: stamp });
    result = applied.ok
      ? { ok: true, errors: [], entry: applied.entry, kind: applied.kind }
      : { ...applied, entry: ledger.entries[index] };
    if (applied.ok) {
      ledger.entries[index] = applied.entry;
      ledger.updated_at = stamp;
    }
    return ledger;
  }, { fallback: emptyLedger() });

  return result;
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

  updateJson(activationLedgerPath(dataRoot), (raw) => {
    const ledger = {
      ...emptyLedger(),
      ...(raw && typeof raw === 'object' ? raw : {}),
      entries: Array.isArray(raw?.entries) ? raw.entries.slice() : [],
    };
    for (let i = 0; i < ledger.entries.length; i += 1) {
      const entry = ledger.entries[i];
      if (!isActivationLeaseExpired(entry, clock)) continue;
      const applied = applyActivationLedgerTransition(entry, {
        to: 'ready',
        kind: 'reclaim_lease_expired',
        now: stamp,
        updated_at: stamp,
      }, { now: stamp });
      if (!applied.ok) continue;
      ledger.entries[i] = applied.entry;
      reclaimed.push(applied.entry);
    }
    if (reclaimed.length) ledger.updated_at = stamp;
    return ledger;
  }, { fallback: emptyLedger() });

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
  const reactors = {};
  for (const reactor of EVIDENCE_BATCH_REACTORS) {
    reactors[reactor] = {
      realtime: emptyLaneSlice(),
      replay: emptyLaneSlice(),
    };
  }
  for (const entry of entries) {
    if (!EVIDENCE_BATCH_REACTORS.includes(entry.reactor)) continue;
    if (!ACTIVATION_LANES.includes(entry.lane)) continue;
    if (!ACTIVATION_LEDGER_STATES.includes(entry.state)) continue;
    const slice = reactors[entry.reactor][entry.lane];
    if (entry.state === 'handled') slice.handled_total += 1;
    else if (slice[entry.state] != null) slice[entry.state] += 1;
  }
  for (const reactor of EVIDENCE_BATCH_REACTORS) {
    for (const lane of ACTIVATION_LANES) {
      const slice = reactors[reactor][lane];
      slice.open_total = laneOpenCount(slice);
      reconcileLaneCounts(slice);
    }
  }
  return reactors;
}
