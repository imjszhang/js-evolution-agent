import { describe, expect, it } from 'vitest';
import {
  extractReportSuggestions,
  formatReportSuggestionsForPrompt,
  reconcileSuggestionCoverage,
} from '../src/intelligence/report-suggestions.mjs';

describe('report suggestions', () => {
  it('extracts numbered bullets from 下一轮建议', () => {
    const md = `# Report

## Seen
- fact

## 下一轮建议
- 复测分页
1. 生成本地学习状态报告
- 忽略无关段落

## Other
- not a suggestion
`;
    expect(extractReportSuggestions(md)).toEqual([
      { id: 'S1', text: '复测分页' },
      { id: 'S2', text: '生成本地学习状态报告' },
      { id: 'S3', text: '忽略无关段落' },
    ]);
  });

  it('reconcile fills unaddressed and downgrades invalid adopted index', () => {
    const suggestions = [
      { id: 'S1', text: 'probe A' },
      { id: 'S2', text: 'write report' },
      { id: 'S3', text: 'skip me' },
    ];
    const result = reconcileSuggestionCoverage({
      suggestions,
      analysis: {
        suggestion_coverage: {
          S1: { disposition: 'adopted', action_index: 0 },
          S3: { disposition: 'adopted', action_index: 9 },
        },
      },
      queuedActions: [{ type: 'agent_run' }],
    });

    expect(result.summary).toEqual({
      total: 3,
      adopted: 1,
      deferred: 2,
      rejected: 0,
      unaddressed: 1,
    });
    expect(result.items.find((i) => i.id === 'S2')).toMatchObject({
      disposition: 'deferred',
      reason: 'unaddressed',
      host_filled: true,
    });
    expect(result.items.find((i) => i.id === 'S3')).toMatchObject({
      disposition: 'deferred',
    });
    expect(result.warnings.some((w) => w.id === 'S3')).toBe(true);
    expect(result.carryoverItems.every((i) => i.origin === 'suggestion_deferred')).toBe(true);
    expect(result.carryoverItems).toHaveLength(2);
  });

  it('formatReportSuggestionsForPrompt lists ids', () => {
    const text = formatReportSuggestionsForPrompt([
      { id: 'S1', text: 'one' },
      { id: 'S2', text: 'two' },
    ], 'zh');
    expect(text).toContain('S1. one');
    expect(text).toContain('S2. two');
    expect(text).toContain('suggestion_coverage');
  });
});
