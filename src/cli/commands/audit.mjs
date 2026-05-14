import { getProjectRoot } from '../utils/project.mjs';
import { join } from 'node:path';
import { LocalDecisionQueue } from '../../intelligence/decision-queue.mjs';
import {
  findUnknownActions,
  readActiveDecisionQueue,
} from './actions.mjs';

const KNOWN_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'expired'];

function parseTime(value) {
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) ? t : null;
}

function decisionTime(decision) {
  return parseTime(decision.updated_at)
    ?? parseTime(decision.claimed_at)
    ?? parseTime(decision.created_at)
    ?? parseTime(decision.timestamp)
    ?? null;
}

export function auditQueue(queue, validActionNames, { staleMinutes = 60 } = {}) {
  const decisions = Array.isArray(queue?.decisions) ? queue.decisions : [];
  const counts = Object.fromEntries(KNOWN_STATUSES.map((s) => [s, 0]));
  const byStatus = {};
  for (const decision of decisions) {
    const status = decision.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    (byStatus[status] ??= []).push(decision);
  }

  const unknownActions = findUnknownActions(decisions, validActionNames);
  const now = Date.now();
  const staleInProgress = (byStatus.in_progress ?? []).filter((d) => {
    const t = decisionTime(d);
    return t == null || now - t > staleMinutes * 60 * 1000;
  }).map((d) => ({
    id: d.id,
    type: d.action?.type ?? 'unknown',
    status: d.status,
    updated_at: d.updated_at ?? d.claimed_at ?? d.created_at ?? null,
  }));

  const oldestPending = (byStatus.pending ?? [])
    .map((d) => ({ decision: d, time: decisionTime(d) }))
    .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity))[0]?.decision ?? null;

  return {
    total: decisions.length,
    counts,
    unknownActions,
    staleInProgress,
    oldestPending: oldestPending ? {
      id: oldestPending.id,
      type: oldestPending.action?.type ?? 'unknown',
      created_at: oldestPending.created_at ?? oldestPending.timestamp ?? null,
    } : null,
    healthy: unknownActions.length === 0 && staleInProgress.length === 0,
  };
}

async function loadValidActionNames() {
  const mod = await import('../../actions/registry.mjs');
  return mod.actionRegistry.validNames();
}

function printQueueAudit(audit) {
  console.log('# Queue Audit');
  console.log(`total: ${audit.total}`);
  for (const [status, count] of Object.entries(audit.counts)) {
    if (count) console.log(`${status}: ${count}`);
  }
  console.log(`unknown action types: ${audit.unknownActions.length}`);
  for (const item of audit.unknownActions) console.log(`  - ${item.id}: ${item.type}`);
  console.log(`stale in_progress: ${audit.staleInProgress.length}`);
  for (const item of audit.staleInProgress) console.log(`  - ${item.id}: ${item.type}`);
  if (audit.oldestPending) {
    console.log(`oldest pending: ${audit.oldestPending.id} (${audit.oldestPending.type})`);
  }
  console.log(audit.healthy ? 'queue healthy' : 'queue needs attention');
}

function parseStatuses(value) {
  if (!value || value === true) return ['completed', 'expired'];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function printArchiveResult(result) {
  console.log(result.dry_run ? '# Queue Archive Dry Run' : '# Queue Archive');
  console.log(`statuses: ${result.statuses.join(', ')}`);
  console.log(`archiveable: ${result.archived.length}`);
  console.log(`retained: ${result.retained}`);
  console.log(`archive path: ${result.archive_path}`);
  for (const item of result.archived) {
    console.log(`  - ${item.id}: ${item.status} ${item.action?.type ?? 'unknown'}`);
  }
}

export function archiveQueue(root, { statuses = ['completed', 'expired'], dryRun = true } = {}) {
  const { runtime } = readActiveDecisionQueue(root);
  const queue = new LocalDecisionQueue({
    dataDir: join(runtime.runtimeRoot, 'data', 'evolution'),
  });
  return {
    runtime,
    ...queue.archiveDecisions({ statuses, dryRun }),
  };
}

export async function auditCommand({ subcommand, flags = {} } = {}) {
  if (subcommand !== 'queue') {
    console.error('Usage: jea audit queue [--stale-minutes N] [--json] [--archive] [--yes] [--statuses completed,expired]');
    return 2;
  }
  const root = getProjectRoot();
  if (flags.archive) {
    const result = archiveQueue(root, {
      statuses: parseStatuses(flags.statuses),
      dryRun: !flags.yes,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`subject: ${result.runtime.subject}`);
      console.log(`namespace: ${result.runtime.dataNamespace}`);
      console.log(`runtime: ${result.runtime.runtimeRoot}`);
      printArchiveResult(result);
      if (result.dry_run) console.log('pass --yes to archive these decisions');
    }
    return 0;
  }
  const { runtime, queue } = readActiveDecisionQueue(root);
  const staleMinutes = Number(flags['stale-minutes']) || 60;
  const audit = auditQueue(queue, await loadValidActionNames(), { staleMinutes });
  if (flags.json) console.log(JSON.stringify({ runtime, ...audit }, null, 2));
  else {
    console.log(`subject: ${runtime.subject}`);
    console.log(`namespace: ${runtime.dataNamespace}`);
    console.log(`runtime: ${runtime.runtimeRoot}`);
    printQueueAudit(audit);
  }
  return audit.healthy ? 0 : 1;
}

