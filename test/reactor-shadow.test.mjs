import { afterEach, describe, expect, it } from 'vitest';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvidenceBatchClaim } from '../src/contracts/evidence-batch-claim.mjs';
import {
  ackBatchHandled,
  claimEvidenceBatch,
  isReactorBusy,
  nackBatchFailed,
  readClaimLedger,
  reconcileExpiredClaims,
} from '../src/evolution/reactor/claim-ledger.mjs';
import { compareShadowAgainstCycle } from '../src/evolution/reactor/shadow-compare.mjs';
import { runCognitiveShadowReaction, buildDecidePrompt } from '../src/evolution/reactor/cognitive-reactor.mjs';
import { readShadowDecisions, readShadowRuns, appendShadowDecisions } from '../src/evolution/reactor/shadow-store.mjs';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeDataRoot(prefix = 'jea-reactor-shadow-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  const dataRoot = join(tempDir, 'data');
  mkdirSync(join(dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'reports'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution'), { recursive: true });
  return dataRoot;
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function seedEvolutionEvents(dataRoot, count = 3) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `evt-seed-${i}`,
      type: 'exec_pipeline',
      recorded_at: `2026-08-09T0${i}:00:00.000Z`,
      status: 'ok',
      cycle_id: 'cycle-train-1',
    });
  }
  writeJsonl(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), rows);
  return rows;
}

function fileHash(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('evidence batch claim contract', () => {
  it('validates required fields and batch- prefix', () => {
    expect(validateEvidenceBatchClaim({
      batch_id: 'batch-abc',
      reactor: 'cognitive',
      claimed_at: '2026-08-09T00:00:00.000Z',
      deadline_at: '2026-08-09T00:05:00.000Z',
      event_ids: ['evt-1'],
      status: 'claimed',
    }).ok).toBe(true);
    expect(validateEvidenceBatchClaim({
      batch_id: 'bad',
      reactor: 'cognitive',
      claimed_at: '2026-08-09T00:00:00.000Z',
      deadline_at: '2026-08-09T00:05:00.000Z',
      event_ids: ['evt-1'],
      status: 'claimed',
    }).ok).toBe(false);
  });
});

describe('claim ledger', () => {
  it('claims oldest uncovered evidence and supports ack/nack/busy/expiry', () => {
    const dataRoot = makeDataRoot();
    seedEvolutionEvents(dataRoot, 3);

    const first = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 2, timeoutMs: 60_000 });
    expect(first.skipped).toBeUndefined();
    expect(first.events).toHaveLength(2);
    expect(first.events[0].id).toBe('evt-seed-0');
    expect(isReactorBusy(dataRoot, 'cognitive')).toBe(true);

    const busy = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 2 });
    expect(busy.skipped).toBe('reactor_busy');

    ackBatchHandled(dataRoot, first.batch_id);
    expect(isReactorBusy(dataRoot, 'cognitive')).toBe(false);

    const second = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 10 });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].id).toBe('evt-seed-2');
    nackBatchFailed(dataRoot, second.batch_id, { error: 'boom' });
    const ledger = readClaimLedger(dataRoot);
    expect(ledger.claims.find((c) => c.batch_id === second.batch_id).status).toBe('failed');

    // failed batch does not permanently cover ids → reclaimable
    const retry = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 10 });
    expect(retry.events.map((e) => e.id)).toEqual(['evt-seed-2']);
    ackBatchHandled(dataRoot, retry.batch_id);

    const empty = claimEvidenceBatch(dataRoot, { reactor: 'cognitive' });
    expect(empty.skipped).toBe('no_pending_evidence');
  });

  it('reconciles expired claimed batches to failed', () => {
    const dataRoot = makeDataRoot();
    seedEvolutionEvents(dataRoot, 1);
    const claimed = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 1,
      timeoutMs: 1,
      now: Date.now() - 10_000,
    });
    expect(claimed.batch_id).toBeTruthy();
    const expired = reconcileExpiredClaims(dataRoot, { now: Date.now() });
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe('failed');
    expect(isReactorBusy(dataRoot, 'cognitive')).toBe(false);
  });
});

