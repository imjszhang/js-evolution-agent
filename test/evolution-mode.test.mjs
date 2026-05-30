import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  evolutionModeFromEnv,
  evolutionModeFromFlags,
  resolveEvolutionMode,
} from '../src/cli/utils/evolution-mode.mjs';

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
});
