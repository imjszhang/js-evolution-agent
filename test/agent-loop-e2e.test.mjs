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
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { createCycle, readStepArtifact } from '../src/cli/utils/cycle-state.mjs';
import {
  buildCycleContext,
  runAgentLoopStep,
  runBeliefUpdateStep,
  runDiaryStep,
  runExecStep,
  runGoalsAssessStep,
  runGoalsCalibrateStep,
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
  const root = mkdtempSync(join(tmpdir(), 'jea-agent-loop-e2e-'));
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

describe('agent_loop e2e (mock)', () => {
  it('runs agent_loop then exec/verify/belief/goals/diary and closes cycle artifacts', async () => {
    const root = makeE2eProjectRoot();
    const prevCwd = process.cwd();
    const prevMock = process.env.JEA_FORCE_MOCK;
    const prevPipeline = process.env.JEA_CYCLE_PIPELINE;
    try {
      process.chdir(root);
      process.env.JEA_FORCE_MOCK = '1';
      process.env.JEA_CYCLE_PIPELINE = 'agent_loop';
      delete process.env.DEEPSEEK_API_KEY;

      const runtime = runtimeForSubject(root, SUBJECT);
      const ctx = await buildCycleContext(root, runtime);
      // Ensure mock client supports tools
      expect(typeof ctx.cfg.aiClient.chatMessagesWithTools).toBe('function');

      const cycleState = createCycle(root, SUBJECT, {
        meta: { driver: 'run', pipeline: 'agent_loop' },
      });
      const recordState = { root, subject: SUBJECT };

      const loopOutcome = await runAgentLoopStep(ctx, {
        cycleId: cycleState.cycle_id,
        recordState,
      });
      expect(loopOutcome.intelResult.success).toBe(true);
      expect(existsSync(loopOutcome.intelResult.report.mdPath)).toBe(true);

      const intelCp = readStepArtifact(root, SUBJECT, cycleState.cycle_id, 'intel');
      const loopCp = readStepArtifact(root, SUBJECT, cycleState.cycle_id, 'agent_loop');
      expect(intelCp?.success).toBe(true);
      expect(loopCp?.success).toBe(true);
      expect(readStepArtifact(root, SUBJECT, cycleState.cycle_id, 'exec')).toBeNull();

      const { execResult } = await runExecStep(ctx, {
        recordState,
        intelResult: loopOutcome.intelResult,
        stateCycleId: cycleState.cycle_id,
      });
      const execCp = readStepArtifact(root, SUBJECT, cycleState.cycle_id, 'exec');
      expect(Array.isArray(execCp?.executed)).toBe(true);

      const { verification, reportPath } = await runVerifyStep(ctx, {
        intelResult: loopOutcome.intelResult,
        execResult,
        recordState,
      });
      expect(existsSync(reportPath)).toBe(true);

      await runBeliefUpdateStep(ctx, {
        intelResult: loopOutcome.intelResult,
        execResult,
        verification,
        reportPath,
        recordState,
      });
      const goalsOutcome = await runGoalsAssessStep(ctx, {
        intelResult: loopOutcome.intelResult,
        reportPath,
        intelReportReady: true,
        recordState,
      });
      if (goalsOutcome.goalsAssessResult) {
        await runGoalsCalibrateStep(ctx, {
          intelResult: loopOutcome.intelResult,
          goalsAssessResult: goalsOutcome.goalsAssessResult,
          store: ctx.store,
          recordState,
        });
      }
      const diary = await runDiaryStep(ctx, {
        intelResult: loopOutcome.intelResult,
        execResult,
        verification,
        beliefUpdateResult: null,
        goalsAssessResult: goalsOutcome.goalsAssessResult,
        goalsCalibrateResult: null,
        reportPath,
        recordState,
      });
      expect(diary.failed).not.toBe(true);

      const turnsPath = join(
        runtime.runtimeRoot,
        'data',
        'evolution',
        'records',
        cycleState.cycle_id,
        'agent_loop_turns.jsonl',
      );
      expect(existsSync(turnsPath)).toBe(true);
      const turns = readFileSync(turnsPath, 'utf-8').trim().split('\n').filter(Boolean);
      expect(turns.length).toBeGreaterThanOrEqual(1);
    } finally {
      process.chdir(prevCwd);
      if (prevMock == null) delete process.env.JEA_FORCE_MOCK;
      else process.env.JEA_FORCE_MOCK = prevMock;
      if (prevPipeline == null) delete process.env.JEA_CYCLE_PIPELINE;
      else process.env.JEA_CYCLE_PIPELINE = prevPipeline;
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
