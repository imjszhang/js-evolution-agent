import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CATCH_UP_BUDGET_REASON,
  catchUpAllowsEvidenceBacklog,
  clearCatchUpIfIdle,
  noteCatchUpBatch,
  readCatchUpProjection,
  writeCatchUpRecord,
} from '../src/evolution/reactor/catch-up-budget.mjs';

const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempDataRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-catch-up-'));
  roots.push(root);
  return root;
}

describe('catch-up budget', () => {
  it('pauses after the configured batch limit', () => {
    const dataRoot = tempDataRoot();
    const env = { JEA_CATCHUP_MAX_BATCHES: '2', JEA_CATCHUP_MAX_WALL_MS: '600000' };
    expect(catchUpAllowsEvidenceBacklog(dataRoot, {}, env).allowed).toBe(true);
    expect(noteCatchUpBatch(dataRoot, { pendingCount: 9 }, env).paused).toBe(false);
    const afterLimit = noteCatchUpBatch(dataRoot, { pendingCount: 8 }, env);
    expect(afterLimit).toMatchObject({
      paused: true,
      pause_reason: CATCH_UP_BUDGET_REASON,
      remaining_at_pause: 8,
      batches: 2,
    });
    expect(catchUpAllowsEvidenceBacklog(dataRoot, {}, env).allowed).toBe(false);
    expect(catchUpAllowsEvidenceBacklog(dataRoot, { ignoreBudget: true }, env).allowed).toBe(true);
    expect(readCatchUpProjection(dataRoot, env)).toMatchObject({
      paused: true,
      reason: CATCH_UP_BUDGET_REASON,
    });
  });

  it('pauses when the wall clock budget is already exhausted', () => {
    const dataRoot = tempDataRoot();
    const env = { JEA_CATCHUP_MAX_BATCHES: '80', JEA_CATCHUP_MAX_WALL_MS: '1000' };
    writeCatchUpRecord(dataRoot, {
      schema_version: 1,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      batches: 1,
      paused: false,
      pause_reason: null,
      remaining_at_pause: null,
    });
    const gate = catchUpAllowsEvidenceBacklog(dataRoot, {}, env);
    expect(gate.allowed).toBe(false);
    expect(gate.record.paused).toBe(true);
  });

  it('clears the pause when no eligible evidence remains', () => {
    const dataRoot = tempDataRoot();
    const env = { JEA_CATCHUP_MAX_BATCHES: '1', JEA_CATCHUP_MAX_WALL_MS: '600000' };
    noteCatchUpBatch(dataRoot, { pendingCount: 3 }, env);
    expect(readCatchUpProjection(dataRoot, env).paused).toBe(true);
    expect(clearCatchUpIfIdle(dataRoot, 3, env).paused).toBe(true);
    expect(clearCatchUpIfIdle(dataRoot, 0, env).paused).toBe(false);
    expect(readCatchUpProjection(dataRoot, env).paused).toBe(false);
  });
});
