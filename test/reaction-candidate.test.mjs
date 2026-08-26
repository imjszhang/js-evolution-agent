import { afterEach, describe, expect, it } from 'vitest';
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
import { randomUUID } from 'node:crypto';
import { INITIAL_ACTIVATION_POLICY_VERSION } from '../src/contracts/index.mjs';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import {
  assembleReactionCandidates,
  measureCandidateAmplification,
  reactionCandidateId,
  resolveCognitiveWork,
} from '../src/evolution/reactor/reaction-candidate.mjs';
import { runCognitiveShadowReaction } from '../src/evolution/reactor/cognitive-reactor.mjs';
import { readBatchCheckpoint, writeBatchCheckpoint } from '../src/evolution/reactor/batch-checkpoint-store.mjs';
import { claimEvidenceBatch, readClaimLedger } from '../src/evolution/reactor/claim-ledger.mjs';
import { readShadowDecisions, readShadowRuns, writeShadowReport } from '../src/evolution/reactor/shadow-store.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { writePendingOperatorFact } from '../src/intelligence/operator-facts.mjs';
import {
  assertIntelReportEvidenceHonesty,
  POISON_INTENT_CLAIM_E2E,
} from './helpers/intel-report-honesty-assert.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

class CountingToolsClient extends MockToolsAIClient {
  constructor(opts = {}) {
    super(opts);
    this.llmCalls = 0;
  }

  async chat(message, thinking, timeout) {
    this.llmCalls += 1;
    return super.chat(message, thinking, timeout);
  }

  async chatMessagesWithTools(messages, opts) {
    this.llmCalls += 1;
    return super.chatMessagesWithTools(messages, opts);
  }
}

