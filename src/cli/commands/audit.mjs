import { getProjectRoot } from '../../infra/project.mjs';
import { join } from 'node:path';
import { LocalDecisionQueue } from '../../intelligence/decision-queue.mjs';
import {
  collectValidActionNames,
  findUnknownActions,
  readActiveDecisionQueue,
} from './actions.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import {
  parseCountOption,
  renderEvidenceAuditText,
  runEvidenceAudit,
  summarizeEvidenceAuditForIngest,
} from '../../intelligence/evidence-audit.mjs';
import {
  renderClosureAuditText,
  runClosureAudit,
} from '../../intelligence/closure-audit.mjs';
import {
  evaluateClosureTarget,
  readFrozenClosureTarget,
} from '../../intelligence/closure-target.mjs';

const KNOWN_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'expired',
  'blocked',
  'retired',
];

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

function summarizeBacklogItem(d) {
  const runSpec = d.action?.params?.run_spec ?? d.action?.run_spec ?? {};
  return {
    id: d.id,
    type: d.action?.type ?? 'unknown',
    status: d.status,
    attempts: d.attempts ?? 0,
    max_attempts: d.max_attempts ?? null,
    last_error: d.last_error?.message
      ? String(d.last_error.message).slice(0, 160)
      : (d.error ? String(d.error).slice(0, 160) : null),
    permission_profile: runSpec.permission_profile ?? runSpec.permissionProfile ?? null,
    serves_goal: d.action?.serves_goal ?? null,
    created_at: d.created_at ?? d.timestamp ?? null,
  };
}

export function auditQueue(queue, validActionNames, { staleMinutes = 60, backlogLimit = 10 } = {}) {
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

  const limit = Number.isFinite(Number(backlogLimit)) ? Math.max(0, Math.floor(Number(backlogLimit))) : 10;
  const backlog = {
    pending_count: (byStatus.pending ?? []).length,
    blocked_count: (byStatus.blocked ?? []).length,
    pending: (byStatus.pending ?? []).slice(0, limit).map(summarizeBacklogItem),
    blocked: (byStatus.blocked ?? []).slice(0, limit).map(summarizeBacklogItem),
  };

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
    backlog,
    healthy: unknownActions.length === 0 && staleInProgress.length === 0,
  };
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
  if (audit.backlog) {
    console.log(`# Decision Backlog`);
    console.log(`pending: ${audit.backlog.pending_count}; blocked: ${audit.backlog.blocked_count}`);
    for (const item of audit.backlog.blocked || []) {
      console.log(`  - [blocked] ${item.id}: ${item.type} attempts=${item.attempts}/${item.max_attempts ?? '?'} ${item.last_error || ''}`);
    }
    for (const item of audit.backlog.pending || []) {
      console.log(`  - [pending] ${item.id}: ${item.type} attempts=${item.attempts}/${item.max_attempts ?? '?'}`);
    }
  }
  console.log(audit.healthy ? 'queue healthy' : 'queue needs attention');
}

function parseStatuses(value) {
  if (!value || value === true) return ['completed', 'expired', 'retired', 'failed'];
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

export function archiveQueue(root, { statuses = ['completed', 'expired', 'retired', 'failed'], dryRun = true } = {}) {
  const { runtime } = readActiveDecisionQueue(root);
  const queue = new LocalDecisionQueue({
    dataDir: join(runtime.runtimeRoot, 'data', 'evolution'),
  });
  return {
    runtime,
    ...queue.archiveDecisions({ statuses, dryRun }),
  };
}

function ingestEvidenceAuditObservation(runtime, audit) {
  const store = createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai',
  });
  const { content, audit_summary } = summarizeEvidenceAuditForIngest(audit);
  return store.ingestObservation({
    source: 'evidence_audit',
    kind: 'observation',
    confidence: 'medium',
    subject: runtime.subject,
    tags: ['evidence_audit'],
    content,
    audit_summary,
  });
}

