#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeInfoForDefaultSubject } from './src/cli/utils/subjects.mjs';
import { withSubjectLock } from './src/cli/utils/evolve-runs.mjs';
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
  loadStepArtifacts,
  skipGoalsAssessFromEnv,
  skipBeliefUpdateFromEnv,
} from './src/evolution/cycle-steps.mjs';
import { readCycleState } from './src/cli/utils/cycle-state.mjs';

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
  return { ...base, code: 'unknown', retryable: false };
}

function recordStateBag(runtime) {
  return {
    root: __dirname,
    subject: runtime.subject,
  };
}

async function runSingleStepMode(runtime, step, cycleId) {
  const ctx = await buildCycleContext(__dirname, runtime);
  const recordState = recordStateBag(runtime);
  const cycleState = cycleId ? readCycleState(__dirname, runtime.subject, cycleId) : null;

  switch (step) {
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
      const intelResult = { cycle_id: cycleId, report: cycleState?.meta?.report_path ? { mdPath: cycleState.meta.report_path } : null };
      const outcome = await runIntelReportStep(ctx, { intelResult, recordState });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'intel_report', cycle_id: cycleId, ok: !outcome.failed, intel_report_ready: outcome.intelReportReady })}`);
      if (outcome.failed) throw new Error('intel report step failed');
      return;
    }
    case 'exec': {
      const { execResult } = await runExecStep(ctx, { recordState });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'exec', cycle_id: execResult.cycle_id, ok: true })}`);
      return;
    }
    case 'verify': {
      const intelResult = { cycle_id: cycleId };
      const execResult = { cycle_id: cycleId, executed: [] };
      const { verification, reportPath } = await runVerifyStep(ctx, { intelResult, execResult, recordState });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'verify', cycle_id: cycleId, ok: true, report_path: reportPath })}`);
      return;
    }
    case 'belief_update': {
      const intelResult = { cycle_id: cycleId };
      const execResult = { cycle_id: cycleId };
      const { verification, reportPath } = loadStepArtifacts(runtime.runtimeRoot, cycleId);
      const outcome = await runBeliefUpdateStep(ctx, {
        intelResult, execResult, verification, reportPath, recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'belief_update', cycle_id: cycleId, ok: true, skipped: outcome.skipped })}`);
      return;
    }
    case 'goals_assess': {
      const intelResult = { cycle_id: cycleId };
      const { reportPath } = loadStepArtifacts(runtime.runtimeRoot, cycleId);
      const intelReportReady = cycleState?.meta?.intel_report_ready ?? false;
      const outcome = await runGoalsAssessStep(ctx, {
        intelResult, reportPath, intelReportReady, recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'goals_assess', cycle_id: cycleId, ok: true, skipped: outcome.skipped })}`);
      return;
    }
    case 'goals_calibrate': {
      const intelResult = { cycle_id: cycleId };
      const outcome = await runGoalsCalibrateStep(ctx, {
        intelResult,
        goalsAssessResult: null,
        store: ctx.store,
        recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'goals_calibrate', cycle_id: cycleId, ok: true, skipped: outcome.skipped })}`);
      return;
    }
    case 'diary': {
      const intelResult = { cycle_id: cycleId };
      const execResult = { cycle_id: cycleId };
      const { verification, reportPath } = loadStepArtifacts(runtime.runtimeRoot, cycleId);
      const outcome = await runDiaryStep(ctx, {
        intelResult,
        execResult,
        verification,
        beliefUpdateResult: null,
        goalsAssessResult: null,
        goalsCalibrateResult: null,
        reportPath,
        recordState,
      });
      console.log(`JEA_STEP_RESULT ${JSON.stringify({ step: 'diary', cycle_id: cycleId, ok: !outcome.failed })}`);
      return;
    }
    default:
      throw new Error(`Unknown cycle step: ${step}`);
  }
}

async function runCycle(runtime) {
  const ctx = await buildCycleContext(__dirname, runtime);
  const recordState = recordStateBag(runtime);
  const { store } = ctx;

  console.log('\n=== active subject runtime ===');
  console.log('  subject:', runtime.subject);
  console.log('  namespace:', runtime.dataNamespace);
  console.log('  runtimeRoot:', runtime.runtimeRoot);

  console.log('\n=== Phase 1: intel pipeline ===');
  const intelOutcome = await runIntelStep(ctx, { recordState });
  const intelResult = intelOutcome.intelResult;
  console.log('  success:', intelResult.success);
  console.log('  actions queued:', intelResult.decisions_queued.length);

  console.log('\n=== Phase 1.5: intel report ===');
  const reportOutcome = await runIntelReportStep(ctx, { intelResult, recordState });
  const intelReportReady = reportOutcome.intelReportReady;
  if (reportOutcome.failed) {
    console.warn('  report generation failed (non-fatal)');
  } else {
    console.log('  report ready:', intelReportReady);
  }

  console.log('\n=== Phase 2: exec pipeline ===');
  let execResult;
  try {
    ({ execResult } = await runExecStep(ctx, { recordState }));
    console.log('  success:', execResult.success);
    console.log('  executed:', execResult.executed.length);
  } catch (e) {
    throw e;
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
  return withSubjectLock(__dirname, runtime.subject, run);
}

main().catch((err) => {
  console.error('js-evolution-agent failed:', err?.message || err);
  const record = buildExitRecord(err);
  console.error(`JEA_EXIT_RECORD ${JSON.stringify(record)}`);
  process.exit(1);
});
