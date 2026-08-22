import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeContext } from '../src/infra/jea-home.mjs';
import {
  listBackgroundSubjects,
  resolveAutomationPolicy,
  resolveAutomationPolicyFromEntry,
  setSubjectAutomation,
} from '../src/product/automation-policy.mjs';

const homes = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop(), { recursive: true, force: true });
});

function tempRuntime(registry) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-auto-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-auto-home-'));
  homes.push(sourceRoot, jeaHome);
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify(registry));
  return createRuntimeContext({ sourceRoot, jeaHome });
}

describe('product automation policy', () => {
  it('defaults to automatic and maps legacy continuous / on_demand', () => {
    expect(resolveAutomationPolicyFromEntry({})).toMatchObject({
      mode: 'automatic',
      mapped_from: 'default',
      diagnostic: null,
      background: false,
    });
    expect(resolveAutomationPolicyFromEntry({ evolution: { mode: 'continuous' } })).toMatchObject({
      mode: 'automatic',
      mapped_from: 'continuous',
      diagnostic: 'legacy_continuous',
    });
    expect(resolveAutomationPolicyFromEntry({ evolution: { mode: 'on_demand' } })).toMatchObject({
      mode: 'automatic',
      mapped_from: 'on_demand',
      diagnostic: 'legacy_on_demand',
    });
    expect(resolveAutomationPolicyFromEntry({ evolution: { mode: 'weird' } })).toMatchObject({
      mode: 'automatic',
      mapped_from: 'ambiguous',
      diagnostic: 'ambiguous_evolution_mode',
    });
  });

  it('honors explicit automation and background without rewriting legacy mode', () => {
    const runtime = tempRuntime({
      default_subject: 'alpha',
      subjects: {
        alpha: {
          data_namespace: 'alpha-data',
          evolution: { mode: 'on_demand', background: true },
        },
      },
    });
    expect(resolveAutomationPolicy(runtime, 'alpha')).toMatchObject({
      subject: 'alpha',
      mode: 'automatic',
      diagnostic: 'legacy_on_demand',
      background: true,
    });
    const written = setSubjectAutomation(runtime, 'alpha', 'paused');
    expect(written).toMatchObject({ changed: true, previous: 'automatic', mode: 'paused' });
    expect(resolveAutomationPolicy(runtime, 'alpha')).toMatchObject({
      mode: 'paused',
      mapped_from: 'automation',
      background: true,
    });
    const registry = JSON.parse(readFileSync(join(runtime.jeaHome, 'subjects', 'registry.json'), 'utf8'));
    expect(registry.subjects.alpha.evolution.mode).toBe('on_demand');
    expect(registry.subjects.alpha.evolution.automation).toBe('paused');
    expect(registry.subjects.alpha.evolution.background).toBe(true);
  });

  it('persists paused / automatic and lists background subjects only', () => {
    const runtime = tempRuntime({
      default_subject: 'alpha',
      subjects: {
        alpha: { data_namespace: 'alpha-data', evolution: { mode: 'continuous' } },
        beta: { data_namespace: 'beta-data', evolution: { automation: 'automatic', background: true } },
      },
    });
    setSubjectAutomation(runtime, 'alpha', 'paused');
    expect(resolveAutomationPolicy(runtime, 'alpha').mode).toBe('paused');
    setSubjectAutomation(runtime, 'alpha', 'automatic');
    expect(resolveAutomationPolicy(runtime, 'alpha').mode).toBe('automatic');
    expect(listBackgroundSubjects(runtime)).toEqual(['beta']);
  });
});