async function auditEvidenceCommand(flags = {}) {
  const root = getProjectRoot();
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);
  const audit = runEvidenceAudit({
    dataRoot: runtime.dataRoot,
    reports: parseCountOption(flags.reports, 5),
    diaries: parseCountOption(flags.diaries, 5),
    events: parseCountOption(flags.events, 200),
    narrative: !flags['no-narrative'],
  });

  let ingested = 0;
  if (flags.ingest) {
    ingested = ingestEvidenceAuditObservation(runtime, audit);
  }

  if (flags.json) {
    console.log(JSON.stringify({
      subject: runtime.subject,
      namespace: runtime.dataNamespace,
      runtime: runtime.runtimeRoot,
      ingested,
      ...audit,
    }, null, 2));
  } else {
    console.log(`subject: ${runtime.subject}`);
    console.log(`namespace: ${runtime.dataNamespace}`);
    console.log(`runtime: ${runtime.runtimeRoot}`);
    process.stdout.write(renderEvidenceAuditText(audit));
    if (flags.ingest) console.log(`ingested observation: ${ingested}`);
  }

  if ((audit.summary?.errors ?? 0) > 0) return 1;
  if (flags.strict && (audit.summary?.warnings ?? 0) > 0) return 1;
  return 0;
}

async function auditClosureCommand(flags = {}) {
  const root = getProjectRoot();
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);
  const audit = runClosureAudit({
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    runtimeRoot: runtime.runtimeRoot,
    dataRoot: runtime.dataRoot,
  });
  const target = readFrozenClosureTarget(root);
  audit.target = {
    path: target.path,
    valid: target.ok,
    reason: target.reason,
    target_id: target.target_id ?? null,
  };
  if (target.ok) {
    audit.gate = evaluateClosureTarget(audit, target.target);
    audit.ok = audit.gate.ok;
    audit.status = audit.gate.status;
  } else {
    audit.ok = false;
    audit.status = 'failed';
    audit.gate = {
      ...audit.gate,
      ok: false,
      status: 'failed',
      failures: [
        ...(audit.gate?.failures ?? []),
        { id: 'frozen_target', actual: target.reason, expected: 'closure_target_valid' },
      ],
    };
  }
  if (flags.json) console.log(JSON.stringify(audit, null, 2));
  else process.stdout.write(renderClosureAuditText(audit));
  return audit.ok ? 0 : 1;
}

async function auditQueueCommand(flags = {}) {
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
  const { runtime, queue } = readActiveDecisionQueue(root, flags);
  const staleMinutes = Number(flags['stale-minutes']) || 60;
  const audit = auditQueue(queue, await collectValidActionNames(root, flags), { staleMinutes });
  if (flags.json) console.log(JSON.stringify({ runtime, ...audit }, null, 2));
  else {
    console.log(`subject: ${runtime.subject}`);
    console.log(`namespace: ${runtime.dataNamespace}`);
    console.log(`runtime: ${runtime.runtimeRoot}`);
    printQueueAudit(audit);
  }
  return audit.healthy ? 0 : 1;
}

export async function auditCommand({ subcommand, flags = {} } = {}) {
  if (subcommand === 'closure') {
    return auditClosureCommand(flags);
  }
  if (subcommand === 'evidence') {
    return auditEvidenceCommand(flags);
  }
  if (subcommand === 'queue') {
    return auditQueueCommand(flags);
  }
  console.error('Usage: jea audit <queue|evidence|closure> [options]');
  console.error('  jea audit queue [--stale-minutes N] [--json] [--archive] [--yes] [--statuses completed,expired]');
  console.error('  jea audit evidence [--subject NAME] [--json] [--strict] [--ingest] [--no-narrative] [--reports N] [--diaries N] [--events N]');
  console.error('  jea audit closure [--subject NAME] [--json]');
  return 2;
}
