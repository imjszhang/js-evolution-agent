/**
 * Bounded Activation Ledger reader for the 0.3.0 incremental projection.
 *
 * This module does not route or write work. #211 owns ledger production.
 * Missing / corrupt / oversized stores are unknown or degraded — never
 * rewritten as an empty healthy inbox.
 */
import { existsSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import {
  ACTIVATION_LANES,
  ACTIVATION_LEDGER_STATES,
  EVIDENCE_BATCH_REACTORS,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  collectForbiddenControlPlaneKeys,
  reconcileLaneCounts,
} from '../contracts/index.mjs';
import { isPlainObject } from '../contracts/validation.mjs';
import { activationLedgerDeltasPath } from '../evolution/reactor/paths.mjs';
import { ACTIVATION_LEDGER_STORE_SCHEMA, activationLedgerPath } from '../evolution/reactor/activation-ledger-store.mjs';

export const DEFAULT_ACTIVATION_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ACTIVATION_LEDGER_DELTA_MAX_LINES = 4_096;

const OPEN_STATES = Object.freeze(['ready', 'claimed', 'deferred', 'blocked']);

function projectionByteLimit(env = process.env) {
  const configured = Number(env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_ACTIVATION_LEDGER_MAX_BYTES;
}

function deltaLineLimit(env = process.env) {
  const configured = Number(env.JEA_ACTIVATION_LEDGER_DELTA_MAX_LINES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_ACTIVATION_LEDGER_DELTA_MAX_LINES;
}

function fileBytes(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

export function emptyLaneCountSlice() {
  return {
    ready: 0,
    claimed: 0,
    deferred: 0,
    blocked: 0,
    handled_total: 0,
    open_total: 0,
  };
}

export function emptyReactorLaneCounts() {
  return Object.fromEntries(
    ACTIVATION_LANES.map((lane) => [lane, emptyLaneCountSlice()]),
  );
}

function cloneLaneSlice(slice = {}) {
  return {
    ready: Number.isInteger(slice.ready) ? slice.ready : 0,
    claimed: Number.isInteger(slice.claimed) ? slice.claimed : 0,
    deferred: Number.isInteger(slice.deferred) ? slice.deferred : 0,
    blocked: Number.isInteger(slice.blocked) ? slice.blocked : 0,
    handled_total: Number.isInteger(slice.handled_total) ? slice.handled_total : 0,
    open_total: Number.isInteger(slice.open_total) ? slice.open_total : 0,
  };
}

export function cloneReactorCounts(reactors = {}) {
  const next = {};
  for (const [reactor, lanes] of Object.entries(reactors || {})) {
    if (!EVIDENCE_BATCH_REACTORS.includes(reactor) || !isPlainObject(lanes)) continue;
    next[reactor] = emptyReactorLaneCounts();
    for (const lane of ACTIVATION_LANES) {
      next[reactor][lane] = cloneLaneSlice(lanes[lane]);
    }
  }
  return next;
}

function stripForbidden(value) {
  if (!isPlainObject(value)) return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (collectForbiddenControlPlaneKeys({ [key]: child }, 'value').length) continue;
    next[key] = isPlainObject(child) ? stripForbidden(child) : child;
  }
  return next;
}

function compactLedgerEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const reactor = String(entry.reactor || entry.identity?.reactor || '').trim();
  const lane = String(entry.lane || '').trim();
  const state = String(entry.state || '').trim();
  if (!EVIDENCE_BATCH_REACTORS.includes(reactor)) return null;
  if (!ACTIVATION_LANES.includes(lane)) return null;
  if (!ACTIVATION_LEDGER_STATES.includes(state)) return null;
  const identityKey = typeof entry.identity_key === 'string' && entry.identity_key.trim()
    ? entry.identity_key.trim()
    : null;
  return stripForbidden({
    identity_key: identityKey,
    reactor,
    lane,
    state,
    activation_reason: entry.activation_reason ?? null,
    priority: entry.priority ?? null,
    updated_at: entry.updated_at ?? null,
    created_at: entry.created_at ?? null,
    origin: entry.origin ?? null,
    claim: isPlainObject(entry.claim) ? stripForbidden(entry.claim) : null,
    progress: isPlainObject(entry.progress) ? stripForbidden(entry.progress) : null,
    hold_reason: isPlainObject(entry.hold_reason) ? stripForbidden(entry.hold_reason) : null,
    grouping: isPlainObject(entry.grouping) ? stripForbidden(entry.grouping) : null,
    replay_epoch_id: entry.replay_epoch_id ?? null,
  });
}

function compactDelta(row) {
  if (!isPlainObject(row)) return null;
  const sequence = Number(row.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) return null;
  const to = String(row.to || row.state || '').trim();
  const reactor = String(row.reactor || '').trim();
  const lane = String(row.lane || '').trim();
  if (to && !ACTIVATION_LEDGER_STATES.includes(to)) return null;
  if (reactor && !EVIDENCE_BATCH_REACTORS.includes(reactor)) return null;
  if (lane && !ACTIVATION_LANES.includes(lane)) return null;
  const from = row.from == null ? null : String(row.from).trim();
  if (from && !ACTIVATION_LEDGER_STATES.includes(from)) return null;
  return stripForbidden({
    sequence,
    identity_key: typeof row.identity_key === 'string' ? row.identity_key : null,
    reactor: reactor || null,
    lane: lane || null,
    from: from || null,
    to: to || null,
    kind: typeof row.kind === 'string' ? row.kind : null,
    updated_at: row.updated_at ?? null,
    claim: isPlainObject(row.claim) ? stripForbidden(row.claim) : null,
    progress: isPlainObject(row.progress) ? stripForbidden(row.progress) : null,
    hold_reason: isPlainObject(row.hold_reason) ? stripForbidden(row.hold_reason) : null,
  });
}

function finishLaneSlice(slice) {
  const reconciled = reconcileLaneCounts(slice);
  slice.open_total = reconciled.open_total ?? (
    (Number.isInteger(slice.ready) ? slice.ready : 0)
    + (Number.isInteger(slice.claimed) ? slice.claimed : 0)
    + (Number.isInteger(slice.deferred) ? slice.deferred : 0)
    + (Number.isInteger(slice.blocked) ? slice.blocked : 0)
  );
  return slice;
}

export function ensureReactorLaneSlice(reactors, reactor, lane) {
  if (!EVIDENCE_BATCH_REACTORS.includes(reactor) || !ACTIVATION_LANES.includes(lane)) {
    return null;
  }
  if (!reactors[reactor]) reactors[reactor] = emptyReactorLaneCounts();
  if (!reactors[reactor][lane]) reactors[reactor][lane] = emptyLaneCountSlice();
  return reactors[reactor][lane];
}

function adjustStateCount(slice, state, delta) {
  if (!slice || !state || !delta) return;
  if (OPEN_STATES.includes(state)) {
    slice[state] = Math.max(0, (Number.isInteger(slice[state]) ? slice[state] : 0) + delta);
  } else if (state === 'handled') {
    slice.handled_total = Math.max(
      0,
      (Number.isInteger(slice.handled_total) ? slice.handled_total : 0) + delta,
    );
  }
}

export function applyLedgerDeltaToCounts(reactors, delta) {
  if (!delta?.reactor || !delta?.lane) return reactors;
  const slice = ensureReactorLaneSlice(reactors, delta.reactor, delta.lane);
  if (!slice) return reactors;
  if (delta.from && delta.from !== delta.to) adjustStateCount(slice, delta.from, -1);
  if (delta.to) adjustStateCount(slice, delta.to, 1);
  finishLaneSlice(slice);
  return reactors;
}

export function recountReactorCountsFromEntries(entries = []) {
  const reactors = {};
  for (const entry of entries) {
    const slice = ensureReactorLaneSlice(reactors, entry.reactor, entry.lane);
    if (!slice) continue;
    adjustStateCount(slice, entry.state, 1);
  }
  for (const lanes of Object.values(reactors)) {
    for (const lane of ACTIVATION_LANES) {
      finishLaneSlice(lanes[lane]);
    }
  }
  return reactors;
}

function acceptedLedgerSchema(raw) {
  if (raw.schema_version == null) return true;
  if (raw.schema_version === REACTOR_CONTROL_PLANE_CONTRACT_VERSION) return true;
  if (raw.schema_version === ACTIVATION_LEDGER_STORE_SCHEMA) return true;
  return raw.contract_version === REACTOR_CONTROL_PLANE_CONTRACT_VERSION;
}

function rawEntryList(raw) {
  if (raw.entries == null) return [];
  if (Array.isArray(raw.entries)) return raw.entries;
  if (typeof raw.entries === 'object') return Object.values(raw.entries);
  return null;
}

export function readActivationLedgerStore(dataRoot, { env = process.env } = {}) {
  let filePath;
  try {
    filePath = activationLedgerPath(dataRoot);
  } catch {
    return {
      status: 'unknown',
      reason: 'activation_ledger_unresolved',
      generation: null,
      sequence: null,
      updated_at: null,
      entries: [],
      file_bytes: null,
    };
  }
  if (!existsSync(filePath)) {
    return {
      status: 'unknown',
      reason: 'activation_ledger_unresolved',
      generation: null,
      sequence: null,
      updated_at: null,
      entries: [],
      file_bytes: null,
    };
  }
  const bytes = fileBytes(filePath);
  const limit = projectionByteLimit(env);
  if (bytes != null && bytes > limit) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_oversized',
      generation: null,
      sequence: null,
      updated_at: null,
      entries: [],
      file_bytes: bytes,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_unreadable',
      generation: null,
      sequence: null,
      updated_at: null,
      entries: [],
      file_bytes: bytes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isPlainObject(raw)) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_invalid',
      generation: null,
      sequence: null,
      updated_at: null,
      entries: [],
      file_bytes: bytes,
    };
  }
  if (!acceptedLedgerSchema(raw)) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_schema_mismatch',
      generation: Number.isInteger(raw.generation) ? raw.generation : (raw.generation ?? null),
      sequence: Number.isInteger(raw.sequence) ? raw.sequence : null,
      updated_at: raw.updated_at ?? null,
      entries: [],
      file_bytes: bytes,
    };
  }
  const listed = rawEntryList(raw);
  if (listed == null) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_invalid',
      generation: Number.isInteger(raw.generation) ? raw.generation : (raw.generation ?? null),
      sequence: Number.isInteger(raw.sequence) ? raw.sequence : null,
      updated_at: raw.updated_at ?? null,
      entries: [],
      file_bytes: bytes,
    };
  }
  const entries = listed.map(compactLedgerEntry).filter(Boolean);
  return {
    status: 'ok',
    reason: null,
    generation: Number.isInteger(raw.generation) ? raw.generation : 0,
    sequence: Number.isInteger(raw.sequence) ? raw.sequence : entries.length,
    updated_at: raw.updated_at ?? null,
    entries,
    file_bytes: bytes,
  };
}

