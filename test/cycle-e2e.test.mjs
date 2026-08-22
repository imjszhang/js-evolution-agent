import { describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { runCommand } from '../src/cli/commands/run.mjs';
import { listOpenCycles, listStepArtifacts, readStepArtifact } from '../src/daemon/cycle-state.mjs';
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';
import { runSingleCycle } from '../src/evolution/runner.mjs';
import { readLastCommittedMemoryCheckpoint } from '../src/evolution/reactor/memory-compactor.mjs';
import { readExecResult } from '../src/evolution/reactor/exec-result-store.mjs';
import { settleEvidenceWindow } from '../src/evolution/settlement-service.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { runClosureAudit } from '../src/intelligence/closure-audit.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBJECT = 'alpha';

function linkOrCopy(from, to, { dir = false, preferCopy = false } = {}) {
  if (existsSync(to)) return;
  if (preferCopy) {
    cpSync(from, to, { recursive: dir });
    return;
  }
  try {
    cpSync(from, to, { recursive: dir });
  } catch {
    /* ignore */
  }
}

function makeE2eProjectRoot({ initialize = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jea-e2e-'));
  for (const name of ['run.mjs', 'oada.config.mjs']) {
    linkOrCopy(join(REPO_ROOT, name), join(root, name), { preferCopy: true });
  }
  linkOrCopy(join(REPO_ROOT, 'src'), join(root, 'src'), { dir: true });
  linkOrCopy(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), { dir: true });
  linkOrCopy(join(REPO_ROOT, 'policies', 'authority'), join(root, 'policies', 'authority'), { dir: true });

  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(root, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(root, 'policies', 'active-subject.json'), {
    active: SUBJECT,
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });

  if (initialize) initData(root, { all: true, subject: SUBJECT });
  return root;
}

function installCertificationMock(root) {
  cpSync(join(REPO_ROOT, 'oada.config.mjs'), join(root, 'oada.base.mjs'));
  writeFileSync(join(root, 'oada.config.mjs'), `
import loadBase from './oada.base.mjs';

const decision = {
  analysis: { key_patterns: ['certification path'], actions: [] },
  decision: 'execute',
  rationale: 'Exercise one belief-bound production action.',
  actions: [{
    type: 'agent_run',
    description: 'certification belief action',
    serves_goal: 'bootstrap',
    params: {
      run_spec: {
        permission_profile: 'read_only',
        primary_cwd_kind: 'subject_runtime',
        intent: 'produce deterministic certification evidence',
        expected_output: ['evidence'],
        context: {
          belief_id: 'belief-certification',
          belief_relation: 'test_belief',
          expected_belief_update: 'validate when evidence is observed'
        }
      }
    }
  }],
  goal_coverage: { covered: ['bootstrap'], not_covered: {} },
  deferred: [],
  risk_mitigation: [],
  confidence_score: 1
};

export default async function loadCertificationConfig(options) {
  const cfg = await loadBase(options);
  cfg.aiClient._canned.unshift(
    {
      match: /信念更新器|belief updater/i,
      response: {
        status: 'updated',
        reason: 'deterministic certification evidence matched',
        updates: [{
          belief_id: 'belief-certification',
          change: 'validate',
          reason: 'structured evidence matched expected output',
          evidence_refs: []
        }]
      }
    },
    {
      match: /Strategic Analysis & Decision/i,
      response: decision
    },
    {
      match: /standing memory|standing memory 索引/i,
      response: '## Current State\\n- Certification settlement was consolidated.'
    }
  );
  cfg.host.actionHandlers = {
    ...cfg.host.actionHandlers,
    agent_run: async (action, ctx) => {
      const result = {
        success: true,
        status: 'completed',
        execution_status: 'completed',
        acceptance_status: 'passed',
        goal_progress_status: 'progressed',
        evidence: [{ ref: 'certification:evidence' }],
        writes: {},
        outputs: [],
        test_results: [],
        next_actions: [],
        schema_status: 'valid'
      };
      cfg.host.intelligenceStore.recordActionReceipt(action, result, ctx);
      return result;
    }
  };
  return cfg;
}
`, 'utf8');
}

function installBootstrapMock(root, {
  actionSucceeds = true,
  comparisonStatus = 'matched',
} = {}) {
  const expectedOutput = comparisonStatus === 'uncertain'
    ? ['evidence', 'outputs']
    : ['evidence'];
  const evidence = actionSucceeds && comparisonStatus !== 'not_observed'
    ? [{ ref: 'bootstrap:evidence' }]
    : [];
  const acceptanceStatus = !actionSucceeds || comparisonStatus === 'contradicted'
    ? 'failed'
    : 'passed';
  cpSync(join(REPO_ROOT, 'oada.config.mjs'), join(root, 'oada.base.mjs'));
  writeFileSync(join(root, 'oada.config.mjs'), `
import loadBase from './oada.base.mjs';

const decision = {
  analysis: { key_patterns: ['fresh bootstrap'], actions: [] },
  decision: 'execute',
  rationale: 'Bootstrap a first belief from structured execution evidence.',
  actions: [{
    type: 'agent_run',
    description: 'fresh bootstrap belief action',
    serves_goal: 'bootstrap',
    params: {
      run_spec: {
        permission_profile: 'read_only',
        primary_cwd_kind: 'subject_runtime',
        intent: 'produce deterministic bootstrap evidence',
        expected_output: ${JSON.stringify(expectedOutput)},
        context: {
          belief_id: 'belief-fresh-bootstrap',
          belief_relation: 'create_belief',
          expected_belief_claim: 'the fresh bootstrap path emits deterministic evidence',
          expected_belief_update: 'validate the bootstrap path on the next independent run'
        }
      }
    }
  }],
  goal_coverage: { covered: ['bootstrap'], not_covered: {} },
  deferred: [],
  risk_mitigation: [],
  confidence_score: 1
};

export default async function loadBootstrapConfig(options) {
  const cfg = await loadBase(options);
  cfg.aiClient._canned.unshift(
    {
      match: /信念更新器|belief updater/i,
      response: {
        status: 'updated',
        reason: 'attempt a model-authored bootstrap that the settlement guard must ignore',
        updates: [{
          belief_id: 'belief-fresh-bootstrap',
          change: 'create',
          goal_id: 'bootstrap',
          claim: 'model output alone must never create this bootstrap belief',
          next_test: 'require matched structured verification',
          reason: 'model requested creation without authority',
          evidence_refs: []
        }]
      }
    },
    {
      match: /Strategic Analysis & Decision/i,
      response: decision
    }
  );
  cfg.host.actionHandlers = {
    ...cfg.host.actionHandlers,
    agent_run: async (action, ctx) => {
      const result = {
        success: ${actionSucceeds ? 'true' : 'false'},
        status: '${actionSucceeds ? 'completed' : 'failed'}',
        execution_status: '${actionSucceeds ? 'completed' : 'failed'}',
        acceptance_status: '${acceptanceStatus}',
        goal_progress_status: '${actionSucceeds ? 'progressed' : 'blocked'}',
        evidence: ${JSON.stringify(evidence)},
        writes: {},
        outputs: [],
        test_results: [],
        next_actions: [],
        schema_status: 'valid'
      };
      cfg.host.intelligenceStore.recordActionReceipt(action, result, ctx);
      return result;
    }
  };
  return cfg;
}
`, 'utf8');
}

function seedCertificationBelief(root) {
  const runtime = runtimeForSubject(root, SUBJECT);
  const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir });
  store.recordCurrentBeliefs({
    schema_version: 1,
    updated_at: '2026-08-22T00:00:00.000Z',
    beliefs: [{
      id: 'belief-certification',
      goal_id: 'bootstrap',
      claim: 'the production orchestration preserves the causal closure chain',
      status: 'active',
      confidence: 'medium',
      evidence_refs: [],
      next_test: 'run one deterministic belief-bound action',
    }],
  });
}

