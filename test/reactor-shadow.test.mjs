import { afterEach, describe, expect, it } from 'vitest';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import { spawn } from 'node:child_process';
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
  listEligibleEvidence,
  nackBatchFailed,
  readClaimLedger,
  reconcileExpiredClaims,
} from '../src/evolution/reactor/claim-ledger.mjs';
import { compareShadowAgainstCycle } from '../src/evolution/reactor/shadow-compare.mjs';
import { runCognitiveShadowReaction, buildDecidePrompt } from '../src/evolution/reactor/cognitive-reactor.mjs';
import { readShadowDecisions, readShadowRuns, appendShadowDecisions, appendShadowRun } from '../src/evolution/reactor/shadow-store.mjs';
import { readBatchCheckpoint, writeBatchCheckpoint } from '../src/evolution/reactor/batch-checkpoint-store.mjs';
import { writeShadowReport } from '../src/evolution/reactor/shadow-store.mjs';
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

  it('covers event ids independently per reactor', () => {
    const dataRoot = makeDataRoot();
    mkdirSync(join(dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
    writeJsonl(join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), [
      {
        id: 'receipt-shared-0',
        action_type: 'record_observation',
        recorded_at: '2026-08-09T00:00:00.000Z',
        action: { type: 'record_observation' },
        result: { success: true },
      },
      {
        id: 'receipt-shared-1',
        action_type: 'record_observation',
        recorded_at: '2026-08-09T01:00:00.000Z',
        action: { type: 'record_observation' },
        result: { success: true },
      },
    ]);
    const cognitive = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 2 });
    expect(cognitive.events).toHaveLength(2);
    const rule = claimEvidenceBatch(dataRoot, { reactor: 'rule', limit: 2 });
    expect(rule.skipped).toBeUndefined();
    expect(rule.events.map((item) => item.id)).toEqual(cognitive.events.map((item) => item.id));
    ackBatchHandled(dataRoot, cognitive.batch_id);
    const ruleAgain = claimEvidenceBatch(dataRoot, { reactor: 'rule', limit: 2 });
    expect(ruleAgain.skipped).toBe('reactor_busy');
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

  it('does not let a second process claim the same batch', () => {
    const dataRoot = makeDataRoot();
    seedEvolutionEvents(dataRoot, 2);
    const first = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 2 });
    const second = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 2 });
    expect(first.batch_id).toBeTruthy();
    expect(second.skipped).toBe('reactor_busy');
    expect(readClaimLedger(dataRoot).claims.filter((c) => c.status === 'claimed')).toHaveLength(1);
  });

  it('serializes claims from two node processes', async () => {
    const dataRoot = makeDataRoot();
    seedEvolutionEvents(dataRoot, 2);
    const claimModule = new URL(
      '../src/evolution/reactor/claim-ledger.mjs',
      import.meta.url,
    ).href;
    const script = [
      `import { claimEvidenceBatch } from ${JSON.stringify(claimModule)};`,
      'console.log(JSON.stringify(claimEvidenceBatch(process.env.DATA_ROOT, { reactor: "cognitive", limit: 2 })));',
    ].join('\n');
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DATA_ROOT: dataRoot },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `child exited ${code}`));
          return;
        }
        resolve(JSON.parse(stdout.trim()));
      });
    });

    const results = await Promise.all([run(), run()]);
    expect(results.filter((result) => result.batch_id)).toHaveLength(1);
    expect(results.filter((result) => result.skipped === 'reactor_busy')).toHaveLength(1);
    expect(readClaimLedger(dataRoot).claims.filter((claim) => claim.status === 'claimed'))
      .toHaveLength(1);
  });

  it('keeps same id different kinds independently', () => {
    const dataRoot = makeDataRoot();
    mkdirSync(join(dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
    mkdirSync(join(dataRoot, 'evolution', 'verify_reports'), { recursive: true });
    writeJsonl(join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), [{
      id: 'shared-id',
      action_type: 'record_observation',
      recorded_at: '2026-08-09T00:00:00.000Z',
      action: { type: 'record_observation' },
      result: { success: true },
    }]);
    writeFileSync(join(dataRoot, 'evolution', 'verify_reports', 'shared-id.json'), JSON.stringify({
      timestamp: '2026-08-09T00:00:00.000Z',
      verified: [],
      pending: [],
    }));
    const claimed = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 10 });
    const keys = claimed.claim.evidence_keys.sort();
    expect(keys).toContain('action_receipts:shared-id');
    expect(keys).toContain('verify_reports:shared-id');
  });

  it('does not treat cognitive outputs as eligible cognitive backlog', () => {
    const dataRoot = makeDataRoot();
    writeJsonl(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), [{
      id: 'evt-self',
      type: 'reactor_pipeline',
      recorded_at: '2026-08-09T00:00:00.000Z',
      producer: 'cognitive',
    }]);
    const eligible = listEligibleEvidence(dataRoot, { reactor: 'cognitive' });
    expect(eligible.map((item) => item.id)).not.toContain('evt-self');
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
    expect(prompt.content).toContain('## Available Action Types');
    expect(prompt.content).toContain('Required params: content');
    expect(prompt.content).toContain('Required params: hypothesis, success_signal, failure_signal, death_boundary');
    expect(prompt.content).toContain('"params": { "content": "..." }');
    expect(prompt.content).not.toContain('"params": {}');
    expect(prompt.stablePrefix).not.toContain('batch-prompt');
    expect(prompt.dynamicPayload).toContain('batch_id: batch-prompt');
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
    expect(result.prompt_cache?.report?.metadata?.stable_prefix_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.prompt_cache.report.metadata.stable_prefix_hash)
      .not.toBe(result.prompt_cache.decide.metadata.stable_prefix_hash);
    expect(result.prompt_cache.report.invariant.status).toMatch(/baseline|stable/);

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

  it('resumes the same cognitive batch after a report-stage crash', async () => {
    const dataRoot = makeDataRoot('jea-reactor-resume-');
    seedEvolutionEvents(dataRoot, 2);
    const claimed = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 2 });
    const reportPath = writeShadowReport(dataRoot, claimed.batch_id, [
      '# Shadow Cognitive Reactor Report',
      '',
      '## Seen',
      '- existing',
      '',
      '## Inferred',
      '- resumed',
      '',
      '## Cyber-Taoist analysis',
      '- ok',
      '',
      '## Next cycle suggestions',
      '- continue',
      '',
    ].join('\n'));
    writeBatchCheckpoint(dataRoot, {
      batch_id: claimed.batch_id,
      reactor: 'cognitive',
      subject: 'demo',
      stage: 'report',
      event_ids: claimed.events.map((item) => item.id),
      evidence_keys: claimed.events.map((item) => `${item.kind}:${item.id}`),
      report_path: reportPath,
      report_source: 'fallback',
      honesty: { status: 'ok', findings_count: 0 },
    });

    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const aiClient = new MockToolsAIClient({
      responses: [{
        match: /Strategic Analysis & Decision/,
        response: {
          decision: 'execute',
          actions: [{
            type: 'record_observation',
            description: 'resume note',
            serves_goal: 'bootstrap',
            params: { content: 'resume' },
          }],
          goal_coverage: { covered: ['bootstrap'], not_covered: {} },
          deferred: [],
          risk_mitigation: [],
          confidence_score: 0.4,
        },
      }],
      defaultResponse: { decision: 'execute', actions: [] },
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
      runtime: { dataRoot, runtimeRoot: tempDir, subject: 'demo' },
      store,
      projectRoot: tempDir,
    };

    const first = await runCognitiveShadowReaction(ctx, { skipInvestigate: true });
    expect(first.batch_id).toBe(claimed.batch_id);
    expect(readBatchCheckpoint(dataRoot, claimed.batch_id).stage).toBe('committed');
    const honesty = readShadowRuns(dataRoot, { limit: 50 })
      .filter((row) => row.type === 'shadow_report_honesty');
    expect(honesty).toHaveLength(0);

    const second = await runCognitiveShadowReaction(ctx, { skipInvestigate: true });
    expect(second.skipped).toBe(true);
    expect(readClaimLedger(dataRoot).claims.filter((claim) => claim.status === 'claimed')).toHaveLength(0);
  });

  it('does not emit a second honesty event when the report file already exists', async () => {
    const dataRoot = makeDataRoot('jea-reactor-honesty-resume-');
    seedEvolutionEvents(dataRoot, 1);
    const claimed = claimEvidenceBatch(dataRoot, { reactor: 'cognitive', limit: 1 });
    const reportPath = writeShadowReport(dataRoot, claimed.batch_id, [
      '# Shadow Cognitive Reactor Report',
      '',
      '## Seen',
      '- existing',
      '',
      '## Inferred',
      '- resumed',
      '',
      '## Cyber-Taoist analysis',
      '- ok',
      '',
      '## Next cycle suggestions',
      '- continue',
      '',
    ].join('\n'));
    writeBatchCheckpoint(dataRoot, {
      batch_id: claimed.batch_id,
      reactor: 'cognitive',
      subject: 'demo',
      stage: 'investigate',
      event_ids: claimed.events.map((item) => item.id),
      evidence_keys: claimed.events.map((item) => `${item.kind}:${item.id}`),
      report_path: reportPath,
      report_source: 'fallback',
    });
    appendShadowRun(dataRoot, {
      batch_id: claimed.batch_id,
      type: 'shadow_report_honesty',
      status: 'ok',
      findings_count: 0,
    });

    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const aiClient = new MockToolsAIClient({
      defaultResponse: { decision: 'execute', actions: [] },
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
      runtime: { dataRoot, runtimeRoot: tempDir, subject: 'demo' },
      store,
      projectRoot: tempDir,
    };

    await runCognitiveShadowReaction(ctx, { skipInvestigate: true });
    const honesty = readShadowRuns(dataRoot, { limit: 50 })
      .filter((row) => row.type === 'shadow_report_honesty');
    expect(honesty).toHaveLength(1);
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
