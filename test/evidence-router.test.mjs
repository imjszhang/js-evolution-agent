import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVATION_PRIORITY,
  EVIDENCE_SOURCE_KINDS,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  formatActivationIdentity,
  isReactorControlPlaneAuthoritative,
  validateActivationLedgerEntry,
} from '../src/contracts/index.mjs';
import {
  activationLedgerPath,
  getActivationLedgerEntry,
  listActivationLedgerEntries,
  readActivationLedger,
} from '../src/evolution/reactor/activation-ledger-store.mjs';
import {
  ACTIVATION_POLICY_VERSION,
  classifyChannelEventClass,
  evaluateEvidenceActivation,
  evaluateRouterPolicyChange,
  extractGroupingIdentity,
  hasExplicitActivationIntent,
  isChannelLifecycleEvent,
  isCognitiveSelfOutput,
  isCommittedSettlementEvidence,
  isDecisionRelevantReceipt,
  isExpectedOutputContradiction,
  isLegacyBroadcastTargets,
  isSemanticOperatorChannelInput,
  listActivationPolicyTable,
  routeEvidenceDelta,
  routeJournalGenerationChange,
} from '../src/evolution/reactor/evidence-router.mjs';

const AT = '2026-08-25T05:00:00.000Z';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function dataRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-evidence-router-'));
  return tempDir;
}

function envelope(kind, id, overrides = {}) {
  const { payload, grouping, ...rest } = overrides;
  return {
    id,
    kind,
    type: rest.type ?? kind,
    occurred_at: rest.occurred_at ?? AT,
    evidence_key: rest.evidence_key ?? `${kind}:${id}`,
    provenance: rest.provenance ?? { store: kind, file: `${kind}.jsonl`, id },
    subject: rest.subject ?? 'alpha',
    payload: payload ?? {},
    ...rest,
    ...(grouping ? { grouping } : {}),
  };
}

function replayEpoch(overrides = {}) {
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    id: 'replay-epoch-policy-v2',
    kind: 'policy_backfill',
    from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    to_activation_policy_version: 'activation-policy.v2',
    created_at: AT,
    reason: 'eligibility rule change',
    authorized: true,
    preview: false,
    ...overrides,
  };
}

function reactorsOf(result) {
  return (result.created || result.activations || []).map((entry) => entry.reactor).sort();
}

function expectValidEntries(entries) {
  for (const entry of entries) {
    expect(validateActivationLedgerEntry(entry).ok, validateActivationLedgerEntry(entry).errors?.join('; ')).toBe(true);
    expect(entry).not.toHaveProperty('payload');
    expect(entry).not.toHaveProperty('secret');
  }
}

describe('activation policy table', () => {
  it('documents every evidence source kind and stays on v1', () => {
    expect(ACTIVATION_POLICY_VERSION).toBe('activation-policy.v1');
    expect(ACTIVATION_POLICY_VERSION).toBe(INITIAL_ACTIVATION_POLICY_VERSION);
    const kinds = new Set(listActivationPolicyTable().map((row) => row.kind));
    for (const kind of EVIDENCE_SOURCE_KINDS) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });
});

describe('explicit operator brief/fact', () => {
  it('creates one high-priority realtime Cognitive activation for an operator brief', () => {
    const root = dataRoot();
    const brief = envelope('operator_briefs', 'brief-1', {
      type: 'operator_brief',
      producer: 'operator',
      activation_targets: ['cognitive'],
      activation_reason: 'operator_brief',
      producer_batch_id: 'batch-brief',
      payload: { producer: 'operator', activation_targets: ['cognitive'] },
    });
    const routed = routeEvidenceDelta(root, { envelopes: [brief], subject: 'alpha', now: AT });
    expect(routed.authoritative).toBe(false);
    expect(routed.scanned).toBe(1);
    expect(reactorsOf(routed)).toEqual(['cognitive']);
    expectValidEntries(routed.created);
    const entry = routed.created[0];
    expect(entry.lane).toBe('realtime');
    expect(entry.priority).toBe(ACTIVATION_PRIORITY.HIGH);
    expect(entry.activation_reason).toBe('operator_brief');
    expect(entry.origin).toBe('explicit');
    expect(entry.state).toBe('ready');
    expect(entry.identity_key).toBe(
      `aiv1/cognitive/${INITIAL_ACTIVATION_POLICY_VERSION}/operator_briefs:brief-1`,
    );
    expect(entry.grouping.producer_batch_id).toBe('batch-brief');
  });

  it('creates one high-priority realtime Cognitive activation for an operator fact', () => {
    const fact = envelope('operator_facts', 'fact-1', {
      type: 'operator_fact',
      producer: 'operator',
      activation_targets: ['cognitive'],
      payload: { producer: 'operator', activation_targets: ['cognitive'] },
    });
    const evaluated = evaluateEvidenceActivation(fact, { now: AT, subject: 'alpha' });
    expect(evaluated.activations).toHaveLength(1);
    expect(evaluated.activations[0]).toMatchObject({
      reactor: 'cognitive',
      lane: 'realtime',
      activation_reason: 'operator_fact',
      priority: ACTIVATION_PRIORITY.HIGH,
      origin: 'explicit',
    });
  });
});

