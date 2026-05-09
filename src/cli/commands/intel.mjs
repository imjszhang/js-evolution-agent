import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function buildIntelSummary(root, flags = {}) {
  const runtime = getActiveSubjectRuntimeInfo(root);
  const days = numberFlag(flags, 'days', 7);
  const limit = numberFlag(flags, 'limit', 8);
  const store = createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
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

export async function intelCommand({ subcommand, flags = {} } = {}) {
  if (subcommand !== 'summary') {
    console.error('Usage: jea intel summary [--days N] [--limit N] [--json]');
    return 2;
  }
  const summary = buildIntelSummary(getProjectRoot(), flags);
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else printIntelSummary(summary);
  return 0;
}