function makeRuntime(prefix = 'jea-reaction-candidate-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  const runtime = {
    subject: 'alpha',
    dataNamespace: 'alpha',
    runtimeRoot: tempDir,
    dataRoot: join(tempDir, 'data'),
  };
  mkdirSync(join(runtime.dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
  mkdirSync(join(runtime.dataRoot, 'intelligence', 'reports'), { recursive: true });
  mkdirSync(join(runtime.dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
  mkdirSync(join(runtime.dataRoot, 'evolution', 'verify_reports'), { recursive: true });
  mkdirSync(join(runtime.dataRoot, 'channel'), { recursive: true });
  mkdirSync(join(runtime.dataRoot, 'goals'), { recursive: true });
  return runtime;
}

function writeJsonl(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function envelope({
  id,
  kind,
  type = kind,
  occurredAt,
  producer = 'external',
  payload = {},
  ...rest
}) {
  return {
    id,
    kind,
    type,
    occurred_at: occurredAt,
    evidence_key: `${kind}:${id}`,
    producer,
    provenance: { store: kind, file: null, id },
    payload: { producer, ...payload },
    ...rest,
  };
}

function lifecycleEnvelope(index, occurredAt) {
  const types = [
    'channel_classifier_tick',
    'channel_presence_completed',
    'channel_notify_delivered',
    'channel_task_completed',
  ];
  return envelope({
    id: `channel-lifecycle-${index}`,
    kind: 'channel_events',
    type: types[index % types.length],
    occurredAt,
    producer: 'channel',
  });
}

function defaultCanned() {
  return [
    {
      match: /Shadow Cognitive Reactor Report Task/,
      response: [
        '# Shadow Cognitive Reactor Report',
        '',
        '## Seen',
        '- will be replaced',
        '',
        '## Inferred',
        '- mock inference',
        '',
        '## Cyber-Taoist analysis',
        '- candidate path',
        '',
        '## Next cycle suggestions',
        '- continue',
      ].join('\n'),
    },
    {
      match: /Strategic Analysis & Decision/,
      response: {
        decision: 'execute',
        actions: [{
          type: 'record_observation',
          description: `candidate note ${randomUUID().slice(0, 8)}`,
          serves_goal: 'bootstrap',
          params: {
            content: 'candidate observation',
            context: { no_belief_reason: 'record_only' },
          },
        }],
        goal_coverage: { covered: ['bootstrap'], not_covered: {} },
        deferred: [],
        risk_mitigation: [],
        confidence_score: 0.4,
      },
    },
  ];
}

function buildCtx(runtime, aiClient) {
  const store = createIntelligenceStore({
    baseDir: join(runtime.dataRoot, 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  return {
    store,
    ctx: {
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
      projectRoot: runtime.runtimeRoot,
    },
  };
}

describe('reaction candidate assembly', () => {
  it('produces deterministic IDs for the same ordered activation set and policy version', () => {
    const claimed = [
      envelope({
        id: 'brief-1',
        kind: 'operator_briefs',
        type: 'verification_request',
        occurredAt: '2026-08-25T01:00:00.000Z',
        producer: 'operator',
        payload: { summary: 'check rank' },
      }),
      envelope({
        id: 'receipt-1',
        kind: 'action_receipts',
        type: 'agent_run',
        occurredAt: '2026-08-25T01:01:00.000Z',
        producer: 'exec',
        execution_id: 'exec-1',
        payload: { status: 'failed', execution_id: 'exec-1' },
      }),
    ];
    const first = assembleReactionCandidates(claimed);
    const second = assembleReactionCandidates([...claimed].reverse());
    const ids = first.candidates.map((item) => item.candidate_id).sort();
    expect(ids).toEqual(second.candidates.map((item) => item.candidate_id).sort());
    expect(ids.every((id) => id.startsWith('rc1/'))).toBe(true);

    const otherPolicy = assembleReactionCandidates(claimed, {
      policyVersion: 'activation-policy.v2',
    });
    expect(otherPolicy.candidates.map((item) => item.candidate_id).sort())
      .not.toEqual(ids);

    const rebuilt = reactionCandidateId({
      policyVersion: INITIAL_ACTIVATION_POLICY_VERSION,
      grouping: first.candidates[0].grouping,
      includedKeys: first.candidates[0].included.map((item) => item.evidence_key),
      coalescedSignature: first.candidates[0].coalesced.map((item) => [
        item.type,
        item.count,
        item.first_at,
        item.last_at,
        ...(item.evidence_keys || []),
      ].join(':')),
      splitIndex: first.candidates[0].split_index,
    });
    expect(rebuilt).toBe(first.candidates[0].candidate_id);
  });

  it('groups one execution/belief chain without losing typed refs', () => {
    const claimed = [
      envelope({
        id: 'receipt-chain',
        kind: 'action_receipts',
        type: 'agent_run',
        occurredAt: '2026-08-25T02:00:00.000Z',
        producer: 'exec',
        execution_id: 'exec-chain',
        belief_id: 'belief-chain',
        producer_batch_id: 'batch-origin',
        payload: {
          status: 'failed',
          execution_id: 'exec-chain',
          belief_id: 'belief-chain',
          producer_batch_id: 'batch-origin',
        },
      }),
      envelope({
        id: 'verify-chain',
        kind: 'verify_reports',
        type: 'verify_reports',
        occurredAt: '2026-08-25T02:01:00.000Z',
        producer: 'verify',
        execution_id: 'exec-chain',
        belief_id: 'belief-chain',
        producer_batch_id: 'batch-origin',
        payload: {
          execution_id: 'exec-chain',
          belief_id: 'belief-chain',
          producer_batch_id: 'batch-origin',
          semantic: { ok: false },
          pending: [{ id: 'receipt-chain', reason: 'expected_output_mismatch' }],
        },
      }),
    ];
    const assembly = assembleReactionCandidates(claimed);
    const work = resolveCognitiveWork(assembly);
    expect(work.invoke_llm).toBe(true);
    expect(work.candidate.grouping.execution_id).toBe('exec-chain');
    expect(work.candidate.grouping.belief_id).toBe('belief-chain');
    expect(work.candidate.grouping.producer_batch_id).toBe('batch-origin');
    expect(work.candidate.included.map((item) => item.source_ref)).toEqual([
      'action_receipts:receipt-chain',
      'verify_reports:verify-chain',
    ]);
    expect(work.candidate.included.every((item) => item.honesty_safe_ref || item.kind === 'verify_reports'))
      .toBe(true);
  });

  it('coalesces Channel lifecycle and does not treat a raw 16-batch as one LLM', () => {
    const claimed = Array.from({ length: 16 }, (_, index) => (
      lifecycleEnvelope(index, `2026-08-25T03:0${index % 6}:00.000Z`)
    ));
    const work = resolveCognitiveWork(assembleReactionCandidates(claimed));
    expect(work.invoke_llm).toBe(false);
    expect(work.skip_reason).toBe('no_decision_relevant_delta');
    expect(work.candidate.coalesced.reduce((sum, item) => sum + item.count, 0)).toBe(16);
    expect(work.candidate.included).toHaveLength(0);
    expect(work.candidate.estimated_cost.llm_phases).toEqual([]);
  });

  it('splits oversized groups deterministically without breaking causal order', () => {
    const claimed = Array.from({ length: 20 }, (_, index) => envelope({
      id: `receipt-big-${String(index).padStart(2, '0')}`,
      kind: 'action_receipts',
      type: 'agent_run',
      occurredAt: `2026-08-25T04:${String(index).padStart(2, '0')}:00.000Z`,
      producer: 'exec',
      execution_id: 'exec-oversized',
      payload: { status: 'failed', execution_id: 'exec-oversized' },
    }));
    const assembly = assembleReactionCandidates(claimed, { maxIncluded: 8 });
    expect(assembly.candidates.length).toBeGreaterThan(1);
    expect(assembly.candidates.every((item) => item.grouping.execution_id === 'exec-oversized')).toBe(true);
    expect(assembly.candidates.map((item) => item.split_index)).toEqual(
      assembly.candidates.map((_, index) => index),
    );
    const flattened = assembly.candidates.flatMap((item) => item.included.map((entry) => entry.evidence_key));
    expect(flattened).toEqual(claimed.map((item) => item.evidence_key));
    expect(new Set(assembly.candidates.map((item) => item.candidate_id)).size)
      .toBe(assembly.candidates.length);
  });
});

describe('cognitive consumption of reaction candidates', () => {
  it('skips report/Decide LLM when the candidate has no decision-relevant delta', async () => {
    const runtime = makeRuntime('jea-candidate-noop-');
    writeJsonl(
      join(runtime.dataRoot, 'channel', 'events.jsonl'),
      Array.from({ length: 16 }, (_, index) => ({
        id: `channel-lifecycle-${index}`,
        type: [
          'channel_classifier_tick',
          'channel_presence_completed',
          'channel_notify_delivered',
          'channel_task_completed',
        ][index % 4],
        recorded_at: `2026-08-25T05:${String(index).padStart(2, '0')}:00.000Z`,
        subject: 'alpha',
        producer: 'channel',
      })),
    );
    const aiClient = new CountingToolsClient({ canned: defaultCanned() });
    const { ctx } = buildCtx(runtime, aiClient);
    const result = await runCognitiveShadowReaction(ctx, {
      batchLimit: 16,
      skipInvestigate: true,
    });
    expect(result.llm_skipped).toBe(true);
    expect(result.skip_reason).toBe('no_decision_relevant_delta');
    expect(result.mechanical_reason).toMatch(/no decision-relevant/);
    expect(result.report_path).toBeNull();
    expect(aiClient.llmCalls).toBe(0);
    expect(result.candidate.decision_relevant).toBe(false);
    expect(existsSync(join(runtime.dataRoot, 'evolution', 'reactor', 'activation-ledger.json'))).toBe(false);
    expect(existsSync(join(runtime.dataRoot, 'evolution', 'reactor', 'inbox.json'))).toBe(false);
    const completed = readShadowRuns(runtime.dataRoot, { limit: 20 })
      .filter((row) => row.type === 'shadow_reaction_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].llm_skipped).toBe(true);
  });

  it('keeps operator brief/fact and verify contradiction actionable', async () => {
    const runtime = makeRuntime('jea-candidate-actionable-');
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-actionable',
      summary: 'Please verify the rank regression',
    });
    writePendingOperatorFact(runtime.runtimeRoot, {
      id: 'fact-actionable',
      content: 'standing.rank lower is better',
    });
    writeFileSync(join(runtime.dataRoot, 'evolution', 'verify_reports', 'cycle-verify-actionable.json'), JSON.stringify({
      cycle_id: 'cycle-verify-actionable',
      timestamp: '2026-08-25T06:00:00.000Z',
      verified: [],
      pending: [{ id: 'receipt-missing', reason: 'expected_output_mismatch' }],
      semantic: { ok: false, timestamp: '2026-08-25T06:00:00.000Z' },
      producer: 'verify',
    }));
    const aiClient = new CountingToolsClient({ canned: defaultCanned() });
    const { ctx } = buildCtx(runtime, aiClient);
    const result = await runCognitiveShadowReaction(ctx, {
      batchLimit: 16,
      skipInvestigate: true,
    });
    expect(result.llm_skipped).toBe(false);
    expect(aiClient.llmCalls).toBeGreaterThanOrEqual(2);
    const roles = new Set((result.candidate?.included || []).map((item) => item.role));
    expect([...roles].some((role) => (
      role === 'operator_brief' || role === 'operator_fact' || role === 'expected_output_contradiction'
    ))).toBe(true);
    const decisions = readShadowDecisions(runtime.dataRoot).decisions;
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].producer_batch_id).toMatch(/^batch-/);
    expect(decisions[0].reaction_id).toBeTruthy();
    expect(decisions[0].decision_id).toBe(decisions[0].id);
    expect(decisions[0].action.params.context.no_belief_reason).toBe('record_only');
  });

  it('resumes after assembly without duplicate report or decision writes', async () => {
    const runtime = makeRuntime('jea-candidate-resume-');
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-resume',
      summary: 'Resume after candidate assembly',
    });
    const claimed = claimEvidenceBatch(runtime.dataRoot, { reactor: 'cognitive', limit: 4 });
    const assembly = assembleReactionCandidates(claimed.events, {
      pendingBriefs: [{ id: 'brief-resume', kind: 'verification_request', created_at: '2026-08-25T07:00:00.000Z' }],
    });
    const work = resolveCognitiveWork(assembly);
    expect(work.invoke_llm).toBe(true);
    writeBatchCheckpoint(runtime.dataRoot, {
      batch_id: claimed.batch_id,
      reactor: 'cognitive',
      subject: 'alpha',
      stage: 'claimed',
      event_ids: claimed.events.map((item) => item.id),
      evidence_keys: claimed.events.map((item) => `${item.kind}:${item.id}`),
      assembly_completed: true,
      candidate: work.candidate,
    });
    const aiClient = new CountingToolsClient({ canned: defaultCanned() });
    const { ctx } = buildCtx(runtime, aiClient);
    const first = await runCognitiveShadowReaction(ctx, { skipInvestigate: true });
    expect(first.batch_id).toBe(claimed.batch_id);
    expect(first.llm_skipped).toBe(false);
    const reportPath = first.report_path;
    const reportHash = readFileSync(reportPath, 'utf8');
    const decisionsAfterFirst = readShadowDecisions(runtime.dataRoot).decisions.length;
    const honestyAfterFirst = readShadowRuns(runtime.dataRoot, { limit: 50 })
      .filter((row) => row.type === 'shadow_report_honesty').length;

    const second = await runCognitiveShadowReaction(ctx, { skipInvestigate: true });
    expect(second.skipped).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toBe(reportHash);
    expect(readShadowDecisions(runtime.dataRoot).decisions).toHaveLength(decisionsAfterFirst);
    expect(readShadowRuns(runtime.dataRoot, { limit: 50 })
      .filter((row) => row.type === 'shadow_report_honesty')).toHaveLength(honestyAfterFirst);
    expect(readBatchCheckpoint(runtime.dataRoot, claimed.batch_id).stage).toBe('committed');
    expect(readClaimLedger(runtime.dataRoot).claims.filter((claim) => claim.status === 'claimed')).toHaveLength(0);
  });

  it('keeps host-owned Seen honesty on the report path', async () => {
    const runtime = makeRuntime('jea-candidate-honesty-');
    writeJsonl(join(runtime.dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), [{
      id: 'evt-candidate-honesty',
      type: 'exec_pipeline',
      recorded_at: '2026-08-25T08:00:00.000Z',
      status: 'ok',
      producer: 'exec',
    }]);
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-honesty',
      kind: 'verification_request',
      summary: POISON_INTENT_CLAIM_E2E,
      desired_decision_effect: 'must not appear in Seen',
    });
    const aiClient = new CountingToolsClient({
      canned: [
        {
          match: /Shadow Cognitive Reactor Report Task/,
          response: [
            '# Candidate honesty',
            '',
            '## Seen',
            `- ${POISON_INTENT_CLAIM_E2E} promoted as fact`,
            '- bare bullet',
            '',
            '## Inferred',
            `- Brief intent ${POISON_INTENT_CLAIM_E2E} stays out of Seen.`,
            '',
            '## Cyber-Taoist analysis',
            '- Host splice owns Seen.',
            '',
            '## Next cycle suggestions',
            '- Continue.',
          ].join('\n'),
        },
        defaultCanned()[1],
      ],
    });
    const { ctx, store } = buildCtx(runtime, aiClient);
    store.ingest('intel_observations', {
      id: 'obs-candidate-honesty',
      kind: 'observation',
      source: 'test',
      subject: 'alpha',
      content: 'honesty fixture observation',
    });
    const result = await runCognitiveShadowReaction(ctx, {
      batchLimit: 8,
      skipInvestigate: true,
    });
    expect(result.llm_skipped).toBe(false);
    expect(result.honesty?.status).toBe('ok');
    assertIntelReportEvidenceHonesty({
      store,
      markdown: readFileSync(result.report_path, 'utf8'),
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
      minSeenBulletsWithRefs: 1,
      runtimeRoot: runtime.runtimeRoot,
    });
  });
});