export async function readActivationLedgerDeltas(dataRoot, {
  afterSequence = -1,
  env = process.env,
} = {}) {
  const filePath = activationLedgerDeltasPath(dataRoot);
  if (!existsSync(filePath)) {
    return { status: 'ok', reason: null, deltas: [], truncated: false };
  }
  const bytes = fileBytes(filePath);
  const limit = projectionByteLimit(env);
  if (bytes != null && bytes > limit) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_deltas_oversized',
      deltas: [],
      truncated: true,
      file_bytes: bytes,
    };
  }
  const maxLines = deltaLineLimit(env);
  const deltas = [];
  let seen = 0;
  let truncated = false;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return {
          status: 'degraded',
          reason: 'activation_ledger_deltas_unreadable',
          deltas: [],
          truncated: false,
          file_bytes: bytes,
        };
      }
      const delta = compactDelta(parsed);
      if (!delta) {
        return {
          status: 'degraded',
          reason: 'activation_ledger_deltas_invalid',
          deltas: [],
          truncated: false,
          file_bytes: bytes,
        };
      }
      if (delta.sequence <= afterSequence) continue;
      seen += 1;
      if (seen > maxLines) {
        truncated = true;
        break;
      }
      deltas.push(delta);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  if (truncated) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_deltas_unbounded',
      deltas: [],
      truncated: true,
      file_bytes: bytes,
    };
  }
  return { status: 'ok', reason: null, deltas, truncated: false, file_bytes: bytes };
}

