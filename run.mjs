#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvolutionEngine,
  ExecutionPipeline,
  verifyActions,
} from 'js-evolution-engine';
import loadConfig from './oada.config.mjs';
import { assessActiveGoals, autoCalibrateGoals } from './src/cli/commands/goals.mjs';
import { runtimeInfoForDefaultSubject } from './src/cli/utils/subjects.mjs';
import { withSubjectLock } from './src/cli/utils/evolve-runs.mjs';
import { ConversationalIntelligencePipeline } from './src/intelligence/conversational-intel-pipeline.mjs';
import { verifyWithRestoredConversation } from './src/intelligence/conversation-context.mjs';
import { buildEvolutionDiary } from './src/intelligence/evolution-diary-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function skipGoalsAssess() {
  const v = process.env.JEA_SKIP_GOALS_ASSESS;
  if (!v) return false;
  return v === '1' || String(v).toLowerCase() === 'true';
}

function parseExecLimit() {
  const raw = process.env.JEA_EXEC_LIMIT;
  if (raw == null || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > 100) return 100;
  return i;
}

/**
 * Machine-readable exit metadata for evolution supervisors (parsed from stderr).
 * Line format: JEA_EXIT_RECORD {"code":"...","message":"...","retryable":true}
 */
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

function previewDoc(doc) {
  return doc.text.split('\n').slice(0, 2).join(' | ').slice(0, 100);
}

function inspectQueue(runtimeRoot) {
  const queueFile = join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
  if (!existsSync(queueFile)) return [];
  const raw = JSON.parse(readFileSync(queueFile, 'utf-8'));
  return raw.decisions ?? [];
}

async function main() {
  process.chdir(__dirname);
  const runtime = runtimeInfoForDefaultSubject(__dirname);
  mkdirSync(runtime.runtimeRoot, { recursive: true });
  if (process.env.JEA_SUBJECT_RUN_LOCK_HELD === '1') {
    return runCycle(runtime);
  }
  return withSubjectLock(__dirname, runtime.subject, () => runCycle(runtime));
}