describe('expected-output contradiction', () => {
  it('creates Cognitive and Rule activations without duplicates', () => {
    const root = dataRoot();
    const report = envelope('verify_reports', 'verify-contra', {
      type: 'verify_report',
      producer: 'verify',
      execution_id: 'exec-1',
      decision_id: 'dec-1',
      reaction_id: 'rxn-1',
      belief_id: 'belief-1',
      producer_batch_id: 'batch-verify',
      payload: {
        producer: 'verify',
        activation_targets: ['cognitive', 'rule'],
        comparison: {
          status: 'contradicted',
          settlement_signal: { trigger: true, target: 'rule', reason: 'expected_output_contradicted' },
          actions: [{ status: 'contradicted' }],
        },
      },
    });
    expect(isExpectedOutputContradiction(report)).toBe(true);
    const first = routeEvidenceDelta(root, { envelopes: [report], now: AT });
    expect(reactorsOf(first)).toEqual(['cognitive', 'rule']);
    expectValidEntries(first.created);
    expect(first.created.every((entry) => entry.lane === 'realtime')).toBe(true);
    expect(first.created.every((entry) => entry.activation_reason === 'expected_output_contradiction')).toBe(true);
    expect(first.created.every((entry) => entry.priority === ACTIVATION_PRIORITY.HIGH)).toBe(true);
    expect(first.created.every((entry) => entry.grouping.execution_id === 'exec-1')).toBe(true);
    expect(first.created.every((entry) => entry.grouping.belief_id === 'belief-1')).toBe(true);

    const second = routeEvidenceDelta(root, { envelopes: [report], now: AT });
    expect(second.created).toHaveLength(0);
    expect(second.reused).toHaveLength(2);
    expect(listActivationLedgerEntries(root)).toHaveLength(2);
    expect(second.diagnostics.some((item) => item.outcome === 'duplicate')).toBe(true);
  });

  it('does not treat a matched verify report as contradiction work', () => {
    const report = envelope('verify_reports', 'verify-ok', {
      payload: {
        activation_targets: ['cognitive', 'rule'],
        comparison: { status: 'matched', actions: [{ status: 'matched' }] },
      },
    });
    const evaluated = evaluateEvidenceActivation(report, { now: AT });
    expect(evaluated.activations).toEqual([]);
    expect(evaluated.diagnostics.some((item) => item.code === 'verify_report_not_contradicted')).toBe(true);
  });
});

describe('action receipts', () => {
  it('activates Rule only for a normal 0.2.x broadcast receipt', () => {
    const receipt = envelope('action_receipts', 'receipt-1', {
      type: 'record_observation',
      producer: 'exec',
      payload: {
        producer: 'exec',
        activation_targets: ['cognitive', 'rule'],
        action_type: 'record_observation',
      },
    });
    expect(isLegacyBroadcastTargets(receipt)).toBe(true);
    expect(isDecisionRelevantReceipt(receipt)).toBe(false);
    const evaluated = evaluateEvidenceActivation(receipt, { now: AT });
    expect(reactorsOf(evaluated)).toEqual(['rule']);
    expect(evaluated.activations[0]).toMatchObject({
      lane: 'replay',
      origin: 'legacy_fallback',
      activation_reason: 'legacy_fallback',
      priority: ACTIVATION_PRIORITY.NORMAL,
    });
  });

  it('activates Cognitive only under an explicit decision-relevant rule', () => {
    const receipt = envelope('action_receipts', 'receipt-relevant', {
      producer: 'exec',
      activation_reason: 'decision_relevant_receipt',
      activation_targets: ['cognitive', 'rule'],
      payload: { producer: 'exec', decision_relevant: true, activation_targets: ['cognitive', 'rule'] },
    });
    expect(isDecisionRelevantReceipt(receipt)).toBe(true);
    const evaluated = evaluateEvidenceActivation(receipt, { now: AT });
    expect(reactorsOf(evaluated)).toEqual(['cognitive', 'rule']);
    expect(evaluated.activations.every((entry) => entry.lane === 'realtime')).toBe(true);
    expect(evaluated.activations.every((entry) => entry.activation_reason === 'decision_relevant_receipt')).toBe(true);
    expect(evaluated.activations.every((entry) => entry.priority === ACTIVATION_PRIORITY.HIGH)).toBe(true);
  });
});

