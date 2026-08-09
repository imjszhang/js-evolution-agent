import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { buildCycleContext } from '../../evolution/cycle-steps.mjs';
import { runCognitiveShadowReaction } from '../../evolution/reactor/cognitive-reactor.mjs';
import {
  reconcileExpiredClaims,
  summarizeClaimLedger,
} from '../../evolution/reactor/claim-ledger.mjs';
import {
  compareShadowAgainstCycle,
  guessLatestTrainCycleId,
} from '../../evolution/reactor/shadow-compare.mjs';
import { readShadowDecisions, readShadowRuns } from '../../evolution/reactor/shadow-store.mjs';
import { shadowDecisionsPath, shadowRunsPath } from '../../evolution/reactor/paths.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

function numberFlag(flags, name, fallback) {
  if (flags[name] == null || flags[name] === true) return fallback;
  const n = Number(flags[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function fileSha256(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function printStatus(runtime, dataRoot) {
  reconcileExpiredClaims(dataRoot);
  const claims = summarizeClaimLedger(dataRoot);
  const runs = readShadowRuns(dataRoot, { limit: 10 });
  const decisions = readShadowDecisions(dataRoot);
  const honesty = runs.filter((r) => r.type === 'shadow_report_honesty');
  console.log('# Reactor shadow status');
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`dataRoot: ${dataRoot}`);
  console.log(`claims: total=${claims.total} claimed=${claims.counts.claimed || 0} handled=${claims.counts.handled || 0} failed=${claims.counts.failed || 0}`);
  console.log(`busy.cognitive: ${claims.busy.cognitive}`);
  console.log(`shadow_decisions: ${decisions.decisions.length}`);
  console.log(`shadow_runs_recent: ${runs.length}`);
  console.log(`honesty_events_recent: ${honesty.length}`);
  console.log('');
  if (!runs.length) {
    console.log('(no shadow runs yet)');
    return;
  }
  console.log('recent runs:');
  for (const run of runs.slice(-8)) {
    console.log(`- [${run.recorded_at}] ${run.type} batch=${run.batch_id || '-'} status=${run.status || '-'}`);
  }
}

export async function reactorCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();

  if (subcommand !== 'shadow') {
    console.error(
      'Usage: jea reactor shadow <run|status|compare> [...]\n'
      + '  jea reactor shadow run [--subject NAME] [--mock] [--limit N] [--skip-investigate] [--json]\n'
      + '  jea reactor shadow status [--subject NAME] [--json]\n'
      + '  jea reactor shadow compare --cycle ID [--subject NAME] [--json]',
    );
    return 2;
  }

  const action = args[0];
  const runtime = runtimeForFlags(root, flags);
  const dataRoot = runtime.dataRoot;

  if (action === 'status') {
    if (flags.json) {
      reconcileExpiredClaims(dataRoot);
      console.log(JSON.stringify({
        runtime: {
          subject: runtime.subject,
          dataNamespace: runtime.dataNamespace,
          dataRoot,
        },
        claims: summarizeClaimLedger(dataRoot),
        shadow_decisions: readShadowDecisions(dataRoot),
        recent_runs: readShadowRuns(dataRoot, { limit: 20 }),
      }, null, 2));
      return 0;
    }
    printStatus(runtime, dataRoot);
    return 0;
  }

  if (action === 'compare') {
    const cycleId = typeof flags.cycle === 'string'
      ? flags.cycle
      : guessLatestTrainCycleId(dataRoot);
    if (!cycleId) {
      console.error('Missing --cycle ID (and no latest report cycle could be guessed)');
      return 2;
    }
    const report = compareShadowAgainstCycle(dataRoot, {
      cycleId,
      batchId: typeof flags.batch === 'string' ? flags.batch : null,
    });
    if (flags.json) {
      console.log(JSON.stringify({ runtime: { subject: runtime.subject, dataRoot }, report }, null, 2));
      return 0;
    }
    console.log('# Reactor shadow compare');
    console.log(`subject: ${runtime.subject}`);
    console.log(`cycle: ${report.cycle_id}`);
    console.log(`train_count: ${report.train_count}`);
    console.log(`shadow_count: ${report.shadow_count}`);
    console.log(`matched: ${report.summary.matched}`);
    console.log(`shadow_only: ${report.summary.shadow_only}`);
    console.log(`train_only: ${report.summary.train_only}`);
    console.log(`coverage: ${report.coverage.toFixed(3)}`);
    return 0;
  }

  if (action === 'run') {
    if (flags.mock) {
      process.env.JEA_FORCE_MOCK = '1';
    }
    const beforePending = fileSha256(join(dataRoot, 'evolution', 'pending_decisions.json'));
    const beforeReports = fileSha256(join(dataRoot, 'intelligence', 'reports', 'index.jsonl'));
    const beforeEvents = fileSha256(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'));

    const ctx = await buildCycleContext(root, runtime);
    const result = await runCognitiveShadowReaction(ctx, {
      batchLimit: numberFlag(flags, 'limit', 16),
      skipInvestigate: Boolean(flags['skip-investigate']),
    });

    const afterPending = fileSha256(join(dataRoot, 'evolution', 'pending_decisions.json'));
    const afterReports = fileSha256(join(dataRoot, 'intelligence', 'reports', 'index.jsonl'));
    const afterEvents = fileSha256(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'));
    const untouched = {
      pending_decisions: beforePending === afterPending,
      reports_index: beforeReports === afterReports,
      evolution_events: beforeEvents === afterEvents,
    };

    if (flags.json) {
      console.log(JSON.stringify({
        runtime: {
          subject: runtime.subject,
          dataNamespace: runtime.dataNamespace,
          dataRoot,
        },
        result,
        untouched,
        shadow_paths: {
          decisions: shadowDecisionsPath(dataRoot),
          runs: shadowRunsPath(dataRoot),
        },
      }, null, 2));
      return result.skipped ? 0 : 0;
    }

    console.log('# Reactor shadow run');
    console.log(`subject: ${runtime.subject}`);
    if (result.skipped) {
      console.log(`skipped: ${result.reason}`);
      return 0;
    }
    console.log(`batch_id: ${result.batch_id}`);
    console.log(`claimed_events: ${result.claimed_events}`);
    console.log(`decisions: ${result.decisions?.length ?? 0}`);
    console.log(`honesty: ${result.honesty?.status} findings=${result.honesty?.findings_count ?? 0}`);
    console.log(`report: ${result.report_path}`);
    console.log(`untouched.pending_decisions: ${untouched.pending_decisions}`);
    console.log(`untouched.reports_index: ${untouched.reports_index}`);
    console.log(`untouched.evolution_events: ${untouched.evolution_events}`);
    return untouched.pending_decisions && untouched.reports_index && untouched.evolution_events
      ? 0
      : 1;
  }

  console.error(
    'Usage: jea reactor shadow <run|status|compare> [...]\n'
    + '  jea reactor shadow run [--subject NAME] [--mock] [--limit N] [--skip-investigate] [--json]\n'
    + '  jea reactor shadow status [--subject NAME] [--json]\n'
    + '  jea reactor shadow compare --cycle ID [--subject NAME] [--json]',
  );
  return 2;
}
