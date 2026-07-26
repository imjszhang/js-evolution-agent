import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalProvider } from '../src/engine/decide/goal-provider.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function writeGoals(tree) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-goals-'));
  const goalsDir = join(tempDir, 'data', 'goals');
  mkdirSync(goalsDir, { recursive: true });
  writeFileSync(join(goalsDir, 'active_goals.json'), JSON.stringify(tree, null, 2), 'utf-8');
  return tempDir;
}

describe('GoalProvider bootstrap convention', () => {
  it('silently falls back to root for missing bootstrap id', () => {
    const root = writeGoals({
      id: 'win-more',
      name: 'Win more',
      intent: 'improve',
      good_signal: 'up',
      bad_signal: 'down',
      children: [],
    });
    const warning = vi.fn();
    const provider = new GoalProvider(root, { warning });
    const text = provider.formatForPrompt('bootstrap');
    expect(text).toContain('Win more');
    expect(warning).not.toHaveBeenCalled();
    const observe = provider.formatForObserve('bootstrap');
    expect(observe).toContain('Win more');
    expect(warning).not.toHaveBeenCalled();
  });

  it('still warns for other missing goal ids', () => {
    const root = writeGoals({
      id: 'win-more',
      name: 'Win more',
      intent: 'improve',
      good_signal: 'up',
      bad_signal: 'down',
      children: [],
    });
    const warning = vi.fn();
    const provider = new GoalProvider(root, { warning });
    provider.formatForPrompt('does-not-exist');
    expect(warning).toHaveBeenCalled();
  });
});
