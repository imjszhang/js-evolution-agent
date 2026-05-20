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
  applyGoalObject,
  assessActiveGoals,
  autoCalibrateGoals,
  buildGoalUpdate,
  getActiveGoals,
  getGoalHistory,
  parseEvidenceRefs,
  updateGoals,
  validateGoalShape,
} from '../src/cli/commands/goals.mjs';
import { buildIntelSummary, findReportRecord } from '../src/cli/commands/intel.mjs';
import {
  briefList,
  briefProcessed,
  briefPut,
} from '../src/cli/commands/intel-briefs.mjs';
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
import {
  buildCycleEnv,
  classifyCycleFailure,
  parseExitRecord,
  runSingleCycle,
} from '../src/cli/commands/evolve.mjs';
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
  appendRunEvent,
  createRunManifest,
  findRunManifest,
  listRunManifests,
  normalizeInterruptedManifest,
  normalizeEvolveSubjects,
  runtimeForSubject,
  saveRunManifest,
  summarizeManifest,
} from '../src/cli/utils/evolve-runs.mjs';
import {
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  reclaimExpiredLeases,
  readTaskQueue,
  renewTaskLease,
  retryTask,
} from '../src/cli/utils/daemon-tasks.mjs';
import {
  buildDaemonProjection,
  currentStatePath,
  writeDaemonProjection,
} from '../src/cli/utils/daemon-projection.mjs';
import {
  createWorkerState,
  readWorkerState,
  requestWorkerStop,
  workerStatePath,
} from '../src/cli/utils/daemon-worker-state.mjs';
import { daemonCommand, runDaemonWorker, workOnce } from '../src/cli/commands/daemon.mjs';
import { selectSubjects } from '../src/cli/utils/subject-selection.mjs';
import { buildSubjectArtifactOverview } from '../src/cli/utils/subject-artifacts.mjs';
import {
  configuredActionToSpec,
  loadSubjectActionConfig,
  normalizeConfiguredAction,
} from '../src/actions/configured-actions.mjs';
import {
  actionHandlers,
  buildRetrospectiveEnrichmentAction,
} from '../src/actions/handlers.mjs';
import {
  buildClaudeOptions,
  buildCursorOptions,
  resolveAgentExecutionRoots,
  runAgenticAction,
} from '../src/actions/agent-adapter.mjs';
import {
  markOperatorBriefsProcessed,
  readPendingOperatorBriefs,
  readProcessedOperatorBriefs,
} from '../src/intelligence/operator-briefs.mjs';

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
      flags: { retries: '1', 'exec-limit': '2', 'global-delay-ms': '10' },
    });

    expect(manifest.run_id).toBe('evolve-test');
    expect(manifest.subjects).toEqual(['alpha', 'beta']);
    expect(manifest.flags.exec_limit).toBe(2);
    expect(manifest.flags.global_delay_ms).toBe(10);
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

  it('prefers structured exit records over regex fallback', () => {
    const output = [
      'js-evolution-agent failed: DeepSeek returned empty content',
      'JEA_EXIT_RECORD {"code":"configuration","message":"Subject policy not found","retryable":false}',
    ].join('\n');

    expect(parseExitRecord(output)).toMatchObject({
      code: 'configuration',
      retryable: false,
    });
    expect(classifyCycleFailure({ exitCode: 1, output })).toMatchObject({
      retryable: false,
      code: 'configuration',
      reason: 'configuration',
    });
  });

  it('normalizes stale running rounds as interrupted', () => {
    const root = makeEvolveProjectRoot();
    const manifest = createRunManifest({
      root,
      runId: 'evolve-interrupted',
      subject: 'alpha',
      subjects: ['alpha'],
      rounds: 1,
      flags: {},
    });
    manifest.status = 'running';
    manifest.rounds[0].status = 'running';
    manifest.rounds[0].attempts = 1;

    const result = normalizeInterruptedManifest(root, manifest);

    expect(result.changed).toBe(true);
    expect(result.manifest.status).toBe('interrupted');
    expect(result.manifest.rounds[0].status).toBe('interrupted');
    expect(result.manifest.last_error_code).toBe('interrupted');
  });

  it('appends run index events', () => {
    const root = makeEvolveProjectRoot();
    const manifest = createRunManifest({
      root,
      runId: 'evolve-index',
      subject: 'alpha',
      subjects: ['alpha'],
      rounds: 1,
      flags: {},
    });

    appendRunEvent(root, 'alpha', manifest, { type: 'created' });
    appendRunEvent(root, 'alpha', manifest, { type: 'round_started', round: 1 });

    const indexPath = join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'runs', 'index.jsonl');
    const records = readFileSync(indexPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(['created', 'round_started']);
    expect(records[0].run_id).toBe('evolve-index');
  });

  it('passes execution limit through child process env', () => {
    const env = buildCycleEnv({
      mock: true,
      'skip-goals-assess': true,
      'exec-limit': '2',
    }, 'alpha');

    expect(env.JEA_SUBJECT).toBe('alpha');
    expect(env.JEA_FORCE_MOCK).toBe('1');
    expect(env.JEA_SKIP_GOALS_ASSESS).toBe('1');
    expect(env.JEA_EXEC_LIMIT).toBe('2');
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe('daemon task queue foundation', () => {
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function captureConsole(fn) {
    const logs = [];
    const errors = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const code = await fn();
      return {
        code,
        stdout: logs.join('\n'),
        stderr: errors.join('\n'),
      };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  function makeDaemonProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-daemon-'));
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

  it('enqueues daemon tasks idempotently and claims leases', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:1',
      input: { retries: 0 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:1',
      input: { retries: 0 },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.task_id).toBe(first.task.task_id);

    const claimed = claimNextTask(root, 'alpha', { workerId: 'test-worker', leaseMs: 1000 });
    expect(claimed.task.status).toBe('running');
    expect(claimed.task.lease_owner).toBe('test-worker');

    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks[0].status).toBe('running');
  });

  it('transitions daemon tasks to completed and failed', () => {
    const root = makeDaemonProjectRoot();
    const enqueued = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:complete',
    });

    completeTask(root, 'alpha', enqueued.task.task_id, { ok: true });
    expect(readTaskQueue(root, 'alpha').tasks[0].status).toBe('completed');

    const failedTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:failed',
    });
    failTask(root, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });
    const failed = readTaskQueue(root, 'alpha').tasks.find((task) => task.task_id === failedTask.task.task_id);
    expect(failed.status).toBe('failed');
    expect(failed.last_error_code).toBe('boom');
  });

  it('builds and writes daemon current-state projection', () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:projection',
    });

    const projection = buildDaemonProjection(root, 'alpha');
    writeDaemonProjection(root, 'alpha', projection);

    expect(projection.tasks.counts.pending).toBe(1);
    expect(readJsonSafe(currentStatePath(root, 'alpha')).tasks.counts.pending).toBe(1);
  });

  it('summarizes daemon health for idle, stale, expired, and failed states', async () => {
    const idleRoot = makeDaemonProjectRoot();
    expect(buildDaemonProjection(idleRoot, 'alpha').health.status).toBe('idle');
    rmSync(idleRoot, { recursive: true, force: true });

    const staleRoot = makeDaemonProjectRoot();
    createWorkerState(staleRoot, 'alpha', { workerId: 'stale-worker', staleMs: 1 });
    await delay(5);
    expect(buildDaemonProjection(staleRoot, 'alpha').health.status).toBe('stale');
    rmSync(staleRoot, { recursive: true, force: true });

    const expiredRoot = makeDaemonProjectRoot();
    enqueueTask(expiredRoot, 'alpha', { type: 'run_cycle', idempotencyKey: 'alpha:expired-health' });
    claimNextTask(expiredRoot, 'alpha', { workerId: 'old-worker', leaseMs: -1 });
    expect(buildDaemonProjection(expiredRoot, 'alpha').health.status).toBe('blocked');
    rmSync(expiredRoot, { recursive: true, force: true });

    const failedRoot = makeDaemonProjectRoot();
    const failedTask = enqueueTask(failedRoot, 'alpha', { type: 'run_cycle', idempotencyKey: 'alpha:failed-health' });
    failTask(failedRoot, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });
    expect(buildDaemonProjection(failedRoot, 'alpha').health.status).toBe('failed');
  });

  it('tracks daemon worker state and stop requests', () => {
    const root = makeDaemonProjectRoot();
    const created = createWorkerState(root, 'alpha', {
      workerId: 'worker-test',
      pid: 123,
      staleMs: 1000,
    });

    expect(created.created).toBe(true);
    expect(readJsonSafe(workerStatePath(root, 'alpha')).status).toBe('running');

    const duplicate = createWorkerState(root, 'alpha', {
      workerId: 'worker-other',
      pid: 456,
      staleMs: 1000,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.reason).toBe('already_running');

    const stopped = requestWorkerStop(root, 'alpha', { staleMs: 1000 });
    expect(stopped.requested).toBe(true);
    expect(readWorkerState(root, 'alpha').status).toBe('stopping');
  });

  it('prints daemon events through the CLI as JSON', async () => {
    const root = makeDaemonProjectRoot();
    createIntelligenceStore({ baseDir: runtimeForSubject(root, 'alpha').intelligenceDir })
      .recordEvolutionEvent({
        subject: 'alpha',
        type: 'task_completed',
        status: 'ok',
        task_id: 'task-1',
      });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'events',
      flags: { json: true, limit: '5' },
    }));

    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout).events[0]).toMatchObject({
      type: 'task_completed',
      task_id: 'task-1',
    });
  });

  it('selects active, explicit, and all daemon subjects', () => {
    const root = makeDaemonProjectRoot();

    expect(selectSubjects(root)).toEqual(['alpha']);
    expect(selectSubjects(root, { subjects: 'beta,alpha' })).toEqual(['beta', 'alpha']);
    expect(selectSubjects(root, { all: true })).toEqual(['alpha', 'beta']);
  });

  it('reports multi-subject daemon status as JSON', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:multi-status',
    });
    const failedTask = enqueueTask(root, 'beta', {
      type: 'run_cycle',
      idempotencyKey: 'beta:multi-status',
    });
    failTask(root, 'beta', failedTask.task.task_id, { code: 'boom', message: 'failed' });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'status',
      flags: { all: true, json: true },
    }));
    const payload = JSON.parse(output.stdout);

    expect(output.code).toBe(0);
    expect(payload.subjects.map((item) => item.subject)).toEqual(['alpha', 'beta']);
    expect(payload.subjects.find((item) => item.subject === 'alpha').tasks.counts.pending).toBe(1);
    expect(payload.subjects.find((item) => item.subject === 'beta').health.status).toBe('failed');
  });

  it('fans out daemon stop to selected subjects only', async () => {
    const root = makeDaemonProjectRoot();
    createWorkerState(root, 'alpha', { workerId: 'worker-alpha', pid: 1, staleMs: 1000 });
    createWorkerState(root, 'beta', { workerId: 'worker-beta', pid: 2, staleMs: 1000 });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'stop',
      flags: { subjects: 'beta', json: true },
    }));
    const payload = JSON.parse(output.stdout);

    expect(output.code).toBe(0);
    expect(payload.subjects[0].subject).toBe('beta');
    expect(readWorkerState(root, 'beta').status).toBe('stopping');
    expect(readWorkerState(root, 'alpha').status).toBe('running');
  });

  it('refuses multi-subject daemon task mutations', async () => {
    const root = makeDaemonProjectRoot();
    const task = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:multi-mutation',
    });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['cancel', task.task.task_id],
      flags: { all: true, json: true },
    }));

    expect(output.code).toBe(2);
    expect(readTaskQueue(root, 'alpha').tasks[0].status).toBe('pending');
  });

  it('builds a multi-subject artifact inbox', async () => {
    const root = makeDaemonProjectRoot();
    const alphaRuntime = runtimeForSubject(root, 'alpha');
    createIntelligenceStore({ baseDir: alphaRuntime.intelligenceDir }).recordIntelReport({
      cycle_id: 'cycle-alpha',
      generated_at: '2026-05-20T00:00:00.000Z',
      md_path: join(alphaRuntime.intelligenceDir, 'reports', 'cycle-alpha.md'),
      tldr: 'alpha report',
      source: 'ai',
    });
    mkdirSync(join(alphaRuntime.evolutionDir, 'diaries'), { recursive: true });
    writeFileSync(join(alphaRuntime.evolutionDir, 'diaries', 'exec-alpha.md'), '# alpha diary', 'utf-8');
    mkdirSync(join(alphaRuntime.evolutionDir, 'verify_reports'), { recursive: true });
    writeJsonFile(join(alphaRuntime.evolutionDir, 'verify_reports', 'exec-alpha.json'), {
      cycle_id: 'exec-alpha',
      verified: [{}],
      pending: [],
      semantic: { status: 'ok' },
    });

    const overview = buildSubjectArtifactOverview(root, 'alpha', {
      projection: buildDaemonProjection(root, 'alpha'),
    });
    expect(overview.latest_report.cycle_id).toBe('cycle-alpha');
    expect(overview.latest_diary.name).toBe('exec-alpha.md');
    expect(overview.latest_verify_report.semantic_status).toBe('ok');

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'inbox',
      flags: { all: true, json: true },
    }));
    const payload = JSON.parse(output.stdout);
    expect(output.code).toBe(0);
    expect(payload.subjects.find((item) => item.subject === 'alpha').latest_report.cycle_id).toBe('cycle-alpha');
  });

  it('reports daemon doctor diagnostics for pending work without a worker', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:doctor-pending',
    });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'doctor',
      flags: { json: true },
    }));
    const report = JSON.parse(output.stdout);

    expect(output.code).toBe(1);
    expect(report.health.status).toBe('blocked');
    expect(report.diagnostics.map((item) => item.code)).toContain('pending_without_worker');
  });

  it('lists, inspects, retries, and cancels daemon tasks through the CLI', async () => {
    const root = makeDaemonProjectRoot();
    const failedTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:tasks-failed',
    });
    failTask(root, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });
    const pendingTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:tasks-pending',
    });

    const list = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['list'],
      flags: { json: true },
    }));
    expect(JSON.parse(list.stdout).tasks).toHaveLength(2);

    const inspected = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['inspect', failedTask.task.task_id],
      flags: { json: true },
    }));
    expect(JSON.parse(inspected.stdout).task.task_id).toBe(failedTask.task.task_id);

    const retried = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['retry', failedTask.task.task_id],
      flags: { json: true },
    }));
    expect(retried.code).toBe(0);

    const cancelled = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['cancel', pendingTask.task.task_id],
      flags: { json: true },
    }));
    expect(cancelled.code).toBe(0);

    const tasks = readTaskQueue(root, 'alpha').tasks;
    expect(tasks.find((task) => task.task_id === failedTask.task.task_id).status).toBe('pending');
    expect(tasks.find((task) => task.task_id === pendingTask.task.task_id).status).toBe('cancelled');
  });

  it('does not claim later daemon rounds while an earlier round is incomplete', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-1:alpha:run_cycle:1',
      input: { run_id: 'run-1', round_index: 1, rounds: 2 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-1:alpha:run_cycle:2',
      input: { run_id: 'run-1', round_index: 2, rounds: 2 },
    });
    failTask(root, 'alpha', first.task.task_id, { code: 'boom', message: 'failed' });

    const claimed = claimNextTask(root, 'alpha', { workerId: 'timeline-worker' });

    expect(claimed.task).toBeNull();
    expect(readTaskQueue(root, 'alpha').tasks.find((task) => task.task_id === second.task.task_id).status)
      .toBe('pending');
  });

  it('claims the next daemon round once earlier rounds are completed', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-2:alpha:run_cycle:1',
      input: { run_id: 'run-2', round_index: 1, rounds: 2 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-2:alpha:run_cycle:2',
      input: { run_id: 'run-2', round_index: 2, rounds: 2 },
    });
    completeTask(root, 'alpha', first.task.task_id, { ok: true });

    const claimed = claimNextTask(root, 'alpha', { workerId: 'timeline-worker' });

    expect(claimed.task.task_id).toBe(second.task.task_id);
    expect(claimed.task.status).toBe('running');
  });

  it('allows retrying a failed daemon round only before later rounds complete', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-3:alpha:run_cycle:1',
      input: { run_id: 'run-3', round_index: 1, rounds: 2 },
    });
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-3:alpha:run_cycle:2',
      input: { run_id: 'run-3', round_index: 2, rounds: 2 },
    });
    failTask(root, 'alpha', first.task.task_id, { code: 'boom', message: 'failed' });

    const retried = retryTask(root, 'alpha', first.task.task_id, {
      code: 'manual_retry',
      message: 'retry',
    });

    expect(retried.task.status).toBe('pending');
  });

  it('rejects retrying historical daemon rounds after later rounds complete', async () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-4:alpha:run_cycle:1',
      input: { run_id: 'run-4', round_index: 1, rounds: 2 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-4:alpha:run_cycle:2',
      input: { run_id: 'run-4', round_index: 2, rounds: 2 },
    });
    failTask(root, 'alpha', first.task.task_id, { code: 'boom', message: 'failed' });
    completeTask(root, 'alpha', second.task.task_id, { ok: true });

    expect(() => retryTask(root, 'alpha', first.task.task_id, {
      code: 'manual_retry',
      message: 'retry',
    })).toThrow(/later rounds already completed/);

    const retried = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['retry', first.task.task_id],
      flags: { json: true },
    }));
    const body = JSON.parse(retried.stdout);

    expect(retried.code).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/later rounds already completed/);
  });

  it('reclaims expired daemon task leases explicitly', () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:expired-lease',
    });
    const claimed = claimNextTask(root, 'alpha', { workerId: 'old-worker', leaseMs: -1 });
    expect(claimed.task.status).toBe('running');

    const projectionBefore = buildDaemonProjection(root, 'alpha');
    expect(projectionBefore.tasks.expired_running_count).toBe(1);

    const reclaimed = reclaimExpiredLeases(root, 'alpha');
    expect(reclaimed.reclaimed).toHaveLength(1);
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks[0].status).toBe('pending');
    expect(queue.tasks[0].lease_owner).toBeNull();
  });

  it('renews running task leases only for the current owner', () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:renew-lease',
    });
    const claimed = claimNextTask(root, 'alpha', { workerId: 'lease-worker', leaseMs: 1000 });
    const firstExpiry = Date.parse(claimed.task.lease_expires_at);

    const denied = renewTaskLease(root, 'alpha', claimed.task.task_id, {
      workerId: 'other-worker',
      leaseMs: 5000,
    });
    expect(denied.renewed).toBe(false);
    expect(denied.reason).toBe('lease_owner_mismatch');

    const renewed = renewTaskLease(root, 'alpha', claimed.task.task_id, {
      workerId: 'lease-worker',
      leaseMs: 5000,
    });
    expect(renewed.renewed).toBe(true);
    expect(Date.parse(renewed.task.lease_expires_at)).toBeGreaterThan(firstExpiry);
  });

  it('runSingleCycle aborts a child process with a structured stop record', async () => {
    const root = makeDaemonProjectRoot();
    writeFileSync(join(root, 'run.mjs'), [
      "process.on('SIGTERM', () => {",
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf-8');
    const controller = new AbortController();

    const result = await runSingleCycle({
      root,
      subject: 'alpha',
      flags: { mock: true },
      signal: controller.signal,
      hooks: {
        onChildStart: () => controller.abort(),
      },
      abortKillMs: 50,
    });

    expect(result.aborted).toBe(true);
    expect(parseExitRecord(result.output)).toMatchObject({
      code: 'daemon_stop_requested',
      retryable: true,
    });
  });

  it('runs the daemon loop through workOnce and writes worker health', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:loop-missing-runner',
      input: { retries: 0 },
    });

    const result = await runDaemonWorker(root, 'alpha', {
      worker: 'loop-worker',
      'max-iterations': '1',
      'interval-ms': '0',
      'idle-interval-ms': '0',
    });

    expect(result.started).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.reason).toBe('max_iterations');
    const state = readWorkerState(root, 'alpha');
    expect(state.status).toBe('stopped');
    expect(state.last_work_result.worked).toBe(true);
    expect(state.last_work_result.error_code).toBe('matched_non_retryable');

    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.worker.status).toBe('stopped');
    expect(projection.tasks.counts.failed).toBe(1);
  });

  it('renews leases and heartbeats while a daemon task is running', async () => {
    const root = makeDaemonProjectRoot();
    writeFileSync(join(root, 'run.mjs'), [
      'setTimeout(() => process.exit(0), 140);',
    ].join('\n'), 'utf-8');
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:long-running',
      input: { retries: 0 },
    });

    const result = await runDaemonWorker(root, 'alpha', {
      worker: 'long-worker',
      'max-iterations': '1',
      'lease-ms': '80',
      'heartbeat-ms': '20',
      'interval-ms': '0',
      'idle-interval-ms': '0',
    });

    expect(result.started).toBe(true);
    expect(result.reason).toBe('max_iterations');
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks[0].status).toBe('completed');
    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.tasks.expired_running_count).toBe(0);
    expect(Date.parse(readWorkerState(root, 'alpha').heartbeat_at))
      .toBeGreaterThan(Date.parse(readWorkerState(root, 'alpha').started_at));
  });

  it('propagates daemon stop requests to the running child and releases the task', async () => {
    const root = makeDaemonProjectRoot();
    writeFileSync(join(root, 'run.mjs'), [
      "process.on('SIGTERM', () => {",
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf-8');
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:stop-running',
      input: { retries: 0 },
    });

    const worker = runDaemonWorker(root, 'alpha', {
      worker: 'stop-worker',
      'lease-ms': '100',
      'heartbeat-ms': '20',
      'interval-ms': '0',
      'idle-interval-ms': '0',
    });
    await delay(60);
    const stopped = requestWorkerStop(root, 'alpha');
    expect(stopped.requested).toBe(true);

    const result = await worker;
    expect(result.reason).toBe('stop_requested');
    const task = readTaskQueue(root, 'alpha').tasks[0];
    expect(task.status).toBe('pending');
    expect(task.last_error_code).toBe('daemon_stop_requested');
    expect(readWorkerState(root, 'alpha').status).toBe('stopped');
  });

  it('workOnce handles a run_cycle task without executing when runner is missing', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:missing-runner',
      input: { retries: 0 },
    });

    const result = await workOnce(root, 'alpha', { worker: 'test-worker' });

    expect(result.worked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.task.status).toBe('failed');
    expect(result.task.last_error_code).toBe('matched_non_retryable');
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

  it('passes explicit action cwd into Claude and Cursor agent options', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-cwd-'));
    const action = {
      type: 'agent_execute',
      params: {
        cwd: tempDir,
        mode: 'observe',
      },
    };
    const ctx = { projectRoot: join(tempDir, 'fallback') };

    const claude = buildClaudeOptions(action, ctx);
    const cursor = buildCursorOptions(action, ctx);

    expect(claude.cwdWasConfigured).toBe(true);
    expect(claude.options.cwd).toBe(tempDir);
    expect(cursor.cwdWasConfigured).toBe(true);
    expect(cursor.options.local.cwd).toBe(tempDir);
  });

  it('treats explicit params.cwd as execution project root instead of host projectRoot', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-cwd-'));
    const externalDir = join(tempDir, 'agentank-evolver');
    const subjectRuntime = join(tempDir, 'runtime', 'subjects', 'agentank-tank');
    const hostRoot = join(tempDir, 'js-evolution-agent');
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(subjectRuntime, { recursive: true });
    mkdirSync(hostRoot, { recursive: true });

    const action = {
      type: 'run_probe',
      params: {
        cwd: externalDir,
        mode: 'observe',
        objective: 'inspect data/candidates for hash a3f92b',
        targets: ['data/candidates/'],
      },
    };
    const ctx = {
      projectRoot: subjectRuntime,
      host: { sourceRoot: hostRoot, runtimeRoot: subjectRuntime },
    };

    const roots = resolveAgentExecutionRoots(action, ctx);
    expect(roots.executionCwd).toBe(externalDir);
    expect(roots.usesExternalWorkspace).toBe(true);

    const claude = buildClaudeOptions(action, ctx);
    expect(claude.options.cwd).toBe(externalDir);
    expect(claude.options.systemPrompt.append).toContain(externalDir);
    expect(claude.options.systemPrompt.append).not.toContain('host_project_root');
  });

  it('blocks agent startup when explicit cwd does not exist', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-cwd-'));
    const missingCwd = join(tempDir, 'missing');

    const result = await runAgenticAction({
      type: 'agent_execute',
      params: {
        provider: 'claude_code_sdk',
        cwd: missingCwd,
        mode: 'observe',
        objective: 'inspect local files',
        boundary: 'read only',
        acceptance: 'returns a structured receipt',
        escape_hatch_reason: 'stop if cwd is invalid',
      },
    }, { projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(false);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.error).toContain('agent cwd does not exist');
    expect(result.error).toContain(missingCwd);
  });

  it('records write_retrospective locally without starting an agent', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-retro-local-'));
    const store = createIntelligenceStore({ baseDir: join(tempDir, 'intelligence') });
    const action = {
      id: 'retro-1',
      type: 'write_retrospective',
      serves_goal: 'bootstrap',
      params: {
        provider: 'claude_code_sdk',
        summary: 'cycle completed',
        outcome: 'ok',
        lessons: ['use local writes for retrospectives'],
        next_actions: ['continue'],
      },
    };

    const result = await actionHandlers.write_retrospective(action, {
      cycleId: 'exec-test',
      host: { intelligenceStore: store },
    });

    expect(result).toMatchObject({
      success: true,
      status: 'recorded',
      provider: 'local',
      fallback_used: false,
      writes_applied: { retrospectives: 1 },
    });
    expect(result.agentic_execution).toBeUndefined();
    expect(store.readRetrospectives({ limit: 1 })[0]).toMatchObject({
      summary: 'cycle completed',
      outcome: 'ok',
      action_type: 'write_retrospective',
      served_goal: 'bootstrap',
    });
    expect(store.readLatestReview()).toMatchObject({ summary: 'cycle completed' });
    expect(store.readActionReceipts({ limit: 1 })[0]).toMatchObject({
      cycle_id: 'exec-test',
      action_type: 'write_retrospective',
      result: {
        provider: 'local',
        writes_applied: { retrospectives: 1 },
      },
    });
  });

  it('builds retrospective enrichment actions without file tools by default', () => {
    const enriched = buildRetrospectiveEnrichmentAction({
      type: 'write_retrospective',
      params: {
        enrich: true,
        summary: 'cycle completed',
      },
    });

    expect(enriched.params.provider).toBe('llm_only');
    expect(enriched.params.allowedTools).toEqual([]);
    expect(enriched.params.mode).toBe('propose');
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

  it('applies an in-memory goal object and records a goal event', () => {
    const root = makeGoalsRoot('jea-goals-apply-object-');
    const runtime = getActiveSubjectRuntimeInfo(root);
    const nextGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };

    const result = applyGoalObject(root, nextGoal, {
      reason: 'Applied high-confidence goal refine from cycle cycle-apply.',
      evidenceRefs: [{ type: 'intel_report', id: 'cycle-apply', ref: 'intel_report:cycle-apply' }],
      cycle: 'cycle-apply',
    });

    expect(result.written).toBe(1);
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);
    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events[0]).toMatchObject({
      type: 'updated',
      goal_id: 'bootstrap-refined',
      reason: 'Applied high-confidence goal refine from cycle cycle-apply.',
      next_goal: nextGoal,
    });
  });

  it('validates proposed goal shape mechanically', () => {
    expect(validateGoalShape({
      id: 'goal',
      name: 'Goal',
      intent: 'Intent',
      good_signal: 'Good',
      bad_signal: 'Bad',
      children: [],
    })).toMatchObject({ valid: true });

    expect(validateGoalShape({
      id: 'goal',
      name: 'Goal',
      intent: 'Intent',
      good_signal: 'Good',
      bad_signal: 'Bad',
      children: {},
    })).toMatchObject({
      valid: false,
      reason: 'invalid_proposed_goal',
    });
  });

  it('auto-applies only high-confidence refine assessments', () => {
    const root = makeGoalsRoot('jea-goals-auto-refine-');
    const runtime = getActiveSubjectRuntimeInfo(root);
    const nextGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };
    const assessmentResult = {
      report: { cycle_id: 'cycle-auto' },
      event: {
        evidence_refs: [{ type: 'intel_report', id: 'cycle-auto', ref: 'intel_report:cycle-auto' }],
      },
      assessment: {
        status: 'refine',
        confidence: 'high',
        proposed_goal: nextGoal,
        evidence_refs: [{ type: 'intel_report', id: 'cycle-auto', ref: 'intel_report:cycle-auto' }],
      },
    };

    const result = autoCalibrateGoals(root, assessmentResult);

    expect(result).toMatchObject({
      status: 'applied',
      previous_goal_id: 'bootstrap',
      next_goal_id: 'bootstrap-refined',
      written: 1,
    });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);
  });

  it('skips auto calibration for non-refine, low confidence, or invalid goals', () => {
    const root = makeGoalsRoot('jea-goals-auto-skip-');
    const runtime = getActiveSubjectRuntimeInfo(root);
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const validGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };

    expect(autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-keep' },
      assessment: { status: 'keep', confidence: 'high', proposed_goal: validGoal },
    })).toMatchObject({ status: 'skipped', reason: 'status_not_refine' });

    expect(autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-low' },
      assessment: { status: 'refine', confidence: 'medium', proposed_goal: validGoal },
    })).toMatchObject({ status: 'skipped', reason: 'confidence_not_high' });

    expect(autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-invalid' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        proposed_goal: { ...validGoal, children: null },
      },
    })).toMatchObject({ status: 'skipped', reason: 'invalid_proposed_goal' });

    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);
    expect(getGoalHistory(root, { limit: 10 }).events).toHaveLength(0);
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

