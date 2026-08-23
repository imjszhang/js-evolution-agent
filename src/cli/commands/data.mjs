import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { getProjectRoot } from '../../infra/project.mjs';
import { migrateJeaHome } from '../../infra/jea-home-migration.mjs';
import { confirm } from '../utils/prompt.mjs';
import {
  countFiles,
  copyDirBetweenRoots,
  ensureProjectDir,
  latestFile,
  removeProjectDir,
  writeJsonIfMissing,
} from '../../infra/files.mjs';
import { extractMarkdownSection } from './subject.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import {
  ensureSubjectsRegistry,
  readSubjectPolicy,
  resolveSubjectRepoLane,
  resolveSubjectFromFlags,
  runtimeInfoForSubject,
} from '../../infra/subjects.mjs';
import { getLanguage, t, tObject } from '../../infra/i18n.mjs';
import { readJson } from '../../infra/json-store.mjs';
import { runtimeMaintenanceStatePath } from '../../daemon/runtime-maintenance.mjs';
import {
  claimsArchivePath,
  claimsCoveredIndexPath,
  claimsTerminalArchivePath,
  rebuildClaimArchiveSummary,
  reconcileTerminalClaimStorage,
  terminalClaimArchiveStats,
} from '../../evolution/reactor/claim-ledger.mjs';
import { evidenceIndexPath } from '../../evolution/reactor/evidence-index.mjs';
import {
  inspectClaimLedgerMigration,
  inspectLegacyClaimArchiveMigration,
  migrateClaimLedger,
  migrateLegacyClaimArchive,
} from '../../evolution/reactor/claim-ledger-migration.mjs';
import { channelEventArchivePath } from '../../channel/event-queue.mjs';
import { channelEventQueuePath } from '../../channel/paths.mjs';

const DATA_DIRS = [
  join('data', 'evolution'),
  join('data', 'intelligence'),
  join('data', 'goals'),
];
const RESET_DIRS = ['data'];

