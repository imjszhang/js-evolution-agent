import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CARRYOVER_MECHANICAL_LIMIT,
  buildStepStatusSnapshot,
  filterStalePipelineCarryoverItems,
  formatCarryover,
  mergeDiaryCarryover,
  rankAndLimitMechanicalItems,
  readCarryoverDocument,
  readCarryoverItems,
  writeCarryoverItems,
} from '../src/evolution/carryover.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeRuntimeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-carryover-'));
  return tempDir;
}

describe('carryover v2', () => {
  it('reads v1 string items as diary-source entries', () => {
    const root = makeRuntimeRoot();
    const path = join(root, 'data', 'evolution', 'agent_loop_carryover.json');
    mkdirSync(join(root, 'data', 'evolution'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      cycle_id: 'old',
      items: ['legacy item A', 'legacy item B'],
    }, null, 2));

    const doc = readCarryoverDocument(root);
    expect(doc.schema_version).toBe(2);
    expect(doc.items).toEqual([
      { text: 'legacy item A', source: 'diary' },
      { text: 'legacy item B', source: 'diary' },
    ]);
    expect(readCarryoverItems(root)).toEqual(['legacy item A', 'legacy item B']);
  });

  it('writes mechanical items and preserves them across diary merge', () => {
    const root = makeRuntimeRoot();
    writeCarryoverItems(root, {
      cycleId: 'cycle-1',
      defaultSource: 'mechanical',
      items: [
        { text: 'open gap: throttle', source: 'mechanical', origin: 'open_gap' },
        { text: 'S2: write learning report（budget）', source: 'mechanical', origin: 'suggestion_deferred' },
      ],
    });

    const before = readCarryoverDocument(root);
    expect(before.schema_version).toBe(2);
    expect(before.items.every((i) => i.source === 'mechanical')).toBe(true);

    const merged = mergeDiaryCarryover({
      existingItems: before.items,
      diaryBullets: ['下轮复核分页', '不要复述 calibrate skipped'],
      stepStatusSnapshot: { goals_calibrate: 'applied(patch)', exec: 'ok(3)' },
    });
    writeCarryoverItems(root, {
      cycleId: 'cycle-1',
      items: merged.items,
      step_status_snapshot: merged.step_status_snapshot,
    });

    const after = readCarryoverDocument(root);
    expect(after.step_status_snapshot).toEqual({
      goals_calibrate: 'applied(patch)',
      exec: 'ok(3)',
    });
    expect(after.items.filter((i) => i.source === 'mechanical')).toHaveLength(2);
    expect(after.items.filter((i) => i.source === 'diary').map((i) => i.text)).toEqual([
      '下轮复核分页',
      '不要复述 calibrate skipped',
    ]);
  });

  it('formatCarryover renders snapshot, tags, and conflict instruction', () => {
    const text = formatCarryover({
      step_status_snapshot: { goals_calibrate: 'applied(patch)' },
      items: [
        { text: 'deferred learning report', source: 'mechanical', origin: 'suggestion_deferred' },
        { text: 'narrative note', source: 'diary' },
      ],
    }, 'zh');

    expect(text).toContain('以后者为准');
    expect(text).toContain('goals_calibrate: applied(patch)');
    expect(text).toContain('[mechanical/suggestion_deferred] deferred learning report');
    expect(text).toContain('[diary] narrative note');
  });

  it('buildStepStatusSnapshot extracts mechanical step statuses', () => {
    const snapshot = buildStepStatusSnapshot({
      execResult: { success: true, executed: [{}, {}, {}] },
      verification: {
        verified: [{}, {}, {}],
        pending: [],
        semantic: { status: 'ok' },
      },
      beliefUpdateResult: { result: { status: 'updated', updates: [1, 2] } },
      goalsAssessResult: { assessment: { status: 'ok', rule_status: 'learn' } },
      goalsCalibrateResult: { status: 'applied', mode: 'patch' },
    });
    expect(snapshot.exec).toBe('ok(3)');
    expect(snapshot.verify).toContain('3/3');
    expect(snapshot.belief_update).toBe('updated(2)');
    expect(snapshot.goals_assess).toBe('ok(learn)');
    expect(snapshot.goals_calibrate).toBe('applied(patch)');
  });

  it('rankAndLimitMechanicalItems keeps decide_deferred over goal_suggestion', () => {
    const items = [
      { text: 'g1', source: 'mechanical', origin: 'goal_suggestion' },
      { text: 'g2', source: 'mechanical', origin: 'goal_suggestion' },
      { text: 'gap1', source: 'mechanical', origin: 'open_gap' },
      { text: 'def1', source: 'mechanical', origin: 'decide_deferred' },
      { text: 'ov1', source: 'mechanical', origin: 'suggestion_overflow' },
      { text: 'sd1', source: 'mechanical', origin: 'suggestion_deferred' },
      { text: 'gap2', source: 'mechanical', origin: 'open_gap' },
      { text: 'gap3', source: 'mechanical', origin: 'open_gap' },
      { text: 'gap4', source: 'mechanical', origin: 'open_gap' },
      { text: 'gap5', source: 'mechanical', origin: 'open_gap' },
      { text: 'gap6', source: 'mechanical', origin: 'open_gap' },
      { text: 'g3', source: 'mechanical', origin: 'goal_suggestion' },
    ];
    const { kept, dropped } = rankAndLimitMechanicalItems(items, { limit: CARRYOVER_MECHANICAL_LIMIT });
    expect(kept).toHaveLength(8);
    expect(kept.map((i) => i.origin)).toEqual([
      'decide_deferred',
      'suggestion_deferred',
      'open_gap',
      'open_gap',
      'open_gap',
      'open_gap',
      'open_gap',
      'open_gap',
    ]);
    expect(dropped.some((i) => i.origin === 'goal_suggestion')).toBe(true);
    expect(dropped.some((i) => i.origin === 'suggestion_overflow')).toBe(true);
  });

  it('filterStalePipelineCarryoverItems drops pending claims for finished steps', () => {
    const { kept, dropped } = filterStalePipelineCarryoverItems([
      { text: 'DeepSeek assessment 链：goals_calibrate 仍 pending', source: 'diary' },
      { text: '分页 API 仍 502', source: 'mechanical', origin: 'open_gap' },
      { text: 'verify pipeline 独立核验 standing_memory', source: 'diary' },
    ], {
      goals_calibrate: 'applied(patch)',
      goals_assess: 'refine(learn)',
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].text).toContain('goals_calibrate');
    expect(kept.map((i) => i.text)).toEqual([
      '分页 API 仍 502',
      'verify pipeline 独立核验 standing_memory',
    ]);
  });

  it('mergeDiaryCarryover exact-dedupes diary texts against mechanical and reports drops', () => {
    const merged = mergeDiaryCarryover({
      existingItems: [
        { text: '分页聚合口径合并', source: 'mechanical', origin: 'open_gap' },
        { text: 'DeepSeek goals_calibrate 仍 pending', source: 'mechanical', origin: 'open_gap' },
      ],
      diaryBullets: [
        '分页聚合口径合并',
        '新的叙事项：学习期退出评估',
        'goals_assess 尚未完成',
      ],
      stepStatusSnapshot: {
        goals_calibrate: 'applied(patch)',
        goals_assess: 'refine(learn)',
      },
    });
    expect(merged.items.filter((i) => i.source === 'mechanical')).toHaveLength(1);
    expect(merged.items.filter((i) => i.source === 'diary').map((i) => i.text)).toEqual([
      '新的叙事项：学习期退出评估',
    ]);
    expect(merged.dropped.some((d) => d.drop_reason === 'exact_dupe_of_mechanical')).toBe(true);
    expect(merged.dropped.some((d) => d.drop_reason === 'stale_pipeline_status')).toBe(true);
  });
});
