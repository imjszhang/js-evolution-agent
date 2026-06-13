import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EvolutionEngine,
  ExecutionPipeline,
  verifyActions,
} from '../engine/index.mjs';
import loadConfig from '../../oada.config.mjs'; // project root oada.config.mjs
import { assessActiveGoals, autoCalibrateGoals } from '../domain/cognition/index.mjs';
import { updateActiveBeliefs } from '../intelligence/belief-updater.mjs';
import { ConversationalIntelligencePipeline } from '../intelligence/conversational-intel-pipeline.mjs';
import { verifyWithRestoredConversation } from '../intelligence/conversation-context.mjs';
import { buildEvolutionDiary } from '../intelligence/evolution-diary-builder.mjs';
import { markStepStatus, writeStepArtifact } from '../cli/utils/cycle-state.mjs';
import { loadCycleStepContext, loadVerifyReportForCycle } from '../cli/utils/cycle-checkpoints.mjs';

export { loadCycleStepContext } from '../cli/utils/cycle-checkpoints.mjs';

export function skipGoalsAssessFromEnv() {
  const v = process.env.JEA_SKIP_GOALS_ASSESS;
  if (!v) return false;
  return v === '1' || String(v).toLowerCase() === 'true';
}

export function skipBeliefUpdateFromEnv() {
  const v = process.env.JEA_SKIP_BELIEF_UPDATE;
  if (!v) return false;
  return v === '1' || String(v).toLowerCase() === 'true';
}

export function parseExecLimitFromEnv() {
  const raw = process.env.JEA_EXEC_LIMIT;
  if (raw == null || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > 100) return 100;
  return i;
}

function inspectQueue(runtimeRoot) {
  const queueFile = join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
  if (!existsSync(queueFile)) return [];
  const raw = JSON.parse(readFileSync(queueFile, 'utf-8'));
  return raw.decisions ?? [];
}

export async function buildCycleContext(projectRoot, runtime) {
  const cfg = await loadConfig({ cwd: projectRoot }); // eslint-disable-line -- explicit root
  const engine = new EvolutionEngine({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    goalId: 'bootstrap',
    actionRegistry: cfg.actionRegistry,
    agentContextDocs: cfg.agentContextDocs,
  });
  return { cfg, engine, runtime, store: cfg.host.intelligenceStore, projectRoot };
}

async function recordStepSidecar(root, subject, cycleId, step, status, metaPatch = {}) {
  if (!cycleId || !root || !subject) return;
  try {
    markStepStatus(root, subject, cycleId, step, { status, metaPatch });
  } catch {
    // sidecar must not break step execution
  }
}

function stateCycleId(intelResult, stateCycleId = null, execResult = null) {
  return stateCycleId || intelResult?.cycle_id || execResult?.cycle_id || null;
}

export async function runIntelStep(ctx, { cycleId = null, recordState = null } = {}) {
  const { cfg, engine, runtime, store } = ctx;
  const forcedCycleId = cycleId || process.env.JEA_CYCLE_ID;
  if (forcedCycleId) {
    engine.setCycleId(forcedCycleId);
  }
  const intel = new ConversationalIntelligencePipeline({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    goalId: 'bootstrap',
    mode: 'local',
    engine,
    agentContextDocs: cfg.agentContextDocs,
    actionRegistry: cfg.actionRegistry,
    runtime,
  });
  const intelResult = await intel.run();
  const resolvedCycleId = intelResult.cycle_id;
  store.recordEvolutionEvent({
    type: 'intel_pipeline',
    status: intelResult.success ? 'ok' : 'failed',
    cycle_id: resolvedCycleId,
    actions_count: intelResult.actions.length,
    error: intelResult.error,
  });
  if (!intelResult.success) {
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, resolvedCycleId, 'intel', 'failed', {
        error: intelResult.error,
      });
    }
    throw new Error(intelResult.error || 'intel pipeline failed');
  }
  const metaPatch = { decisions_queued: intelResult.decisions_queued?.length ?? 0 };
  if (recordState) {
    await persistCheckpoint(recordState, resolvedCycleId, 'intel', {
      cycle_id: resolvedCycleId,
      success: true,
      decisions_queued: metaPatch.decisions_queued,
      report: intelResult.report ? {
        mdPath: intelResult.report.mdPath,
        source: intelResult.report.source,
        indexRecord: intelResult.report.indexRecord,
      } : null,
    });
    await recordStepSidecar(recordState.root, recordState.subject, resolvedCycleId, 'intel', 'done', metaPatch);
  }
  return {
    cycleId: resolvedCycleId,
    intelResult,
    eventPayload: { decisions_queued: metaPatch.decisions_queued },
  };
}

