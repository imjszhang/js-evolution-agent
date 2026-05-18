import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
import { archiveQueue, auditQueue } from '../src/cli/commands/audit.mjs';
import { buildDefaultGoals, backupData, dataStatus, initData } from '../src/cli/commands/data.mjs';
import {
  assessActiveGoals,
  buildGoalUpdate,
  getActiveGoals,
  getGoalHistory,
  parseEvidenceRefs,
  updateGoals,
} from '../src/cli/commands/goals.mjs';
import { buildIntelSummary, findReportRecord } from '../src/cli/commands/intel.mjs';
import {
  isValidSource,
  listValidSources,
  parseRecordsInput,
  runIntelIngest,
  validateRecordsForSource,
} from '../src/cli/commands/intel-ingest.mjs';
import {
  defaultInboxDir,
  drainInboxDir,
  inboxDrain,
  inboxPut,
} from '../src/cli/commands/intel-inbox.mjs';
import { buildIntelReport } from '../src/intelligence/report-builder.mjs';
import { LocalDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { checkPolicy } from '../src/cli/commands/policy.mjs';
import { classifyCycleFailure } from '../src/cli/commands/evolve.mjs';
import {
  createSubject,
  ensureDefaultSubject,
  buildDefaultSubjectPolicy,
  getActiveSubjectRuntimeInfo,
  listSubjects,
  readActiveSubjectPolicy,
  setActiveSubject,
} from '../src/cli/utils/subjects.mjs';
import {
  createRunManifest,
  findRunManifest,
  listRunManifests,
  normalizeEvolveSubjects,
  runtimeForSubject,
  saveRunManifest,
  summarizeManifest,
} from '../src/cli/utils/evolve-runs.mjs';
import {
  configuredActionToSpec,
  loadSubjectActionConfig,
  normalizeConfiguredAction,
} from '../src/actions/configured-actions.mjs';

let tempDir = null;
const originalJeaLanguage = process.env.JEA_LANGUAGE;
const originalJeaSubject = process.env.JEA_SUBJECT;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (originalJeaLanguage === undefined) delete process.env.JEA_LANGUAGE;
  else process.env.JEA_LANGUAGE = originalJeaLanguage;
  if (originalJeaSubject === undefined) delete process.env.JEA_SUBJECT;
  else process.env.JEA_SUBJECT = originalJeaSubject;
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

  it('creates default subject layout from localized policy template', () => {
    const root = makeProjectRoot();
    const result = ensureDefaultSubject(root);
    expect(result.subject.written).toBe(true);
    expect(listSubjects(root)).toEqual(['js-evolution-agent']);
    expect(readActiveSubjectPolicy(root).active.active).toBe('js-evolution-agent');
    expect(readActiveSubjectPolicy(root).text).toContain('`js-evolution-agent` 是本项目的受控自演化宿主');
    expect(readActiveSubjectPolicy(root).text).toContain('## Probe Requirements');
  });

  it('creates English default subject policy when requested by env language', () => {
    const root = makeProjectRoot();
    process.env.JEA_LANGUAGE = 'en-US';

    const result = ensureDefaultSubject(root);

    expect(result.subject.written).toBe(true);
    expect(readActiveSubjectPolicy(root).text).toContain("`js-evolution-agent` is this project's controlled self-evolution host");
    expect(readActiveSubjectPolicy(root).text).toContain('## Probe Requirements');
    expect(buildDefaultSubjectPolicy('en-US')).toContain("`js-evolution-agent` is this project's controlled self-evolution host");
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

describe('evolve run manifests', () => {
  function makeEvolveProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-evolve-'));
    mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
    writeFileSync(join(tempDir, 'policies', 'subjects', 'beta.md'), '# beta\n\n## Subject\nbeta', 'utf-8');
    writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
      active: 'alpha',
      policy: 'subjects/alpha.md',
      data_namespace: 'alpha',
    });
    return tempDir;
  }

  it('creates, saves, finds, and summarizes evolve manifests', () => {
    const root = makeEvolveProjectRoot();
    const subjects = normalizeEvolveSubjects(root, { subjects: 'alpha,beta' });
    const manifest = createRunManifest({
      root,
      runId: 'evolve-test',
      subject: 'alpha',
      subjects,
      rounds: 2,
      flags: { retries: '1' },
    });

    expect(manifest.run_id).toBe('evolve-test');
    expect(manifest.subjects).toEqual(['alpha', 'beta']);
    expect(manifest.rounds.map((round) => round.status)).toEqual(['pending', 'pending']);

    manifest.rounds[0].status = 'succeeded';
    const saved = saveRunManifest(root, 'alpha', manifest);
    const found = findRunManifest(root, 'evolve-test', { subject: 'alpha' });
    const summary = summarizeManifest(found.manifest);

    expect(saved.completed_rounds).toBe(0);
    expect(found.filePath).toContain(join('runtime', 'subjects', 'alpha', 'data', 'evolution', 'runs', 'evolve-test.json'));
    expect(summary.completed_rounds).toBe(1);
    expect(summary.counts.pending).toBe(1);
    expect(listRunManifests(root).map((item) => item.manifest.run_id)).toContain('evolve-test');
  });

  it('resolves subject runtime without changing active subject files', () => {
    const root = makeEvolveProjectRoot();

    process.env.JEA_SUBJECT = 'beta';

    expect(runtimeForSubject(root, 'beta').runtimeRoot).toBe(join(root, 'runtime', 'subjects', 'beta'));
    expect(getActiveSubjectRuntimeInfo(root).subject).toBe('beta');
    expect(readJsonSafe(join(root, 'policies', 'active-subject.json')).active).toBe('alpha');
  });

  it('classifies transient AI failures as retryable', () => {
    expect(classifyCycleFailure({
      exitCode: 1,
      output: 'js-evolution-agent failed: DeepSeek returned empty content',
    }).retryable).toBe(true);
    expect(classifyCycleFailure({
      exitCode: 1,
      output: 'DEEPSEEK_API_KEY is required for --deepseek.',
    }).retryable).toBe(false);
  });
});