describe('channel events', () => {
  it.each([
    ['channel_message_sent'],
    ['channel_presence_tick'],
    ['channel_notify_retry_scheduled'],
    ['channel_task_enqueued'],
    ['channel_speech_generated'],
    ['channel_deliverable_dispatched'],
    ['channel_inbound_completed'],
    ['channel_worker_started'],
  ])('does not activate Cognitive for lifecycle %s', (type) => {
    const event = envelope('channel_events', `ch-${type}`, {
      type,
      producer: 'channel',
      payload: { type, producer: 'channel' },
    });
    expect(isChannelLifecycleEvent(event)).toBe(true);
    expect(classifyChannelEventClass(event)).toBe('lifecycle');
    const evaluated = evaluateEvidenceActivation(event, { now: AT });
    expect(evaluated.activations).toEqual([]);
    expect(evaluated.diagnostics.some((item) => item.code === 'channel_lifecycle')).toBe(true);
  });

  it('activates realtime Cognitive for semantic operator Channel input', () => {
    const event = envelope('channel_events', 'ch-ingested', {
      type: 'channel_message_ingested',
      producer: 'channel',
      payload: {
        type: 'channel_message_ingested',
        producer: 'channel',
        classifier: {
          classification: 'verification_request',
          understanding: { user_intent: 'please verify rank', needs_immediate_action: true },
        },
      },
    });
    expect(isSemanticOperatorChannelInput(event)).toBe(true);
    const evaluated = evaluateEvidenceActivation(event, { now: AT });
    expect(evaluated.activations).toHaveLength(1);
    expect(evaluated.activations[0]).toMatchObject({
      reactor: 'cognitive',
      lane: 'realtime',
      activation_reason: 'semantic_operator_channel',
      priority: ACTIVATION_PRIORITY.HIGH,
    });
  });
});

describe('cognitive self-loop', () => {
  it('does not let Cognitive reports or evolution events self-reactivate Cognitive', () => {
    const report = envelope('reports', 'report-1', {
      type: 'reactor_report',
      producer: 'cognitive',
      activation_targets: ['cognitive'],
      payload: { producer: 'cognitive', pipeline: 'reactor', activation_targets: ['cognitive'] },
    });
    const event = envelope('evolution_events', 'evt-1', {
      type: 'reactor_pipeline',
      producer: 'cognitive',
      payload: { producer: 'cognitive', type: 'reactor_pipeline', activation_targets: [] },
    });
    expect(isCognitiveSelfOutput(report)).toBe(true);
    expect(isCognitiveSelfOutput(event)).toBe(true);
    expect(evaluateEvidenceActivation(report, { now: AT }).activations).toEqual([]);
    expect(evaluateEvidenceActivation(event, { now: AT }).activations).toEqual([]);
    expect(evaluateEvidenceActivation(report, { now: AT }).diagnostics.some((item) => item.code === 'cognitive_self_loop' || item.code === 'explicit_empty_targets' || item.code === 'cognitive_self_loop')).toBe(true);
  });

  it('rejects Cognitive even when a cognitive report lists cognitive as a target', () => {
    const report = envelope('reports', 'report-2', {
      producer: 'cognitive',
      activation_targets: ['cognitive', 'memory'],
      payload: { producer: 'cognitive', source: 'reactor' },
    });
    const evaluated = evaluateEvidenceActivation(report, { now: AT });
    expect(evaluated.activations.map((entry) => entry.reactor)).not.toContain('cognitive');
    expect(evaluated.diagnostics.some((item) => item.code === 'cognitive_self_loop')).toBe(true);
  });
});

describe('legacy 0.2.x fallback', () => {
  it('marks honest fallback and uses replay when realtime intent cannot be established', () => {
    const legacyBrief = envelope('operator_briefs', 'legacy-brief', {
      type: 'operator_brief',
      producer: 'operator',
      payload: { producer: 'operator' },
    });
    expect(hasExplicitActivationIntent(legacyBrief)).toBe(false);
    const evaluated = evaluateEvidenceActivation(legacyBrief, { now: AT });
    expect(evaluated.activations).toHaveLength(1);
    expect(evaluated.activations[0]).toMatchObject({
      reactor: 'cognitive',
      lane: 'replay',
      origin: 'legacy_fallback',
      activation_reason: 'legacy_fallback',
    });
    expect(evaluated.diagnostics.some((item) => item.outcome === 'legacy')).toBe(true);
  });

  it('does not fabricate a contradiction from a 0.2.x verify report without comparison', () => {
    const legacyVerify = envelope('verify_reports', 'legacy-verify', {
      producer: 'verify',
      payload: { producer: 'verify' },
    });
    const evaluated = evaluateEvidenceActivation(legacyVerify, { now: AT });
    expect(evaluated.activations).toEqual([]);
    expect(evaluated.diagnostics.some((item) => (
      item.outcome === 'legacy' && item.code === 'verify_report_not_contradicted'
    ))).toBe(true);
  });
});

