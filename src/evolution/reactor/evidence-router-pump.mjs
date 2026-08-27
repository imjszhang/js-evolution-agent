/**
 * Bounded persistent Evidence Router pump.
 *
 * Advances a generation-scoped journal byte cursor and calls routeEvidenceDelta
 * exactly once per newly appended compact journal entry. Never scans history
 * after a generation change — rebuild already reconciled the ledger.
 */
import { existsSync, statSync } from 'node:fs';
import { readJson, writeJson } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import {
  activationLedgerPath,
  emptyActivationLedgerStore,
  writeActivationLedger,
} from './activation-ledger-store.mjs';
import { inspectControlPlaneReadiness } from './control-plane-readiness.mjs';
import {
  evidenceIndexJournalPath,
  evidenceIndexPath,
  hydrateIndexedEnvelope,
  refreshEvidenceIndex,
  scanJournalEntriesFromOffset,
} from './evidence-index.mjs';
import { routeEvidenceDelta } from './evidence-router.mjs';
import { evidenceRouterCursorPath } from './paths.mjs';

export const DEFAULT_ROUTER_PUMP_LIMIT = 32;
export const ROUTER_CURSOR_SCHEMA = 'evidence-router-cursor.v1';

export function readRouterCursor(dataRoot) {
  return readJson(evidenceRouterCursorPath(dataRoot), {
    schema_version: ROUTER_CURSOR_SCHEMA,
    generation: null,
    offset: 0,
    updated_at: null,
  });
}

export function writeRouterCursor(dataRoot, patch = {}) {
  const current = readRouterCursor(dataRoot);
  const next = {
    schema_version: ROUTER_CURSOR_SCHEMA,
    generation: patch.generation ?? current.generation ?? null,
    offset: Number.isFinite(Number(patch.offset)) ? Math.max(0, Math.floor(Number(patch.offset))) : (current.offset || 0),
    updated_at: patch.updated_at ?? nowIso(),
  };
  writeJson(evidenceRouterCursorPath(dataRoot), next);
  return next;
}

function journalGeneration(dataRoot) {
  const manifest = readJson(evidenceIndexPath(dataRoot), null);
  return typeof manifest?.generation === 'string' && manifest.generation.trim()
    ? manifest.generation.trim()
    : (manifest?.generation ?? null);
}

function journalByteLength(dataRoot) {
  const path = evidenceIndexJournalPath(dataRoot);
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function ensureEmptyLedgerForFreshSubject(dataRoot, generation) {
  if (!dataRoot) return;
  try {
    const file = activationLedgerPath(dataRoot);
    if (existsSync(file)) return;
    writeActivationLedger(dataRoot, emptyActivationLedgerStore({
      generation: generation ?? null,
      updated_at: nowIso(),
    }));
  } catch {
    // Next inspect without a ledger fail-closes. Do not invent entries.
  }
}

/**
 * Route a bounded window of newly appended journal entries.
 * Cursor advances only after a successful hydrate+route.
 */
export function pumpEvidenceRouter(dataRoot, {
  limit = DEFAULT_ROUTER_PUMP_LIMIT,
  subject = null,
  env = process.env,
  readLedger = null,
} = {}) {
  if (!dataRoot) {
    return { ok: false, reason: 'activation_ledger_unresolved', routed: 0 };
  }
  const readiness = inspectControlPlaneReadiness({ dataRoot, env, readLedger });
  if (!readiness.allow_pump) {
    return {
      ok: false,
      reason: readiness.reason || 'control_plane_not_ready',
      routed: 0,
      ready: false,
    };
  }

  try {
    refreshEvidenceIndex(dataRoot);
  } catch (error) {
    if (error?.code === 'evidence_index_rebuild_required' || error?.code === 'evidence_journal_maintenance_blocked') {
      return {
        ok: false,
        reason: error.code,
        routed: 0,
        ready: readiness.ready,
      };
    }
    throw error;
  }

  const generation = journalGeneration(dataRoot);
  if (readiness.fresh_subject) {
    ensureEmptyLedgerForFreshSubject(dataRoot, generation);
  }
  if (!generation) {
    return { ok: true, routed: 0, reason: 'no_journal_generation', eof: true };
  }

  const cursor = readRouterCursor(dataRoot);
  if (cursor.generation && cursor.generation !== generation) {
    const offset = journalByteLength(dataRoot);
    writeRouterCursor(dataRoot, { generation, offset });
    return {
      ok: true,
      routed: 0,
      reset: 'generation_changed',
      generation,
      offset,
      eof: true,
    };
  }

  const start = cursor.generation ? Math.max(0, Number(cursor.offset) || 0) : 0;
  if (!cursor.generation) {
    writeRouterCursor(dataRoot, { generation, offset: start });
  }

  const window = scanJournalEntriesFromOffset(dataRoot, {
    start,
    limit: Math.max(1, Math.floor(Number(limit) || DEFAULT_ROUTER_PUMP_LIMIT)),
  });

  let routed = 0;
  let created = 0;
  let lastOffset = start;
  for (const item of window.entries) {
    const compact = item.entry;
    const endOffset = item.endOffset;
    const envelope = hydrateIndexedEnvelope(dataRoot, compact);
    if (!envelope) {
      return {
        ok: false,
        reason: 'hydrate_failed',
        routed,
        created,
        generation,
        offset: lastOffset,
        eof: false,
        retryable: true,
        ready: readiness.ready,
      };
    }
    const outcome = routeEvidenceDelta(dataRoot, {
      envelopes: [envelope],
      subject,
    });
    routed += 1;
    created += outcome.created?.length ?? 0;
    lastOffset = endOffset;
    writeRouterCursor(dataRoot, { generation, offset: lastOffset });
  }

  return {
    ok: true,
    routed,
    created,
    generation,
    offset: lastOffset,
    eof: window.eof === true,
    ready: readiness.ready,
  };
}
