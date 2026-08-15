import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CYCLE_PIPELINES,
  cyclePipelineFromFlags,
  normalizeCyclePipeline,
  resolveCyclePipeline,
} from '../src/daemon/cycle-pipeline-mode.mjs';

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

  it('exposes only reactor as a live pipeline', () => {
    expect(CYCLE_PIPELINES).toEqual(['reactor']);
  });

  it('normalizes reactor and retired aliases for historical reads', () => {
    expect(normalizeCyclePipeline('reactor')).toBe('reactor');
    expect(normalizeCyclePipeline('classic')).toBe('phases');
    expect(normalizeCyclePipeline('agent-loop')).toBe('agent_loop');
    expect(normalizeCyclePipeline('nope')).toBeNull();
  });

  it('defaults to reactor when unset', () => {
    writeRegistry(null);
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: {},
      env: {},
    });
    expect(resolved).toEqual({ pipeline: 'reactor', source: 'default' });
  });

  it('rejects retired live pipelines', () => {
    writeRegistry('agent_loop');
    expect(() => resolveCyclePipeline(tempRoot, { subject: 'demo' })).toThrow(/removed in S9/);
    writeRegistry(null);
    expect(() => resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { loop: true },
    })).toThrow(/removed in S9/);
    expect(() => resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'phases' },
    })).toThrow(/removed in S9/);
  });

  it('parses pipeline flags without running them', () => {
    expect(cyclePipelineFromFlags({ loop: true })).toBe('agent_loop');
    expect(cyclePipelineFromFlags({ pipeline: 'phases' })).toBe('phases');
    expect(cyclePipelineFromFlags({ pipeline: 'reactor' })).toBe('reactor');
    expect(cyclePipelineFromFlags({})).toBeNull();
  });
});