function nowIso() {
  return new Date().toISOString();
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function buildDefaultGoals(language = getLanguage()) {
  return tObject('data.defaultGoals', language);
}

function getSubject(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  const { text, config: subjectConfig } = readSubjectPolicy(root, config);
  return extractMarkdownSection(text, 'Subject') || subjectConfig.name || 'js-evolution-agent';
}

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

function statusObject(root, relativeDir) {
  const full = join(root, relativeDir);
  const latest = latestFile(full);
  return {
    dir: relativeDir,
    exists: existsSync(full),
    files: countFiles(full),
    latest: latest ? relative(root, latest.path) : null,
  };
}

function printDirStatus(root, relativeDir) {
  const status = statusObject(root, relativeDir);
  console.log(`${status.dir}:`);
  console.log(`  exists: ${status.exists}`);
  console.log(`  files: ${status.files}`);
  console.log(`  latest: ${status.latest ?? 'none'}`);
}

export function dataStatus(root, flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  return DATA_DIRS.map((dir) => statusObject(runtime.runtimeRoot, dir));
}

function collectionState(path, collection) {
  const value = readJson(path, null);
  const rows = Array.isArray(value?.[collection]) ? value[collection] : [];
  return {
    path,
    exists: existsSync(path),
    count: rows.length,
    updated_at: value?.updated_at ?? null,
  };
}

function claimHotState(dataRoot) {
  try {
    const state = inspectClaimLedgerMigration(dataRoot);
    return {
      path: state.source_path,
      exists: state.exists,
      count: state.claims,
      bytes: state.source_bytes,
      migration_reduction_bytes: state.estimated_reduction_bytes ?? 0,
      terminal_indexed_entries: state.terminal_indexed_entries_removed ?? 0,
      status: 'ok',
    };
  } catch (error) {
    const path = join(dataRoot, 'evolution', 'reactor', 'claims.json');
    return {
      path,
      exists: existsSync(path),
      count: null,
      bytes: null,
      migration_reduction_bytes: null,
      terminal_indexed_entries: null,
      status: 'corrupt',
      error: error?.message || String(error),
    };
  }
}

function maintenanceNextDueAt(state) {
  const completed = Date.parse(state?.completed_at ?? '');
  const interval = Number(state?.interval_ms);
  if (!Number.isFinite(completed) || !Number.isFinite(interval)) return null;
  return new Date(completed + interval).toISOString();
}

export function runtimeMaintenanceStatus(root, flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const dataRoot = runtime.dataRoot;
  const maintenancePath = runtimeMaintenanceStatePath(dataRoot);
  const maintenance = readJson(maintenancePath, null);
  const evidenceIndex = readJson(evidenceIndexPath(dataRoot), null);
  const evidenceSources = Object.values(evidenceIndex?.sources ?? {});
  const evidenceFiles = evidenceSources.flatMap((source) => Object.values(source?.files ?? {}));
  const daemonTasks = join(dataRoot, 'evolution', 'tasks');
  const channelTasks = join(dataRoot, 'channel', 'tasks');
  const terminalClaimStats = terminalClaimArchiveStats(dataRoot);
  return {
    schema_version: 'runtime-maintenance-status.v1',
    maintenance: {
      path: maintenancePath,
      exists: existsSync(maintenancePath),
      status: maintenance?.status ?? 'never_run',
      completed_at: maintenance?.completed_at ?? null,
      interval_ms: maintenance?.interval_ms ?? null,
      next_due_at: maintenanceNextDueAt(maintenance),
      errors: maintenance?.errors ?? {},
    },
    reactor: {
      claims: {
        hot: claimHotState(dataRoot),
        archive: {
          path: claimsTerminalArchivePath(dataRoot),
          exists: existsSync(claimsTerminalArchivePath(dataRoot)),
          count: terminalClaimStats.lines,
          invalid: terminalClaimStats.invalid,
          bytes: terminalClaimStats.bytes,
          legacy: collectionState(claimsArchivePath(dataRoot), 'claims'),
        },
        covered_index: {
          path: claimsCoveredIndexPath(dataRoot),
          exists: existsSync(claimsCoveredIndexPath(dataRoot)),
        },
      },
      evidence_index: {
        path: evidenceIndexPath(dataRoot),
        exists: existsSync(evidenceIndexPath(dataRoot)),
        schema_version: evidenceIndex?.schema_version ?? null,
        updated_at: evidenceIndex?.updated_at ?? null,
        sources: evidenceSources.length,
        files: evidenceFiles.length,
        indexed_entries: evidenceFiles.reduce(
          (sum, file) => sum + (Array.isArray(file?.entries) ? file.entries.length : 0),
          0,
        ),
      },
      tasks: {
        hot: collectionState(join(daemonTasks, 'pending_tasks.json'), 'tasks'),
        archive: collectionState(join(daemonTasks, 'archive', 'terminal_tasks.json'), 'tasks'),
      },
    },
    channel: {
      tasks: {
        hot: collectionState(join(channelTasks, 'pending_tasks.json'), 'tasks'),
        archive: collectionState(join(channelTasks, 'archive', 'terminal_tasks.json'), 'tasks'),
      },
      events: {
        hot: collectionState(channelEventQueuePath(root, runtime.subject), 'events'),
        archive: collectionState(channelEventArchivePath(root, runtime.subject), 'events'),
      },
    },
  };
}

export function initData(root, flags = {}) {
  const language = flags.language || getLanguage();
  const withGoals = !!(flags.goals || flags.all);
  const withSeed = !!(flags.seed || flags.all);
  const policies = flags.all ? ensureSubjectsRegistry(root, { language }) : null;
  const runtime = runtimeForFlags(root, flags);
  const initializedAt = nowIso();
  const result = {
    runtime,
    policies,
    directories: DATA_DIRS.map((dir) => ({ dir, ...ensureProjectDir(runtime.runtimeRoot, dir) })),
    goals: null,
    requiredSources: null,
    seed: null,
  };

  if (withGoals) {
    result.goals = writeJsonIfMissing(
      runtime.runtimeRoot,
      join('data', 'goals', 'active_goals.json'),
      buildDefaultGoals(language),
      { force: !!flags.force },
    );
  }

  if (flags.all) {
    result.requiredSources = {
      standingMemory: writeJsonIfMissing(
        runtime.runtimeRoot,
        join('data', 'intelligence', 'memory', 'standing_memory.json'),
        {
          schema_version: 1,
          source: 'jea data init',
          source_cycle_id: null,
          generated_at: initializedAt,
          updated_at: initializedAt,
          char_limit: 12_000,
          text: '',
          evidence_refs: [],
          typed_evidence_refs: [],
          last_settled_cursor: null,
          freshness: {
            status: 'empty',
            settled_through: null,
            consolidated_at: initializedAt,
            pending_settled_count: 0,
          },
        },
      ),
      daemonTasks: writeJsonIfMissing(
        runtime.runtimeRoot,
        join('data', 'evolution', 'tasks', 'pending_tasks.json'),
        {
          schema_version: 1,
          tasks: [],
          updated_at: initializedAt,
        },
      ),
    };
  }

  if (withSeed) {
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    const subject = getSubject(root, flags);
    const observationCount = store.ingestObservation({
      source: 'jea data init',
      subject: 'js-evolution-agent',
      kind: 'initialization',
      content: t('data.init.seedContent', { subject }, language),
      confidence: 'high',
      tags: ['init', 'bootstrap'],
      initialized_at: initializedAt,
    });
    const eventCount = store.recordEvolutionEvent({
      type: 'data_initialized',
      status: 'ok',
      subject,
      initialized_at: initializedAt,
      project: 'js-evolution-agent',
    });
    result.seed = { observationCount, eventCount, initializedAt };
  }

  return result;
}

export function backupData(root, flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const name = String(flags.name || `data-${timestampForPath()}`)
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, '-');
  const destination = join('backups', 'subjects', runtime.dataNamespace, name);
  const result = copyDirBetweenRoots(
    runtime.runtimeRoot,
    '.',
    runtime.jeaHome,
    destination,
    { force: !!flags.force },
  );
  return {
    ...result,
    runtime,
    name,
    files: existsSync(result.destination) ? countFiles(result.destination) : 0,
  };
}