describe('shadow compare', () => {
  it('reports matched / shadow_only / train_only', () => {
    const dataRoot = makeDataRoot();
    mkdirSync(join(dataRoot, 'evolution'), { recursive: true });
    writeFileSync(join(dataRoot, 'evolution', 'pending_decisions.json'), JSON.stringify({
      decisions: [
        {
          id: 'cycle-train-1:0',
          cycle_id: 'cycle-train-1',
          status: 'pending',
          action: { type: 'record_observation', description: 'a', serves_goal: 'bootstrap' },
        },
        {
          id: 'cycle-train-1:1',
          cycle_id: 'cycle-train-1',
          status: 'pending',
          action: { type: 'propose_probe', description: 'b', serves_goal: 'bootstrap' },
        },
      ],
    }, null, 2));
    mkdirSync(join(dataRoot, 'evolution', 'reactor'), { recursive: true });
    writeFileSync(join(dataRoot, 'evolution', 'reactor', 'shadow_decisions.json'), JSON.stringify({
      decisions: [
        {
          id: 'batch-x:0',
          batch_id: 'batch-x',
          action: { type: 'record_observation', description: 'a', serves_goal: 'bootstrap' },
        },
        {
          id: 'batch-x:1',
          batch_id: 'batch-x',
          action: { type: 'write_retrospective', description: 'c', serves_goal: 'bootstrap' },
        },
      ],
    }, null, 2));

    const report = compareShadowAgainstCycle(dataRoot, { cycleId: 'cycle-train-1' });
    expect(report.summary.matched).toBe(1);
    expect(report.summary.shadow_only).toBe(1);
    expect(report.summary.train_only).toBe(1);
  });
});

