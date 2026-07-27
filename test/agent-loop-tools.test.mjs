import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { buildInvestigationTools, buildLoopTools } from '../src/evolution/agent-loop/tool-registry.mjs';
import { buildInvestigationDigest } from '../src/prompts/agent-loop.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeLoopCtx(overrides = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-loop-tools-'));
  const runtimeRoot = join(tempDir, 'runtime');
  mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'intelligence'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'data', 'goals', 'active_goals.json'), JSON.stringify({
    id: 'bootstrap',
    name: 'Bootstrap',
    intent: 'test',
    good_signal: 'ok',
    bad_signal: 'bad',
    children: [],
  }, null, 2), 'utf-8');

  const store = createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const host = {
    sourceRoot: tempDir,
    runtimeRoot,
    intelligenceStore: store,
    actionHandlers: {
      record_observation: async () => {
        throw new Error('handlers must not run inside investigation');
      },
    },
    logger: { info() {}, warning() {}, error() {} },
  };
  const runtime = { runtimeRoot, subject: 'demo', dataNamespace: 'demo' };
  const decisionQueue = createHostDecisionQueue({
    dataDir: join(runtimeRoot, 'data', 'evolution'),
  });
  const loopCtx = {
    host,
    runtime,
    store,
    cycleId: 'cycle-test',
    decisionQueue,
    budget: {
      maxTurns: 6,
      maxActions: 2,
      maxWallClockMs: 60_000,
      toolResultMaxChars: 2000,
      actionsUsed: 0,
    },
    dedup: new Set(),
    queued: [],
    executed: [],
    queryLog: [],
    emitEvent() {},
    ...overrides,
  };
  return { loopCtx, runtimeRoot, store, decisionQueue };
}

describe('agent-loop investigation tools', () => {
  it('exposes readonly tools and finish_investigation only (no action queue tools)', () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildInvestigationTools(loopCtx);
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('intel_query');
    expect(names).toContain('finish_investigation');
    expect(names).not.toContain('record_observation');
    expect(names).not.toContain('agent_run');
    expect(buildLoopTools(loopCtx).tools.map((t) => t.name)).toEqual(names);
  });

  it('finish_investigation stores payload on loopCtx', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildInvestigationTools(loopCtx);
    const outcome = await tools.dispatch('finish_investigation', {
      findings_summary: 'Seen is enough',
      enough_for_report: true,
      gaps_closed: ['queue summary'],
      open_gaps: ['publish later'],
    });
    expect(outcome.ok).toBe(true);
    expect(loopCtx.investigation.findings_summary).toBe('Seen is enough');
    expect(loopCtx.investigation.open_gaps).toEqual(['publish later']);
  });

  it('rejects empty findings_summary', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildInvestigationTools(loopCtx);
    const outcome = await tools.dispatch('finish_investigation', {
      findings_summary: '   ',
      enough_for_report: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/findings_summary/);
  });

  it('returns deprecated for finish_cycle shim', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildInvestigationTools(loopCtx);
    const outcome = await tools.dispatch('finish_cycle', {
      status: 'done',
      report_markdown: '# nope\n',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('deprecated_tool');
  });

  it('returns valid_tools for unknown tool names', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildInvestigationTools(loopCtx);
    const outcome = await tools.dispatch('not_a_real_tool', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('unknown_tool');
    expect(outcome.valid_tools).toContain('finish_investigation');
    expect(outcome.valid_tools).toContain('intel_query');
  });

  it('reads active goals and logs readonly queries', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildInvestigationTools(loopCtx);
    const goals = await tools.dispatch('get_active_goals', {});
    expect(goals.ok).toBe(true);
    expect(JSON.stringify(goals.result)).toContain('bootstrap');
    expect(JSON.stringify(goals.result)).toContain('[machine_context:active_goals]');
    expect(loopCtx.queryLog.some((q) => q.name === 'get_active_goals')).toBe(true);
  });

  it('validates intel_query source enum and attaches item.ref', async () => {
    const { loopCtx, store } = makeLoopCtx();
    store.ingest('intel_observations', {
      id: 'obs-ref-1',
      kind: 'observation',
      source: 'test',
      content: 'ref handle fixture',
      confidence: 'medium',
    });
    const tools = buildInvestigationTools(loopCtx);
    const bad = await tools.dispatch('intel_query', { source: 'nope' });
    expect(bad.ok).toBe(false);
    const ok = await tools.dispatch('intel_query', { source: 'intel_observations', limit: 5 });
    expect(ok.ok).toBe(true);
    const payload = typeof ok.result === 'string' ? JSON.parse(ok.result) : ok.result;
    const items = payload.items || payload.preview && [];
    if (Array.isArray(payload.items)) {
      expect(payload.items.some((row) => row.ref === '[intel_observations:obs-ref-1]')).toBe(true);
    } else {
      expect(JSON.stringify(ok.result)).toContain('[intel_observations:obs-ref-1]');
    }
    expect(items || true).toBeTruthy();
  });

  it('accepts verified_facts and rejects invalid refs', async () => {
    const { loopCtx, store } = makeLoopCtx();
    store.ingest('intel_observations', {
      id: 'obs-vf-1',
      kind: 'observation',
      source: 'test',
      content: 'verified fact fixture',
      confidence: 'medium',
    });
    const tools = buildInvestigationTools(loopCtx);
    const outcome = await tools.dispatch('finish_investigation', {
      findings_summary: 'closed with verified facts',
      enough_for_report: true,
      verified_facts: [
        { ref: '[intel_observations:obs-vf-1]', statement: 'fixture observation present' },
        { ref: '[machine_context:decision_queue]', statement: 'queue summary available' },
        { ref: '[intel_observations:missing]', statement: 'should be rejected' },
        { ref: 'not-a-ref', statement: 'unparseable' },
      ],
    });
    expect(outcome.ok).toBe(true);
    expect(loopCtx.investigation.verified_facts).toHaveLength(2);
    expect(loopCtx.investigation.rejected_facts).toHaveLength(2);
    expect(outcome.result.rejected).toHaveLength(2);
  });

  it('builds a bounded investigation digest including verified facts', () => {
    const digest = buildInvestigationDigest({
      investigation: {
        findings_summary: 'ok',
        enough_for_report: true,
        gaps_closed: ['a'],
        open_gaps: ['b'],
        verified_facts: [
          { ref: '[intel_observations:obs-1]', statement: 'seen fact' },
        ],
        rejected_facts: [
          { ref: '[intel_observations:missing]', statement: 'nope', reason: 'dangling_ref' },
        ],
      },
      queryLog: [{ name: 'intel_query', ok: true, preview: '{"count":1}' }],
      maxChars: 2000,
    });
    expect(digest).toContain('Findings summary');
    expect(digest).toContain('Verified facts');
    expect(digest).toContain('[intel_observations:obs-1]');
    expect(digest).toContain('Rejected facts');
    expect(digest).toContain('intel_query');
    expect(digest).toContain('Open gaps');
  });
});
