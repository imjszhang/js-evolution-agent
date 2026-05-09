import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  actionHandlers,
  actionVerifiers,
} from '../src/actions/handlers.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

let tempDir = null;

function makeCtx() {
  tempDir = mkdtempSync(join(tmpdir(), 'js-evolution-agent-actions-'));
  return {
    cycleId: 'test-cycle',
    host: {
      intelligenceStore: createIntelligenceStore({ baseDir: tempDir }),
    },
  };
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('controlled action handlers', () => {
  it('records observations through the intelligence store', () => {
    const ctx = makeCtx();
    const result = actionHandlers.record_observation({
      type: 'record_observation',
      params: {
        source: 'test',
        subject: 'handler',
        content: 'handler wrote an observation',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(ctx.host.intelligenceStore.readRecentIntel({ days: 1, limit: 5 })[0].content)
      .toBe('handler wrote an observation');
  });

  it('requires bounded probe fields before recording a probe', () => {
    const ctx = makeCtx();
    expect(() => actionHandlers.propose_probe({
      type: 'propose_probe',
      params: { hypothesis: 'too little data' },
    }, ctx)).toThrow(/missing required field/);
  });

  it('records core requests without executing mutation', () => {
    const ctx = makeCtx();
    const action = {
      type: 'request_core_review',
      params: {
        target: 'engine core',
        rationale: 'needs approval',
        risks: ['mutation'],
      },
    };
    const result = actionHandlers.request_core_review(action, ctx);
    const verification = actionVerifiers.request_core_review.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(verification.status).toBe('improved');
  });
});