export async function runIntelReportStep(ctx, { intelResult, recordState = null } = {}) {
  const { store } = ctx;
  let intelReportReady = false;
  try {
    const report = intelResult.report;
    if (!report) throw new Error('conversational intel pipeline did not return a report');
    store.recordEvolutionEvent({
      type: 'intel_report',
      status: 'ok',
      cycle_id: intelResult.cycle_id,
      report_path: report.mdPath,
      source: report.source,
      language: report.indexRecord.language,
    });
    intelReportReady = Boolean(report.mdPath && existsSync(report.mdPath));
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'intel_report',
      status: 'failed',
      cycle_id: intelResult.cycle_id,
      error: msg,
    });
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'intel_report', 'failed', { error: msg });
    }
    return { intelReportReady: false, failed: true };
  }
  if (recordState) {
    await persistCheckpoint(recordState, intelResult.cycle_id, 'intel_report', {
      cycle_id: intelResult.cycle_id,
      intel_report_ready: intelReportReady,
      report_path: intelResult.report?.mdPath ?? null,
      source: intelResult.report?.source ?? null,
      indexRecord: intelResult.report?.indexRecord ?? null,
    });
    await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'intel_report', 'done', {
      intel_report_ready: intelReportReady,
    });
  }
  return { intelReportReady, eventPayload: { intel_report_ready: intelReportReady } };
}

export async function runExecStep(ctx, { recordState = null, intelResult = null, stateCycleId: stateCycleIdOpt = null } = {}) {
  const { cfg, runtime, store } = ctx;
  const resolvedCycleId = stateCycleId(intelResult, stateCycleIdOpt, null);
  const exec = new ExecutionPipeline({
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    aiClient: cfg.aiClient,
    source: 'queue',
    cycleId: resolvedCycleId || undefined,
  });
  const execResult = await exec.run({
    limit: parseExecLimitFromEnv(),
    cycleId: resolvedCycleId || undefined,
  });
  const artifactCycleId = stateCycleId(intelResult, stateCycleIdOpt, execResult);
  store.recordEvolutionEvent({
    type: 'exec_pipeline',
    status: execResult.success ? 'ok' : 'failed',
    cycle_id: execResult.cycle_id,
    executed_count: execResult.executed.length,
    error: execResult.error,
  });
  if (!execResult.success) {
    if (recordState && artifactCycleId) {
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'exec', 'failed', {
        error: execResult.error,
      });
    }
    throw new Error(execResult.error || 'exec pipeline failed');
  }
  if (recordState && artifactCycleId) {
    await persistCheckpoint(recordState, artifactCycleId, 'exec', {
      cycle_id: execResult.cycle_id,
      intel_cycle_id: intelResult?.cycle_id ?? artifactCycleId,
      success: execResult.success,
      executed: execResult.executed ?? [],
      error: execResult.error ?? null,
    });
    await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'exec', 'done');
  }
  return { execResult };
}

