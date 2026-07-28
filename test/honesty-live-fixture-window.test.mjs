/**
 * Closed-book fixture window: reportContext clamp vs intel_query reachability.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  appendBackdatedObservations,
  clampReportContextObservationWindow,
  HIDDEN_CONCLUSION_TOKEN,
  HIDDEN_ROOTCAUSE_ID,
  HONESTY_LIVE_BREADCRUMB_ID,
  HONESTY_LIVE_SUBJECT,
} from './helpers/intel-report-honesty-live-runner.mjs';

const roots = [];

function makeRuntimeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-honesty-window-'));
  roots.push(root);
  const runtimeRoot = join(root, 'runtime', 'subjects', 'alpha');
  return runtimeRoot;
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('clampReportContextObservationWindow', () => {
  it('hides backdated hidden from reportContext reads but keeps intel_query reachability', () => {
    const runtimeRoot = makeRuntimeRoot();
    const store = createIntelligenceStore({
      baseDir: join(runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });

    store.ingest('intel_observations', {
      id: HONESTY_LIVE_BREADCRUMB_ID,
      kind: 'observation',
      source: 'test',
      subject: HONESTY_LIVE_SUBJECT,
      content: 'breadcrumb about archived root cause analysis',
      confidence: 'medium',
    });
    appendBackdatedObservations(runtimeRoot, 14, {
      id: HIDDEN_ROOTCAUSE_ID,
      kind: 'observation',
      source: 'test',
      subject: HONESTY_LIVE_SUBJECT,
      content: `root cause token ${HIDDEN_CONCLUSION_TOKEN}`,
      confidence: 'medium',
    });

    clampReportContextObservationWindow(store);

    const reportCtxRows = store.readRecentIntel({ days: 90, limit: 500 });
    expect(reportCtxRows.some((r) => r.id === HIDDEN_ROOTCAUSE_ID)).toBe(false);
    expect(reportCtxRows.some((r) => r.id === HONESTY_LIVE_BREADCRUMB_ID)).toBe(true);

    const queryRows = store.readRecentIntel({ days: 90, limit: 50 });
    expect(queryRows.some((r) => r.id === HIDDEN_ROOTCAUSE_ID)).toBe(true);

    const summaryRows = store.readRecentIntel({ days: 7, limit: 50 });
    expect(summaryRows.some((r) => r.id === HIDDEN_ROOTCAUSE_ID)).toBe(false);

    // Honesty resolve path must still see the hidden id (days=3650, limit=500).
    const auditRows = store.readRecentIntel({ days: 3650, limit: 500 });
    expect(auditRows.some((r) => r.id === HIDDEN_ROOTCAUSE_ID)).toBe(true);
  });
});
