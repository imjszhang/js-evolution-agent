import { describe, expect, it } from 'vitest';
import {
  claudeProvider,
  cursorProvider,
  reasonixProvider,
  resolveAgentExecutionRoots,
  runAgenticAction,
  runReceiptVerifyLoop,
} from '../src/actions/agent-adapter/index.mjs';

describe('agent adapter split facades', () => {
  it('exposes provider-specific entrypoints through split modules', () => {
    expect(typeof claudeProvider.buildClaudeOptions).toBe('function');
    expect(typeof cursorProvider.buildCursorOptions).toBe('function');
    expect(typeof reasonixProvider.buildReasonixOptions).toBe('function');
    expect(typeof resolveAgentExecutionRoots).toBe('function');
    expect(typeof runAgenticAction).toBe('function');
  });

  it('runs a shared receipt verification loop until validation passes', async () => {
    const attempts = [];
    const result = await runReceiptVerifyLoop({
      attempts: 3,
      runAttempt: ({ attempt }) => {
        attempts.push(attempt);
        return { attempt };
      },
      validate: (receipt) => ({ valid: receipt.attempt === 2 }),
    });

    expect(result.ok).toBe(true);
    expect(result.result.attempt).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });
});
