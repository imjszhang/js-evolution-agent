import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CYCLE_PIPELINES,
  cyclePipelineFromFlags,
  normalizeCyclePipeline,
  resetPhasesDeprecationWarningForTests,
  resolveCyclePipeline,
} from '../src/daemon/cycle-pipeline-mode.mjs';

describe('cycle pipeline mode', () => {
  let tempRoot;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
    resetPhasesDeprecationWarningForTests();
    vi.restoreAllMocks();
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
    expect(CYCLE_PIPELINES).toEqual(['phases', 'agent_loop', 'reactor']);
  });

  it('normalizes reactor pipeline', () => {
    expect(normalizeCyclePipeline('reactor')).toBe('reactor');
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
      env: { JEA_CYCLE_PIPELINE: 'phases', JEA_SUPPRESS_PHASES_DEPRECATION: '1' },
    });
    expect(resolved).toEqual({ pipeline: 'agent_loop', source: 'runtime-registry.json' });
  });

  it('resolves CLI --loop over env', () => {
    writeRegistry(null);
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { loop: true },
      env: { JEA_CYCLE_PIPELINE: 'phases', JEA_SUPPRESS_PHASES_DEPRECATION: '1' },
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

  it('falls back to agent_loop for invalid values', () => {
    writeRegistry('not-a-pipeline');
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'garbage' },
      env: { JEA_CYCLE_PIPELINE: 'also-bad' },
    });
    expect(resolved).toEqual({ pipeline: 'reactor', source: 'default' });
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

  it('still resolves explicit phases and warns once unless suppressed', () => {
    writeRegistry(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'phases' },
      env: {},
    });
    expect(resolved).toEqual({ pipeline: 'phases', source: 'cli' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/deprecated/i);

    resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'phases' },
      env: {},
    });
    expect(warn).toHaveBeenCalledTimes(1);

    resetPhasesDeprecationWarningForTests();
    warn.mockClear();
    const suppressed = resolveCyclePipeline(tempRoot, {
      subject: 'demo',
      flags: { pipeline: 'phases' },
      env: { JEA_SUPPRESS_PHASES_DEPRECATION: '1' },
    });
    expect(suppressed).toEqual({ pipeline: 'phases', source: 'cli' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses pipeline flags', () => {
    expect(cyclePipelineFromFlags({ loop: true })).toBe('agent_loop');
    expect(cyclePipelineFromFlags({ pipeline: 'phases' })).toBe('phases');
    expect(cyclePipelineFromFlags({})).toBeNull();
  });
});