export async function runVerifyStep(ctx, { intelResult, execResult, recordState = null } = {}) {
  const { cfg, runtime, store } = ctx;
  const verification = verifyActions(
    execResult,
    runtime.runtimeRoot,
    cfg.host,
    (msg, level = 'info') => cfg.host.logger?.[level]?.(`[verify] ${msg}`),
  );
  const semanticVerification = await verifyWithRestoredConversation({
    aiClient: cfg.aiClient,
    runtimeRoot: runtime.runtimeRoot,
    cycleId: intelResult.cycle_id,
    execResult,
    mechanicalVerification: verification,
    logger: cfg.host.logger,
  });
  verification.semantic = semanticVerification;
  const reportDir = join(runtime.runtimeRoot, 'data', 'evolution', 'verify_reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${execResult.cycle_id}.json`);
  writeFileSync(reportPath, JSON.stringify(verification, null, 2), 'utf-8');
  store.recordEvolutionEvent({
    type: 'verify_pipeline',
    status: 'ok',
    cycle_id: execResult.cycle_id,
    verified_count: verification.verified.length,
    pending_count: verification.pending.length,
    semantic_status: semanticVerification.status,
    report_path: reportPath,
  });
  if (recordState) {
    const artifactCycleId = stateCycleId(intelResult);
    await persistCheckpoint(recordState, artifactCycleId, 'verify', {
      cycle_id: execResult.cycle_id,
      report_path: reportPath,
      verified_count: verification.verified?.length ?? 0,
      semantic_status: semanticVerification.status,
    });
    await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'verify', 'done');
  }
  return { verification, reportPath, semanticVerification };
}

export async function runBeliefUpdateStep(ctx, {
  intelResult, execResult, verification, reportPath, recordState = null,
} = {}) {
  const { cfg, store } = ctx;
  if (skipBeliefUpdateFromEnv()) {
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'belief_update', 'skipped');
      await persistCheckpoint(recordState, artifactCycleId, 'belief_update', {
        cycle_id: execResult.cycle_id,
        skipped: true,
        beliefUpdateResult: null,
      });
    }
    return { skipped: true, beliefUpdateResult: null };
  }
  try {
    const beliefUpdateResult = await updateActiveBeliefs(ctx.projectRoot, {
      cycleId: execResult.cycle_id,
      intelResult,
      execResult,
      verification,
      verificationReportPath: reportPath,
      store,
      aiClient: cfg.aiClient,
      agentContextDocs: cfg.agentContextDocs,
      logger: cfg.host.logger,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'belief_update', 'done');
      await persistCheckpoint(recordState, artifactCycleId, 'belief_update', {
        cycle_id: execResult.cycle_id,
        skipped: false,
        beliefUpdateResult: {
          source: beliefUpdateResult.source,
          result: beliefUpdateResult.result,
          eventsWritten: beliefUpdateResult.eventsWritten ?? 0,
        },
      });
    }
    return { beliefUpdateResult };
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'belief_update',
      status: 'failed',
      cycle_id: execResult.cycle_id,
      error: msg,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'belief_update', 'failed', { error: msg });
    }
    return { failed: true, error: msg, beliefUpdateResult: null };
  }
}

export async function runGoalsAssessStep(ctx, {
  intelResult, reportPath, intelReportReady, recordState = null,
} = {}) {
  const { store } = ctx;
  if (skipGoalsAssessFromEnv() || !intelReportReady) {
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_assess', 'skipped');
      await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_assess', {
        cycle_id: intelResult.cycle_id,
        skipped: true,
        goalsAssessResult: null,
      });
    }
    return { skipped: true, goalsAssessResult: null };
  }
  try {
    const assessResult = await assessActiveGoals(ctx.projectRoot, { cycle: intelResult.cycle_id }, {
      verificationReportPath: reportPath,
    });
    store.recordEvolutionEvent({
      type: 'goals_assess',
      status: 'ok',
      cycle_id: intelResult.cycle_id,
      assessment_status: assessResult.assessment.status,
    });
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_assess', 'done');
      await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_assess', {
        cycle_id: intelResult.cycle_id,
        skipped: false,
        goalsAssessResult: assessResult,
      });
    }
    return { goalsAssessResult: assessResult };
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'goals_assess',
      status: 'failed',
      cycle_id: intelResult.cycle_id,
      error: msg,
    });
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_assess', 'failed', { error: msg });
    }
    return { failed: true, goalsAssessResult: null };
  }
}