export function resetData(root, flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const removed = [];
  for (const target of RESET_DIRS) {
    if (removeProjectDir(runtime.runtimeRoot, target)) {
      removed.push(join(runtime.runtimeRoot, target));
    }
  }
  return {
    runtime,
    targets: RESET_DIRS.map((target) => join(runtime.runtimeRoot, target)),
    removed,
  };
}

function printInitResult(result, root, language = getLanguage()) {
  console.log(t('data.init.heading', {}, language));
  console.log(`  ${t('data.init.subject', {}, language)}: ${result.runtime.subject}`);
  console.log(`  ${t('data.init.namespace', {}, language)}: ${result.runtime.dataNamespace}`);
  console.log(`  ${t('data.init.runtime', {}, language)}: ${result.runtime.runtimeRoot}`);
  if (result.policies) {
    const { registry, subject } = result.policies;
    const registryLabel = registry?.registryWritten
      ? t('data.init.created', {}, language)
      : t('data.init.exists', {}, language);
    const subjectLabel = subject?.written
      ? t('data.init.created', {}, language)
      : t('data.init.exists', {}, language);
    const policyRel = relative(root, subject.file);
    console.log(`  ${t('data.init.policies', {}, language)}:`);
    console.log(`    - ${relative(root, registry.path)}: ${registryLabel}`);
    console.log(`    - ${policyRel}: ${subjectLabel}`);
  }
  for (const dir of result.directories) {
    const label = dir.created
      ? t('data.init.created', {}, language)
      : t('data.init.exists', {}, language);
    console.log(`  - ${dir.dir}: ${label}`);
  }
  if (result.goals) {
    const action = result.goals.written
      ? (result.goals.existed
        ? t('data.init.overwritten', {}, language)
        : t('data.init.created', {}, language))
      : t('data.init.skipped', {}, language);
    console.log(`  - data/goals/active_goals.json: ${action}`);
  }
  if (result.seed) {
    console.log(`  - ${t('data.init.seedObservations', {}, language)}: ${result.seed.observationCount}`);
    console.log(`  - ${t('data.init.seedEvents', {}, language)}: ${result.seed.eventCount}`);
  }
}