describe('intel operator briefs', () => {
  it('briefPut queues a one-cycle operator brief under the active runtime', async () => {
    const root = makeIntelRoot('jea-brief-put-');
    const filePath = join(root, 'brief.json');
    writeFileSync(filePath, JSON.stringify({
      id: 'brief-cli',
      summary: 'Verify candidate hash next cycle',
      claims_to_verify: ['codeHash differs from baseline'],
      suggested_actions: ['agentank_generate_candidate'],
    }));

    const code = await briefPut({ root, flags: { file: filePath, json: true } });
    expect(code).toBe(0);

    const runtime = getActiveSubjectRuntimeInfo(root);
    const pending = readPendingOperatorBriefs(runtime.runtimeRoot);
    expect(pending.briefs).toHaveLength(1);
    expect(pending.briefs[0]).toMatchObject({
      id: 'brief-cli',
      summary: 'Verify candidate hash next cycle',
      scope: 'next_cycle',
    });
    expect(briefList({ root, flags: { json: true } })).toBe(0);
  });

  it('briefProcessed lists consumed briefs', async () => {
    const root = makeIntelRoot('jea-brief-processed-');
    const filePath = join(root, 'brief.json');
    writeFileSync(filePath, JSON.stringify({
      id: 'brief-done',
      summary: 'Verify diaries root',
      claims_to_verify: ['diaries path exists under subject runtime'],
    }));

    expect(await briefPut({ root, flags: { file: filePath } })).toBe(0);
    const runtime = getActiveSubjectRuntimeInfo(root);
    const pending = readPendingOperatorBriefs(runtime.runtimeRoot);
    markOperatorBriefsProcessed(runtime.runtimeRoot, pending.briefs, { cycleId: 'cycle-cli' });

    expect(readProcessedOperatorBriefs(runtime.runtimeRoot).briefs[0].id).toBe('brief-done');
    expect(briefProcessed({ root, flags: { json: true } })).toBe(0);
  });
});