describe('every evidence kind', () => {
  it('covers default routing for each source kind', () => {
    const cases = [
      {
        envelope: envelope('operator_questions', 'q-1', { payload: { kind: 'operator_question' } }),
        reactors: [],
        code: 'no_documented_activation',
      },
      {
        envelope: envelope('probe_results', 'probe-1', {
          payload: { activation_targets: ['cognitive', 'rule'] },
        }),
        reactors: [],
        code: 'no_documented_activation',
      },
      {
        envelope: envelope('intel_observations', 'obs-1', { type: 'observation', payload: { kind: 'observation' } }),
        reactors: [],
        code: 'no_documented_activation',
      },
      {
        envelope: envelope('belief_events', 'belief-open', {
          type: 'updated',
          payload: { type: 'updated', belief_id: 'b-1' },
        }),
        reactors: [],
        code: 'belief_goal_uncommitted',
      },
      {
        envelope: envelope('goal_events', 'goal-open', {
          type: 'updated',
          payload: { type: 'updated' },
        }),
        reactors: [],
        code: 'belief_goal_uncommitted',
      },
      {
        envelope: envelope('belief_events', 'belief-settled', {
          type: 'validate',
          settlement_id: 'settlement-1',
          payload: {
            type: 'validate',
            settlement_id: 'settlement-1',
            settlement_effect: 'belief',
            producer: 'rule',
            activation_targets: ['cognitive'],
          },
        }),
        reactors: ['memory'],
        code: 'legacy_fallback_committed_settlement',
      },
      {
        envelope: envelope('goal_events', 'goal-settled', {
          type: 'calibrate',
          payload: { settlement_id: 'settlement-2', settlement_effect: 'goal_calibrate' },
        }),
        reactors: ['memory'],
      },
      {
        envelope: envelope('evolution_events', 'evt-exec', {
          type: 'exec_pipeline',
          producer: 'exec',
          payload: { producer: 'exec', activation_targets: ['cognitive', 'rule'] },
        }),
        reactors: [],
        code: 'no_documented_activation',
      },
      {
        envelope: envelope('reports', 'report-external', {
          producer: 'external',
          payload: { producer: 'external' },
        }),
        reactors: [],
        code: 'no_documented_activation',
      },
    ];

    for (const item of cases) {
      if (item.envelope.kind === 'belief_events' && item.envelope.settlement_id) {
        expect(isCommittedSettlementEvidence(item.envelope)).toBe(true);
      }
      const evaluated = evaluateEvidenceActivation(item.envelope, { now: AT });
      expect(reactorsOf(evaluated), item.envelope.evidence_key).toEqual(item.reactors);
      if (item.code) {
        expect(
          evaluated.diagnostics.some((diag) => diag.code === item.code),
          `${item.envelope.evidence_key} missing ${item.code}: ${evaluated.diagnostics.map((diag) => diag.code).join(',')}`,
        ).toBe(true);
      }
    }
  });

  it('rejects unknown kinds and empty explicit targets with diagnostics', () => {
    const unknown = evaluateEvidenceActivation(envelope('not_a_kind', 'x-1'), { now: AT });
    expect(unknown.activations).toEqual([]);
    expect(unknown.diagnostics.some((item) => item.outcome === 'unknown' && item.code === 'unknown_evidence_kind')).toBe(true);

    const empty = evaluateEvidenceActivation(envelope('evolution_events', 'evt-empty', {
      producer: 'exec',
      activation_targets: [],
      payload: { producer: 'exec', activation_targets: [] },
    }), { now: AT });
    expect(empty.activations).toEqual([]);
    expect(empty.diagnostics.some((item) => item.code === 'explicit_empty_targets')).toBe(true);
  });
});

