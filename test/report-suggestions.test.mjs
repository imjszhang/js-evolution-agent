import { describe, expect, it } from 'vitest';
import {
  extractReportSuggestions,
  formatReportSuggestionsForPrompt,
  reconcileSuggestionCoverage,
} from '../src/intelligence/report-suggestions.mjs';

describe('report suggestions', () => {
  it('extracts only top-level bullets from 下一轮建议', () => {
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
    expect(extractReportSuggestions(md)).toEqual({
      suggestions: [
        { id: 'S1', text: '复测分页' },
        { id: 'S2', text: '生成本地学习状态报告' },
        { id: 'S3', text: '忽略无关段落' },
      ],
      overflow: [],
      truncated: false,
    });
  });

  it('ignores nested bullets and keeps top-level only (live report shape)', () => {
    const md = `## 下一轮建议

1. **执行一个自主 agent_run**（permission_profile 取 workspace_write）。
2. **agent_run 内按序覆盖以下探针，不拆成多个动作菜单**：
   - 记忆审计复测：清理截断标记
   - 分页聚合重试：统一 2s throttle
   - 学习状态报告补更
   - subject_runtime scope env 注入 scoped 验证
   - getTank 复核 rankScore/codeVersion
   - gate.std.max=35 只读复核
   - 重试 DeepSeek assessment 链以恢复 goals_calibrate
3. **结束条件与记录**：用 record_observation 持久化脱敏结论。
4. **下一轮 Analyze+Decide 的预期**：任何解锁或发布决策都应被守护目标阻塞。
`;
    const extracted = extractReportSuggestions(md);
    expect(extracted.suggestions).toHaveLength(4);
    expect(extracted.suggestions.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(extracted.suggestions[1].text).toContain('不拆成多个动作菜单');
    expect(extracted.suggestions.every((s) => !s.text.startsWith('记忆审计复测'))).toBe(true);
    expect(extracted.overflow).toEqual([]);
    expect(extracted.truncated).toBe(false);
  });

  it('merges run_spec field-label top-level lines into one suggestion', () => {
    const md = `## 下一轮建议

- **执行一个自主 agent_run**（workspace_write）
- **primary_cwd_kind**: subject_runtime
- **permission_profile**: workspace_write
- **intent**: 复测分页聚合与记忆审计
- **context**: belief_id 绑定本轮
- **expected_output**:
- 结束条件：record_observation 落盘脱敏结论
`;
    const extracted = extractReportSuggestions(md);
    expect(extracted.suggestions).toHaveLength(2);
    expect(extracted.suggestions[0].id).toBe('S1');
    expect(extracted.suggestions[0].text).toContain('执行一个自主 agent_run');
    expect(extracted.suggestions[0].text).toContain('primary_cwd_kind: subject_runtime');
    expect(extracted.suggestions[0].text).toContain('intent: 复测分页聚合与记忆审计');
    expect(extracted.suggestions[0].text).not.toContain('expected_output');
    expect(extracted.suggestions[1].text).toContain('结束条件');
    expect(extracted.truncated).toBe(false);
  });

  it('keeps normal top-level suggestions unchanged', () => {
    const md = `## 下一轮建议

1. 复测分页
2. 写学习状态报告
`;
    expect(extractReportSuggestions(md).suggestions.map((s) => s.text)).toEqual([
      '复测分页',
      '写学习状态报告',
    ]);
  });

  it('overflow beyond limit becomes suggestion_overflow carryover candidates', () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `${i + 1}. top-level suggestion ${i + 1}`);
    const md = `## 下一轮建议\n\n${bullets.join('\n')}\n`;
    const extracted = extractReportSuggestions(md, { limit: 8 });
    expect(extracted.suggestions).toHaveLength(8);
    expect(extracted.overflow).toHaveLength(2);
    expect(extracted.truncated).toBe(true);
    expect(extracted.overflow[0].text).toContain('suggestion 9');
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
