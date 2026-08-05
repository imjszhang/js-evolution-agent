import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CARRYOVER_MECHANICAL_LIMIT,
  RETIRABLE_ORIGINS,
  applyCarryoverRetirements,
  buildStepStatusSnapshot,
  carryoverFingerprint,
  filterStalePipelineCarryoverItems,
  formatCarryover,
  inheritCarryoverTracking,
  jaccardSimilarity,
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

  it('formatCarryover appends seen_count streak when >= 2', () => {
    const text = formatCarryover({
      items: [
        {
          text: '候选生成与远端发布',
          source: 'mechanical',
          origin: 'decide_deferred',
          seen_count: 4,
        },
        {
          text: 'first appearance',
          source: 'mechanical',
          origin: 'open_gap',
          seen_count: 1,
        },
      ],
    }, 'zh');
    expect(text).toContain('候选生成与远端发布（已连续 4 轮）');
    expect(text).toContain('[mechanical/open_gap] first appearance');
    expect(text).not.toContain('first appearance（已连续');
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

  it('applyCarryoverRetirements drops retirable mechanical items with closed_by_exec', () => {
    const existing = [
      { text: 'open gap: throttle', source: 'mechanical', origin: 'open_gap' },
      { text: 'decide deferred keep', source: 'mechanical', origin: 'decide_deferred' },
      { text: 'diary keep', source: 'diary' },
      { text: 'suggestion overflow', source: 'mechanical', origin: 'suggestion_overflow' },
    ];
    expect(RETIRABLE_ORIGINS.has('open_gap')).toBe(true);
    expect(RETIRABLE_ORIGINS.has('decide_deferred')).toBe(false);

    const { items, dropped } = applyCarryoverRetirements(existing, [
      {
        id: 'M1',
        reason: 'closed [action_receipts:receipt-1]',
        evidence: '[action_receipts:receipt-1]',
      },
      {
        id: 'M2',
        reason: 'should not retire decide_deferred',
        evidence: '[action_receipts:receipt-2]',
      },
      {
        id: 'M3',
        reason: 'should not retire diary',
        evidence: null,
      },
      {
        id: 'M4',
        reason: 'overflow closed [action_receipts:receipt-4]',
        evidence: '[action_receipts:receipt-4]',
      },
      { id: 'M99', reason: 'out of range ignored', evidence: null },
    ]);

    expect(items.map((i) => i.text)).toEqual([
      'decide deferred keep',
      'diary keep',
    ]);
    expect(dropped).toHaveLength(2);
    expect(dropped.every((d) => d.drop_reason === 'closed_by_exec')).toBe(true);
    expect(dropped.find((d) => d.retirement_id === 'M1').evidence).toBe('[action_receipts:receipt-1]');
    expect(dropped.find((d) => d.retirement_id === 'M4').origin).toBe('suggestion_overflow');
  });

  it('mergeDiaryCarryover applies retirements before cap and preserves behavior without them', () => {
    const without = mergeDiaryCarryover({
      existingItems: [
        { text: 'gap keep', source: 'mechanical', origin: 'open_gap' },
      ],
      diaryBullets: ['叙事'],
    });
    expect(without.items.map((i) => i.text)).toEqual(['gap keep', '叙事']);
    expect(without.dropped).toEqual([]);

    const withRetire = mergeDiaryCarryover({
      existingItems: [
        { text: 'gap closed', source: 'mechanical', origin: 'open_gap' },
        { text: 'deferred keep', source: 'mechanical', origin: 'decide_deferred' },
      ],
      diaryBullets: ['叙事'],
      retirements: [
        { id: 'M1', reason: 'done [action_receipts:r1]', evidence: '[action_receipts:r1]' },
      ],
    });
    expect(withRetire.items.filter((i) => i.source === 'mechanical').map((i) => i.text)).toEqual([
      'deferred keep',
    ]);
    expect(withRetire.dropped).toEqual([
      expect.objectContaining({
        text: 'gap closed',
        drop_reason: 'closed_by_exec',
        evidence: '[action_receipts:r1]',
      }),
    ]);
  });

  it('inherits fingerprint/seen_count across cycles and does not double-count same cycle', () => {
    const root = makeRuntimeRoot();
    writeCarryoverItems(root, {
      cycleId: 'cycle-1',
      defaultSource: 'mechanical',
      items: [
        { text: 'verify pipeline 对磁盘 typed=35 的独立文件层机械核验未执行', source: 'mechanical', origin: 'open_gap' },
      ],
    });
    const c1 = readCarryoverDocument(root);
    expect(c1.items[0].fingerprint).toBe(
      carryoverFingerprint('verify pipeline 对磁盘 typed=35 的独立文件层机械核验未执行'),
    );
    expect(c1.items[0].seen_count).toBe(1);
    expect(c1.items[0].first_seen_cycle).toBe('cycle-1');

    // Same-cycle rewrite (agent_loop → diary) must not increment.
    writeCarryoverItems(root, {
      cycleId: 'cycle-1',
      items: [
        { text: 'verify pipeline 对磁盘 typed=35 的独立文件层机械核验未执行', source: 'mechanical', origin: 'open_gap' },
        { text: '叙事备注', source: 'diary' },
      ],
    });
    expect(readCarryoverDocument(root).items.find((i) => i.source === 'mechanical').seen_count).toBe(1);

    // Next cycle increments.
    writeCarryoverItems(root, {
      cycleId: 'cycle-2',
      defaultSource: 'mechanical',
      items: [
        { text: 'verify pipeline 对磁盘 typed=35 的独立文件层机械核验未执行', source: 'mechanical', origin: 'open_gap' },
      ],
    });
    const c2 = readCarryoverDocument(root).items[0];
    expect(c2.seen_count).toBe(2);
    expect(c2.first_seen_cycle).toBe('cycle-1');
  });

  it('inheritCarryoverTracking uses Jaccard fuzzy match for rewritten mechanical text', () => {
    const prev = {
      cycle_id: 'cycle-1',
      items: [{
        text: 'verify pipeline 对磁盘 typed=35/refs=35 的独立文件层机械核验未执行（连续两次文件层 PASS 第一份证据缺失）',
        source: 'mechanical',
        origin: 'open_gap',
        fingerprint: 'abc',
        first_seen_cycle: 'cycle-1',
        seen_count: 2,
      }],
    };
    expect(jaccardSimilarity(
      prev.items[0].text,
      'verify pipeline 对磁盘 typed=35/refs=35 的独立文件层机械核验仍未执行（连续两次 PASS 第一份证据缺失）',
    )).toBeGreaterThan(0.6);

    const inherited = inheritCarryoverTracking([
      {
        text: 'verify pipeline 对磁盘 typed=35/refs=35 的独立文件层机械核验仍未执行（连续两次 PASS 第一份证据缺失）',
        source: 'mechanical',
        origin: 'open_gap',
      },
    ], prev, { cycleId: 'cycle-2' });
    expect(inherited[0].seen_count).toBe(3);
    expect(inherited[0].first_seen_cycle).toBe('cycle-1');
  });
});