export function readActivationLedgerDeltasSync(dataRoot, {
  afterSequence = -1,
  env = process.env,
} = {}) {
  const filePath = activationLedgerDeltasPath(dataRoot);
  if (!existsSync(filePath)) {
    return { status: 'ok', reason: null, deltas: [], truncated: false };
  }
  const bytes = fileBytes(filePath);
  const limit = projectionByteLimit(env);
  if (bytes != null && bytes > limit) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_deltas_oversized',
      deltas: [],
      truncated: true,
      file_bytes: bytes,
    };
  }
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      status: 'degraded',
      reason: 'activation_ledger_deltas_unreadable',
      deltas: [],
      truncated: false,
      file_bytes: bytes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const maxLines = deltaLineLimit(env);
  const deltas = [];
  let seen = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        status: 'degraded',
        reason: 'activation_ledger_deltas_unreadable',
        deltas: [],
        truncated: false,
        file_bytes: bytes,
      };
    }
    const delta = compactDelta(parsed);
    if (!delta) {
      return {
        status: 'degraded',
        reason: 'activation_ledger_deltas_invalid',
        deltas: [],
        truncated: false,
        file_bytes: bytes,
      };
    }
    if (delta.sequence <= afterSequence) continue;
    seen += 1;
    if (seen > maxLines) {
      return {
        status: 'degraded',
        reason: 'activation_ledger_deltas_unbounded',
        deltas: [],
        truncated: true,
        file_bytes: bytes,
      };
    }
    deltas.push(delta);
  }
  return { status: 'ok', reason: null, deltas, truncated: false, file_bytes: bytes };
}