export async function dataCommand({ subcommand, flags = {}, context = null } = {}) {
  const root = context ?? getProjectRoot();
  if (subcommand === 'migrate-home') {
    if (!flags['dry-run'] && !flags.yes) {
      console.log('Will copy legacy Subject data into JEA Home after verifying all files.');
      const ok = await confirm('Daemons must be stopped. The legacy directory will be preserved.');
      if (!ok) {
        console.log('Cancelled.');
        return 1;
      }
    }
    try {
      const result = await migrateJeaHome(root, { dryRun: !!flags['dry-run'] });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`JEA Home migration: ${result.status}`);
        console.log(`source: ${result.source_subjects_root}`);
        console.log(`target: ${result.target_subjects_root}`);
        if (result.source) {
          console.log(`files: ${result.source.files}`);
          console.log(`bytes: ${result.source.bytes}`);
          console.log(`sha256: ${result.source.digest}`);
        }
        if (result.legacy_preserved) console.log('Legacy source preserved: yes');
      }
      return 0;
    } catch (error) {
      const payload = {
        ok: false,
        code: error?.code ?? 'migration_failed',
        error: error?.message || String(error),
        details: error?.details ?? null,
      };
      if (flags.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.error(`${payload.code}: ${payload.error}`);
        if (payload.details) console.error(JSON.stringify(payload.details, null, 2));
      }
      return 1;
    }
  }
  const runtime = runtimeForFlags(root, flags);
  if (subcommand === 'migrate-claims') {
    const dryRun = !!flags['dry-run'];
    if (!dryRun && !flags.yes) {
      console.log('Will rewrite the claim ledger atomically and preserve a backup.');
      const ok = await confirm('Cycle and Channel daemons must be stopped.');
      if (!ok) {
        console.log('Cancelled.');
        return 1;
      }
    }
    try {
      const hot = dryRun
        ? inspectClaimLedgerMigration(runtime.dataRoot)
        : migrateClaimLedger(runtime.dataRoot, { dryRun: false });
      const hotReconcile = dryRun
        ? null
        : reconcileTerminalClaimStorage(runtime.dataRoot, { requeue: false });
      const archive = dryRun
        ? inspectLegacyClaimArchiveMigration(runtime.dataRoot)
        : migrateLegacyClaimArchive(runtime.dataRoot, { dryRun: false });
      const archiveSummary = dryRun ? null : rebuildClaimArchiveSummary(runtime.dataRoot);
      const payload = {
        ...hot,
        hot_reconcile: hotReconcile,
        archive_migration: archive,
        archive_summary: archiveSummary,
        dry_run: dryRun,
        subject: runtime.subject,
      };
      if (flags.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`Claim ledger migration: ${dryRun ? 'dry-run' : (payload.migrated ? 'completed' : 'not-needed')}`);
        console.log(`source: ${payload.source_path}`);
        console.log(`claims: ${payload.claims}`);
        console.log(`bytes before/after: ${payload.source_bytes}/${payload.projected_bytes}`);
        console.log(`terminal indexed entries removed: ${payload.terminal_indexed_entries_removed}`);
        console.log(`legacy archive claims: ${payload.archive_migration.claims ?? 0}`);
        if (payload.backup_path) console.log(`backup: ${payload.backup_path}`);
      }
      return 0;
    } catch (error) {
      const payload = {
        ok: false,
        code: error?.code ?? 'claim_ledger_migration_failed',
        error: error?.message || String(error),
        details: error?.details ?? null,
      };
      if (flags.json) console.log(JSON.stringify(payload, null, 2));
      else console.error(`${payload.code}: ${payload.error}`);
      return 1;
    }
  }
  if (subcommand === 'status') {
    const status = dataStatus(root, flags);
    const maintenance = runtimeMaintenanceStatus(root, flags);
    const policy = readSubjectPolicy(root, runtime.config);
    const repoLane = resolveSubjectRepoLane(policy.text, {
      root: runtime.sourceRoot,
      subject: runtime.subject,
      config: runtime.config,
    });
    const paths = {
      source_root: runtime.sourceRoot,
      jea_home: runtime.jeaHome,
      jea_home_source: runtime.jeaHomeSource,
      subject_runtime_root: runtime.runtimeRoot,
      execution_root: repoLane.repoRoot ?? null,
    };
    if (flags.json) console.log(JSON.stringify({ runtime, paths, status, maintenance }, null, 2));
    else {
      console.log(`subject: ${runtime.subject}`);
      console.log(`data namespace: ${runtime.dataNamespace}`);
      console.log(`source root: ${paths.source_root}`);
      console.log(`JEA Home: ${paths.jea_home} (${paths.jea_home_source})`);
      console.log(`runtime root: ${runtime.runtimeRoot}`);
      console.log(`execution root: ${paths.execution_root ?? 'not configured'}`);
      for (const item of status) printDirStatus(runtime.runtimeRoot, item.dir);
      console.log(`maintenance: ${maintenance.maintenance.status}`);
      console.log(`reactor claims hot/archive: ${maintenance.reactor.claims.hot.count}/${maintenance.reactor.claims.archive.count}`);
      console.log(`reactor evidence index: ${maintenance.reactor.evidence_index.indexed_entries} entries`);
      console.log(`channel tasks hot/archive: ${maintenance.channel.tasks.hot.count}/${maintenance.channel.tasks.archive.count}`);
      console.log(`channel events hot/archive: ${maintenance.channel.events.hot.count}/${maintenance.channel.events.archive.count}`);
    }
    return 0;
  }

  if (subcommand === 'init') {
    const result = initData(root, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printInitResult(result, runtime.sourceRoot);
    return 0;
  }

  if (subcommand === 'backup') {
    const result = backupData(root, flags);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.copied) {
      console.log(`Backup created: ${result.destination}`);
      console.log(`files: ${result.files}`);
    } else {
      console.log(`Backup skipped: ${result.reason}`);
      console.log(`destination: ${result.destination}`);
    }
    return result.copied || result.reason === 'destination_exists' ? 0 : 1;
  }

  if (subcommand === 'reset') {
    console.log('Will remove all local runtime data for this subject (including reactor, daemon, and channel sidecars):');
    for (const target of RESET_DIRS) console.log(`  - ${join(runtime.runtimeRoot, target)}`);
    console.log(`Will preserve subject policy and configuration under: ${runtime.runtimeRoot}`);
    if (!flags.yes) {
      const ok = await confirm('This cannot be undone.');
      if (!ok) {
        console.log('Cancelled.');
        return 1;
      }
    }
    const result = resetData(root, flags);
    for (const target of result.removed) console.log(`removed: ${target}`);
    const removed = result.removed.length;
    console.log(`Reset complete. Removed ${removed} director${removed === 1 ? 'y' : 'ies'}.`);
    return 0;
  }

  console.error('Usage: jea data <status|init|backup|reset|migrate-home|migrate-claims> [--subject NAME] [--goals] [--seed] [--all] [--force] [--dry-run] [--json] [--yes]');
  return 2;
}

