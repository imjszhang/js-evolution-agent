#!/usr/bin/env node
/**
 * Isolated S0–S9 mock canary. Creates a temporary project root and never
 * reads or writes the three production subject backlogs.
 *
 * Usage:
 *   node scripts/reactor-s0-s9-canary.mjs
 *   npm run reactor:canary
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { enqueueTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { listOpenCycles } from '../src/daemon/cycle-state.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { buildReactorHealthProjection } from '../src/daemon/reactor-health.mjs';
import {
  runCognitiveReactionTask,
  runExecQueueTask,
  runVerifyBatchTask,
  scanWakeBacklog,
} from '../src/evolution/reactor/reactor-tasks.mjs';
import { peekRuleDueWindow, runRuleReaction } from '../src/evolution/reactor/rule-reactor.mjs';
import { compactMemory, readLastCommittedMemoryCheckpoint } from '../src/evolution/reactor/memory-compactor.mjs';
import { listOpenExecIntents, listUncertainExecIntents } from '../src/evolution/reactor/exec-intent-store.mjs';
import { listPendingVerifyResults } from '../src/evolution/reactor/exec-result-store.mjs';
import { readClaimLedger } from '../src/evolution/reactor/claim-ledger.mjs';
import { listBatchCheckpoints } from '../src/evolution/reactor/batch-checkpoint-store.mjs';

const SUBJECT = 'canary';

function fail(assertions, message) {
  assertions.push({ ok: false, message });
}

function pass(assertions, message) {
  assertions.push({ ok: true, message });
}

function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-reactor-canary-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-reactor-canary-home-'));
  process.env.JEA_HOME = jeaHome;
  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(root, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(root, 'policies', 'subjects', `${SUBJECT}.md`), `# ${SUBJECT}\n\n## Subject\n${SUBJECT}`, 'utf-8');
  writeFileSync(join(root, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n\nCanary authority.', 'utf-8');
  writeFileSync(join(root, 'policies', 'authority', 'GUIDE.md'), '# Guide\n\nCanary guide.', 'utf-8');
  writeJsonFile(join(root, 'policies', 'active-subject.json'), {
    active: SUBJECT,
    policy: `subjects/${SUBJECT}.md`,
    data_namespace: SUBJECT,
  });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: SUBJECT,
    subjects: {
      [SUBJECT]: {
        policy: `subjects/${SUBJECT}.md`,
        data_namespace: SUBJECT,
        evolution: { pipeline: 'reactor' },
      },
    },
  });
  initData(root, { subject: SUBJECT });
  return { root, jeaHome };
}

async function main() {
  const previous = {
    JEA_FORCE_MOCK: process.env.JEA_FORCE_MOCK,
    JEA_REACTOR_SKIP_INVESTIGATE: process.env.JEA_REACTOR_SKIP_INVESTIGATE,
    JEA_HOME: process.env.JEA_HOME,
  };
  process.env.JEA_FORCE_MOCK = '1';
  process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';

  const { root, jeaHome } = makeIsolatedRoot();
  const assertions = [];
  try {
    const runtime = runtimeForSubject(root, SUBJECT);
    writePendingOperatorBrief(runtime.runtimeRoot, {
      summary: 'isolated reactor canary brief',
    });
    const scanned = scanWakeBacklog(root, SUBJECT, { enqueueTask });
    const queue = readTaskQueue(root, SUBJECT);
    if (scanned.scanned && queue.tasks.some((task) => task.type === 'cognitive_reaction')) {
      pass(assertions, 'wake scan created cognitive_reaction');
    } else {
      fail(assertions, 'wake scan did not create cognitive_reaction');
    }
    if (listOpenCycles(root, SUBJECT).length === 0) {
      pass(assertions, 'no open cycle after wake scan');
    } else {
      fail(assertions, 'wake scan opened a cycle-state train');
    }

    const cognitive = await runCognitiveReactionTask(root, SUBJECT, {
      skip_investigate: true,
    }, { 'skip-investigate': true });
    if (cognitive.ok && !cognitive.result?.skipped) {
      pass(assertions, `cognitive committed ${cognitive.result?.batch_id || 'batch'}`);
    } else if (cognitive.result?.skipped === true && cognitive.result?.reason === 'no_pending_evidence') {
      pass(assertions, 'cognitive idle with no pending evidence');
    } else {
      fail(assertions, `cognitive failed: ${cognitive.reason || cognitive.result?.reason || 'unknown'}`);
    }

    const exec = await runExecQueueTask(root, SUBJECT, {});
    if (exec.ok) pass(assertions, 'exec queue completed');
    else fail(assertions, `exec failed: ${exec.result?.error || 'unknown'}`);

    const verify = await runVerifyBatchTask(root, SUBJECT, {});
    if (verify.ok) pass(assertions, 'verify batch completed');
    else fail(assertions, 'verify batch failed');

    const rulePeek = peekRuleDueWindow(runtime.dataRoot);
    if (rulePeek.due.length) {
      const rule = await runRuleReaction({ root, subject: SUBJECT, input: { force: true } });
      if (rule?.ok !== false) pass(assertions, 'rule reaction ran');
      else fail(assertions, 'rule reaction failed');
    } else {
      pass(assertions, 'rule window below threshold (expected for tiny canary)');
    }

    for (let i = 0; i < 6; i += 1) {
      const extra = await runCognitiveReactionTask(root, SUBJECT, {
        skip_investigate: true,
      }, { 'skip-investigate': true });
      if (extra.result?.skipped) break;
    }

    const memory = await compactMemory({
      root,
      subject: SUBJECT,
      input: { force: true },
    });
    if (memory?.skipped && memory.reason === 'no_handled_batches') {
      pass(assertions, 'memory skipped with no handled batches');
    } else if (memory?.ok !== false) {
      pass(assertions, 'memory compaction completed');
    } else {
      fail(assertions, 'memory compaction failed');
    }

    const health = buildReactorHealthProjection(root, SUBJECT);
    const pendingVerify = listPendingVerifyResults(runtime.dataRoot);
    const openIntents = listOpenExecIntents(runtime.dataRoot);
    const uncertain = listUncertainExecIntents(runtime.dataRoot);
    const activeClaims = (readClaimLedger(runtime.dataRoot).claims || [])
      .filter((claim) => claim.status === 'claimed');
    const committed = listBatchCheckpoints(runtime.dataRoot, { reactor: 'cognitive' })
      .filter((item) => item.stage === 'committed');
    const memoryCheckpoint = readLastCommittedMemoryCheckpoint(runtime.dataRoot);

    if (activeClaims.length === 0) pass(assertions, 'no active claims');
    else fail(assertions, `active claims remain: ${activeClaims.length}`);
    if (pendingVerify.length === 0) pass(assertions, 'pending verify drained');
    else fail(assertions, `pending verify remains: ${pendingVerify.length}`);
    if (openIntents.length === 0) pass(assertions, 'no open exec intents');
    else fail(assertions, `open intents remain: ${openIntents.length}`);
    if (uncertain.length === 0) pass(assertions, 'no uncertain intents');
    else fail(assertions, `uncertain intents remain: ${uncertain.length}`);
    if (health.ok === true || health.status === 'idle' || health.status === 'healthy') {
      pass(assertions, `health ${health.status}`);
    } else {
      fail(assertions, `health not quiet: ${health.status} ${(health.reasons || []).join('; ')}`);
    }

    const report = {
      ok: assertions.every((item) => item.ok),
      isolated_root: root,
      isolated_jea_home: jeaHome,
      subject: SUBJECT,
      gates: {
        posture: 's9_baked_in',
      },
      cognitive: {
        batch_id: cognitive.result?.batch_id ?? null,
        skipped: cognitive.result?.skipped ?? false,
        decisions_queued: cognitive.result?.decisions_queued?.length ?? 0,
      },
      exec: { execution_id: exec.execution_id ?? null, ok: exec.ok },
      verify: { ok: verify.ok, verified: verify.result?.verified?.length ?? 0 },
      memory: {
        skipped: memory?.skipped ?? false,
        committed: memoryCheckpoint?.stage ?? null,
      },
      committed_cognitive_checkpoints: committed.length,
      health: {
        status: health.status,
        ok: health.ok,
        pending_verify: health.pending_verify,
        exec_intents: health.exec_intents,
      },
      assertions,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    console.log(JSON.stringify({
      ok: false,
      isolated_root: root,
      isolated_jea_home: jeaHome,
      error: err?.stack || err?.message || String(err),
      assertions,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(jeaHome, { recursive: true, force: true });
  }
}

main();