export async function runGoalsCalibrateStep(ctx, { intelResult, goalsAssessResult, store, recordState = null } = {}) {
  if (!goalsAssessResult) {
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_calibrate', 'skipped');
      await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_calibrate', {
        cycle_id: intelResult.cycle_id,
        skipped: true,
        goalsCalibrateResult: null,
      });
    }
    return { skipped: true, goalsCalibrateResult: null };
  }
  const goalsCalibrateResult = autoCalibrateGoals(ctx.projectRoot, goalsAssessResult, { store });
  store.recordEvolutionEvent({
    type: 'goals_calibrate',
    status: goalsCalibrateResult.status,
    cycle_id: intelResult.cycle_id,
    reason: goalsCalibrateResult.reason,
    mode: goalsCalibrateResult.mode ?? null,
    calibrate_mode: goalsCalibrateResult.calibrate_mode ?? null,
    detail: goalsCalibrateResult.detail ?? null,
    warnings: goalsCalibrateResult.warnings ?? [],
    previous_goal_id: goalsCalibrateResult.previous_goal_id,
    next_goal_id: goalsCalibrateResult.next_goal_id,
    written: goalsCalibrateResult.written,
    active_goals_path: goalsCalibrateResult.active_goals_path,
    applied_patches: goalsCalibrateResult.applied_patches ?? [],
    skipped_patches: goalsCalibrateResult.skipped_patches ?? [],
    belief_retirements: goalsCalibrateResult.belief_retirements ?? [],
  });
  if (recordState) {
    await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_calibrate', 'done');
    await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_calibrate', {
      cycle_id: intelResult.cycle_id,
      skipped: false,
      goalsCalibrateResult,
    });
  }
  return { goalsCalibrateResult };
}

export async function runDiaryStep(ctx, {
  intelResult, execResult, verification, beliefUpdateResult,
  goalsAssessResult, goalsCalibrateResult, reportPath, recordState = null,
} = {}) {
  const { cfg, runtime, store } = ctx;
  try {
    const diary = await buildEvolutionDiary({
      aiClient: cfg.aiClient,
      intelResult,
      execResult,
      verification,
      beliefUpdateResult,
      goalsAssessResult,
      goalsCalibrateResult,
      runtime,
      store,
      agentContextDocs: cfg.agentContextDocs,
      reportPath: intelResult.report?.mdPath,
      verifyReportPath: reportPath,
      logger: cfg.host.logger,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'diary', 'done');
      await persistCheckpoint(recordState, artifactCycleId, 'diary', {
        cycle_id: execResult?.cycle_id || intelResult.cycle_id,
        mdPath: diary.mdPath ?? null,
        source: diary.source ?? null,
        tldr: diary.tldr ?? null,
      });
    }
    return { diary };
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'evolution_diary',
      status: 'failed',
      cycle_id: execResult?.cycle_id || intelResult?.cycle_id,
      subject: runtime.subject,
      namespace: runtime.dataNamespace,
      error: msg,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'diary', 'failed', { error: msg });
    }
    return { failed: true, error: msg };
  }
}

const REQUIRED_CHECKPOINT_STEPS = new Set(['intel', 'intel_report', 'exec', 'verify']);

async function persistCheckpoint(recordState, cycleId, step, payload, { required } = {}) {
  if (!recordState?.root || !recordState?.subject || !cycleId) return;
  const mustPersist = required ?? REQUIRED_CHECKPOINT_STEPS.has(step);
  try {
    writeStepArtifact(recordState.root, recordState.subject, cycleId, step, payload);
  } catch (err) {
    if (mustPersist) {
      throw new Error(`checkpoint write failed for ${step} (cycle=${cycleId}): ${err?.message || err}`);
    }
  }
}

function loadVerifyReport(runtimeRoot, cycleId) {
  return loadVerifyReportForCycle(runtimeRoot, cycleId);
}

/**
 * @deprecated use loadCycleStepContext
 */
export function loadStepArtifacts(runtimeRoot, cycleId) {
  const { verification, reportPath } = loadVerifyReport(runtimeRoot, cycleId);
  return { verification, reportPath };
}

export const CYCLE_STEP_RUNNERS = Object.freeze([
  'intel',
  'intel_report',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary',
]);
