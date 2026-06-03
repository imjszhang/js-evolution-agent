import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonSafe, writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  evolutionModeFromEnv,
  evolutionModeFromFlags,
  normalizeEvolutionMode,
  resolveEvolutionMode,
  setSubjectEvolutionMode,
} from '../src/cli/utils/evolution-mode.mjs';
import { applyEvolutionModeChange } from '../src/cli/utils/evolution-mode-apply.mjs';
import { subjectsRegistryFile } from '../src/cli/utils/subjects.mjs';

function makeRoot({ subjectMode = null } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-evolution-mode-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  const entry = {
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  };
  if (subjectMode) entry.evolution = { mode: subjectMode };
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: { alpha: entry },
  });
  return tempDir;
}

describe('evolution-mode', () => {
  it('defaults to continuous when no overrides', () => {
    const root = makeRoot();
    const resolved = resolveEvolutionMode(root, { subject: 'alpha', flags: {}, env: {} });
    expect(resolved.mode).toBe('continuous');
    expect(resolved.source).toBe('default');
    rmSync(root, { recursive: true, force: true });
  });

  it('reads subject evolution.mode from subjects.json', () => {
    const root = makeRoot({ subjectMode: 'on_demand' });
    const resolved = resolveEvolutionMode(root, { subject: 'alpha', flags: {}, env: {} });
    expect(resolved.mode).toBe('on_demand');
    expect(resolved.source).toBe('subjects.json');
    rmSync(root, { recursive: true, force: true });
  });

  it('reports runtime registry source when runtime registry exists', () => {
    const root = makeRoot();
    writeJsonFile(subjectsRegistryFile(root), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { mode: 'on_demand' },
        },
      },
    });
    const resolved = resolveEvolutionMode(root, { subject: 'alpha', flags: {}, env: {} });
    expect(resolved.mode).toBe('on_demand');
    expect(resolved.source).toBe('runtime-registry.json');
    rmSync(root, { recursive: true, force: true });
  });

  it('reads env when subject has no override', () => {
    const root = makeRoot();
    expect(evolutionModeFromEnv({ JEA_EVOLUTION_MODE: 'on_demand' })).toBe('on_demand');
    expect(evolutionModeFromFlags({ 'evolution-mode': 'on_demand' })).toBe('on_demand');
    const resolved = resolveEvolutionMode(root, {
      subject: 'alpha',
      flags: {},
      env: { JEA_EVOLUTION_MODE: 'on_demand' },
    });
    expect(resolved.mode).toBe('on_demand');
    expect(resolved.source).toBe('env');
    rmSync(root, { recursive: true, force: true });
  });

  it('cli flag overrides env', () => {
    const root = makeRoot();
    const resolved = resolveEvolutionMode(root, {
      subject: 'alpha',
      flags: { 'evolution-mode': 'continuous' },
      env: { JEA_EVOLUTION_MODE: 'on_demand' },
    });
    expect(resolved.mode).toBe('continuous');
    expect(resolved.source).toBe('cli');
    rmSync(root, { recursive: true, force: true });
  });

  it('re-reads subjects.json on each resolve for hot reload', () => {
    const root = makeRoot();
    expect(resolveEvolutionMode(root, { subject: 'alpha', flags: {}, env: {} }).mode).toBe('continuous');
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { mode: 'on_demand' },
        },
      },
    });
    const after = resolveEvolutionMode(root, { subject: 'alpha', flags: {}, env: {} });
    expect(after.mode).toBe('on_demand');
    expect(after.source).toBe('subjects.json');
    rmSync(root, { recursive: true, force: true });
  });

  it('setSubjectEvolutionMode writes subjects.json', () => {
    const root = makeRoot();
    const result = setSubjectEvolutionMode(root, 'alpha', 'on_demand');
    expect(result.changed).toBe(true);
    expect(result.previous).toBe('continuous');
    expect(result.mode).toBe('on_demand');
    expect(result.source).toBe('runtime-registry.json');
    const registry = readJsonSafe(subjectsRegistryFile(root), null);
    expect(registry.subjects.alpha.evolution.mode).toBe('on_demand');
    rmSync(root, { recursive: true, force: true });
  });

  it('applyEvolutionModeChange records evolution_mode_changed', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'runtime', 'subjects', 'alpha', 'data', 'intelligence'), { recursive: true });
    const result = applyEvolutionModeChange(root, 'alpha', 'on_demand');
    expect(result.changed).toBe(true);
    expect(result.resolved.mode).toBe('on_demand');
    const eventsPath = join(root, 'runtime', 'subjects', 'alpha', 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.type).toBe('evolution_mode_changed');
    expect(last.from).toBe('continuous');
    expect(last.to).toBe('on_demand');
    rmSync(root, { recursive: true, force: true });
  });

  it('normalizeEvolutionMode accepts on-demand alias', () => {
    expect(normalizeEvolutionMode('on-demand')).toBe('on_demand');
    expect(normalizeEvolutionMode('continuous')).toBe('continuous');
    expect(normalizeEvolutionMode('bad')).toBeNull();
  });
});
