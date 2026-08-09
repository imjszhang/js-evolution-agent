#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeInfoForDefaultSubject } from './src/infra/subjects.mjs';
import { withSubjectLock } from './src/daemon/evolve-runs.mjs';
import { createCycle } from './src/daemon/cycle-state.mjs';
import { loadCycleStepContext } from './src/daemon/cycle-checkpoints.mjs';
import {
  buildCycleContext,
  runAgentLoopStep,
  runReactorStep,
  runBeliefUpdateStep,
  runDiaryStep,
  runExecStep,
  runGoalsAssessStep,
  runGoalsCalibrateStep,
  runIntelReportStep,
  runIntelStep,
  runVerifyStep,
  skipGoalsAssessFromEnv,
  skipBeliefUpdateFromEnv,
} from './src/evolution/cycle-steps.mjs';
import { resolveCyclePipeline } from './src/daemon/cycle-pipeline-mode.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildExitRecord(err) {
  const message = err?.message || String(err);
  const base = { message, retryable: false };
  if (/empty content/i.test(message)) return { ...base, code: 'llm_empty_content', retryable: true };
  if (/timeout|timed out/i.test(message)) return { ...base, code: 'timeout', retryable: true };
  if (/\b429\b|rate limit/i.test(message)) return { ...base, code: 'rate_limit', retryable: true };
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) return { ...base, code: 'network', retryable: true };
  if (/DEEPSEEK_API_KEY is required/i.test(message)) return { ...base, code: 'missing_api_key', retryable: false };
  if (/Subject policy not found|run\.mjs not found/i.test(message)) return { ...base, code: 'configuration', retryable: false };
  if (/Subject is already running/i.test(message)) return { ...base, code: 'subject_already_running', retryable: true };
  if (/intel pipeline failed/i.test(message)) return { ...base, code: 'intel_failed', retryable: true };
  if (/exec pipeline failed/i.test(message)) return { ...base, code: 'exec_failed', retryable: false };
  if (/checkpoint/i.test(message)) return { ...base, code: 'checkpoint_missing', retryable: false };
  return { ...base, code: 'unknown', retryable: false };
}

