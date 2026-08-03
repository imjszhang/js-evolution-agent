import { describe, expect, it } from 'vitest';
import {
  claudeProvider,
  cursorProvider,
  parseRawReceipt,
  reasonixProvider,
  resolveAgentExecutionRoots,
  runAgenticAction,
  runReceiptVerifyLoop,
  stripOuterMarkdownFence,
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

  it('parseRawReceipt accepts outer markdown-fenced JSON receipts', () => {
    const receipt = {
      status: 'partial',
      summary: 'Gate failed; publish blocked.',
      evidence: { gate: { verdict: 'fail' } },
      outputs: { recommendation: 'rerun sim' },
    };
    const fenced = ['```json', JSON.stringify(receipt, null, 2), '```'].join('\n');
    expect(stripOuterMarkdownFence(fenced)).toBe(JSON.stringify(receipt, null, 2));

    const parsed = parseRawReceipt(fenced);
    expect(parsed.parseMode).toBe('fenced_json');
    expect(parsed.receipt).toMatchObject({
      status: 'partial',
      summary: 'Gate failed; publish blocked.',
    });

    // CRLF fences and language-less fences also work.
    const crlf = ['```', JSON.stringify(receipt), '```'].join('\r\n');
    expect(parseRawReceipt(crlf).parseMode).toBe('fenced_json');
  });
});
