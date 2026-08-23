#!/usr/bin/env node
/**
 * Isolated projection performance smoke. Not a PR required check.
 *
 * Measures warm buildDaemonProjection / readiness reads against large fixtures
 * in a temporary JEA_HOME. Does not write ~/.jea or sample this script's CPU
 * as Electron evidence.
 *
 * Usage:
 *   node scripts/performance-projection-smoke.mjs [--json] [--size-mb 60] [--claims-mb 80] [--events 100000]
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, printReport } from './release-lib.mjs';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  buildDaemonProjection,
  readDaemonProjection,
  resetDaemonProjectionCache,
  waitForPendingDaemonProjectionRebuilds,
} from '../src/daemon/daemon-projection.mjs';
import { resetEvidenceHealthSnapshotCache } from '../src/intelligence/evidence-stream.mjs';
import { readSubjectReadiness } from '../src/product/subject-readiness.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

const WARM_P95_MS = 50;
const RSS_GROWTH_MB = 25;
const COLD_WORKER_HINT_MS = 200;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function rssMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-perf-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-perf-home-'));
  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(root, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(root, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  });
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return { root, jeaHome };
}

function seedLargeFixtures(runtime, { sizeMb, claimsMb, events }) {
  const dataRoot = runtime.dataRoot;
  mkdirSync(join(dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'channel'), { recursive: true });
  const payload = 'x'.repeat(2048);
  const evoPath = join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl');
  const targetBytes = Math.max(8, Number(sizeMb) || 60) * 1024 * 1024;
  let written = 0;
  let index = 0;
  const chunk = [];
  while (written < targetBytes) {
    const line = JSON.stringify({
      id: `evt-${index}`,
      type: 'exec_pipeline',
      recorded_at: new Date(Date.now() - index).toISOString(),
      cycle_id: 'cycle-perf',
      payload,
    });
    chunk.push(line);
    written += line.length + 1;
    index += 1;
    if (chunk.length >= 200) {
      appendFileSync(evoPath, `${chunk.join('\n')}\n`);
      chunk.length = 0;
    }
  }
  if (chunk.length) appendFileSync(evoPath, `${chunk.join('\n')}\n`);

  const channelPath = join(dataRoot, 'channel', 'events.jsonl');
  const channelCount = Math.max(1_000, Number(events) || 100_000);
  const channelChunk = [];
  for (let i = 0; i < channelCount; i += 1) {
    channelChunk.push(JSON.stringify({
      id: `channel-event-${i}`,
      type: i % 17 === 0 ? 'channel_message_received' : 'channel_classifier_tick',
      recorded_at: new Date(Date.now() - i).toISOString(),
    }));
    if (channelChunk.length >= 500) {
      appendFileSync(channelPath, `${channelChunk.join('\n')}\n`);
      channelChunk.length = 0;
    }
  }
  if (channelChunk.length) appendFileSync(channelPath, `${channelChunk.join('\n')}\n`);

  writePendingOperatorBrief(runtime.runtimeRoot, {
    id: 'brief-perf-1',
    summary: 'perf fixture brief',
    created_at: new Date().toISOString(),
  });
  const claimDir = join(dataRoot, 'evolution', 'reactor');
  mkdirSync(claimDir, { recursive: true });
  const claimPath = join(claimDir, 'claims.json');
  const claimTargetBytes = Math.max(1, Number(claimsMb) || 80) * 1024 * 1024;
  const indexedPayload = 'y'.repeat(16 * 1024);
  writeFileSync(claimPath, '{"schema_version":1,"claims":[');
  let claimBytes = 0;
  let claimCount = 0;
  while (claimBytes < claimTargetBytes) {
    const row = JSON.stringify({
      batch_id: `batch-perf-${claimCount}`,
      reactor: 'cognitive',
      status: 'handled',
      handled_at: new Date(Date.now() - claimCount).toISOString(),
      event_ids: [`evt-perf-${claimCount}`],
      evidence_keys: [`evolution_events:evt-perf-${claimCount}`],
      indexed_entries: [{ id: `evt-perf-${claimCount}`, payload: indexedPayload }],
    });
    appendFileSync(claimPath, `${claimCount ? ',' : ''}${row}`);
    claimBytes += Buffer.byteLength(row) + 1;
    claimCount += 1;
  }
  appendFileSync(claimPath, '],"updated_at":null}\n');
  return {
    evidence_rows: index,
    channel_events: channelCount,
    evidence_bytes: written,
    claim_rows: claimCount,
    claim_bytes: claimBytes,
  };
}

function measureMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function main() {
  const args = parseArgs();
  const previousHome = process.env.JEA_HOME;
  const isolated = makeIsolatedRoot();
  process.env.JEA_HOME = isolated.jeaHome;
  const runtime = runtimeForSubject({ sourceRoot: isolated.root, jeaHome: isolated.jeaHome }, 'alpha');
  let status = 'ok';
  const notes = [];
  try {
    resetEvidenceHealthSnapshotCache();
    resetDaemonProjectionCache();
    const seeded = seedLargeFixtures(runtime, {
      sizeMb: args['size-mb'] || 60,
      claimsMb: args['claims-mb'] || 80,
      events: args.events || 100_000,
    });
    const ctx = { sourceRoot: isolated.root, jeaHome: isolated.jeaHome };
    let coldProjection;
    const coldMs = measureMs(() => {
      coldProjection = buildDaemonProjection(ctx, 'alpha', { eventLimit: 10 });
    });
    if (coldProjection?.reactor?.claims?.projection_degraded !== true) {
      status = 'failed';
      notes.push('oversized claim fixture did not produce a bounded degraded projection');
    }
    const warmSamples = [];
    for (let i = 0; i < 20; i += 1) {
      warmSamples.push(measureMs(() => buildDaemonProjection(ctx, 'alpha', { eventLimit: 10 })));
    }
    const warmP95 = percentile(warmSamples, 95);
    const beforeRss = rssMb();
    for (let i = 0; i < 100; i += 1) {
      readSubjectReadiness(ctx, 'alpha', { hostKind: 'electron' });
    }
    const afterRss = rssMb();
    const rssGrowth = afterRss - beforeRss;
    if (warmP95 > WARM_P95_MS) {
      status = 'failed';
      notes.push(`warm buildDaemonProjection p95 ${warmP95.toFixed(1)}ms exceeds ${WARM_P95_MS}ms`);
    }
    if (rssGrowth > RSS_GROWTH_MB) {
      status = 'failed';
      notes.push(`readiness RSS growth ${rssGrowth.toFixed(1)}MB exceeds ${RSS_GROWTH_MB}MB`);
    }
    appendFileSync(join(runtime.dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), `${JSON.stringify({
      id: 'evt-defer-probe',
      type: 'exec_pipeline',
      recorded_at: new Date().toISOString(),
    })}\n`);
    const deferMs = measureMs(() => readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
    }));
    await waitForPendingDaemonProjectionRebuilds();
    if (deferMs > WARM_P95_MS) {
      status = 'failed';
      notes.push(`deferred rebuild return ${deferMs.toFixed(1)}ms exceeds ${WARM_P95_MS}ms`);
    }
    if (coldMs > COLD_WORKER_HINT_MS) {
      notes.push(`cold scan ${coldMs.toFixed(1)}ms exceeds ${COLD_WORKER_HINT_MS}ms; Desktop defers later heavy rebuilds to a worker thread`);
    }
    const report = {
      script: 'performance-projection-smoke',
      ok: status === 'ok',
      status,
      isolated: true,
      thresholds: {
        warm_p95_ms: WARM_P95_MS,
        rss_growth_mb: RSS_GROWTH_MB,
        cold_worker_hint_ms: COLD_WORKER_HINT_MS,
        defer_return_ms: WARM_P95_MS,
      },
      metrics: {
        cold_ms: Number(coldMs.toFixed(2)),
        warm_p50_ms: Number(percentile(warmSamples, 50).toFixed(2)),
        warm_p95_ms: Number(warmP95.toFixed(2)),
        defer_return_ms: Number(deferMs.toFixed(2)),
        readiness_rss_before_mb: Number(beforeRss.toFixed(2)),
        readiness_rss_after_mb: Number(afterRss.toFixed(2)),
        readiness_rss_growth_mb: Number(rssGrowth.toFixed(2)),
      },
      fixture: seeded,
      notes,
    };
    printReport(report, { json: Boolean(args.json) });
    if (!report.ok) process.exitCode = 1;
  } finally {
    resetEvidenceHealthSnapshotCache();
    resetDaemonProjectionCache();
    if (previousHome == null) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousHome;
    rmSync(isolated.root, { recursive: true, force: true });
    rmSync(isolated.jeaHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
