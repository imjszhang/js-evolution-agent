import { loadCycleStepContext } from '../daemon/cycle-checkpoints.mjs';
import { resolveCyclePipeline } from '../daemon/cycle-pipeline-mode.mjs';
import {
  buildCycleContext,
  runAgentLoopStep,
  runBeliefUpdateStep,
  runDiaryStep,
  runExecStep,
  runGoalsAssessStep,
  runGoalsCalibrateStep,
  runIntelReportStep,
  runIntelStep,
  runReactorStep,
  runVerifyStep,
} from './cycle-steps.mjs';

function recordStateBag(runtime) {
  return {
    root: runtime,
    subject: runtime.subject,
  };
}

function requireCheckpoint(stepContext, { requireExec = false } = {}) {
  if (!stepContext?.intelResult?.cycle_id) {
    throw new Error('checkpoint missing for intel before downstream step');
  }
  if (requireExec && !stepContext.execResult) {
    throw new Error(`checkpoint missing for exec before downstream step (cycle=${stepContext.intelResult.cycle_id})`);
  }
}

function emitStepResult(payload) {
  const line = `JEA_STEP_RESULT ${JSON.stringify(payload)}`;
  console.log(line);
  return line;
}

/**
 * Run one train/reactor cycle step in-process (S8 JEA_IN_PROCESS_CYCLE).
 * Returns the same { exitCode, output } shape as the subprocess runner.
 */
export async function runSingleStepInProcess({
  root,
  runtime,
  step,
  cycleId = null,
} = {}) {
  if (!runtime) {
    throw new Error('runtime is required for in-process cycle step');
  }
  if (!cycleId && step !== 'intel' && step !== 'agent_loop' && step !== 'reactor') {
    throw new Error(`JEA_CYCLE_ID is required for step: ${step}`);
  }
  const ctx = await buildCycleContext(root, runtime);
  const recordState = recordStateBag(runtime);
  const stepContext = cycleId
    ? loadCycleStepContext(runtime, runtime.subject, cycleId, runtime.runtimeRoot)
    : null;
  if (step === 'reactor' || step === 'agent_loop' || step === 'intel') {
    ctx.pipeline = step === 'reactor' ? 'reactor' : 'agent_loop';
  } else {
    ctx.pipeline = resolveCyclePipeline(runtime, {
      subject: runtime.subject,
      env: process.env,
    }).pipeline;
  }

  const chunks = [];
  const capture = (payload) => {
    chunks.push(emitStepResult(payload));
  };

  switch (step) {
    case 'reactor': {
      const result = await runReactorStep(ctx, { cycleId, recordState });
      capture({
        step: 'reactor',
        cycle_id: result.cycleId,
        ok: true,
        decisions_queued: result.eventPayload?.decisions_queued ?? 0,
        intel_report_ready: result.eventPayload?.intel_report_ready ?? false,
        skipped: result.eventPayload?.skipped ?? false,
      });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'agent_loop': {
      const result = await runAgentLoopStep(ctx, { cycleId, recordState });
      capture({
        step: 'agent_loop',
        cycle_id: result.cycleId,
        ok: true,
        decisions_queued: result.eventPayload?.decisions_queued ?? 0,
        intel_report_ready: true,
      });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'intel': {
      const result = await runIntelStep(ctx, { cycleId, recordState });
      let intelReportReady = false;
      if (result.intelResult?.report) {
        const reportOutcome = await runIntelReportStep(ctx, { intelResult: result.intelResult, recordState });
        intelReportReady = reportOutcome.intelReportReady;
      }
      capture({
        step: 'intel',
        cycle_id: result.cycleId,
        ok: true,
        decisions_queued: result.eventPayload?.decisions_queued ?? 0,
        intel_report_ready: intelReportReady,
      });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'intel_report': {
      requireCheckpoint(stepContext);
      const outcome = await runIntelReportStep(ctx, { intelResult: stepContext.intelResult, recordState });
      capture({
        step: 'intel_report',
        cycle_id: cycleId,
        ok: !outcome.failed,
        intel_report_ready: outcome.intelReportReady,
      });
      if (outcome.failed) throw new Error('intel report step failed');
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'exec': {
      requireCheckpoint(stepContext);
      const { execResult } = await runExecStep(ctx, {
        recordState,
        intelResult: stepContext.intelResult,
        stateCycleId: cycleId,
      });
      capture({ step: 'exec', cycle_id: execResult.cycle_id, ok: true });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'verify': {
      requireCheckpoint(stepContext, { requireExec: true });
      const { reportPath } = await runVerifyStep(ctx, {
        intelResult: stepContext.intelResult,
        execResult: stepContext.execResult,
        recordState,
      });
      capture({ step: 'verify', cycle_id: cycleId, ok: true, report_path: reportPath });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'belief_update': {
      requireCheckpoint(stepContext, { requireExec: true });
      const outcome = await runBeliefUpdateStep(ctx, {
        intelResult: stepContext.intelResult,
        execResult: stepContext.execResult,
        verification: stepContext.verification,
        reportPath: stepContext.reportPath,
        recordState,
      });
      capture({ step: 'belief_update', cycle_id: cycleId, ok: true, skipped: outcome.skipped });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'goals_assess': {
      requireCheckpoint(stepContext);
      const outcome = await runGoalsAssessStep(ctx, {
        intelResult: stepContext.intelResult,
        reportPath: stepContext.reportPath,
        intelReportReady: stepContext.intelReportReady,
        recordState,
      });
      capture({ step: 'goals_assess', cycle_id: cycleId, ok: true, skipped: outcome.skipped });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'goals_calibrate': {
      requireCheckpoint(stepContext);
      const outcome = await runGoalsCalibrateStep(ctx, {
        intelResult: stepContext.intelResult,
        goalsAssessResult: stepContext.goalsAssessResult,
        store: ctx.store,
        recordState,
      });
      capture({ step: 'goals_calibrate', cycle_id: cycleId, ok: true, skipped: outcome.skipped });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    case 'diary': {
      requireCheckpoint(stepContext, { requireExec: true });
      const outcome = await runDiaryStep(ctx, {
        intelResult: stepContext.intelResult,
        execResult: stepContext.execResult,
        verification: stepContext.verification,
        beliefUpdateResult: stepContext.beliefUpdateResult,
        goalsAssessResult: stepContext.goalsAssessResult,
        goalsCalibrateResult: stepContext.goalsCalibrateResult,
        reportPath: stepContext.reportPath,
        recordState,
      });
      capture({ step: 'diary', cycle_id: cycleId, ok: !outcome.failed });
      return { exitCode: 0, output: chunks.join('\n') };
    }
    default:
      throw new Error(`Unknown cycle step: ${step}`);
  }
}