describe('action checks', () => {
  it('loads configured subject actions and converts them to action specs', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-action-config-'));
    mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
    mkdirSync(join(tempDir, 'runtime', 'subjects', 'agentank-tank', 'data', 'config'), { recursive: true });
    writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
      active: 'agentank-tank',
      policy: 'subjects/agentank-tank.md',
      data_namespace: 'agentank-tank',
    });
    writeFileSync(join(tempDir, 'policies', 'subjects', 'agentank-tank.md'), '# agentank\n\n## Subject\nagentank', 'utf-8');
    writeJsonFile(join(tempDir, 'runtime', 'subjects', 'agentank-tank', 'data', 'config', 'actions.json'), {
      external_tools: {
        test_tool: { root: 'tools/test', entry: 'src/cli.mjs' },
      },
      actions: [{
        name: 'agentank_sync_context',
        command: 'sync',
        description: 'Sync context',
        promptHint: 'Sync safely',
        defaultRisk: 'low',
        defaultPriority: 'high',
        layer: 'probe',
        params: { allowed: ['limit'] },
      }],
    });

    const config = loadSubjectActionConfig(tempDir);
    const spec = configuredActionToSpec(config.actions[0]);

    expect(config.actions[0].name).toBe('agentank_sync_context');
    expect(config.actions[0].tool).toBe('test_tool');
    expect(config.actions[0].params.allowed).toEqual(['limit']);
    expect(spec.name).toBe('agentank_sync_context');
  });

  it('rejects invalid configured action names', () => {
    expect(() => normalizeConfiguredAction({ name: '../bad', tool: 'test_tool', command: 'sync' }))
      .toThrow(/Invalid configured action name/);
  });

  it('requires explicit tool when multiple external tools are configured', () => {
    expect(() => normalizeConfiguredAction({ name: 'custom_action', command: 'run' }, {
      externalTools: {
        first_tool: { root: 'tools/first' },
        second_tool: { root: 'tools/second' },
      },
    })).toThrow(/must declare tool/);
  });

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

