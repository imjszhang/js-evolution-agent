#!/usr/bin/env node
/**
 * Phase 3 / M3 kill -9 recovery drill helper.
 *
 * Modes:
 *   simulate  — leave an expired claimed batch, reconcile, assert no hang (no live kill)
 *   live      — spawn `jea run --pipeline reactor --subject NAME`, kill -9 after delay,
 *               reconcile claims, re-run once, print decision/claim invariants
 *
 * Usage:
 *   node scripts/reactor-kill9-drill.mjs simulate --subject js-evolution-agent
 *   node scripts/reactor-kill9-drill.mjs live --subject js-evolution-agent --delay-ms 8000 [--mock]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectRoot } from '../src/infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../src/infra/subjects.mjs';
import {
  readClaimLedger,
  reconcileExpiredClaims,
} from '../src/evolution/reactor/claim-ledger.mjs';
import { claimsPath, reactorDir } from '../src/evolution/reactor/paths.mjs';
import { reconcileEvidenceStream } from '../src/intelligence/evidence-stream.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = getProjectRoot();

function parseArgs(argv) {
  const mode = argv[2] || 'simulate';
  const flags = {};
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { mode, flags };
}

function pendingDecisionsPath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
}

function readPendingFingerprints(runtimeRoot) {
  const path = pendingDecisionsPath(runtimeRoot);
  if (!existsSync(path)) return [];
  const doc = JSON.parse(readFileSync(path, 'utf-8'));
  const decisions = Array.isArray(doc.decisions) ? doc.decisions : [];
  return decisions.map((d) => d.fingerprint || d.id || JSON.stringify(d.action || d));
}

function countDuplicates(list) {
  const seen = new Map();
  for (const item of list) {
    seen.set(item, (seen.get(item) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1);
}

function dataRootFor(runtime) {
  return join(runtime.runtimeRoot, 'data');
}

function simulate(flags) {
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);
  const dataRoot = dataRootFor(runtime);
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  const claimsFile = claimsPath(dataRoot);
  const past = new Date(Date.now() - 60_000).toISOString();
  const now = new Date().toISOString();
  const existing = existsSync(claimsFile)
    ? JSON.parse(readFileSync(claimsFile, 'utf-8'))
    : { claims: [] };
  const ledger = {
    updated_at: now,
    claims: [
      ...(Array.isArray(existing.claims) ? existing.claims.filter((c) => c.batch_id !== 'drill-batch-expired') : []),
      {
        batch_id: 'drill-batch-expired',
        reactor: 'cognitive',
        status: 'claimed',
        claimed_at: past,
        deadline_at: past,
        event_ids: ['evt-drill-1'],
        last_error: null,
      },
    ],
  };
  writeFileSync(claimsFile, JSON.stringify(ledger, null, 2));
  const before = readClaimLedger(dataRoot);
  const expired = reconcileExpiredClaims(dataRoot);
  const after = readClaimLedger(dataRoot);
  const hanging = (after.claims || []).filter((c) => c.status === 'claimed');
  const report = {
    mode: 'simulate',
    subject: runtime.subject,
    claims_path: claimsFile,
    before_claimed: (before.claims || []).filter((c) => c.status === 'claimed').length,
    expired: expired.length,
    after_claimed: hanging.length,
    ok: hanging.length === 0 && expired.length >= 1,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

async function live(flags) {
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);
  const dataRoot = dataRootFor(runtime);
  const delayMs = Math.max(200, Number(flags['delay-ms'] || flags.delayMs || 8000) || 8000);
  const useMock = Boolean(flags.mock);
  const outPath = flags.out || flags['report-path'] || null;
  const fpsBefore = readPendingFingerprints(runtime.runtimeRoot);
  const args = [
    join(root, 'src/cli/jea.mjs'),
    'run',
    '--subject', runtime.subject,
    '--pipeline', 'reactor',
  ];
  if (useMock) args.push('--mock');

  const writeReport = (report) => {
    const text = JSON.stringify(report, null, 2);
    if (outPath) writeFileSync(outPath, text, 'utf-8');
    console.log(text);
  };

  console.error(`[drill] parent_pid=${process.pid} spawning: node ${args.join(' ')} (kill -9 after ${delayMs}ms)`);
  const child = spawn(process.execPath, ['--preserve-symlinks', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += buf.toString(); });
  child.stderr.on('data', (buf) => { stderr += buf.toString(); });
  child.on('error', (err) => {
    console.error(`[drill] spawn error: ${err.message}`);
  });

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (!child.killed && child.exitCode == null && child.signalCode == null) {
    console.error(`[drill] kill -9 pid=${child.pid}`);
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (e) {
      console.error(`[drill] kill failed: ${e.message}`);
    }
  } else {
    console.error(`[drill] child already exited code=${child.exitCode} signal=${child.signalCode}`);
  }
  await new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    child.once('close', resolve);
    setTimeout(resolve, 5000);
  });
  console.error('[drill] child closed; reconciling claims…');

  // Force-expire any still-claimed rows so recovery can proceed (deadline may still be in future).
  const ledgerRaw = readClaimLedger(dataRoot);
  const claimsFile = claimsPath(dataRoot);
  if ((ledgerRaw.claims || []).some((c) => c.status === 'claimed')) {
    const forced = {
      ...ledgerRaw,
      claims: (ledgerRaw.claims || []).map((c) => (
        c.status === 'claimed'
          ? { ...c, deadline_at: new Date(Date.now() - 1000).toISOString() }
          : c
      )),
    };
    writeFileSync(claimsFile, JSON.stringify(forced, null, 2));
  }
  const expired = reconcileExpiredClaims(dataRoot);
  const ledgerAfterKill = readClaimLedger(dataRoot);
  const claimedHang = (ledgerAfterKill.claims || []).filter((c) => c.status === 'claimed');

  console.error('[drill] re-running once to recover…');
  const rerun = spawn(process.execPath, ['--preserve-symlinks', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let rerunOut = '';
  let rerunErr = '';
  rerun.stdout.on('data', (buf) => { rerunOut += buf.toString(); });
  rerun.stderr.on('data', (buf) => { rerunErr += buf.toString(); });
  const rerunCode = await new Promise((resolve) => rerun.once('close', (code) => resolve(code)));

  const fpsAfter = readPendingFingerprints(runtime.runtimeRoot);
  const beforeCounts = new Map();
  for (const fp of fpsBefore) beforeCounts.set(fp, (beforeCounts.get(fp) || 0) + 1);
  const afterCounts = new Map();
  for (const fp of fpsAfter) afterCounts.set(fp, (afterCounts.get(fp) || 0) + 1);
  // Only flag fingerprints whose multiplicity increased after the drill (new dups).
  const newDupGrowth = [...afterCounts.entries()]
    .filter(([fp, n]) => n > (beforeCounts.get(fp) || 0) && n > 1)
    .map(([fp, n]) => [fp, n, beforeCounts.get(fp) || 0]);
  const dups = countDuplicates(fpsAfter);
  const ledgerFinal = readClaimLedger(dataRoot);
  const claimedFinal = (ledgerFinal.claims || []).filter((c) => c.status === 'claimed');
  let reconcileOk = null;
  try {
    const stream = reconcileEvidenceStream(dataRoot);
    const errs = stream?.contract_errors;
    reconcileOk = Array.isArray(errs) ? errs.length === 0 : !(errs > 0);
  } catch (e) {
    reconcileOk = `error: ${e.message}`;
  }

  const report = {
    mode: 'live',
    subject: runtime.subject,
    mock: useMock,
    kill_delay_ms: delayMs,
    expired_after_kill: expired.length,
    claimed_hanging_after_kill: claimedHang.length,
    rerun_exit: rerunCode,
    pending_before: fpsBefore.length,
    pending_after: fpsAfter.length,
    duplicate_fingerprints_all: dups.length,
    duplicate_growth: newDupGrowth,
    claimed_hanging_final: claimedFinal.length,
    evidence_reconcile_ok: reconcileOk,
    ok: newDupGrowth.length === 0 && claimedFinal.length === 0 && reconcileOk === true,
    notes: {
      first_stdout_tail: stdout.slice(-400),
      first_stderr_tail: stderr.slice(-400),
      rerun_stdout_tail: rerunOut.slice(-400),
      rerun_stderr_tail: rerunErr.slice(-400),
    },
  };
  writeReport(report);
  process.exit(report.ok ? 0 : 2);
}

async function main() {
  const { mode, flags } = parseArgs(process.argv);
  if (mode === 'simulate') {
    simulate(flags);
    return;
  }
  if (mode === 'live') {
    await live(flags);
    return;
  }
  console.error('Usage: node scripts/reactor-kill9-drill.mjs <simulate|live> --subject NAME [--mock] [--delay-ms N]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