describe('incremental and crash-safe writes', () => {
  it('routes only the supplied delta and is idempotent for the same policy', () => {
    const root = dataRoot();
    const first = envelope('operator_briefs', 'brief-a', {
      producer: 'operator',
      activation_targets: ['cognitive'],
      payload: { producer: 'operator', activation_targets: ['cognitive'] },
    });
    const second = envelope('operator_briefs', 'brief-b', {
      producer: 'operator',
      activation_targets: ['cognitive'],
      payload: { producer: 'operator', activation_targets: ['cognitive'] },
    });

    const wave1 = routeEvidenceDelta(root, { envelopes: [first], now: AT });
    expect(wave1.scanned).toBe(1);
    expect(wave1.created).toHaveLength(1);

    const wave2 = routeEvidenceDelta(root, { envelopes: [first, second], now: AT });
    expect(wave2.scanned).toBe(2);
    expect(wave2.created).toHaveLength(1);
    expect(wave2.reused).toHaveLength(1);
    expect(wave2.created[0].identity.evidence_key).toBe('operator_briefs:brief-b');

    const again = routeEvidenceDelta(root, { envelopes: [first, second], now: AT });
    expect(again.created).toHaveLength(0);
    expect(again.reused).toHaveLength(2);
    expect(listActivationLedgerEntries(root)).toHaveLength(2);
    expect(readActivationLedger(root).authoritative).toBe(false);
    expect(isReactorControlPlaneAuthoritative('activation_ledger')).toBe(false);
    expect(activationLedgerPath(root)).toContain('activation-ledger.json');
  });

  it('preserves causal grouping and does not hydrate unrelated history', () => {
    const root = dataRoot();
    const receipt = envelope('action_receipts', 'receipt-group', {
      producer: 'exec',
      producer_batch_id: 'batch-9',
      execution_id: 'exec-9',
      decision_id: 'dec-9',
      reaction_id: 'rxn-9',
      belief_id: 'belief-9',
      activation_targets: ['rule'],
      activation_reason: 'rule_receipt',
      payload: {
        producer: 'exec',
        producer_batch_id: 'batch-9',
        settlement_id: 'settlement-9',
      },
    });
    expect(extractGroupingIdentity(receipt)).toMatchObject({
      producer_batch_id: 'batch-9',
      execution_id: 'exec-9',
      decision_id: 'dec-9',
      reaction_id: 'rxn-9',
      belief_id: 'belief-9',
      settlement_id: 'settlement-9',
    });
    const routed = routeEvidenceDelta(root, { envelopes: [receipt], now: AT });
    expect(routed.created[0].grouping).toMatchObject({
      producer_batch_id: 'batch-9',
      execution_id: 'exec-9',
      settlement_id: 'settlement-9',
    });
    expect(getActivationLedgerEntry(root, routed.created[0].identity).identity_key).toBe(
      formatActivationIdentity({
        reactor: 'rule',
        evidence_key: 'action_receipts:receipt-group',
        activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      }),
    );
  });
});

describe('generation and policy epochs', () => {
  it('does not create work when journal generation changes', () => {
    const result = routeJournalGenerationChange({ from_generation: 1, to_generation: 2 });
    expect(result.creates_work).toBe(false);
    expect(result.generation.creates_work).toBe(false);
    expect(result.reappearance.kind).toBe('generation_rebuild_no_work');
    expect(result.authoritative).toBe(false);
  });

  it('refuses a silent policy backfill and requires an explicit replay epoch', () => {
    const brief = envelope('operator_briefs', 'brief-policy', {
      producer: 'operator',
      activation_targets: ['cognitive'],
      payload: { producer: 'operator', activation_targets: ['cognitive'] },
    });
    expect(evaluateRouterPolicyChange({
      to_activation_policy_version: 'activation-policy.v2',
    })).toMatchObject({ allowed: false, code: 'replay_epoch_required' });

    const blocked = evaluateEvidenceActivation(brief, {
      now: AT,
      activation_policy_version: 'activation-policy.v2',
    });
    expect(blocked.activations).toEqual([]);
    expect(blocked.diagnostics.some((item) => item.code === 'replay_epoch_required')).toBe(true);

    const allowed = evaluateEvidenceActivation(brief, {
      now: AT,
      activation_policy_version: 'activation-policy.v2',
      replay_epoch: replayEpoch(),
    });
    expect(allowed.activations).toHaveLength(1);
    expect(allowed.activations[0].identity.activation_policy_version).toBe('activation-policy.v2');
    expect(allowed.activations[0].origin).toBe('replay_epoch');
    expect(allowed.activations[0].lane).toBe('replay');
    expect(allowed.activations[0].activation_reason).toBe('policy_backfill');
    expect(allowed.activations[0].replay_epoch_id).toBe('replay-epoch-policy-v2');
    expect(validateActivationLedgerEntry(allowed.activations[0]).ok).toBe(true);
  });
});