describe('local decision queue lifecycle', () => {
  it('deduplicates hot decisions and summarizes backlog pressure', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-local-queue-'));
    const queue = new LocalDecisionQueue({ dataDir: tempDir });
    const action = {
      type: 'record_observation',
      serves_goal: 'bootstrap',
      params: { subject: 'queue', content: 'same' },
    };

    const first = queue.addDecisionsDetailed({
      cycleId: 'cycle-a',
      actions: [action, action],
      analysisContext: 'analysis',
    });
    const second = queue.addDecisionsDetailed({
      cycleId: 'cycle-b',
      actions: [action],
      analysisContext: 'analysis',
    });
    const summary = queue.summarize({ hotLimit: 1 });

    expect(first.ids).toEqual(['cycle-a:0']);
    expect(first.skipped).toHaveLength(1);
    expect(second.ids).toEqual([]);
    expect(second.skipped[0].reason).toBe('duplicate_hot_decision');
    expect(summary.total).toBe(1);
    expect(summary.hot).toBe(1);
    expect(summary.backpressure).toBe(true);
  });

  it('archives completed decisions without deleting evidence in dry-run', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-local-archive-'));
    writeJsonFile(join(tempDir, 'pending_decisions.json'), {
      decisions: [
        { id: 'done', status: 'completed', action: { type: 'record_observation' } },
        { id: 'todo', status: 'pending', action: { type: 'record_observation' } },
      ],
    });
    const queue = new LocalDecisionQueue({ dataDir: tempDir });

    const dryRun = queue.archiveDecisions({ dryRun: true });
    expect(dryRun.archived.map((d) => d.id)).toEqual(['done']);
    expect(readJsonSafe(join(tempDir, 'pending_decisions.json')).decisions).toHaveLength(2);

    const archived = queue.archiveDecisions({ dryRun: false });
    expect(archived.archived.map((d) => d.id)).toEqual(['done']);
    expect(readJsonSafe(join(tempDir, 'pending_decisions.json')).decisions.map((d) => d.id)).toEqual(['todo']);
    expect(readJsonSafe(join(tempDir, 'archived_decisions.json')).decisions.map((d) => d.id)).toEqual(['done']);
  });
});

