import {
  describe,
  expect,
  it,
} from 'vitest';
import { safeWorktreeSlug } from '../src/actions/worktree-manager.mjs';

describe('worktree-manager slugs', () => {
  it('strips trailing dot after 80-char slice (Windows git worktree invalid path)', () => {
    const target = '强制技能迭代：读取agent-guide.md（确认API与流程），凭据SHA256前缀验证，记忆审计（subject_runtime下standing_memory.json），生成非freeze候选（基于近期replay分析或参数调整），模拟门禁，通过后发布（POST /api/agent/tank/code），记录pre/post rank和rankScore，写回本地报告';
    const slug = safeWorktreeSlug(['exec-20260531-171903', target].join('-'));
    expect(slug.endsWith('.')).toBe(false);
    expect(slug).not.toMatch(/[.\s_-]$/);
  });

  it('uses hash suffix instead of full intent when composed by createBranchWorktree', async () => {
    const { createBranchWorktree } = await import('../src/actions/worktree-manager.mjs');
    const target = 'agent-guide.md API SHA256 subject_runtime standing_memory.json';
    const nameParts = ['exec-test', `t-${'deadbeef'.slice(0, 8)}`];
    const slug = safeWorktreeSlug(nameParts.join('-'));
    expect(slug.length).toBeLessThan(40);
    expect(slug).not.toContain('standing_memory.');
    expect(typeof createBranchWorktree).toBe('function');
  });
});
