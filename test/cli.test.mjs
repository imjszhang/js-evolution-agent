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
import { readJsonSafe, removeProjectDir, writeJsonFile } from '../src/cli/utils/files.mjs';
import { extractMarkdownSection } from '../src/cli/commands/subject.mjs';
import { findUnknownActions, readActiveDecisionQueue } from '../src/cli/commands/actions.mjs';
import { auditQueue } from '../src/cli/commands/audit.mjs';
import { buildDefaultGoals, backupData, dataStatus, initData } from '../src/cli/commands/data.mjs';
import { buildIntelSummary, findReportRecord } from '../src/cli/commands/intel.mjs';
import { buildIntelReport } from '../src/intelligence/report-builder.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { checkPolicy } from '../src/cli/commands/policy.mjs';
import {
  createSubject,
  ensureDefaultSubject,
  getActiveSubjectRuntimeInfo,
  listSubjects,
  readActiveSubjectPolicy,
  setActiveSubject,
} from '../src/cli/utils/subjects.mjs';

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

describe('subject management', () => {
  function makeProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-subject-'));
    mkdirSync(join(tempDir, 'policies'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'project-guidance.md'), [
      '# Guidance',
      '',
      '## Subject',
      'Default subject.',
      '',
      '## Core Layer',
      '- Trust',
      '',
      '## Allowed First-Phase Actions',
      '- Observe',
      '',
      '## Off-Limits Without Human Approval',
      '- Destructive operations',
      '',
      '## Probe Requirements',
      '- `hypothesis`',
    ].join('\n'));
    return tempDir;
  }

  it('creates default subject layout from compatibility guidance', () => {
    const root = makeProjectRoot();
    const result = ensureDefaultSubject(root);
    expect(result.subject.written).toBe(true);
    expect(listSubjects(root)).toEqual(['js-evolution-agent']);
    expect(readActiveSubjectPolicy(root).active.active).toBe('js-evolution-agent');
  });

  it('creates and switches active subjects', () => {
    const root = makeProjectRoot();
    ensureDefaultSubject(root);
    const created = createSubject(root, 'my-product');
    expect(created.written).toBe(true);
    const active = setActiveSubject(root, 'my-product');
    expect(active.active.active).toBe('my-product');
    const policy = readActiveSubjectPolicy(root);
    expect(policy.active.active).toBe('my-product');
    expect(policy.text).toContain('## Subject');
  });

  it('resolves active subject runtime paths from data namespace', () => {
    const root = makeProjectRoot();
    ensureDefaultSubject(root);
    createSubject(root, 'my-product');
    setActiveSubject(root, 'my-product');

    const runtime = getActiveSubjectRuntimeInfo(root);
    expect(runtime.subject).toBe('my-product');
    expect(runtime.dataNamespace).toBe('my-product');
    expect(runtime.runtimeRoot).toBe(join(root, 'runtime', 'subjects', 'my-product'));
    expect(runtime.dataRoot).toBe(join(root, 'runtime', 'subjects', 'my-product', 'data'));
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
    const runtime = getActiveSubjectRuntimeInfo(root);

    expect(result.directories.every((d) => existsSync(d.path))).toBe(true);
    expect(result.directories.every((d) => d.path.startsWith(runtime.runtimeRoot))).toBe(true);
    expect(result.goals).toBeNull();
    expect(result.seed).toBeNull();
    expect(dataStatus(root).map((s) => s.exists)).toEqual([true, true, true]);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('writes goals once and preserves existing goals unless forced', () => {
    const root = makeProjectRoot();
    const goalsPath = join(getActiveSubjectRuntimeInfo(root).goalsDir, 'active_goals.json');

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

    const intelFile = join(getActiveSubjectRuntimeInfo(root).intelligenceDir, 'evolution_events', 'evolution-events.jsonl');
    const lines = readFileSync(intelFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('isolates data status by active subject namespace', () => {
    const root = makeProjectRoot();
    ensureDefaultSubject(root);
    initData(root);
    createSubject(root, 'another-agent');
    setActiveSubject(root, 'another-agent');

    expect(dataStatus(root).map((s) => s.exists)).toEqual([false, false, false]);
    initData(root);
    expect(dataStatus(root).map((s) => s.exists)).toEqual([true, true, true]);
  });

  it('returns JSON-serializable init output', () => {
    const root = makeProjectRoot();
    const result = initData(root, { all: true });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.goals.written).toBe(true);
    expect(result.seed.observationCount).toBe(1);
    expect(result.policies).not.toBeNull();
    expect(existsSync(join(root, 'policies', 'active-subject.json'))).toBe(true);
    expect(existsSync(join(root, 'policies', 'subjects', 'js-evolution-agent.md'))).toBe(true);
  });

  it('backs up data without overwriting by default', () => {
    const root = makeProjectRoot();
    initData(root, { all: true });

    const first = backupData(root, { name: 'snapshot' });
    expect(first.copied).toBe(true);
    expect(first.files).toBeGreaterThan(0);
    expect(first.destination).toBe(join(root, 'backups', 'subjects', 'js-evolution-agent', 'snapshot'));

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
    expect(summary.runtime.dataNamespace).toBe('js-evolution-agent');
    expect(summary.observations).toHaveLength(1);
    expect(summary.events).toHaveLength(1);
    expect(summary.contextSummary).toContain('js-evolution-agent intelligence summary');
  });

  it('reads intelligence from the active subject namespace only', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-intel-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    ensureDefaultSubject(root);
    initData(root, { seed: true });
    createSubject(root, 'other-agent');
    setActiveSubject(root, 'other-agent');

    const emptySummary = buildIntelSummary(root, { days: 1, limit: 5 });
    expect(emptySummary.runtime.dataNamespace).toBe('other-agent');
    expect(emptySummary.observations).toHaveLength(0);
    expect(emptySummary.events).toHaveLength(0);

    initData(root, { seed: true });
    const activeSummary = buildIntelSummary(root, { days: 1, limit: 5 });
    expect(activeSummary.observations).toHaveLength(1);
    expect(activeSummary.events).toHaveLength(1);
  });
});

describe('intel report cli helpers', () => {
  it('returns no record when index is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-cli-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root);
    const { record } = findReportRecord(root, {});
    expect(record).toBeNull();
  });

  it('finds latest and by-cycle records after a report is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-cli-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { all: true });

    const runtime = getActiveSubjectRuntimeInfo(root);
    const store = createIntelligenceStore({
      baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-A', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-B', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const latest = findReportRecord(root, {});
    expect(latest.record.cycle_id).toBe('cycle-B');

    const byCycle = findReportRecord(root, { cycle: 'cycle-A' });
    expect(byCycle.record.cycle_id).toBe('cycle-A');

    const missing = findReportRecord(root, { cycle: 'cycle-Z' });
    expect(missing.record).toBeNull();
  });
});

describe('active decision queue', () => {
  it('reads queued decisions from the active subject namespace only', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    ensureDefaultSubject(root);

    const firstRuntime = getActiveSubjectRuntimeInfo(root);
    writeJsonFile(join(firstRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [{ id: 'first', action: { type: 'record_observation' }, status: 'pending' }],
    });

    createSubject(root, 'other-agent');
    setActiveSubject(root, 'other-agent');
    expect(readActiveDecisionQueue(root).queue.decisions).toHaveLength(0);

    const secondRuntime = getActiveSubjectRuntimeInfo(root);
    writeJsonFile(join(secondRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [{ id: 'second', action: { type: 'custom' }, status: 'pending' }],
    });

    const { runtime, queue } = readActiveDecisionQueue(root);
    const audit = auditQueue(queue, new Set(['record_observation']));
    expect(runtime.dataNamespace).toBe('other-agent');
    expect(queue.decisions.map((d) => d.id)).toEqual(['second']);
    expect(findUnknownActions(queue.decisions, new Set(['record_observation']))).toEqual([
      { id: 'second', type: 'custom' },
    ]);
    expect(audit.unknownActions).toEqual([{ id: 'second', type: 'custom' }]);
  });
});