describe('policy check', () => {
  it('requires Subject section only', () => {
    const missingSubject = checkPolicy([
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    expect(missingSubject.ok).toBe(false);
    expect(missingSubject.missing).toEqual(['Subject']);

    const ok = checkPolicy([
      '## Subject',
      'agent',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    expect(ok.ok).toBe(true);
    expect(ok.missing).toEqual([]);
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
    expect(readJsonSafe(goalsPath).name).toBe('引导启动 js-evolution-agent');

    writeFileSync(goalsPath, JSON.stringify({ active: 'custom' }, null, 2));
    const second = initData(root, { goals: true });
    expect(second.goals.skipped).toBe(true);
    expect(readJsonSafe(goalsPath).active).toBe('custom');

    const forced = initData(root, { goals: true, force: true });
    expect(forced.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath)).toEqual(buildDefaultGoals());
  });

  it('writes English default goals when requested by env language', () => {
    const root = makeProjectRoot();
    const goalsPath = join(getActiveSubjectRuntimeInfo(root).goalsDir, 'active_goals.json');
    process.env.JEA_LANGUAGE = 'en-US';

    const result = initData(root, { goals: true });

    expect(result.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath)).toEqual(buildDefaultGoals('en-US'));
    expect(readJsonSafe(goalsPath).name).toBe('Bootstrap js-evolution-agent');
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
    const store = createIntelligenceStore({
      baseDir: getActiveSubjectRuntimeInfo(root).intelligenceDir,
    });
    expect(store.readRecentIntel({ limit: 5 }).some((record) => (
      record.content === '已为主体初始化运行时数据：The subject is test-agent.'
    ))).toBe(true);
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

describe('goals command helpers', () => {
  function makeGoalsRoot(prefix = 'jea-goals-') {
    const root = mkdtempSync(join(tmpdir(), prefix));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { goals: true });
    return root;
  }

  it('reads active goals for the active subject', () => {
    const root = makeGoalsRoot();
    const result = getActiveGoals(root);

    expect(result.runtime.dataNamespace).toBe('js-evolution-agent');
    expect(result.path).toBe(join(result.runtime.goalsDir, 'active_goals.json'));
    expect(result.goals.id).toBe('bootstrap');
  });

  it('parses evidence references into structured refs', () => {
    expect(parseEvidenceRefs('intel_report:cycle-1, obs-plain')).toEqual([
      { type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' },
      { ref: 'obs-plain' },
    ]);
  });

  it('updates active goals and records a goal event', () => {
    const root = makeGoalsRoot();
    const runtime = getActiveSubjectRuntimeInfo(root);
    const nextPath = join(root, 'next-goals.json');
    const nextGoal = {
      id: 'bootstrap',
      name: 'Bootstrap refined',
      intent: 'Treat the goal as a testable hypothesis.',
      good_signal: 'goal event is recorded',
      bad_signal: 'goal changes without a reason',
      children: [],
    };
    writeFileSync(nextPath, JSON.stringify(nextGoal));

    const result = updateGoals(root, {
      file: nextPath,
      reason: 'latest report narrowed the hypothesis',
      evidence: 'intel_report:cycle-1',
      cycle: 'cycle-1',
    });

    expect(result.written).toBe(1);
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);

    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      type: 'updated',
      goal_id: 'bootstrap',
      reason: 'latest report narrowed the hypothesis',
      cycle_id: 'cycle-1',
      next_goal: nextGoal,
    });
    expect(history.events[0].previous_goal.id).toBe('bootstrap');
    expect(history.events[0].evidence_refs).toEqual([
      { type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' },
    ]);
  });

  it('rejects missing required update inputs before writing history', () => {
    const root = makeGoalsRoot();

    expect(() => buildGoalUpdate(root, { reason: 'missing file' })).toThrow(/--file/);
    expect(() => buildGoalUpdate(root, { file: join(root, 'missing.json') })).toThrow(/--reason/);
    expect(getGoalHistory(root, { limit: 5 }).events).toHaveLength(0);
  });

  it('rejects invalid goal JSON without changing active goals or history', () => {
    const root = makeGoalsRoot();
    const runtime = getActiveSubjectRuntimeInfo(root);
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const badPath = join(root, 'bad-goals.json');
    writeFileSync(badPath, '{not-json');

    expect(() => updateGoals(root, {
      file: badPath,
      reason: 'bad update should fail',
    })).toThrow();

    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);
    expect(getGoalHistory(root, { limit: 5 }).events).toHaveLength(0);
  });

  it('assesses latest report and records an assessment event without changing active goals', async () => {
    const root = makeGoalsRoot();
    const runtime = getActiveSubjectRuntimeInfo(root);
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-goal-assess', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const result = await assessActiveGoals(root, { json: true }, {
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'keep',
          confidence: 'medium',
          reason: 'The latest report only establishes a baseline.',
          evidence_refs: [{ type: 'intel_report', id: 'cycle-goal-assess', ref: 'intel_report:cycle-goal-assess' }],
          proposed_goal: null,
          risk: 'Changing the goal too early would lose the baseline.',
        }),
      },
      agentContextDocs: [],
    });

    expect(result.written).toBe(1);
    expect(result.event).toMatchObject({
      type: 'assessment',
      goal_id: 'bootstrap',
      cycle_id: 'cycle-goal-assess',
      source: 'ai',
    });
    expect(result.assessment.status).toBe('keep');
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);

    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events).toHaveLength(1);
    expect(history.events[0].assessment.status).toBe('keep');
  });

  it('assesses a specific report cycle', async () => {
    const root = makeGoalsRoot('jea-goals-cycle-');
    const runtime = getActiveSubjectRuntimeInfo(root);
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-first', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-second', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const result = await assessActiveGoals(root, { cycle: 'cycle-first' }, {
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'insufficient_evidence',
          confidence: 'low',
          reason: 'The selected report has too little evidence.',
          evidence_refs: [{ type: 'intel_report', id: 'cycle-first', ref: 'intel_report:cycle-first' }],
          proposed_goal: null,
          risk: 'Need more evidence before changing goals.',
        }),
      },
      agentContextDocs: [],
    });

    expect(result.report.cycle_id).toBe('cycle-first');
    expect(result.event.cycle_id).toBe('cycle-first');
  });

  it('does not write assessment events when goals or reports are missing', async () => {
    const rootWithoutGoals = mkdtempSync(join(tmpdir(), 'jea-goals-no-active-'));
    tempDir = rootWithoutGoals;
    mkdirSync(join(rootWithoutGoals, 'policies'), { recursive: true });
    writeFileSync(join(rootWithoutGoals, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(rootWithoutGoals);

    await expect(assessActiveGoals(rootWithoutGoals, {}, {
      aiClient: { chat: async () => '{}' },
      agentContextDocs: [],
    })).rejects.toThrow(/No active goals/);
    expect(getGoalHistory(rootWithoutGoals, { limit: 5 }).events).toHaveLength(0);
    rmSync(rootWithoutGoals, { recursive: true, force: true });
    tempDir = null;

    const rootWithoutReports = makeGoalsRoot('jea-goals-no-report-');
    await expect(assessActiveGoals(rootWithoutReports, {}, {
      aiClient: { chat: async () => '{}' },
      agentContextDocs: [],
    })).rejects.toThrow(/No intel reports/);
    expect(getGoalHistory(rootWithoutReports, { limit: 5 }).events).toHaveLength(0);
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

  it('archives only the active subject decision queue by default in dry-run', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-queue-archive-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    ensureDefaultSubject(root);

    const firstRuntime = getActiveSubjectRuntimeInfo(root);
    writeJsonFile(join(firstRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [{ id: 'first-done', action: { type: 'record_observation' }, status: 'completed' }],
    });

    createSubject(root, 'other-agent');
    setActiveSubject(root, 'other-agent');
    const secondRuntime = getActiveSubjectRuntimeInfo(root);
    writeJsonFile(join(secondRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [
        { id: 'second-done', action: { type: 'record_observation' }, status: 'completed' },
        { id: 'second-pending', action: { type: 'record_observation' }, status: 'pending' },
      ],
    });

    const dryRun = archiveQueue(root, { dryRun: true });
    expect(dryRun.runtime.dataNamespace).toBe('other-agent');
    expect(dryRun.archived.map((d) => d.id)).toEqual(['second-done']);
    expect(readJsonSafe(join(secondRuntime.evolutionDir, 'pending_decisions.json')).decisions).toHaveLength(2);

    const archived = archiveQueue(root, { dryRun: false });
    expect(archived.archived.map((d) => d.id)).toEqual(['second-done']);
    expect(readJsonSafe(join(secondRuntime.evolutionDir, 'pending_decisions.json')).decisions.map((d) => d.id))
      .toEqual(['second-pending']);
    expect(readJsonSafe(join(firstRuntime.evolutionDir, 'pending_decisions.json')).decisions.map((d) => d.id))
      .toEqual(['first-done']);
  });
});

function makeIntelRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDir = root;
  mkdirSync(join(root, 'policies'), { recursive: true });
  writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
  ensureDefaultSubject(root);
  initData(root);
  return root;
}

