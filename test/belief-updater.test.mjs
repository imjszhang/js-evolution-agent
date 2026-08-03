import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildBeliefUpdateContext,
  buildBeliefUpdatePrompt,
  buildBeliefUpdatePromptContext,
  compressBeliefsForPrompt,
} from '../src/intelligence/belief-updater.mjs';

function makeHugeBeliefsDoc(activeCount = 20, refutedCount = 40) {
  const beliefs = [];
  for (let i = 0; i < activeCount; i++) {
    beliefs.push({
      id: `belief-active-${i}`,
      goal_id: 'goal-root',
      claim: `active claim ${i} ${'x'.repeat(800)}`,
      status: 'active',
      confidence: 'medium',
      next_test: `next test ${i}`,
      evidence_refs: Array.from({ length: 12 }, (_, j) => `action_receipt:receipt-${i}-${j}`),
      history: Array.from({ length: 20 }, (_, j) => ({
        cycle_id: `cycle-${j}`,
        note: `history padding ${j} ${'y'.repeat(200)}`,
      })),
    });
  }
  for (let i = 0; i < refutedCount; i++) {
    beliefs.push({
      id: `belief-refuted-${i}`,
      goal_id: 'goal-root',
      claim: `refuted claim ${i} ${'z'.repeat(400)}`,
      status: 'refuted',
      confidence: 'low',
      next_test: null,
      evidence_refs: [`verify_report:cycle-old-${i}`],
      history: Array.from({ length: 10 }, (_, j) => ({
        cycle_id: `cycle-old-${j}`,
        note: `refuted padding ${'w'.repeat(300)}`,
      })),
    });
  }
  return {
    schema_version: 1,
    updated_at: '2026-08-02T15:00:00.000Z',
    source_cycle_id: 'cycle-prev',
    beliefs,
  };
}

describe('belief-updater prompt evidence wiring', () => {
  it('compresses beliefs and keeps evidence ahead of goals/beliefs', () => {
    const huge = makeHugeBeliefsDoc();
    const compressed = compressBeliefsForPrompt(huge);
    expect(compressed.beliefs.active).toHaveLength(20);
    expect(compressed.beliefs.recently_refuted).toHaveLength(10);
    expect(compressed.beliefs.recently_refuted[0]).toEqual({
      id: 'belief-refuted-30',
      claim: expect.stringContaining('refuted claim 30'),
      status: 'refuted',
    });
    expect(compressed.beliefs.active[0].history).toBeUndefined();
    expect(compressed.counts.total).toBe(60);

    const fullJsonLen = JSON.stringify(huge).length;
    const compressedJsonLen = JSON.stringify(compressed).length;
    expect(fullJsonLen).toBeGreaterThan(120000);
    expect(compressedJsonLen).toBeLessThan(fullJsonLen / 2);
  });

  it('keeps receipts and verification inside the clipped prompt when beliefs are huge', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-belief-updater-'));
    const reportDir = join(root, 'verify_reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, 'cycle-evidence.json');
    writeFileSync(reportPath, JSON.stringify({
      timestamp: '2026-08-02T15:50:00.000Z',
      verified: [{
        action: { type: 'agent_run', description: 'run cycle' },
        metric: 'file_outcomes',
        status: 'improved',
        value: { success: true, message: 'UNIQUE_VERIFY_TOKEN_7B2' },
      }],
      pending: [],
      semantic: {
        status: 'ok',
        result: { overall_summary: 'UNIQUE_SEMANTIC_TOKEN_9C4' },
      },
    }, null, 2), 'utf-8');

    const store = {
      readCurrentBeliefs: () => makeHugeBeliefsDoc(),
      readActionReceipts: () => [{
        id: 'receipt-unique-abc',
        cycle_id: 'cycle-evidence',
        action_type: 'agent_run',
        decision_id: 'cycle-evidence:0',
        result: {
          status: 'partial',
          success: true,
          message: 'UNIQUE_RECEIPT_TOKEN_3F1 gate_failed',
        },
      }],
    };

    const context = buildBeliefUpdateContext({
      activeGoals: {
        id: 'goal-root',
        name: 'Root',
        intent: 'Keep evolving',
        good_signal: 'g',
        bad_signal: 'b',
        children: [],
      },
      intelResult: {
        cycle_id: 'cycle-evidence',
        analysis: { decision: 'execute', rationale: 'Need belief update from receipts.' },
        actions: [{
          type: 'agent_run',
          description: 'Iterate skill',
          serves_goal: 'goal-root',
          params: {
            run_spec: {
              intent: 'run',
              context: {
                belief_id: 'belief-active-0',
                expected_belief_update: 'Roll baseline',
              },
            },
          },
        }],
      },
      execResult: { cycle_id: 'cycle-evidence' },
      verification: {
        semantic: {
          status: 'ok',
          result: { overall_summary: 'UNIQUE_SEMANTIC_TOKEN_9C4' },
        },
      },
      verificationReportPath: reportPath,
      store,
    });

    // Full context keeps array beliefs for applyBeliefUpdates.
    expect(Array.isArray(context.current_beliefs.beliefs)).toBe(true);
    expect(Object.keys(context).slice(0, 6)).toEqual([
      'cycle',
      'analysis',
      'actions',
      'receipts',
      'verification',
      'semantic',
    ]);

    const promptContext = buildBeliefUpdatePromptContext(context);
    expect(promptContext.current_beliefs.beliefs.active).toHaveLength(20);
    expect(Array.isArray(promptContext.current_beliefs.beliefs)).toBe(false);

    const prompt = buildBeliefUpdatePrompt({ context, language: 'zh' });
    expect(prompt).toContain('UNIQUE_RECEIPT_TOKEN_3F1');
    expect(prompt).toContain('UNIQUE_VERIFY_TOKEN_7B2');
    expect(prompt).toContain('UNIQUE_SEMANTIC_TOKEN_9C4');
    expect(prompt).toContain('receipt-unique-abc');
    expect(prompt.includes('...(truncated)')).toBe(false);
  });
});