async function runCycle(runtime) {
  const cfg = await loadConfig({ cwd: __dirname });
  const store = cfg.host.intelligenceStore;

  console.log('\n=== active subject runtime ===');
  console.log('  subject:', runtime.subject);
  console.log('  namespace:', runtime.dataNamespace);
  console.log('  runtimeRoot:', runtime.runtimeRoot);

  console.log('\n=== agentContextDocs loaded ===');
  for (const doc of cfg.agentContextDocs || []) {
    console.log(`  - ${doc.id} (${doc.source}) :: ${previewDoc(doc)}...`);
  }

  const engine = new EvolutionEngine({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    goalId: 'bootstrap',
    actionRegistry: cfg.actionRegistry,
    agentContextDocs: cfg.agentContextDocs,
  });

  console.log('\n=== Phase 1: intel pipeline ===');
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
  console.log('  success:', intelResult.success);
  console.log('  actions queued:', intelResult.decisions_queued.length);
  store.recordEvolutionEvent({
    type: 'intel_pipeline',
    status: intelResult.success ? 'ok' : 'failed',
    cycle_id: intelResult.cycle_id,
    actions_count: intelResult.actions.length,
    error: intelResult.error,
  });
  if (!intelResult.success) {
    throw new Error(intelResult.error || 'intel pipeline failed');
  }

  console.log('\n=== Phase 1.5: intel report ===');
  let intelReportReady = false;
  try {
    const report = intelResult.report;
    if (!report) {
      throw new Error('conversational intel pipeline did not return a report');
    }
    console.log(`  source: ${report.source}`);
    console.log(`  language: ${report.indexRecord.language}`);
    console.log(`  report: ${report.mdPath}`);
    if (report.indexRecord.tldr) {
      console.log(`  tldr: ${report.indexRecord.tldr.slice(0, 200)}`);
    }
    store.recordEvolutionEvent({
      type: 'intel_report',
      status: 'ok',
      cycle_id: intelResult.cycle_id,
      report_path: report.mdPath,
      source: report.source,
      language: report.indexRecord.language,
    });
    intelReportReady = Boolean(report.mdPath && existsSync(report.mdPath));
    if (!intelReportReady) {
      console.warn('  report path missing on disk after build; goals assess will be skipped.');
    }
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn(`  report generation failed (non-fatal): ${msg}`);
    store.recordEvolutionEvent({
      type: 'intel_report',
      status: 'failed',
      cycle_id: intelResult.cycle_id,
      error: msg,
    });
  }

  console.log('\n=== queued decisions ===');
  for (const decision of inspectQueue(runtime.runtimeRoot)) {
    const action = decision.action || {};
    console.log(`  - ${decision.id}: ${action.type} layer=${action.layer ?? 'n/a'}`);
  }

  console.log('\n=== Phase 2: exec pipeline ===');
  const exec = new ExecutionPipeline({
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    aiClient: cfg.aiClient,
    source: 'queue',
  });
  const execResult = await exec.run({ limit: parseExecLimit() });
  console.log('  success:', execResult.success);
  console.log('  executed:', execResult.executed.length);
  for (const item of execResult.executed) {
    console.log(`  - ${item.action?.type}: ${item.result?.success ? 'OK' : 'FAIL'} ${item.result?.message || item.result?.error || ''}`);
  }
  store.recordEvolutionEvent({
    type: 'exec_pipeline',
    status: execResult.success ? 'ok' : 'failed',
    cycle_id: execResult.cycle_id,
    executed_count: execResult.executed.length,
    error: execResult.error,
  });
  if (!execResult.success) {
    throw new Error(execResult.error || 'exec pipeline failed');
  }

  console.log('\n=== Phase 3: verify receipts ===');
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
  console.log('  verified:', verification.verified.length);
  console.log('  pending:', verification.pending.length);
  console.log('  semantic:', semanticVerification.status);
  console.log('  report:', reportPath);

  let goalsAssessResult = null;
  let goalsCalibrateResult = null;
  if (skipGoalsAssess()) {
    console.log('\n=== Phase 4: goals assess (skipped) ===');
  } else if (!intelReportReady) {
    console.log('\n=== Phase 4: goals assess (skipped) ===');
    console.log('  reason: intel report was not generated for this cycle');
  } else {
    console.log('\n=== Phase 4: goals assess ===');
    try {
      const assessResult = await assessActiveGoals(__dirname, { cycle: intelResult.cycle_id }, {
        verificationReportPath: reportPath,
      });
      goalsAssessResult = assessResult;
      console.log('  cycle:', assessResult.report.cycle_id);
      console.log('  status:', assessResult.assessment.status);
      console.log('  confidence:', assessResult.assessment.confidence);
      console.log('  recorded:', assessResult.written);
      store.recordEvolutionEvent({
        type: 'goals_assess',
        status: 'ok',
        cycle_id: intelResult.cycle_id,
        assessment_status: assessResult.assessment.status,
      });
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`  goals assess failed (non-fatal): ${msg}`);
      store.recordEvolutionEvent({
        type: 'goals_assess',
        status: 'failed',
        cycle_id: intelResult.cycle_id,
        error: msg,
      });
    }
  }

  if (goalsAssessResult) {
    console.log('\n=== Phase 4.5: goals calibrate ===');
    goalsCalibrateResult = autoCalibrateGoals(__dirname, goalsAssessResult);
    console.log('  status:', goalsCalibrateResult.status);
    console.log('  reason:', goalsCalibrateResult.reason);
    if (goalsCalibrateResult.next_goal_id) {
      console.log('  next goal:', goalsCalibrateResult.next_goal_id);
    }
    store.recordEvolutionEvent({
      type: 'goals_calibrate',
      status: goalsCalibrateResult.status,
      cycle_id: intelResult.cycle_id,
      reason: goalsCalibrateResult.reason,
      previous_goal_id: goalsCalibrateResult.previous_goal_id,
      next_goal_id: goalsCalibrateResult.next_goal_id,
      written: goalsCalibrateResult.written,
      active_goals_path: goalsCalibrateResult.active_goals_path,
    });
  }

  console.log('\n=== Phase 5: evolution diary ===');
  try {
    const diary = await buildEvolutionDiary({
      aiClient: cfg.aiClient,
      intelResult,
      execResult,
      verification,
      goalsAssessResult,
      goalsCalibrateResult,
      runtime,
      store,
      agentContextDocs: cfg.agentContextDocs,
      reportPath: intelResult.report?.mdPath,
      verifyReportPath: reportPath,
      logger: cfg.host.logger,
    });
    console.log(`  source: ${diary.source}`);
    console.log(`  diary: ${diary.mdPath}`);
    if (diary.tldr) {
      console.log(`  tldr: ${diary.tldr.slice(0, 200)}`);
    }
  } catch (e) {
    const msg = e?.message || String(e);
    console.warn(`  evolution diary failed (non-fatal): ${msg}`);
    store.recordEvolutionEvent({
      type: 'evolution_diary',
      status: 'failed',
      cycle_id: execResult.cycle_id,
      subject: runtime.subject,
      namespace: runtime.dataNamespace,
      error: msg,
    });
  }

  console.log('\n=== Done ===');
  console.log(`Evolution data: ${runtime.evolutionDir}`);
  console.log(`Intelligence data: ${runtime.intelligenceDir}`);
}

main().catch((err) => {
  console.error('js-evolution-agent failed:', err?.message || err);
  const record = buildExitRecord(err);
  console.error(`JEA_EXIT_RECORD ${JSON.stringify(record)}`);
  process.exit(1);
});