describe('intel ingest helpers', () => {
  it('exposes valid sources from specs', () => {
    const sources = listValidSources();
    expect(sources).toContain('intel_observations');
    expect(sources).toContain('probe_threads');
    expect(isValidSource('intel_observations')).toBe(true);
    expect(isValidSource('not_a_source')).toBe(false);
  });

  it('requires _entity_id for probe_threads', () => {
    expect(() => validateRecordsForSource('probe_threads', [{ note: 'no entity' }])).toThrow(/_entity_id/);
    expect(() => validateRecordsForSource('probe_threads', [{ _entity_id: 'p1', note: 'ok' }])).not.toThrow();
    expect(() => validateRecordsForSource('intel_observations', [{ note: 'no entity' }])).not.toThrow();
  });

  it('parses records from a JSON file (object or array)', async () => {
    const root = makeIntelRoot('jea-ingest-parse-');
    const objPath = join(root, 'one.json');
    writeFileSync(objPath, JSON.stringify({ id: 'o1', content: 'hello' }));
    const arrPath = join(root, 'arr.json');
    writeFileSync(arrPath, JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));

    expect(await parseRecordsInput({ file: objPath })).toEqual([{ id: 'o1', content: 'hello' }]);
    expect(await parseRecordsInput({ file: arrPath })).toHaveLength(2);
  });
});

