#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvolutionEngine,
  ExecutionPipeline,
  IntelligencePipeline,
  verifyActions,
} from 'js-evolution-engine';
import loadConfig from './oada.config.mjs';
import { getActiveSubjectRuntimeInfo } from './src/cli/utils/subjects.mjs';
import { buildIntelReport } from './src/intelligence/report-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const runtime = getActiveSubjectRuntimeInfo(__dirname);
  mkdirSync(runtime.runtimeRoot, { recursive: true });
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
  const intel = new IntelligencePipeline({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    goalId: 'bootstrap',
    mode: 'local',
    engine,
    agentContextDocs: cfg.agentContextDocs,
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

  console.log('\n=== Phase 1.5: build intel report ===');
  try {
    const report = await buildIntelReport({
      intelResult,
      runtime,
      store,
      agentContextDocs: cfg.agentContextDocs,
      aiClient: cfg.aiClient,
      logger: cfg.host?.logger,
      useAi: true,
    });
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
  const execResult = await exec.run({ limit: 5 });
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
    report_path: reportPath,
  });
  console.log('  verified:', verification.verified.length);
  console.log('  pending:', verification.pending.length);
  console.log('  report:', reportPath);

  console.log('\n=== Done ===');
  console.log(`Evolution data: ${runtime.evolutionDir}`);
  console.log(`Intelligence data: ${runtime.intelligenceDir}`);
}

main().catch((err) => {
  console.error('js-evolution-agent failed:', err?.message || err);
  process.exit(1);
});

