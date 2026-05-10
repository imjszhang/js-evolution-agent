import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { getProjectRoot } from '../utils/project.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';
import { runIntelIngest } from './intel-ingest.mjs';
import { inboxDrain, inboxPut } from './intel-inbox.mjs';

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeStore(runtime) {
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

export function buildIntelSummary(root, flags = {}) {
  const runtime = getActiveSubjectRuntimeInfo(root);
  const days = numberFlag(flags, 'days', 7);
  const limit = numberFlag(flags, 'limit', 8);
  const store = makeStore(runtime);
  const observations = store.readRecentIntel({ days, limit });
  const events = store.readEvolutionEvents({ limit });
  const retrospectives = store.readRetrospectives({ limit });
  const latestReview = store.readLatestReview();
  return {
    runtime,
    days,
    limit,
    observations,
    events,
    retrospectives,
    latestReview,
    contextSummary: store.buildContextSummary(),
  };
}

function printIntelSummary(summary) {
  console.log(`# Intelligence Summary (${summary.days}d, limit ${summary.limit})`);
  console.log(`subject: ${summary.runtime.subject}`);
  console.log(`namespace: ${summary.runtime.dataNamespace}`);
  console.log(`runtime: ${summary.runtime.runtimeRoot}`);
  console.log('');
  console.log(summary.contextSummary);
  console.log('');
  console.log(`Retrospectives: ${summary.retrospectives.length}`);
  if (summary.latestReview) {
    console.log(`Latest review: ${summary.latestReview.summary ?? summary.latestReview.outcome ?? 'available'}`);
  }
}

export function findReportRecord(root, flags = {}) {
  const runtime = getActiveSubjectRuntimeInfo(root);
  const store = makeStore(runtime);
  const limit = numberFlag(flags, 'limit', 20);
  const records = store.readIntelReports({ limit: Math.max(limit, 50) });
  if (!records.length) return { runtime, record: null, records: [] };
  if (flags.cycle) {
    const target = String(flags.cycle);
    const record = records.find((r) => r.cycle_id === target) ?? null;
    return { runtime, record, records };
  }
  const sorted = [...records].sort((a, b) => {
    const at = a.generated_at || a.timestamp || '';
    const bt = b.generated_at || b.timestamp || '';
    return bt.localeCompare(at);
  });
  return { runtime, record: sorted[0], records: sorted };
}

function openInDefaultApp(filePath) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    cmd = 'xdg-open';
    args = [filePath];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function printReportList(records, limit) {
  if (!records.length) {
    console.log('(no intel reports found)');
    return;
  }
  console.log(`# Intel Reports (showing ${Math.min(records.length, limit)} of ${records.length})`);
  for (const r of records.slice(0, limit)) {
    const when = r.generated_at || r.timestamp || '?';
    const lang = r.language ?? '?';
    console.log(`- ${r.cycle_id}  [${when}]  source=${r.source ?? '?'}  lang=${lang}  actions=${r.action_count ?? r.finding_count ?? 0}`);
    if (r.tldr) console.log(`    ${r.tldr}`);
  }
}

export async function intelReportCommand(root, flags = {}, args = []) {
  const sub = args[0];

  if (sub === 'list') {
    const limit = numberFlag(flags, 'limit', 10);
    const { runtime, records } = findReportRecord(root, { limit });
    if (flags.json) {
      console.log(JSON.stringify({ runtime, records: records.slice(0, limit) }, null, 2));
    } else {
      console.log(`active subject: ${runtime.subject}`);
      console.log(`namespace: ${runtime.dataNamespace}`);
      console.log('');
      printReportList(records, limit);
    }
    return 0;
  }

  const { runtime, record } = findReportRecord(root, flags);
  if (!record) {
    if (flags.cycle) {
      console.error(`No intel report found for cycle: ${flags.cycle}`);
    } else {
      console.error('No intel reports found yet. Run `jea run` to generate one.');
    }
    return 1;
  }

  if (flags.json) {
    console.log(JSON.stringify({ runtime, record }, null, 2));
    return 0;
  }

  const mdPath = record.md_path;
  if (!mdPath || !existsSync(mdPath)) {
    console.error(`Report file missing on disk: ${mdPath}`);
    return 1;
  }

  if (flags.open) {
    const ok = openInDefaultApp(mdPath);
    if (!ok) {
      console.log(`Could not open automatically. Path: ${mdPath}`);
      return 1;
    }
    console.log(`Opened: ${mdPath}`);
    return 0;
  }

  console.log(readFileSync(mdPath, 'utf-8'));
  return 0;
}

export async function intelCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();

  if (subcommand === 'summary') {
    const summary = buildIntelSummary(root, flags);
    if (flags.json) console.log(JSON.stringify(summary, null, 2));
    else printIntelSummary(summary);
    return 0;
  }

  if (subcommand === 'report') {
    return intelReportCommand(root, flags, args);
  }

  if (subcommand === 'ingest') {
    return runIntelIngest({ root, flags });
  }

  if (subcommand === 'inbox') {
    const action = args[0];
    if (action === 'put') return inboxPut({ root, flags });
    if (action === 'drain') return inboxDrain({ root, flags });
    console.error('Usage: jea intel inbox <put|drain> [...]\n' +
      '  jea intel inbox put --source NAME [--file PATH | --stdin] [--name LABEL] [--json]\n' +
      '  jea intel inbox drain [--dir PATH] [--json]');
    return 2;
  }

  console.error('Usage: jea intel <summary|report|ingest|inbox> [...]\n' +
    '  jea intel summary [--days N] [--limit N] [--json]\n' +
    '  jea intel report [--latest] [--cycle <id>] [--json] [--open]\n' +
    '  jea intel report list [--limit N] [--json]\n' +
    '  jea intel ingest --source NAME [--file PATH | --stdin] [--json]\n' +
    '  jea intel inbox put --source NAME [--file PATH | --stdin] [--name LABEL]\n' +
    '  jea intel inbox drain [--dir PATH] [--json]');
  return 2;
}
