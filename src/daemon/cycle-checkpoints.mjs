import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStepArtifact } from './cycle-state.mjs';

function loadVerifyReport(runtimeRoot, cycleId) {
  const verifyPath = join(runtimeRoot, 'data', 'evolution', 'verify_reports', `${cycleId}.json`);
  let verification = null;
  if (existsSync(verifyPath)) {
    try {
      verification = JSON.parse(readFileSync(verifyPath, 'utf-8'));
    } catch {
      verification = null;
    }
  }
  return { verification, reportPath: existsSync(verifyPath) ? verifyPath : null };
}

function rebuildIntelResult(cycleId, intelCp, reportCp, agentLoopCp = null, reactorCp = null) {
  const reportFromIntel = intelCp?.report ?? null;
  const reportPath = reportCp?.report_path
    ?? reactorCp?.report_path
    ?? reportFromIntel?.mdPath
    ?? agentLoopCp?.report_path
    ?? null;
  const report = reportFromIntel || (reportPath ? {
    mdPath: reportPath,
    source: reportCp?.source ?? reactorCp?.source ?? null,
    indexRecord: reportCp?.indexRecord ?? {},
  } : null);
  const decisionsQueued = intelCp?.decisions_queued
    ?? reactorCp?.decisions_queued
    ?? agentLoopCp?.decisions_queued
    ?? 0;
  return {
    cycle_id: intelCp?.cycle_id || reactorCp?.cycle_id || cycleId,
    success: intelCp?.success ?? reactorCp?.success ?? true,
    decisions_queued: Array.isArray(decisionsQueued) ? decisionsQueued : Array.from({ length: decisionsQueued }),
    actions: intelCp?.actions ?? [],
    suggestion_coverage: intelCp?.suggestion_coverage
      ?? agentLoopCp?.suggestion_coverage
      ?? null,
    report,
    batch_id: reactorCp?.batch_id ?? null,
    skipped: reactorCp?.skipped ?? false,
  };
}

function rebuildExecResult(cycleId, execCp) {
  if (!execCp) return null;
  return {
    cycle_id: execCp.cycle_id || cycleId,
    success: execCp.success ?? true,
    executed: Array.isArray(execCp.executed) ? execCp.executed : [],
    journal: execCp.journal ?? null,
    error: execCp.error ?? null,
  };
}

/**
 * Reconstruct upstream step outputs from per-step checkpoints for isolated step runs.
 */
export function loadCycleStepContext(root, subject, cycleId, runtimeRoot) {
  const intelCp = readStepArtifact(root, subject, cycleId, 'intel');
  const reportCp = readStepArtifact(root, subject, cycleId, 'intel_report');
  const agentLoopCp = readStepArtifact(root, subject, cycleId, 'agent_loop');
  const reactorCp = readStepArtifact(root, subject, cycleId, 'reactor');
  const execCp = readStepArtifact(root, subject, cycleId, 'exec');
  const beliefCp = readStepArtifact(root, subject, cycleId, 'belief_update');
  const assessCp = readStepArtifact(root, subject, cycleId, 'goals_assess');
  const calibrateCp = readStepArtifact(root, subject, cycleId, 'goals_calibrate');
  const { verification, reportPath } = loadVerifyReport(runtimeRoot, cycleId);

  const intelReportReady = reportCp?.intel_report_ready != null
    ? Boolean(reportCp.intel_report_ready)
    : Boolean(
      (reactorCp?.report_path && existsSync(reactorCp.report_path))
      || (intelCp?.report?.mdPath && existsSync(intelCp.report.mdPath)),
    );

  return {
    intelResult: rebuildIntelResult(cycleId, intelCp, reportCp, agentLoopCp, reactorCp),
    execResult: rebuildExecResult(cycleId, execCp),
    verification,
    reportPath,
    intelReportReady,
    beliefUpdateResult: beliefCp?.beliefUpdateResult ?? null,
    goalsAssessResult: assessCp?.goalsAssessResult ?? null,
    goalsCalibrateResult: calibrateCp?.goalsCalibrateResult ?? null,
  };
}

export function loadVerifyReportForCycle(runtimeRoot, cycleId) {
  return loadVerifyReport(runtimeRoot, cycleId);
}
