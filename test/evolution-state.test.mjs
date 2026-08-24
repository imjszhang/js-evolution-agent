import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeContext } from '../src/infra/jea-home.mjs';
import {
  resolveEvolutionState,
  resolveEvolutionStateFromEntry,
  setSubjectEvolutionState,
} from '../src/product/evolution-state.mjs';
import { resolveAutomationPolicy } from '../src/product/automation-policy.mjs';
import { normalizeDaemonDomain } from '../src/daemon/daemon-core.mjs';

const homes = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop(), { recursive: true, force: true });
});

function tempRuntime(registry) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-state-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-state-home-'));
  homes.push(sourceRoot, jeaHome);
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify(registry));
  return createRuntimeContext({ sourceRoot, jeaHome });
}

describe('evolution state', () => {
  it('prefers state over automation and maps legacy modes to active', () => {
    expect(resolveEvolutionStateFromEntry({})).toMatchObject({
      state: 'active',
      mapped_from: 'default',
    });
    expect(resolveEvolutionStateFromEntry({
      evolution: { state: 'paused', automation: 'automatic', mode: 'continuous' },
    })).toMatchObject({
      state: 'paused',
      mapped_from: 'state',
    });
    expect(resolveEvolutionStateFromEntry({
      evolution: { automation: 'paused', mode: 'continuous' },
    })).toMatchObject({
      state: 'paused',
      mapped_from: 'automation',
    });
    expect(resolveEvolutionStateFromEntry({
      evolution: { mode: 'on_demand' },
    })).toMatchObject({
      state: 'active',
      mapped_from: 'on_demand',
      diagnostic: 'legacy_on_demand',
    });
  });

  it('writes state and automation together', () => {
    const runtime = tempRuntime({
      default_subject: 'alpha',
      subjects: {
        alpha: {
          data_namespace: 'alpha-data',
          evolution: { mode: 'on_demand' },
        },
      },
    });
    const written = setSubjectEvolutionState(runtime, 'alpha', 'paused');
    expect(written).toMatchObject({
      changed: true,
      previous: 'active',
      state: 'paused',
      automation: 'paused',
    });
    expect(resolveEvolutionState(runtime, 'alpha').state).toBe('paused');
    expect(resolveAutomationPolicy(runtime, 'alpha').mode).toBe('paused');
    const registry = JSON.parse(readFileSync(join(runtime.jeaHome, 'subjects', 'registry.json'), 'utf8'));
    expect(registry.subjects.alpha.evolution).toMatchObject({
      mode: 'on_demand',
      state: 'paused',
      automation: 'paused',
    });
    setSubjectEvolutionState(runtime, 'alpha', 'active');
    expect(resolveEvolutionState(runtime, 'alpha').state).toBe('active');
    expect(resolveAutomationPolicy(runtime, 'alpha').mode).toBe('automatic');
  });

  it('maps --domain evolution to the cycle worker', () => {
    expect(normalizeDaemonDomain('evolution')).toBe('cycle');
    expect(normalizeDaemonDomain('cycle')).toBe('cycle');
    expect(normalizeDaemonDomain('channel')).toBe('channel');
    expect(normalizeDaemonDomain(undefined, 'all')).toBe('all');
  });
});