describe('intel ingest command', () => {
  it('writes records into intel_observations and is visible via summary', async () => {
    const root = makeIntelRoot('jea-ingest-ok-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify([
      { id: 'obs-cli-1', content: 'manual note 1', source: 'cli-test' },
      { id: 'obs-cli-2', content: 'manual note 2', source: 'cli-test' },
    ]));

    const code = await runIntelIngest({ root, flags: { source: 'intel_observations', file: filePath, json: true } });
    expect(code).toBe(0);

    const summary = buildIntelSummary(root, { days: 1, limit: 10 });
    const ids = summary.observations.map((o) => o.id);
    expect(ids).toContain('obs-cli-1');
    expect(ids).toContain('obs-cli-2');
  });

  it('rejects unknown source with usage exit code', async () => {
    const root = makeIntelRoot('jea-ingest-bad-source-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify({ id: 'x' }));

    const code = await runIntelIngest({ root, flags: { source: 'nope', file: filePath } });
    expect(code).toBe(2);
  });

  it('rejects probe_threads records missing _entity_id', async () => {
    const root = makeIntelRoot('jea-ingest-probe-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify([{ id: 'evt-1', note: 'missing entity' }]));

    const code = await runIntelIngest({ root, flags: { source: 'probe_threads', file: filePath } });
    expect(code).toBe(2);
  });
});

describe('intel inbox', () => {
  it('inboxPut writes a JSON file under _inbox with source in filename', async () => {
    const root = makeIntelRoot('jea-inbox-put-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify([{ id: 'q1', content: 'queued' }]));

    const code = await inboxPut({
      root,
      flags: { source: 'intel_observations', file: filePath, name: 'unit-test' },
    });
    expect(code).toBe(0);

    const runtime = getActiveSubjectRuntimeInfo(root);
    const dir = defaultInboxDir(runtime);
    const list = readdirSync(dir);
    expect(list.length).toBe(1);
    expect(list[0]).toContain('intel_observations');
    expect(list[0]).toContain('unit-test');
  });

  it('inboxDrain processes known, removes empty, keeps unknown source files', async () => {
    const root = makeIntelRoot('jea-inbox-drain-');
    const runtime = getActiveSubjectRuntimeInfo(root);
    const dir = defaultInboxDir(runtime);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, '01-known.json'), JSON.stringify({
      source_type: 'intel_observations',
      records: [{ id: 'drain-1', content: 'from drain' }],
    }));
    writeFileSync(join(dir, '02-empty.json'), JSON.stringify({
      source_type: 'intel_observations',
      records: [],
    }));
    writeFileSync(join(dir, '03-unknown.json'), JSON.stringify({
      source_type: 'no_such_source',
      records: [{ id: 'x' }],
    }));

    const store = createIntelligenceStore({
      baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const result = drainInboxDir({ inboxDir: dir, store });

    expect(result.processed.intel_observations).toBe(1);
    expect(result.removed).toEqual(expect.arrayContaining(['01-known.json', '02-empty.json']));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file).toBe('03-unknown.json');

    const remaining = readdirSync(dir);
    expect(remaining).toEqual(['03-unknown.json']);

    const summary = buildIntelSummary(root, { days: 1, limit: 10 });
    expect(summary.observations.map((o) => o.id)).toContain('drain-1');
  });

  it('inboxDrain returns exit code 1 when failures exist', async () => {
    const root = makeIntelRoot('jea-inbox-drain-fail-');
    const runtime = getActiveSubjectRuntimeInfo(root);
    const dir = defaultInboxDir(runtime);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ records: [{}] }));

    const code = await inboxDrain({ root, flags: { json: true } });
    expect(code).toBe(1);
  });
});
