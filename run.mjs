#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { runtimeInfoForDefaultSubject } from './src/infra/subjects.mjs';
import { getProjectRoot, loadProjectEnv } from './src/infra/project.mjs';
import {
  assertJeaHomeAuthority,
  createRuntimeContext,
} from './src/infra/jea-home.mjs';
import { withSubjectLock } from './src/daemon/evolve-runs.mjs';
import { createCycle, markStepStatus } from './src/daemon/cycle-state.mjs';
import {
  buildCycleContext,
  runExecStep,
  runReactorStep,
  runVerifyStep,
  skipBeliefUpdateFromEnv,
  skipGoalsAssessFromEnv,
} from './src/evolution/cycle-steps.mjs';
import { settleEvidenceWindow } from './src/evolution/settlement-service.mjs';
import { compactMemory } from './src/evolution/reactor/memory-compactor.mjs';
import { resolveCyclePipeline } from './src/daemon/cycle-pipeline-mode.mjs';

const sourceRoot = getProjectRoot();

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
    root: runtime,
    subject: runtime.subject,
  };
}

function cycleDriverFromEnv() {
  const value = process.env.JEA_CYCLE_DRIVER;
  if (value === 'evolve' || value === 'daemon' || value === 'run') return value;
  return 'run';
}

async function runCycle(runtime) {
  const ctx = await buildCycleContext(sourceRoot, runtime);
  const recordState = recordStateBag(runtime);
  const pipelineResolved = resolveCyclePipeline(runtime, {
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

  console.log('\n=== Cognitive reactor ===');
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

  console.log('\n=== Phase 3: verify receipts ===');
  const { verification, reportPath, semanticVerification } = await runVerifyStep(ctx, {
    intelResult, execResult, recordState,
  });
  console.log('  verified:', verification.verified.length);
  console.log('  semantic:', semanticVerification.status);

  console.log(`\n=== Phase 3.5-4.5: evidence settlement${
    skipBeliefUpdateFromEnv() && skipGoalsAssessFromEnv() ? ' (skipped)' : ''
  } ===`);
  const settlement = await settleEvidenceWindow(ctx, {
    intelResult,
    execResult,
    verification,
    reportPath,
    intelReportReady,
    recordState,
    producer: 'rule',
    activationTargets: ['cognitive'],
  });
  const goalsCalibrateResult = settlement.calibrate?.goalsCalibrateResult ?? null;
  console.log('  settlement:', settlement.settlement_id);
  console.log('  reused:', settlement.reused);
  if (!intelReportReady) console.log('  goals: skipped (intel report unavailable)');
  if (goalsCalibrateResult) console.log('  calibrate status:', goalsCalibrateResult.status);

  console.log('\n=== Memory reactor ===');
  const memory = await compactMemory({
    root: sourceRoot,
    subject: runtime.subject,
    input: { force: true, reason: 'explicit_sync_cycle' },
  });
  console.log('  skipped:', memory.skipped ?? false);
  console.log('  reason:', memory.reason ?? memory.trigger ?? null);
  console.log('  settled cursor:', memory.last_settled_cursor ?? null);
  // cycle-state is a compatibility sidecar, not the reactor live driver.
  // Closing it here does not fabricate a diary artifact; only Memory Reactor
  // may persist an Evolution Diary.
  markStepStatus(recordState.root, runtime.subject, cycleState.cycle_id, 'diary', {
    status: 'done',
    metaPatch: {
      diary_writer: 'memory',
      diary_generated: memory.skipped !== true,
      memory_batch_id: memory.batch_id ?? null,
    },
  });

  console.log('\n=== Done ===');
  console.log(`Evolution data: ${runtime.evolutionDir}`);
  console.log(`Intelligence data: ${runtime.intelligenceDir}`);
}

async function main() {
  process.chdir(sourceRoot);
  loadProjectEnv(sourceRoot);
  const context = createRuntimeContext({ sourceRoot });
  process.env.JEA_PROJECT_ROOT = context.sourceRoot;
  process.env.JEA_HOME = context.jeaHome;
  assertJeaHomeAuthority(context);
  const runtime = runtimeInfoForDefaultSubject(context);
  mkdirSync(runtime.runtimeRoot, { recursive: true });
  if (process.env.JEA_CYCLE_STEP) {
    throw new Error('JEA_CYCLE_STEP was removed in S9. jea run only executes the reactor sync chain.');
  }

  const run = async () => runCycle(runtime);

  if (process.env.JEA_SUBJECT_RUN_LOCK_HELD === '1') {
    return run();
  }
  return withSubjectLock(context, runtime.subject, run, { mode: 'run' });
}

main().catch((err) => {
  console.error('js-evolution-agent failed:', err?.message || err);
  const record = buildExitRecord(err);
  console.error(`JEA_EXIT_RECORD ${JSON.stringify(record)}`);
  process.exit(1);
});
