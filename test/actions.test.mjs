import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const projectRoot = join(tempDir, 'project');
  const dataRoot = join(projectRoot, 'runtime', 'subjects', 'test', 'data');
  mkdirSync(dataRoot, { recursive: true });
  return {
    cycleId: 'test-cycle',
    projectRoot,
    host: {
      sourceRoot: projectRoot,
      dataRoot,
      intelligenceStore: createIntelligenceStore({ baseDir: join(tempDir, 'intelligence') }),
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

  it('runs read-only JSONL probes and records structured results', () => {
    const ctx = makeCtx();
    const target = join(ctx.host.dataRoot, 'events.jsonl');
    writeFileSync(target, '{"type":"event","status":"ok"}\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'jsonl_validate',
        target,
        required_fields: ['type', 'status'],
        hypothesis: 'events are valid JSONL',
        success_signal: 'all lines parse and include required fields',
        failure_signal: 'invalid JSONL or missing fields',
        death_boundary: 'read-only inspection only',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0].probe_type)
      .toBe('jsonl_validate');
  });

  it('runs open-ended investigations without requiring a probe_type', () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.projectRoot, 'README.md'), '# Test Project\n\nEvolution runner evidence.\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Investigate evolution runner evidence in the project',
      params: {
        objective: 'Find evolution runner evidence',
        targets: [ctx.projectRoot],
        budget: { max_files: 10, max_steps: 5 },
      },
    }, ctx);

    const probeResult = ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0];
    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(probeResult.probe_type).toBe('investigation');
    expect(probeResult.evidence.steps.some((step) => step.tool === 'keyword_search')).toBe(true);
  });

  it('infers keyword_search keywords from probe context', () => {
    const ctx = makeCtx();
    const target = join(ctx.projectRoot, 'README.md');
    writeFileSync(target, '# Test Project\n\nPending decisions are visible.\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Search for pending decisions',
      params: {
        probe_type: 'keyword_search',
        target,
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('blocks probes against sensitive files while still recording the outcome', () => {
    const ctx = makeCtx();
    const target = join(ctx.projectRoot, '.env');
    writeFileSync(target, 'SECRET=hidden\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'file_exists',
        target,
        hypothesis: 'sensitive file exists',
        success_signal: 'file exists',
        failure_signal: 'file missing',
        death_boundary: 'do not read sensitive files',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('blocked');
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0].reason)
      .toMatch(/sensitive/);
  });
});

