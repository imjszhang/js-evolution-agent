#!/usr/bin/env node
/**
 * S8 promotion gate for an isolated JEA_HOME + subject.
 * Exit 0 only when quiet=healthy and no duplicate/self-wake leftovers.
 *
 * Usage: node scripts/reactor-s8-promote-check.mjs --subject NAME [--json]
 */
import { getProjectRoot } from '../src/infra/project.mjs';
import { resolveSubjectFromFlags } from '../src/infra/subjects.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { buildDaemonProjection } from '../src/daemon/daemon-projection.mjs';
import { reconcileEvidenceStream } from '../src/intelligence/evidence-stream.mjs';
import { readWakeStore } from '../src/evolution/reactor/wake-store.mjs';
import { readExecIntents } from '../src/evolution/reactor/exec-intent-store.mjs';
import { listPendingVerifyResults } from '../src/evolution/reactor/exec-result-store.mjs';

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function fingerprint(value) {
  return JSON.stringify(value ?? null);
}

const flags = parseArgs(process.argv);
const root = getProjectRoot();
const subject = flags.subject || resolveSubjectFromFlags(root, {}).name;
const runtime = runtimeForSubject(root, subject);
const projection = buildDaemonProjection(root, subject);
const reconcile = reconcileEvidenceStream(runtime.dataRoot);
const wakes = readWakeStore(runtime.dataRoot);
const intents = readExecIntents(runtime.dataRoot);
const pendingVerify = listPendingVerifyResults(runtime.dataRoot);

const pendingWakes = (wakes.wakes || []).filter((item) => item.status === 'pending');
const wakeKeys = pendingWakes.map((item) => item.merge_key || `${item.kind}:${item.id}`);
const duplicateWakes = wakeKeys.filter((key, index) => wakeKeys.indexOf(key) !== index);

const intentFingerprints = (intents.intents || []).map((item) => fingerprint({
  decision_id: item.decision_id,
  attempt: item.attempt,
  status: item.status,
}));
const duplicateIntents = intentFingerprints.filter((key, index) => intentFingerprints.indexOf(key) !== index);

const reactor = projection.reactor || {};
const checks = [
  {
    id: 'health_ok',
    ok: projection.health?.ok === true,
    detail: projection.health?.status ?? null,
  },
  {
    id: 'reactor_quiet',
    ok: reactor.status === 'idle' || reactor.status === 'healthy',
    detail: reactor.status ?? null,
  },
  {
    id: 'pending_verify_zero',
    ok: (reactor.pending_verify?.count ?? pendingVerify.length) === 0,
    detail: reactor.pending_verify?.count ?? pendingVerify.length,
  },
  {
    id: 'uncertain_zero',
    ok: (reactor.exec_intents?.uncertain ?? 0) === 0,
    detail: reactor.exec_intents?.uncertain ?? 0,
  },
  {
    id: 'reconcile_ok',
    ok: reconcile?.ok === true && (reconcile.contract_error_count ?? 0) === 0,
    detail: reconcile?.contract_error_count ?? null,
  },
  {
    id: 'no_duplicate_wakes',
    ok: duplicateWakes.length === 0,
    detail: duplicateWakes,
  },
  {
    id: 'no_duplicate_intents',
    ok: duplicateIntents.length === 0,
    detail: duplicateIntents,
  },
];

const failed = checks.filter((item) => !item.ok);
const report = {
  generated_at: new Date().toISOString(),
  subject,
  jea_home: runtime.jeaHome ?? null,
  ok: failed.length === 0,
  failed: failed.map((item) => item.id),
  checks,
  health: projection.health,
  reactor: {
    status: reactor.status,
    ok: reactor.ok,
    pending_verify: reactor.pending_verify,
    exec_intents: reactor.exec_intents,
  },
};

const text = JSON.stringify(report, null, 2);
console.log(text);
if (!report.ok) {
  process.exitCode = 1;
}
