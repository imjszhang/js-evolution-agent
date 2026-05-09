import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { parseArgv } from '../src/cli/utils/args.mjs';
import { readJsonSafe, removeProjectDir } from '../src/cli/utils/files.mjs';
import { extractMarkdownSection } from '../src/cli/commands/subject.mjs';
import { findUnknownActions } from '../src/cli/commands/actions.mjs';
import { auditQueue } from '../src/cli/commands/audit.mjs';
import { buildDefaultGoals, backupData, dataStatus, initData } from '../src/cli/commands/data.mjs';
import { buildIntelSummary } from '../src/cli/commands/intel.mjs';
import { checkPolicy } from '../src/cli/commands/policy.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('CLI argument parsing', () => {
  it('splits positionals and flags', () => {
    expect(parseArgv(['run', '--mock', '--limit', '2'])).toEqual({
      positionals: ['run'],
      flags: { mock: true, limit: '2' },
    });
  });
});

describe('subject extraction', () => {
  it('extracts markdown sections by heading', () => {
    const text = [
      '# Policy',
      '',
      '## Subject',
      'The subject is agent.',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n');
    expect(extractMarkdownSection(text, 'Subject')).toBe('The subject is agent.');
    expect(extractMarkdownSection(text, 'Core Layer')).toBe('- Trust');
  });
});

describe('action checks', () => {
  it('detects unknown queued action types', () => {
    const decisions = [
      { id: 'ok', action: { type: 'record_observation' } },
      { id: 'bad', action: { type: 'custom' } },
    ];
    expect(findUnknownActions(decisions, new Set(['record_observation']))).toEqual([
      { id: 'bad', type: 'custom' },
    ]);
  });
});

describe('queue audit', () => {
  it('summarizes queue health and unknown actions', () => {
    const result = auditQueue({
      decisions: [
        { id: 'a', status: 'pending', action: { type: 'record_observation' }, created_at: '2026-01-01T00:00:00Z' },
        { id: 'b', status: 'in_progress', action: { type: 'custom' } },
      ],
    }, new Set(['record_observation']), { staleMinutes: 1 });

    expect(result.total).toBe(2);
    expect(result.counts.pending).toBe(1);
    expect(result.unknownActions).toEqual([{ id: 'b', type: 'custom' }]);
    expect(result.healthy).toBe(false);
  });
});

describe('policy check', () => {
  it('detects missing required sections', () => {
    const result = checkPolicy([
      '## Subject',
      'agent',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('Probe Requirements');
  });
});

describe('data reset safety', () => {
  it('removes only paths under the project root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-reset-'));
    const target = join(tempDir, 'data', 'evolution');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'x.json'), '{}');

    expect(removeProjectDir(tempDir, join('data', 'evolution'))).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(() => removeProjectDir(tempDir, '..')).toThrow(/outside project root/);
  });
});

describe('data initialization', () => {
  function makeProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-init-'));
    mkdirSync(join(tempDir, 'policies'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'project-guidance.md'), [
      '# Guidance',
      '',
      '## Subject',
      'The subject is test-agent.',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    return tempDir;
  }

  it('creates runtime directories without goals or seed by default', () => {
    const root = makeProjectRoot();
    const result = initData(root);

    expect(result.directories.every((d) => existsSync(d.path))).toBe(true);
    expect(result.goals).toBeNull();
    expect(result.seed).toBeNull();
    expect(dataStatus(root).map((s) => s.exists)).toEqual([true, true, true]);
  });

  it('writes goals once and preserves existing goals unless forced', () => {
    const root = makeProjectRoot();
    const goalsPath = join(root, 'data', 'goals', 'active_goals.json');

    const first = initData(root, { goals: true });
    expect(first.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath).id).toBe('bootstrap');

    writeFileSync(goalsPath, JSON.stringify({ active: 'custom' }, null, 2));
    const second = initData(root, { goals: true });
    expect(second.goals.skipped).toBe(true);
    expect(readJsonSafe(goalsPath).active).toBe('custom');

    const forced = initData(root, { goals: true, force: true });
    expect(forced.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath)).toEqual(buildDefaultGoals());
  });

  it('appends seed intelligence without overwriting history', () => {
    const root = makeProjectRoot();
    const first = initData(root, { seed: true });
    const second = initData(root, { seed: true });

    expect(first.seed.observationCount).toBe(1);
    expect(first.seed.eventCount).toBe(1);
    expect(second.seed.observationCount).toBe(1);
    expect(second.seed.eventCount).toBe(1);

    const intelFile = join(root, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
    const lines = readFileSync(intelFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('returns JSON-serializable init output', () => {
    const root = makeProjectRoot();
    const result = initData(root, { all: true });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.goals.written).toBe(true);
    expect(result.seed.observationCount).toBe(1);
  });

  it('backs up data without overwriting by default', () => {
    const root = makeProjectRoot();
    initData(root, { all: true });

    const first = backupData(root, { name: 'snapshot' });
    expect(first.copied).toBe(true);
    expect(first.files).toBeGreaterThan(0);

    const second = backupData(root, { name: 'snapshot' });
    expect(second.copied).toBe(false);
    expect(second.reason).toBe('destination_exists');
    expect(second.files).toBeGreaterThan(0);
  });
});

describe('intel summary', () => {
  it('reads seeded intelligence summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-intel-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { seed: true });

    const summary = buildIntelSummary(root, { days: 1, limit: 5 });
    expect(summary.observations).toHaveLength(1);
    expect(summary.events).toHaveLength(1);
    expect(summary.contextSummary).toContain('js-evolution-agent intelligence summary');
  });
});

