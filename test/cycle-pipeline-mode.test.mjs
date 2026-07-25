import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CYCLE_PIPELINES,
  cyclePipelineFromFlags,
  normalizeCyclePipeline,
  resolveCyclePipeline,
} from '../src/cli/utils/cycle-pipeline-mode.mjs';

describe('cycle pipeline mode', () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  function writeRegistry(pipeline = null) {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-pipeline-'));
    const subjectsDir = join(tempRoot, 'runtime', 'subjects');
    mkdirSync(subjectsDir, { recursive: true });
    const subject = {
      policy: 'SUBJECT.md',
      data_namespace: 'demo',
      evolution: { mode: 'on_demand' },
    };
    if (pipeline) subject.evolution.pipeline = pipeline;
    writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
      default_subject: 'demo',
      subjects: { demo: subject },
    }, null, 2), 'utf-8');
    mkdirSync(join(subjectsDir, 'demo'), { recursive: true });
    writeFileSync(join(subjectsDir, 'demo', 'SUBJECT.md'), '# Subject\n\nDemo.\n', 'utf-8');
    return tempRoot;
  }

  it('exposes supported pipelines', () => {
    expect(CYCLE_PIPELINES).toEqual(['phases', 'agent_loop']);
  });

  it('normalizes aliases', () => {
    expect(normalizeCyclePipeline('classic')).toBe('phases');
    expect(normalizeCyclePipeline('agent-loop')).toBe('agent_loop');
    expect(normalizeCyclePipeline('loop')).toBe('agent_loop');
    expect(normalizeCyclePipeline('nope')).toBeNull();
  });

  it('resolves registry over cli/env/default', () => {
    writeRegistry('agent_loop');
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'phases' },
      env: { JEA_CYCLE_PIPELINE: 'phases' },
    });
    expect(resolved).toEqual({ pipeline: 'agent_loop', source: 'runtime-registry.json' });
  });

  it('resolves CLI --loop over env', () => {
    writeRegistry(null);
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { loop: true },
      env: { JEA_CYCLE_PIPELINE: 'phases' },
    });
    expect(resolved).toEqual({ pipeline: 'agent_loop', source: 'cli' });
  });

  it('resolves env over default', () => {
    writeRegistry(null);
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: {},
      env: { JEA_CYCLE_PIPELINE: 'agent_loop' },
    });
    expect(resolved).toEqual({ pipeline: 'agent_loop', source: 'env' });
  });

  it('falls back to phases for invalid values', () => {
    writeRegistry('not-a-pipeline');
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'garbage' },
      env: { JEA_CYCLE_PIPELINE: 'also-bad' },
    });
    expect(resolved).toEqual({ pipeline: 'phases', source: 'default' });
  });

  it('parses pipeline flags', () => {
    expect(cyclePipelineFromFlags({ loop: true })).toBe('agent_loop');
    expect(cyclePipelineFromFlags({ pipeline: 'phases' })).toBe('phases');
    expect(cyclePipelineFromFlags({})).toBeNull();
  });
});