describe('baseline-style amplification vs raw 16-batching', () => {
  it('reduces Cognitive LLM calls without losing seeded actionable cases', () => {
    const envelopes = [];
    for (let index = 0; index < 64; index += 1) {
      envelopes.push(lifecycleEnvelope(index, `2026-05-01T${String(index % 20).padStart(2, '0')}:00:00.000Z`));
    }
    for (let index = 0; index < 12; index += 1) {
      envelopes.push(envelope({
        id: `channel-message-${index}`,
        kind: 'channel_events',
        type: 'channel_message_received',
        occurredAt: `2026-08-25T10:${String(index).padStart(2, '0')}:00.000Z`,
        producer: 'channel',
        payload: { text: `operator chat ${index}`, activation_targets: ['cognitive'] },
      }));
    }
    for (let index = 0; index < 3; index += 1) {
      envelopes.push(envelope({
        id: `brief-seed-${index}`,
        kind: 'operator_briefs',
        type: 'verification_request',
        occurredAt: `2026-08-25T11:0${index}:00.000Z`,
        producer: 'operator',
        payload: { summary: `seeded brief ${index}` },
      }));
    }
    for (let index = 0; index < 2; index += 1) {
      envelopes.push(envelope({
        id: `fact-seed-${index}`,
        kind: 'operator_facts',
        type: 'operator_fact',
        occurredAt: `2026-08-25T11:1${index}:00.000Z`,
        producer: 'operator',
        payload: { content: `seeded fact ${index}` },
      }));
    }
    for (let index = 0; index < 2; index += 1) {
      envelopes.push(envelope({
        id: `verify-seed-${index}`,
        kind: 'verify_reports',
        type: 'verify_reports',
        occurredAt: `2026-08-25T11:2${index}:00.000Z`,
        producer: 'verify',
        payload: {
          semantic: { ok: false },
          pending: [{ id: `receipt-seed-${index}`, reason: 'expected_output_mismatch' }],
        },
      }));
    }
    const measured = measureCandidateAmplification(envelopes);
    expect(measured.raw.raw_records).toBe(83);
    expect(measured.raw.llm_calls).toBe(12);
    expect(measured.candidate.llm_calls).toBeLessThan(measured.raw.llm_calls);
    expect(measured.reduction.ratio).toBeGreaterThanOrEqual(0.4);
    expect(measured.candidate.seeded_actionable.operator_briefs).toBe(3);
    expect(measured.candidate.seeded_actionable.operator_facts).toBe(2);
    expect(measured.candidate.seeded_actionable.expected_output_contradiction).toBe(2);
    expect(measured.candidate.seeded_actionable.semantic_operator_channel).toBe(12);
  });
});

