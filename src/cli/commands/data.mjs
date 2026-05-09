import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { getProjectRoot } from '../utils/project.mjs';
import { confirm } from '../utils/prompt.mjs';
import {
  countFiles,
  copyProjectDir,
  ensureProjectDir,
  latestFile,
  readTextSafe,
  removeProjectDir,
  writeJsonIfMissing,
} from '../utils/files.mjs';
import { extractMarkdownSection } from './subject.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';

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

export function buildDefaultGoals() {
  return {
    id: 'bootstrap',
    name: 'Bootstrap js-evolution-agent',
    intent: 'Verify the controlled evolution loop, context documents, and intelligence persistence.',
    good_signal: 'Mock and DeepSeek runs complete with verified actions and persisted intelligence.',
    bad_signal: 'The loop cannot load context, queue actions, execute handlers, or write intelligence.',
    children: [
      {
        id: 'safe-runtime',
        name: 'Safe Runtime',
        intent: 'Keep data operations bounded to js-evolution-agent and preserve operator trust.',
        good_signal: 'Data commands only touch data/evolution, data/intelligence, and data/goals.',
        bad_signal: 'Any command attempts to modify engine packages, docs snapshots, or secrets.',
        children: [],
      },
    ],
  };
}

function getSubject(root) {
  const text = readTextSafe(join(root, 'policies', 'project-guidance.md'));
  return extractMarkdownSection(text, 'Subject') || 'js-evolution-agent';
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

export function dataStatus(root) {
  return DATA_DIRS.map((dir) => statusObject(root, dir));
}

export function initData(root, flags = {}) {
  const withGoals = !!(flags.goals || flags.all);
  const withSeed = !!(flags.seed || flags.all);
  const result = {
    directories: DATA_DIRS.map((dir) => ({ dir, ...ensureProjectDir(root, dir) })),
    goals: null,
    seed: null,
  };

  if (withGoals) {
    result.goals = writeJsonIfMissing(
      root,
      join('data', 'goals', 'active_goals.json'),
      buildDefaultGoals(),
      { force: !!flags.force },
    );
  }

  if (withSeed) {
    const store = createIntelligenceStore({
      baseDir: join(root, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const initializedAt = nowIso();
    const subject = getSubject(root);
    const observationCount = store.ingestObservation({
      source: 'jea data init',
      subject: 'js-evolution-agent',
      kind: 'initialization',
      content: `Initialized runtime data for subject: ${subject}`,
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
  const name = String(flags.name || `data-${timestampForPath()}`)
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, '-');
  const destination = join('backups', name);
  const result = copyProjectDir(root, 'data', destination, { force: !!flags.force });
  return {
    ...result,
    name,
    files: existsSync(result.destination) ? countFiles(result.destination) : 0,
  };
}

function printInitResult(result) {
  console.log('Initialized runtime data:');
  for (const dir of result.directories) {
    console.log(`  - ${dir.dir}: ${dir.created ? 'created' : 'exists'}`);
  }
  if (result.goals) {
    const action = result.goals.written
      ? (result.goals.existed ? 'overwritten' : 'created')
      : 'skipped';
    console.log(`  - data/goals/active_goals.json: ${action}`);
  }
  if (result.seed) {
    console.log(`  - seed observations: ${result.seed.observationCount}`);
    console.log(`  - seed events: ${result.seed.eventCount}`);
  }
}

export async function dataCommand({ subcommand, flags = {} } = {}) {
  const root = getProjectRoot();
  if (subcommand === 'status') {
    const status = dataStatus(root);
    if (flags.json) console.log(JSON.stringify({ status }, null, 2));
    else for (const item of status) printDirStatus(root, item.dir);
    return 0;
  }

  if (subcommand === 'init') {
    const result = initData(root, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printInitResult(result);
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
    for (const target of DATA_DIRS) console.log(`  - ${join(root, target)}`);
    if (!flags.yes) {
      const ok = await confirm('This cannot be undone.');
      if (!ok) {
        console.log('Cancelled.');
        return 1;
      }
    }
    let removed = 0;
    for (const target of DATA_DIRS) {
      if (removeProjectDir(root, target)) {
        removed++;
        console.log(`removed: ${join(root, target)}`);
      }
    }
    console.log(`Reset complete. Removed ${removed} director${removed === 1 ? 'y' : 'ies'}.`);
    return 0;
  }

  console.error('Usage: jea data <status|init|backup|reset> [--goals] [--seed] [--all] [--force] [--json] [--yes]');
  return 2;
}

