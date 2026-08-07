import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { getProjectRoot } from '../../infra/project.mjs';
import { confirm } from '../utils/prompt.mjs';
import {
  countFiles,
  copyProjectDir,
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
  resolveSubjectFromFlags,
  runtimeInfoForSubject,
} from '../../infra/subjects.mjs';
import { getLanguage, t, tObject } from '../../infra/i18n.mjs';

const DATA_DIRS = [
  join('data', 'evolution'),
  join('data', 'intelligence'),
  join('data', 'goals'),
];

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

export function initData(root, flags = {}) {
  const language = flags.language || getLanguage();
  const withGoals = !!(flags.goals || flags.all);
  const withSeed = !!(flags.seed || flags.all);
  const policies = flags.all ? ensureSubjectsRegistry(root, { language }) : null;
  const runtime = runtimeForFlags(root, flags);
  const result = {
    runtime,
    policies,
    directories: DATA_DIRS.map((dir) => ({ dir, ...ensureProjectDir(runtime.runtimeRoot, dir) })),
    goals: null,
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

  if (withSeed) {
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    const initializedAt = nowIso();
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
  const source = relative(root, runtime.runtimeRoot);
  const destination = join('backups', 'subjects', runtime.dataNamespace, name);
  const result = copyProjectDir(root, source, destination, { force: !!flags.force });
  return {
    ...result,
    runtime,
    name,
    files: existsSync(result.destination) ? countFiles(result.destination) : 0,
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

export async function dataCommand({ subcommand, flags = {} } = {}) {
  const root = getProjectRoot();
  const runtime = runtimeForFlags(root, flags);
  if (subcommand === 'status') {
    const status = dataStatus(root, flags);
    if (flags.json) console.log(JSON.stringify({ runtime, status }, null, 2));
    else {
      console.log(`subject: ${runtime.subject}`);
      console.log(`data namespace: ${runtime.dataNamespace}`);
      console.log(`runtime root: ${runtime.runtimeRoot}`);
      for (const item of status) printDirStatus(runtime.runtimeRoot, item.dir);
    }
    return 0;
  }

  if (subcommand === 'init') {
    const result = initData(root, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printInitResult(result, root);
    return 0;
  }

  if (subcommand === 'backup') {
    const result = backupData(root, flags);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.copied) {
      console.log(`Backup created: ${relative(root, result.destination)}`);
      console.log(`files: ${result.files}`);
    } else {
      console.log(`Backup skipped: ${result.reason}`);
      console.log(`destination: ${relative(root, result.destination)}`);
    }
    return result.copied || result.reason === 'destination_exists' ? 0 : 1;
  }

  if (subcommand === 'reset') {
    console.log('Will remove local runtime data:');
    for (const target of DATA_DIRS) console.log(`  - ${join(runtime.runtimeRoot, target)}`);
    if (!flags.yes) {
      const ok = await confirm('This cannot be undone.');
      if (!ok) {
        console.log('Cancelled.');
        return 1;
      }
    }
    let removed = 0;
    for (const target of DATA_DIRS) {
      const relativeTarget = relative(root, join(runtime.runtimeRoot, target));
      if (removeProjectDir(root, relativeTarget)) {
        removed++;
        console.log(`removed: ${join(runtime.runtimeRoot, target)}`);
      }
    }
    console.log(`Reset complete. Removed ${removed} director${removed === 1 ? 'y' : 'ies'}.`);
    return 0;
  }

  console.error('Usage: jea data <status|init|backup|reset> [--subject NAME] [--goals] [--seed] [--all] [--force] [--json] [--yes]');
  return 2;
}