describe('checkpoint compatibility', () => {
  it('does not rewrite an already persisted report when resuming from report stage', async () => {
    const runtime = makeRuntime('jea-candidate-report-resume-');
    writeJsonl(join(runtime.dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), [{
      id: 'evt-resume-report',
      type: 'exec_pipeline',
      recorded_at: '2026-08-25T09:00:00.000Z',
      status: 'ok',
      producer: 'exec',
    }]);
    const claimed = claimEvidenceBatch(runtime.dataRoot, { reactor: 'cognitive', limit: 1 });
    const reportPath = writeShadowReport(runtime.dataRoot, claimed.batch_id, [
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
    writeBatchCheckpoint(runtime.dataRoot, {
      batch_id: claimed.batch_id,
      reactor: 'cognitive',
      subject: 'alpha',
      stage: 'report',
      event_ids: claimed.events.map((item) => item.id),
      evidence_keys: claimed.events.map((item) => `${item.kind}:${item.id}`),
      report_path: reportPath,
      report_source: 'fallback',
      honesty: { status: 'ok', findings_count: 0 },
    });
    const aiClient = new CountingToolsClient({ canned: defaultCanned() });
    const { ctx } = buildCtx(runtime, aiClient);
    const result = await runCognitiveShadowReaction(ctx, { skipInvestigate: true });
    expect(result.batch_id).toBe(claimed.batch_id);
    expect(readFileSync(reportPath, 'utf8')).toContain('resumed');
    expect(readShadowRuns(runtime.dataRoot, { limit: 20 })
      .filter((row) => row.type === 'shadow_report_honesty')).toHaveLength(0);
  });
});
