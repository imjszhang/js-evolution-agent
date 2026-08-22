/**
 * Bounded catch-up for large evidence backlogs.
 * Explicit wakes, exec, verify, and process-once still proceed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../../infra/json-store.mjs';
import { nowIso, parsePositiveInt } from '../../infra/runtime-paths.mjs';
import { reactorDir } from './paths.mjs';

export const CATCH_UP_BUDGET_REASON = 'catch_up_budget';
export const DEFAULT_CATCH_UP_MAX_BATCHES = 8;
export const DEFAULT_CATCH_UP_MAX_WALL_MS = 15 * 60 * 1000;

export function catchUpPath(dataRoot) {
  return join(reactorDir(dataRoot), 'catch-up.json');
}

function emptyRecord(limits) {
  return {
    schema_version: 1,
    started_at: null,
    batches: 0,
    paused: false,
    pause_reason: null,
    remaining_at_pause: null,
    updated_at: nowIso(),
    max_batches: limits.maxBatches,
    max_wall_ms: limits.maxWallMs,
  };
}

export function resolveCatchUpLimits(env = process.env) {
  return {
    maxBatches: parsePositiveInt(env.JEA_CATCHUP_MAX_BATCHES, {
      name: 'JEA_CATCHUP_MAX_BATCHES',
      defaultValue: DEFAULT_CATCH_UP_MAX_BATCHES,
      min: 1,
    }),
    maxWallMs: parsePositiveInt(env.JEA_CATCHUP_MAX_WALL_MS, {
      name: 'JEA_CATCHUP_MAX_WALL_MS',
      defaultValue: DEFAULT_CATCH_UP_MAX_WALL_MS,
      min: 1,
    }),
  };
}

export function readCatchUpRecord(dataRoot, env = process.env) {
  const limits = resolveCatchUpLimits(env);
  const path = catchUpPath(dataRoot);
  if (!existsSync(path)) return emptyRecord(limits);
  try {
    const raw = readJson(path);
    if (!raw || typeof raw !== 'object') return emptyRecord(limits);
    return {
      ...emptyRecord(limits),
      ...raw,
      max_batches: limits.maxBatches,
      max_wall_ms: limits.maxWallMs,
    };
  } catch {
    return emptyRecord(limits);
  }
}

export function writeCatchUpRecord(dataRoot, record) {
  writeJson(catchUpPath(dataRoot), {
    ...record,
    schema_version: 1,
    updated_at: nowIso(),
  });
  return record;
}

export function readCatchUpProjection(dataRoot, env = process.env) {
  const record = readCatchUpRecord(dataRoot, env);
  return {
    paused: record.paused === true,
    reason: record.paused ? (record.pause_reason || CATCH_UP_BUDGET_REASON) : null,
    batches: Number.isInteger(record.batches) ? record.batches : 0,
    remaining_at_pause: record.remaining_at_pause ?? null,
    max_batches: record.max_batches,
    max_wall_ms: record.max_wall_ms,
  };
}

export function clearCatchUpIfIdle(dataRoot, pendingCount, env = process.env) {
  if ((pendingCount ?? 0) > 0) return readCatchUpRecord(dataRoot, env);
  const limits = resolveCatchUpLimits(env);
  return writeCatchUpRecord(dataRoot, emptyRecord(limits));
}

export function noteCatchUpBatch(dataRoot, { pendingCount = 0 } = {}, env = process.env) {
  const limits = resolveCatchUpLimits(env);
  const previous = readCatchUpRecord(dataRoot, env);
  const startedAt = previous.started_at || nowIso();
  const batches = (Number.isInteger(previous.batches) ? previous.batches : 0) + 1;
  const elapsed = Date.parse(startedAt);
  const overBatches = batches >= limits.maxBatches;
  const overWall = Number.isFinite(elapsed) && (Date.now() - elapsed) >= limits.maxWallMs;
  const paused = overBatches || overWall;
  return writeCatchUpRecord(dataRoot, {
    ...previous,
    started_at: startedAt,
    batches,
    paused,
    pause_reason: paused ? CATCH_UP_BUDGET_REASON : null,
    remaining_at_pause: paused ? pendingCount : null,
    max_batches: limits.maxBatches,
    max_wall_ms: limits.maxWallMs,
  });
}

export function catchUpAllowsEvidenceBacklog(dataRoot, { ignoreBudget = false } = {}, env = process.env) {
  if (ignoreBudget) return { allowed: true, record: readCatchUpRecord(dataRoot, env) };
  const record = readCatchUpRecord(dataRoot, env);
  if (record.paused) return { allowed: false, record };
  if (record.started_at) {
    const elapsed = Date.parse(record.started_at);
    if (Number.isFinite(elapsed) && (Date.now() - elapsed) >= record.max_wall_ms) {
      return {
        allowed: false,
        record: writeCatchUpRecord(dataRoot, {
          ...record,
          paused: true,
          pause_reason: CATCH_UP_BUDGET_REASON,
        }),
      };
    }
  }
  return { allowed: true, record };
}
