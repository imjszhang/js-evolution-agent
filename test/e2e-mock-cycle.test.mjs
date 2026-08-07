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
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';
import {
  CYCLE_STEP_TYPES,
  TERMINAL_STEP_STATUSES,
} from '../src/daemon/cycle-reducer.mjs';
import {
  generateCycleId,
  listStepArtifacts,
  readCycleState,
  readStepArtifact,
  stepArtifactPath,
} from '../src/daemon/cycle-state.mjs';
import {
  buildCycleContext,
  runBeliefUpdateStep,
  runDiaryStep,
  runExecStep,
  runGoalsAssessStep,
  runGoalsCalibrateStep,
  runIntelReportStep,
  runIntelStep,
  runVerifyStep,
} from '../src/evolution/cycle-steps.mjs';

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

function makeE2eProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-cycle-steps-'));
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

  initData(root, { all: true, subject: SUBJECT });
  return root;
}

function readEvolutionEvents(root) {
  const runtimeRoot = runtimeForSubject(root, SUBJECT).runtimeRoot;
  const path = join(runtimeRoot, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expectDecisionShape(decision) {
  expect(decision).toEqual(expect.objectContaining({
    id: expect.any(String),
    status: expect.any(String),
    action: expect.objectContaining({
      type: expect.any(String),
    }),
  }));
}

function expectReceiptShape(receipt) {
  expect(receipt).toEqual(expect.objectContaining({
    id: expect.stringMatching(/^receipt-/),
    recorded_at: expect.any(String),
    action_type: expect.any(String),
    action: expect.objectContaining({
      type: expect.any(String),
    }),
    result: expect.any(Object),
  }));
}

function expectStepCheckpointShape(checkpoint, expectedStep, expectedCycleId) {
  expect(checkpoint).toEqual(expect.objectContaining({
    step: expectedStep,
    cycle_id: expectedCycleId,
    written_at: expect.any(String),
    payload: expect.any(Object),
  }));
}

function expectVerifyReportShape(report) {
  expect(report).toEqual(expect.objectContaining({
    verified: expect.any(Array),
    pending: expect.any(Array),
    semantic: expect.objectContaining({
      status: expect.any(String),
    }),
  }));
}

describe('mock cycle step runners e2e', () => {
  it('runs all eight cycle steps without skip flags', async () => {
    const previousForceMock = process.env.JEA_FORCE_MOCK;
    const previousSkipBelief = process.env.JEA_SKIP_BELIEF_UPDATE;
    const previousSkipGoals = process.env.JEA_SKIP_GOALS_ASSESS;
    process.env.JEA_FORCE_MOCK = '1';
    delete process.env.JEA_SKIP_BELIEF_UPDATE;
    delete process.env.JEA_SKIP_GOALS_ASSESS;

    const root = makeE2eProjectRoot();
    try {
      const runtime = runtimeForSubject(root, SUBJECT);
      const ctx = await buildCycleContext(root, runtime);
      const cycleId = generateCycleId();
      const recordState = { root, subject: SUBJECT };

      const intel = await runIntelStep(ctx, { cycleId, recordState });
      const intelReport = await runIntelReportStep(ctx, {
        intelResult: intel.intelResult,
        recordState,
      });
      const exec = await runExecStep(ctx, {
        intelResult: intel.intelResult,
        recordState,
        stateCycleId: cycleId,
      });
      const verify = await runVerifyStep(ctx, {
        intelResult: intel.intelResult,
        execResult: exec.execResult,
        recordState,
      });
      const belief = await runBeliefUpdateStep(ctx, {
        intelResult: intel.intelResult,
        execResult: exec.execResult,
        verification: verify.verification,
        reportPath: verify.reportPath,
        recordState,
      });
      const goalsAssess = await runGoalsAssessStep(ctx, {
        intelResult: intel.intelResult,
        reportPath: verify.reportPath,
        intelReportReady: intelReport.intelReportReady,
        recordState,
      });
      const goalsCalibrate = await runGoalsCalibrateStep(ctx, {
        intelResult: intel.intelResult,
        goalsAssessResult: goalsAssess.goalsAssessResult,
        store: ctx.store,
        recordState,
      });
      const diary = await runDiaryStep(ctx, {
        intelResult: intel.intelResult,
        execResult: exec.execResult,
        verification: verify.verification,
        beliefUpdateResult: belief.beliefUpdateResult,
        goalsAssessResult: goalsAssess.goalsAssessResult,
        goalsCalibrateResult: goalsCalibrate.goalsCalibrateResult,
        reportPath: verify.reportPath,
        recordState,
      });

      expect(intel.intelResult.success).toBe(true);
      expect(intelReport.intelReportReady).toBe(true);
      expect(exec.execResult.success).toBe(true);
      expect(verify.verification.verified.length).toBeGreaterThan(0);
      expect(belief.skipped).not.toBe(true);
      expect(goalsAssess.skipped).not.toBe(true);
      expect(goalsCalibrate.skipped).not.toBe(true);
      expect(diary.diary?.mdPath).toBeTruthy();

      const state = readCycleState(root, SUBJECT, cycleId);
      expect(state?.status).toBe('closed');
      for (const step of CYCLE_STEP_TYPES) {
        expect(TERMINAL_STEP_STATUSES.has(state.steps[step]?.status), `${step}=${state.steps[step]?.status}`).toBe(true);
      }

      const artifacts = listStepArtifacts(root, SUBJECT, cycleId);
      for (const step of CYCLE_STEP_TYPES) {
        expect(artifacts, `missing artifact for ${step}`).toContain(step);
      }

      expect(readStepArtifact(root, SUBJECT, cycleId, 'belief_update')).toMatchObject({
        skipped: false,
      });
      expect(readStepArtifact(root, SUBJECT, cycleId, 'goals_assess')).toMatchObject({
        skipped: false,
      });
      expect(readStepArtifact(root, SUBJECT, cycleId, 'goals_calibrate')).toMatchObject({
        skipped: false,
      });

      const runtimeRoot = runtime.runtimeRoot;
      const queue = readJson(join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json'));
      expect(queue.decisions.length).toBeGreaterThan(0);
      for (const decision of queue.decisions) {
        expectDecisionShape(decision);
      }

      const receipts = readJsonl(join(runtimeRoot, 'data', 'intelligence', 'action_receipts', 'action-receipts.jsonl'));
      expect(receipts.length).toBeGreaterThan(0);
      for (const receipt of receipts) {
        expectReceiptShape(receipt);
      }

      for (const step of CYCLE_STEP_TYPES) {
        const checkpoint = readJson(stepArtifactPath(root, SUBJECT, cycleId, step));
        expectStepCheckpointShape(checkpoint, step, cycleId);
      }

      expectVerifyReportShape(readJson(verify.reportPath));

      const eventTypes = new Set(readEvolutionEvents(root).map((event) => event.type));
      for (const type of [
        'intel_pipeline',
        'intel_report',
        'exec_pipeline',
        'verify_pipeline',
        'belief_update',
        'goals_assess',
        'goals_calibrate',
      ]) {
        expect(eventTypes.has(type), `missing event ${type}`).toBe(true);
      }
    } finally {
      if (previousForceMock == null) delete process.env.JEA_FORCE_MOCK;
      else process.env.JEA_FORCE_MOCK = previousForceMock;
      if (previousSkipBelief == null) delete process.env.JEA_SKIP_BELIEF_UPDATE;
      else process.env.JEA_SKIP_BELIEF_UPDATE = previousSkipBelief;
      if (previousSkipGoals == null) delete process.env.JEA_SKIP_GOALS_ASSESS;
      else process.env.JEA_SKIP_GOALS_ASSESS = previousSkipGoals;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
