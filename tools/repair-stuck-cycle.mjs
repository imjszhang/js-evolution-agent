#!/usr/bin/env node
/**
 * Repair open cycle with exec:done but missing exec.json checkpoint.
 * Usage: node tools/repair-stuck-cycle.mjs [--cycle ID] [--subject NAME] [--dry-run]
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { getProjectRoot } from '../src/infra/project.mjs';
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';
import { writeStepArtifact, markStepStatus, isStepArtifactComplete } from '../src/daemon/cycle-state.mjs';
import { acknowledgeTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

const DEFAULT_CYCLE = 'cycle-20260531123649-3cca5618';
const DEFAULT_SUBJECT = 'agentank-tank';
const DEFAULT_RECEIPT = 'D:/github/My/agentank-evolver/.worktrees/js-evolution-agent/exec-20260531-204334-t-888b98db-1780231414357/actions/receipts/receipt-exec-20260531-204334-t-888b98db-1780231414357.json';
const EXEC_ID = 'exec-20260531-204334-t-888b98db-1780231414357';
const EXEC_ROOT = 'D:/github/My/agentank-evolver/.worktrees/js-evolution-agent/exec-20260531-204334-t-888b98db-1780231414357';

function parseArgs(argv) {
  const flags = { dryRun: false, cycleId: DEFAULT_CYCLE, subject: DEFAULT_SUBJECT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dry-run') flags.dryRun = true;
    else if (argv[i] === '--cycle') flags.cycleId = argv[++i];
    else if (argv[i] === '--subject') flags.subject = argv[++i];
  }
  return flags;
}

function buildResultFromReceipt(receipt, decision) {
  const summary = receipt.summary ?? receipt.evidence_summary ?? '';
  const runSpec = decision.action?.params?.run_spec;
  return {
    success: true,
    status: 'completed',
    execution_status: 'completed',
    schema_status: 'valid',
    schema_missing: [],
    pipeline_status: 'completed',
    agent_status: 'completed',
    acceptance_status: 'passed',
    goal_progress_status: 'progressed',
    message: summary,
    error: null,
    provider: 'cursor_sdk',
    requires_approval: false,
    execution_root: EXEC_ROOT,
    root_metadata: {
      resource_kind: 'unknown',
      resource_scope: 'lane_worktree',
      execution_root: EXEC_ROOT,
      authoritative_root: EXEC_ROOT,
      root_resolution_source: 'repair_stuck_cycle',
      relative_targets: [],
      root_mismatch: null,
    },
    run_spec: runSpec
      ? {
        primary_cwd: EXEC_ROOT,
        primary_cwd_kind: 'lane_worktree',
        additional_directories: [
          decision.validation?.run_spec?.primary_cwd
            ?? 'D:/github/My/js-evolution-agent/runtime/subjects/agentank-tank',
        ],
        permission_profile: runSpec.permission_profile,
        provider: 'cursor_sdk',
        intent: runSpec.intent,
        expected_output: runSpec.expected_output,
      }
      : null,
    agent: {
      provider: 'cursor_sdk',
      status: 'completed',
      summary,
      action_type: 'agent_run',
      action_id: decision.id,
      served_goal: decision.action?.serves_goal ?? null,
    },
    evidence: receipt.evidence ?? {},
    lane_workspace: null,
  };
}

function withQueueLock(queuePath, fn) {
  if (!existsSync(queuePath)) throw new Error(`Queue not found: ${queuePath}`);
  let release;
  try {
    release = lockfile.lockSync(queuePath, { retries: { retries: 8, minTimeout: 100 } });
  } catch {
    return fn();
  }
  try {
    return fn();
  } finally {
    try { release(); } catch { /* ignore */ }
  }
}

function writeQueueAtomic(queuePath, data) {
  mkdirSync(dirname(queuePath), { recursive: true });
  data.updated_at = new Date().toISOString();
  const tmp = `${queuePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, queuePath);
}

function main() {
  const { dryRun, cycleId, subject } = parseArgs(process.argv);
  const root = getProjectRoot();
  const runtime = runtimeForSubject(root, subject);
  const queuePath = join(runtime.runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
  const decisionId = `${cycleId}:0`;

  if (!existsSync(DEFAULT_RECEIPT)) {
    throw new Error(`Receipt not found: ${DEFAULT_RECEIPT}`);
  }

  const receipt = JSON.parse(readFileSync(DEFAULT_RECEIPT, 'utf-8'));
  const queueData = JSON.parse(readFileSync(queuePath, 'utf-8'));
  const decision = queueData.decisions?.find((d) => d.id === decisionId);
  if (!decision) throw new Error(`Decision ${decisionId} not found`);

  const result = buildResultFromReceipt(receipt, decision);

  console.log(`Repair ${cycleId} (${subject}) dryRun=${dryRun}`);

  if (dryRun) {
    console.log('[dry-run] write exec checkpoint, complete decision, ingest receipt, reset steps, ack verify tasks');
    return;
  }

  copyFileSync(queuePath, `${queuePath}.bak-repair-${Date.now()}`);
  console.log('Backed up pending_decisions.json');

  writeStepArtifact(root, subject, cycleId, 'exec', {
    cycle_id: EXEC_ID,
    intel_cycle_id: cycleId,
    success: true,
    executed: [{ id: decisionId, action: decision.action, result }],
    error: null,
  });
  console.log('Wrote exec.json checkpoint');

  withQueueLock(queuePath, () => {
    const data = JSON.parse(readFileSync(queuePath, 'utf-8'));
    const d = data.decisions.find((item) => item.id === decisionId);
    if (!d) throw new Error(`Decision not found: ${decisionId}`);
    d.status = 'completed';
    d.status_updated_at = new Date().toISOString();
    d.result = result;
    d.error = null;
    writeQueueAtomic(queuePath, data);
  });
  console.log(`Decision completed: ${decisionId}`);

  const store = createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const ingested = store.recordActionReceipt(decision.action, result, {
    cycleId,
    execCycleId: EXEC_ID,
    intelCycleId: cycleId,
    decisionId,
  });
  console.log(`Ingested action receipt: ${ingested?.id ?? 'ok'}`);

  for (const step of ['verify', 'belief_update', 'goals_assess']) {
    markStepStatus(root, subject, cycleId, step, { status: 'pending', error: null });
    console.log(`Reset step ${step} -> pending`);
  }

  const taskQueue = readTaskQueue(root, subject);
  const failedVerify = taskQueue.tasks.filter(
    (t) => t.type === 'verify'
      && t.input?.cycle_id === cycleId
      && t.status === 'failed',
  );
  for (const task of failedVerify) {
    acknowledgeTask(root, subject, task.task_id, 'repair_stuck_cycle');
    console.log(`Acknowledged failed verify task: ${task.task_id}`);
  }

  const execOk = isStepArtifactComplete(root, subject, cycleId, 'exec');
  console.log(`isStepArtifactComplete(exec): ${execOk}`);
  if (!execOk) throw new Error('exec artifact still incomplete after repair');
  console.log('Repair complete.');
}

main();
