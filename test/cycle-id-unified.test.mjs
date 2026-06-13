import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EvolutionEngine,
  ExecutionPipeline,
  MockAIClient,
  NULL_HOST,
} from '../src/engine/index.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';

describe('unified cycle_id', () => {
  let tempDir;

  it('EvolutionEngine.setCycleId overrides default id', () => {
    const engine = new EvolutionEngine({
      aiClient: new MockAIClient(),
      host: NULL_HOST,
      projectRoot: process.cwd(),
    });
    expect(engine.cycleId).toMatch(/^cycle-/);
    engine.setCycleId('cycle-fixed-123');
    expect(engine.cycleId).toBe('cycle-fixed-123');
  });

  it('ExecutionPipeline uses intel cycle_id when provided', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-cycle-'));
    const cycleId = 'cycle-unified-test';
    const queue = createHostDecisionQueue({
      dataDir: join(tempDir, 'evolution'),
    });
    queue.addDecisions({
      cycleId,
      actions: [{
        type: 'record_observation',
        params: { summary: 'cycle id test' },
      }],
    });

    const exec = new ExecutionPipeline({
      host: {
        ...NULL_HOST,
        actionHandlers: {
          record_observation: async () => ({ success: true }),
        },
      },
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId,
    });
    const result = await exec.run({ limit: 1, cycleId });
    expect(result.cycle_id).toBe(cycleId);
    expect(result.cycle_id).not.toMatch(/^exec-/);
    expect(result.success).toBe(true);
  });

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });
});
