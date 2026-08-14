/**
 * Atomic evidence-batch checkpoint (S4). Recovery truth for gate-on
 * reactor tasks. Cycle-state artifacts are only for the explicit train fallback.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { handleContractValidation, validateBatchCheckpoint } from '../../contracts/index.mjs';
import { writeJsonAtomic } from '../../infra/atomic-json-write.mjs';
import { readJson } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import { reactorDir } from './paths.mjs';

const RESUMABLE_STAGES = Object.freeze(['claimed', 'investigate', 'report', 'decide', 'deferred']);
const STAGE_ORDER = Object.freeze({
  claimed: 0,
  investigate: 1,
  report: 2,
  decide: 3,
  committed: 4,
  deferred: 0,
  failed: -1,
});

export function batchCheckpointsDir(dataRoot) {
  return join(reactorDir(dataRoot), 'checkpoints');
}

export function batchCheckpointPath(dataRoot, batchId) {
  return join(batchCheckpointsDir(dataRoot), `${batchId}.json`);
}

export function readBatchCheckpoint(dataRoot, batchId) {
  const filePath = batchCheckpointPath(dataRoot, batchId);
  if (!existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

export function writeBatchCheckpoint(dataRoot, record) {
  const payload = {
    ...record,
    written_at: record.written_at || nowIso(),
  };
  handleContractValidation('batch_checkpoint', validateBatchCheckpoint(payload));
  mkdirSync(batchCheckpointsDir(dataRoot), { recursive: true });
  writeJsonAtomic(batchCheckpointPath(dataRoot, payload.batch_id), payload);
  return payload;
}

export function patchBatchCheckpoint(dataRoot, batchId, patch = {}) {
  const current = readBatchCheckpoint(dataRoot, batchId) || {
    batch_id: batchId,
    reactor: patch.reactor || 'cognitive',
    stage: 'claimed',
    event_ids: [],
    written_at: nowIso(),
  };
  const next = { ...current, ...patch, batch_id: batchId };
  const incomingIds = Array.isArray(patch.event_ids) ? patch.event_ids : null;
  if ((!incomingIds || incomingIds.length === 0) && current.event_ids?.length) {
    next.event_ids = current.event_ids;
  }
  return writeBatchCheckpoint(dataRoot, next);
}

export function listBatchCheckpoints(dataRoot, { reactor = null } = {}) {
  const dir = batchCheckpointsDir(dataRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return readJson(join(dir, name));
      } catch {
        return null;
      }
    })
    .filter((record) => record?.batch_id && (!reactor || record.reactor === reactor));
}

export function checkpointStageReached(checkpoint, stage) {
  const current = STAGE_ORDER[checkpoint?.stage] ?? -1;
  const target = STAGE_ORDER[stage] ?? 99;
  return current >= target;
}

export function findResumableCheckpoint(dataRoot, { reactor = 'cognitive' } = {}) {
  const open = listBatchCheckpoints(dataRoot, { reactor })
    .filter((record) => RESUMABLE_STAGES.includes(record.stage))
    .sort((a, b) => String(b.written_at || '').localeCompare(String(a.written_at || '')));
  return open[0] ?? null;
}