describe('cognitive shadow reactor e2e', () => {
  it('buildDecidePrompt injects action registry required params', () => {
    const prompt = buildDecidePrompt({
      batchId: 'batch-prompt',
      reportMarkdown: '# Report\n- seen',
      live: true,
    });
    expect(prompt).toContain('## Available Action Types');
    expect(prompt).toContain('Required params: content');
    expect(prompt).toContain('Required params: hypothesis, success_signal, failure_signal, death_boundary');
    expect(prompt).toContain('"params": { "content": "..." }');
    expect(prompt).not.toContain('"params": {}');
  });

  it('produces shadow artifacts without touching train files', async () => {
    const dataRoot = makeDataRoot('jea-reactor-e2e-');
    const runtimeRoot = tempDir;
    mkdirSync(join(runtimeRoot, 'data'), { recursive: true });
    // align layout: runtimeRoot/data == dataRoot when dataRoot is runtimeRoot/data
    // recreate under runtimeRoot/data
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), 'jea-reactor-e2e-'));
    const runtime = {
      subject: 'alpha',
      dataNamespace: 'alpha',
      runtimeRoot: tempDir,
      dataRoot: join(tempDir, 'data'),
    };
    mkdirSync(join(runtime.dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
    mkdirSync(join(runtime.dataRoot, 'intelligence', 'reports'), { recursive: true });
    mkdirSync(join(runtime.dataRoot, 'evolution'), { recursive: true });
    mkdirSync(join(runtime.dataRoot, 'goals'), { recursive: true });
    seedEvolutionEvents(runtime.dataRoot, 2);

    const pendingPath = join(runtime.dataRoot, 'evolution', 'pending_decisions.json');
    const reportsPath = join(runtime.dataRoot, 'intelligence', 'reports', 'index.jsonl');
    const eventsPath = join(runtime.dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl');
    writeFileSync(pendingPath, JSON.stringify({ decisions: [{ id: 'keep-me', status: 'pending', action: { type: 'record_observation' } }] }, null, 2));
    writeFileSync(reportsPath, `${JSON.stringify({ id: 'report-keep', cycle_id: 'cycle-old' })}\n`);
    const beforePending = fileHash(pendingPath);
    const beforeReports = fileHash(reportsPath);
    const beforeEvents = fileHash(eventsPath);

    const store = createIntelligenceStore({
      baseDir: join(runtime.dataRoot, 'intelligence'),
      timezone: 'Asia/Shanghai',
    });

    const aiClient = new MockToolsAIClient({
      finishReport: [
        '# Shadow report',
        '',
        '## Seen',
        '- placeholder',
        '',
        '## Inferred',
        '- ok',
        '',
        '## Cyber-Taoist analysis',
        '- ok',
        '',
        '## Next cycle suggestions',
        '- continue',
      ].join('\n'),
      canned: [
        {
          match: /Shadow Cognitive Reactor Report Task/,
          response: [
            '# Shadow Cognitive Reactor Report',
            '',
            '## Seen',
            '- will be replaced',
            '',
            '## Inferred',
            '- mock shadow inference',
            '',
            '## Cyber-Taoist analysis',
            '- dual-run path intact',
            '',
            '## Next cycle suggestions',
            '- compare with train',
          ].join('\n'),
        },
        {
          match: /Strategic Analysis & Decision/,
          response: {
            decision: 'execute',
            actions: [{
              type: 'record_observation',
              description: `shadow note ${randomUUID().slice(0, 8)}`,
              serves_goal: 'bootstrap',
              params: { content: 'shadow observation' },
            }],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            confidence_score: 0.4,
          },
        },
      ],
      defaultResponse: {
        decision: 'execute',
        actions: [{
          type: 'record_observation',
          description: 'default shadow action',
          serves_goal: 'bootstrap',
        }],
        goal_coverage: { covered: [], not_covered: {} },
        deferred: [],
        risk_mitigation: [],
      },
    });

    const ctx = {
      cfg: {
        aiClient,
        agentContextDocs: '',
        actionRegistry: { list: () => [] },
        host: {
          logger: { info() {}, warning() {}, error() {} },
          intelligenceStore: store,
          knowledgeWriter: store,
        },
      },
      engine: {
        cycleId: null,
        setCycleId() {},
        goalProvider: { formatForPrompt: () => 'bootstrap' },
        loadRules: () => '',
        guidanceReader: { readGuidance: () => '' },
      },
      runtime,
      store,
      projectRoot: tempDir,
    };

    const result = await runCognitiveShadowReaction(ctx, {
      batchLimit: 2,
      skipInvestigate: true,
    });

    expect(result.skipped).toBe(false);
    expect(result.batch_id).toMatch(/^batch-/);
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(result.report_path)).toBe(true);

    const runs = readShadowRuns(runtime.dataRoot, { limit: 50 });
    const honesty = runs.filter((r) => r.type === 'shadow_report_honesty');
    expect(honesty).toHaveLength(1);

    const ledger = readClaimLedger(runtime.dataRoot);
    expect(ledger.claims.find((c) => c.batch_id === result.batch_id)?.status).toBe('handled');

    expect(fileHash(pendingPath)).toBe(beforePending);
    expect(fileHash(reportsPath)).toBe(beforeReports);
    expect(fileHash(eventsPath)).toBe(beforeEvents);

    const shadow = readShadowDecisions(runtime.dataRoot);
    expect(shadow.decisions.some((d) => d.batch_id === result.batch_id)).toBe(true);
  });

  it('appendShadowDecisions skips non-object actions', () => {
    const dataRoot = makeDataRoot('jea-reactor-shadow-skip-');
    const result = appendShadowDecisions(dataRoot, {
      batchId: 'batch-skip',
      subject: 'demo',
      actions: [
        'propose_probe: leftover string',
        { type: 'record_observation', description: 'keep', params: { content: 'k' } },
        null,
      ],
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.decisions[0].action.type).toBe('record_observation');
    const stored = readShadowDecisions(dataRoot);
    expect(stored.decisions).toHaveLength(1);
    expect(typeof stored.decisions[0].action).toBe('object');
  });
});
