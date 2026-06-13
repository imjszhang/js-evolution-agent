import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DecisionQueue,
  decisionFingerprint,
} from '../src/engine/index.mjs';

describe('unified DecisionQueue', () => {
  let tempDir;

  it('adds, deduplicates hot decisions, claims, and completes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });

    const action = { type: 'record_observation', params: { summary: 'test' } };
    const fp = decisionFingerprint(action);
    expect(fp).toContain('record_observation');

    const first = queue.addDecisionsDetailed({
      cycleId: 'cycle-test-1',
      actions: [action],
    });
    expect(first.ids).toHaveLength(1);
    expect(first.skipped).toHaveLength(0);

    const dup = queue.addDecisionsDetailed({
      cycleId: 'cycle-test-1',
      actions: [action],
    });
    expect(dup.ids).toHaveLength(0);
    expect(dup.skipped[0]?.reason).toBe('duplicate_hot_decision');

    const claimed = queue.claimNext(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(first.ids[0]);

    queue.completeDecision(claimed[0].id, 'ok');
    expect(queue.getById(claimed[0].id)?.status).toBe('completed');
  });

  it('archives completed decisions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisions({
      cycleId: 'cycle-archive',
      actions: [{ type: 'record_observation', params: { summary: 'x' } }],
    });
    const [decision] = queue.claimNext(1);
    queue.completeDecision(decision.id, 'done');

    const preview = queue.archiveDecisions({ dryRun: true });
    expect(preview.archived).toHaveLength(1);

    queue.archiveDecisions({ dryRun: false });
    expect(queue.readAll().decisions).toHaveLength(0);
  });

  it('assigns monotonic ids when the same cycle enqueues multiple batches', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const cycleId = 'cycle-multi-batch';

    const first = queue.addDecisionsDetailed({
      cycleId,
      actions: [
        { type: 'record_observation', params: { summary: 'a' } },
        { type: 'propose_probe', params: { probe_id: 'p1' } },
      ],
    });
    expect(first.ids).toEqual([`${cycleId}:0`, `${cycleId}:1`]);

    const [done] = queue.claimNext(1);
    queue.completeDecision(done.id, 'ok');

    const second = queue.addDecisionsDetailed({
      cycleId,
      actions: [
        { type: 'write_retrospective', params: { summary: 'b' } },
      ],
    });
    expect(second.ids).toEqual([`${cycleId}:2`]);
    expect(queue.getAll().map((d) => d.id).sort()).toEqual([
      `${cycleId}:0`,
      `${cycleId}:1`,
      `${cycleId}:2`,
    ]);
  });

  it('summarize reports backpressure signals', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    for (let i = 0; i < 3; i++) {
      queue.addDecisions({
        cycleId: `cycle-${i}`,
        actions: [{ type: 'record_observation', params: { summary: `s${i}` } }],
      });
    }
    const summary = queue.summarize({ hotLimit: 2 });
    expect(summary.hot).toBe(3);
    expect(summary.backpressure).toBe(true);
  });

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });
});