function readEvolutionEventTypes(root) {
  const runtimeRoot = runtimeForSubject(root, SUBJECT).runtimeRoot;
  const path = join(runtimeRoot, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('reactor sync cycle e2e (mock)', () => {
  it('mechanically creates a fresh bootstrap belief through runCommand and replays idempotently', async () => {
    const previousHome = process.env.JEA_HOME;
    const previousProjectRoot = process.env.JEA_PROJECT_ROOT;
    const root = makeE2eProjectRoot({ initialize: false });
    try {
      process.env.JEA_HOME = join(root, '.jea');
      process.env.JEA_PROJECT_ROOT = root;
      initData(root, { all: true, subject: SUBJECT });
      installBootstrapMock(root);

      expect(await runCommand({ root, flags: { mock: true, subject: SUBJECT } })).toBe(0);

      const runtime = runtimeForSubject(root, SUBJECT);
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir });
      expect(store.readCurrentBeliefs().beliefs).toEqual([
        expect.objectContaining({
          id: 'belief-fresh-bootstrap',
          goal_id: 'bootstrap',
          claim: 'the fresh bootstrap path emits deterministic evidence',
          status: 'active',
          origin: 'mechanical_bootstrap',
        }),
      ]);
      const receipts = store.readActionReceipts({ limit: null });
      expect(receipts[0]).toMatchObject({
        belief_id: 'belief-fresh-bootstrap',
        belief_relation: 'create_belief',
        expected_belief_claim: 'the fresh bootstrap path emits deterministic evidence',
      });
      const verifyEvent = readEvolutionEventTypes(root)
        .find((event) => event.type === 'verify_pipeline');
      const reportPath = join(
        runtime.dataRoot,
        'evolution',
        'verify_reports',
        `${verifyEvent.execution_id}.json`,
      );
      const verification = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(verification.comparison.actions[0]).toMatchObject({
        status: 'matched',
        execution_success: true,
        belief_id: 'belief-fresh-bootstrap',
        belief_relation: 'create_belief',
        expected_belief_claim: 'the fresh bootstrap path emits deterministic evidence',
      });

      const createEventsBefore = store.readBeliefEvents({ limit: null })
        .filter((event) => event.change === 'create');
      expect(createEventsBefore).toHaveLength(1);
      expect(createEventsBefore[0]).toMatchObject({
        belief_id: 'belief-fresh-bootstrap',
        evidence_refs: expect.arrayContaining([
          expect.stringMatching(/^action_receipt:/),
          `verify_report:${verifyEvent.execution_id}`,
        ]),
        settlement_id: expect.stringMatching(/^settlement-/),
        settlement_effect: 'belief',
      });

      const replay = await settleEvidenceWindow({
        runtime,
        store,
      }, {
        intelResult: { cycle_id: verification.reaction_id ?? verification.cycle_id },
        execResult: readExecResult(runtime.dataRoot, verifyEvent.execution_id),
        verification,
        reportPath,
        receipts,
      });
      expect(replay).toMatchObject({
        settlement_id: createEventsBefore[0].settlement_id,
        reused: true,
      });
      const createEventsAfter = store.readBeliefEvents({ limit: null })
        .filter((event) => event.change === 'create');
      expect(createEventsAfter.map((event) => event.id))
        .toEqual(createEventsBefore.map((event) => event.id));
    } finally {
      if (previousHome === undefined) delete process.env.JEA_HOME;
      else process.env.JEA_HOME = previousHome;
      if (previousProjectRoot === undefined) delete process.env.JEA_PROJECT_ROOT;
      else process.env.JEA_PROJECT_ROOT = previousProjectRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('does not create a fresh bootstrap belief when the action fails', async () => {
    const previousHome = process.env.JEA_HOME;
    const previousProjectRoot = process.env.JEA_PROJECT_ROOT;
    const root = makeE2eProjectRoot({ initialize: false });
    try {
      process.env.JEA_HOME = join(root, '.jea');
      process.env.JEA_PROJECT_ROOT = root;
      initData(root, { all: true, subject: SUBJECT });
      installBootstrapMock(root, { actionSucceeds: false });

      await runCommand({ root, flags: { mock: true, subject: SUBJECT } });

      const runtime = runtimeForSubject(root, SUBJECT);
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir });
      expect(store.readCurrentBeliefs()?.beliefs ?? []).toEqual([]);
      expect(store.readBeliefEvents({ limit: null }).some((event) => (
        event.change === 'create'
        && event.belief_id === 'belief-fresh-bootstrap'
      ))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.JEA_HOME;
      else process.env.JEA_HOME = previousHome;
      if (previousProjectRoot === undefined) delete process.env.JEA_PROJECT_ROOT;
      else process.env.JEA_PROJECT_ROOT = previousProjectRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it.each(['uncertain', 'not_observed', 'contradicted'])(
    'does not bootstrap through runCommand when expected output is %s',
    async (comparisonStatus) => {
      const previousHome = process.env.JEA_HOME;
      const previousProjectRoot = process.env.JEA_PROJECT_ROOT;
      const root = makeE2eProjectRoot({ initialize: false });
      try {
        process.env.JEA_HOME = join(root, '.jea');
        process.env.JEA_PROJECT_ROOT = root;
        initData(root, { all: true, subject: SUBJECT });
        installBootstrapMock(root, { comparisonStatus });

        expect(await runCommand({ root, flags: { mock: true, subject: SUBJECT } })).toBe(0);

        const runtime = runtimeForSubject(root, SUBJECT);
        const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir });
        const verifyEvent = readEvolutionEventTypes(root)
          .find((event) => event.type === 'verify_pipeline');
        const verification = JSON.parse(readFileSync(join(
          runtime.dataRoot,
          'evolution',
          'verify_reports',
          `${verifyEvent.execution_id}.json`,
        ), 'utf8'));

        expect(verification.comparison.actions[0]).toMatchObject({
          status: comparisonStatus,
          execution_success: true,
          belief_id: 'belief-fresh-bootstrap',
          belief_relation: 'create_belief',
        });
        expect(store.readCurrentBeliefs()?.beliefs ?? []).toEqual([]);
        expect(store.readBeliefEvents({ limit: null }).some((event) => (
          event.change === 'create'
          && event.belief_id === 'belief-fresh-bootstrap'
        ))).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.JEA_HOME;
        else process.env.JEA_HOME = previousHome;
        if (previousProjectRoot === undefined) delete process.env.JEA_PROJECT_ROOT;
        else process.env.JEA_PROJECT_ROOT = previousProjectRoot;
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it('runs the complete belief-bound closure chain through runCommand and run.mjs', async () => {
    const previousHome = process.env.JEA_HOME;
    const previousProjectRoot = process.env.JEA_PROJECT_ROOT;
    const root = makeE2eProjectRoot({ initialize: false });
    try {
      process.env.JEA_HOME = join(root, '.jea');
      process.env.JEA_PROJECT_ROOT = root;
      initData(root, { all: true, subject: SUBJECT });
      installCertificationMock(root);
      seedCertificationBelief(root);

      const exitCode = await runCommand({ root, flags: { mock: true, subject: SUBJECT } });
      expect(exitCode).toBe(0);

      const runtime = runtimeForSubject(root, SUBJECT);
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir });
      const events = readEvolutionEventTypes(root);
      expect(events.find((event) => event.type === 'reactor_pipeline')?.decisions_queued)
        .toBeGreaterThan(0);
      expect(events.find((event) => event.type === 'exec_pipeline')?.executed_count)
        .toBeGreaterThan(0);
      const verifyEvent = events.find((event) => event.type === 'verify_pipeline');
      expect(verifyEvent?.verified_count).toBeGreaterThan(0);

      const verifyDir = join(runtime.dataRoot, 'evolution', 'verify_reports');
      const reportFile = readFileSync(
        join(verifyDir, `${verifyEvent.execution_id}.json`),
        'utf8',
      );
      const verifyReport = JSON.parse(reportFile);
      expect(verifyReport.comparison).toMatchObject({
        status: 'matched',
        execution_success: true,
      });
      expect(verifyReport.comparison.actions[0].belief_id).toBe('belief-certification');

      const beliefEvents = store.readBeliefEvents({ limit: null });
      const commit = beliefEvents.find((event) => event.type === 'settlement_commit');
      expect(commit).toMatchObject({
        settlement_effect: 'belief',
        execution_id: verifyReport.execution_id,
      });
      expect(beliefEvents.some((event) => (
        event.change === 'validate'
        && event.belief_id === 'belief-certification'
        && event.settlement_id === commit.settlement_id
      ))).toBe(true);
      expect(readLastCommittedMemoryCheckpoint(runtime.dataRoot)).toMatchObject({
        stage: 'committed',
        reactor: 'memory',
      });
      expect(store.readStandingMemory()).toMatchObject({
        memory_batch_id: expect.stringMatching(/^batch-memory-/),
        freshness: { status: 'fresh' },
      });

      const audit = runClosureAudit({
        root,
        subject: SUBJECT,
        namespace: SUBJECT,
        runtimeRoot: runtime.runtimeRoot,
        dataRoot: runtime.dataRoot,
      });
      expect(audit.schema_version).toBe('closure-audit.v1');
      expect(audit.metrics.decision_coverage).toMatchObject({
        belief_binding: { bound: 1, legacy_unknown: 0 },
        expected_output: { covered: 1, legacy_unknown: 0 },
      });
      expect(audit.metrics.causal_correlation.settlement_events.reopenable)
        .toBeGreaterThan(0);
      expect(audit.metrics.standing_memory_freshness).toMatchObject({
        exists: true,
        cursor_status: 'current',
        freshness: { status: 'fresh' },
      });
    } finally {
      if (previousHome === undefined) delete process.env.JEA_HOME;
      else process.env.JEA_HOME = previousHome;
      if (previousProjectRoot === undefined) delete process.env.JEA_PROJECT_ROOT;
      else process.env.JEA_PROJECT_ROOT = previousProjectRoot;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('jea run --mock leaves low-frequency diary writes to Memory Reactor', async () => {
    const root = makeE2eProjectRoot();
    try {
      const result = await runSingleCycle({
        root,
        subject: SUBJECT,
        flags: {
          mock: true,
          'skip-goals-assess': true,
          'skip-belief-update': true,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(listOpenCycles(root, SUBJECT)).toHaveLength(0);

      const events = readEvolutionEventTypes(root);
      const types = new Set(events.map((e) => e.type));
      expect(types.has('reactor_pipeline')).toBe(true);
      expect(types.has('exec_pipeline')).toBe(true);
      expect(types.has('verify_pipeline')).toBe(true);
      expect(types.has('evolution_diary')).toBe(false);
      expect(types.has('standing_memory_update')).toBe(false);

      const honesty = events.filter((e) => e.type === 'reactor_report_honesty');
      expect(honesty.length).toBeGreaterThanOrEqual(1);
      expect(honesty[0].batch_id).toMatch(/^batch-/);

      const cycleId = honesty[0].cycle_id;
      const artifacts = listStepArtifacts(root, SUBJECT, cycleId);
      expect(artifacts).toContain('reactor');
      expect(artifacts).toContain('exec');
      expect(artifacts).toContain('verify');
      expect(artifacts).not.toContain('diary');
      const reactorCp = readStepArtifact(root, SUBJECT, cycleId, 'reactor');
      expect(reactorCp?.batch_id).toBe(honesty[0].batch_id);
      expect(events.find((event) => event.type === 'reactor_pipeline')?.decisions_queued)
        .toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('jea run --mock also writes belief and goals when they are not skipped', async () => {
    const root = makeE2eProjectRoot();
    try {
      const result = await runSingleCycle({
        root,
        subject: SUBJECT,
        flags: { mock: true },
      });
      expect(result.exitCode).toBe(0);

      const events = readEvolutionEventTypes(root);
      const types = new Set(events.map((e) => e.type));
      expect(types.has('belief_update')).toBe(true);
      expect(types.has('goals_assess')).toBe(true);
      expect(types.has('goals_calibrate')).toBe(true);
      const honesty = events.filter((e) => e.type === 'reactor_report_honesty');
      expect(honesty.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