function recordStateBag(runtime) {
  return {
    root: __dirname,
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

async function runSingleStepMode(runtime, step, cycleId) {
  if (!cycleId && step !== 'intel' && step !== 'agent_loop' && step !== 'reactor') {
    throw new Error(`JEA_CYCLE_ID is required for step: ${step}`);
  }
  const ctx = await buildCycleContext(__dirname, runtime);
  const recordState = recordStateBag(runtime);
  const stepContext = cycleId
    ? loadCycleStepContext(__dirname, runtime.subject, cycleId, runtime.runtimeRoot)
    : null;
  // Align carryover write gate with the step being executed.
  if (step === 'reactor' || step === 'agent_loop' || step === 'intel') {
    ctx.pipeline = step === 'reactor' ? 'reactor' : 'agent_loop';
  } else {
    ctx.pipeline = resolveCyclePipeline(__dirname, {
      subject: runtime.subject,
      env: process.env,
    }).pipeline;
  }

  switch (step) {
    case 'reactor': {
      const result = await runReactorStep(ctx, { cycleId, recordState });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({
        step: 'reactor',
        cycle_id: result.cycleId,
        ok: true,
        decisions_queued: result.eventPayload?.decisions_queued ?? 0,
        intel_report_ready: result.eventPayload?.intel_report_ready ?? false,
        skipped: result.eventPayload?.skipped ?? false,
      })}`);
      return;
    }
    case 'agent_loop': {
      const result = await runAgentLoopStep(ctx, { cycleId, recordState });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({
        step: 'agent_loop',
        cycle_id: result.cycleId,
        ok: true,
        decisions_queued: result.eventPayload?.decisions_queued ?? 0,
        intel_report_ready: true,
      })}`);
      return;
    }
    case 'intel': {
      const result = await runIntelStep(ctx, { cycleId, recordState });
      let intelReportReady = false;
      if (result.intelResult?.report) {
        const reportOutcome = await runIntelReportStep(ctx, { intelResult: result.intelResult, recordState });
        intelReportReady = reportOutcome.intelReportReady;
      }
      console.log(`JEA_STEP_RESULT ${JSON.stringify({
        step: 'intel',
        cycle_id: result.cycleId,
        ok: true,
        decisions_queued: result.eventPayload?.decisions_queued ?? 0,
        intel_report_ready: intelReportReady,
      })}`);
      return;
    }
    case 'intel_report': {
      requireCheckpoint(stepContext);
      const outcome = await runIntelReportStep(ctx, { intelResult: stepContext.intelResult, recordState });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'intel_report', cycle_id: cycleId, ok: !outcome.failed, intel_report_ready: outcome.intelReportReady })}`);
      if (outcome.failed) throw new Error('intel report step failed');
      return;
    }
    case 'exec': {
      requireCheckpoint(stepContext);
      const { execResult } = await runExecStep(ctx, {
        recordState,
        intelResult: stepContext.intelResult,
        stateCycleId: cycleId,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'exec', cycle_id: execResult.cycle_id, ok: true })}`);
      return;
    }
    case 'verify': {
      requireCheckpoint(stepContext, { requireExec: true });
      const { verification, reportPath } = await runVerifyStep(ctx, {
        intelResult: stepContext.intelResult,
        execResult: stepContext.execResult,
        recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'verify', cycle_id: cycleId, ok: true, report_path: reportPath })}`);
      return;
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
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'belief_update', cycle_id: cycleId, ok: true, skipped: outcome.skipped })}`);
      return;
    }
    case 'goals_assess': {
      requireCheckpoint(stepContext);
      const outcome = await runGoalsAssessStep(ctx, {
        intelResult: stepContext.intelResult,
        reportPath: stepContext.reportPath,
        intelReportReady: stepContext.intelReportReady,
        recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'goals_assess', cycle_id: cycleId, ok: true, skipped: outcome.skipped })}`);
      return;
    }
    case 'goals_calibrate': {
      requireCheckpoint(stepContext);
      const outcome = await runGoalsCalibrateStep(ctx, {
        intelResult: stepContext.intelResult,
        goalsAssessResult: stepContext.goalsAssessResult,
        store: ctx.store,
        recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'goals_calibrate', cycle_id: cycleId, ok: true, skipped: outcome.skipped })}`);
      return;
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
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'diary', cycle_id: cycleId, ok: !outcome.failed })}`);
      return;
    }
    default:
      throw new Error(`Unknown cycle step: ${step}`);
  }
}

function cycleDriverFromEnv() {
  const value = process.env.JEA_CYCLE_DRIVER;
  if (value === 'evolve' || value === 'daemon' || value === 'run') return value;
  return 'run';
}

async function runCycle(runtime) {
  const ctx = await buildCycleContext(__dirname, runtime);
  const recordState = recordStateBag(runtime);
  const { store } = ctx;
  const pipelineResolved = resolveCyclePipeline(__dirname, {
    subject: runtime.subject,
    env: process.env,
  });
  const pipeline = pipelineResolved.pipeline;
  // Carryover write gate and step selection both read this.
  ctx.pipeline = pipeline;

  console.log('\n=== active subject runtime ===');
  console.log('  subject:', runtime.subject);
  console.log('  namespace:', runtime.dataNamespace);
  console.log('  runtimeRoot:', runtime.runtimeRoot);
  console.log('  pipeline:', pipeline, `(${pipelineResolved.source})`);

  const cycleState = createCycle(recordState.root, runtime.subject, {
    meta: { driver: cycleDriverFromEnv(), pipeline },
  });

  let intelResult;
  let execResult;
  let intelReportReady = false;

  if (pipeline === 'agent_loop') {
    console.log('\n=== Agent loop (intel only) ===');
    const loopOutcome = await runAgentLoopStep(ctx, { cycleId: cycleState.cycle_id, recordState });
    intelResult = loopOutcome.intelResult;
    intelReportReady = Boolean(intelResult?.report?.mdPath);
    console.log('  success:', intelResult.success);
    console.log('  decisions queued:', intelResult.decisions_queued?.length ?? 0);
    console.log('  report ready:', intelReportReady);

    console.log('\n=== Phase 2: exec pipeline ===');
    ({ execResult } = await runExecStep(ctx, { recordState, intelResult, stateCycleId: intelResult.cycle_id }));
    console.log('  success:', execResult.success);
    console.log('  executed:', execResult.executed.length);
  } else if (pipeline === 'reactor') {
    console.log('\n=== Cognitive reactor (Phase 3 gray) ===');
    const reactorOutcome = await runReactorStep(ctx, { cycleId: cycleState.cycle_id, recordState });
    intelResult = reactorOutcome.intelResult;
    intelReportReady = Boolean(intelResult?.report?.mdPath);
    console.log('  success:', intelResult.success);
    console.log('  skipped:', intelResult.skipped ?? false);
    console.log('  decisions queued:', intelResult.decisions_queued?.length ?? 0);
    console.log('  report ready:', intelReportReady);

    console.log('\n=== Phase 2: exec pipeline ===');
    ({ execResult } = await runExecStep(ctx, { recordState, intelResult, stateCycleId: intelResult.cycle_id }));
    console.log('  success:', execResult.success);
    console.log('  executed:', execResult.executed.length);
  } else {
    console.log('\n=== Phase 1: intel pipeline ===');
    const intelOutcome = await runIntelStep(ctx, { cycleId: cycleState.cycle_id, recordState });
    intelResult = intelOutcome.intelResult;
    console.log('  success:', intelResult.success);
    console.log('  actions queued:', intelResult.decisions_queued.length);

    console.log('\n=== Phase 1.5: intel report ===');
    const reportOutcome = await runIntelReportStep(ctx, { intelResult, recordState });
    intelReportReady = reportOutcome.intelReportReady;
    if (reportOutcome.failed) {
      console.warn('  report generation failed (non-fatal)');
    } else {
      console.log('  report ready:', intelReportReady);
    }

    console.log('\n=== Phase 2: exec pipeline ===');
    ({ execResult } = await runExecStep(ctx, { recordState, intelResult, stateCycleId: intelResult.cycle_id }));
    console.log('  success:', execResult.success);
    console.log('  executed:', execResult.executed.length);
  }

  console.log('\n=== Phase 3: verify receipts ===');
  const { verification, reportPath, semanticVerification } = await runVerifyStep(ctx, {
    intelResult, execResult, recordState,
  });
  console.log('  verified:', verification.verified.length);
  console.log('  semantic:', semanticVerification.status);

  let beliefUpdateResult = null;
  if (skipBeliefUpdateFromEnv()) {
    console.log('\n=== Phase 3.5: belief update (skipped) ===');
  } else {
    console.log('\n=== Phase 3.5: belief update ===');
    const beliefOutcome = await runBeliefUpdateStep(ctx, {
      intelResult, execResult, verification, reportPath, recordState,
    });
    beliefUpdateResult = beliefOutcome.beliefUpdateResult;
  }

  let goalsAssessResult = null;
  let goalsCalibrateResult = null;
  if (skipGoalsAssessFromEnv()) {
    console.log('\n=== Phase 4: goals assess (skipped) ===');
  } else if (!intelReportReady) {
    console.log('\n=== Phase 4: goals assess (skipped) ===');
    console.log('  reason: intel report was not generated for this cycle');
  } else {
    console.log('\n=== Phase 4: goals assess ===');
    const goalsOutcome = await runGoalsAssessStep(ctx, {
      intelResult, reportPath, intelReportReady, recordState,
    });
    goalsAssessResult = goalsOutcome.goalsAssessResult;
  }

  if (goalsAssessResult) {
    console.log('\n=== Phase 4.5: goals calibrate ===');
    const calOutcome = await runGoalsCalibrateStep(ctx, {
      intelResult, goalsAssessResult, store, recordState,
    });
    goalsCalibrateResult = calOutcome.goalsCalibrateResult;
    console.log('  status:', goalsCalibrateResult.status);
  }

  console.log('\n=== Phase 5: evolution diary ===');
  await runDiaryStep(ctx, {
    intelResult,
    execResult,
    verification,
    beliefUpdateResult,
    goalsAssessResult,
    goalsCalibrateResult,
    reportPath,
    recordState,
  });

  console.log('\n=== Done ===');
  console.log(`Evolution data: ${runtime.evolutionDir}`);
  console.log(`Intelligence data: ${runtime.intelligenceDir}`);
}

async function main() {
  process.chdir(__dirname);
  const runtime = runtimeInfoForDefaultSubject(__dirname);
  mkdirSync(runtime.runtimeRoot, { recursive: true });
  const step = process.env.JEA_CYCLE_STEP;
  const cycleId = process.env.JEA_CYCLE_ID || null;

  const run = async () => {
    if (step) {
      return runSingleStepMode(runtime, step, cycleId);
    }
    return runCycle(runtime);
  };

  if (process.env.JEA_SUBJECT_RUN_LOCK_HELD === '1') {
    return run();
  }
  return withSubjectLock(__dirname, runtime.subject, run, { mode: 'run' });
}

main().catch((err) => {
  console.error('js-evolution-agent failed:', err?.message || err);
  const record = buildExitRecord(err);
  console.error(`JEA_EXIT_RECORD ${JSON.stringify(record)}`);
  process.exit(1);
});
