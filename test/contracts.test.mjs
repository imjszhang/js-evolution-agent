import { describe, expect, it } from 'vitest';
import {
  assertValidContract,
  contractModeFromEnv,
  handleContractValidation,
  validateActionReceipt,
  validateAgentRunSpec,
  validateDaemonTask,
  validateDecision,
  validateStepCheckpoint,
  validateStepCheckpointPayload,
  validateBeliefEvent,
  validateChannelEnvelope,
  validateAgentRateLedger,
  validateBatchCheckpoint,
  validateEvidenceBatchClaim,
  validateEvidenceEnvelope,
  validateEvolutionEvent,
  validateWakeIntent,
  validateExecIntent,
  validateExecResult,
  evidenceKey,
  validateGoalEvent,
  validateVerifyReport,
} from '../src/contracts/index.mjs';

describe('contracts', () => {
  it('validates core runtime shapes', () => {
    expect(validateDecision({
      id: 'cycle-test:0',
      status: 'pending',
      action: { type: 'record_observation', description: 'record' },
    }).ok).toBe(true);

    expect(validateActionReceipt({
      id: 'receipt-test',
      recorded_at: '2026-06-13T00:00:00.000Z',
      action_type: 'record_observation',
      action: { type: 'record_observation' },
      result: { success: true },
    }).ok).toBe(true);

    expect(validateAgentRunSpec({
      primary_cwd_kind: 'target_repo',
      permission_profile: 'read_only',
      intent: 'Inspect state',
      expected_output: ['summary'],
    }).ok).toBe(true);

    expect(validateStepCheckpoint({
      step: 'exec',
      cycle_id: 'cycle-test',
      written_at: '2026-06-13T00:00:00.000Z',
      payload: { executed: [] },
    }).ok).toBe(true);

    expect(validateStepCheckpointPayload('exec', { executed: [] }).ok).toBe(true);

    expect(validateDaemonTask({
      id: 'task-test',
      type: 'intel',
      status: 'pending',
      payload: {},
    }).ok).toBe(true);

    expect(validateVerifyReport({ cycle_id: 'cycle-1', summary: {} }).ok).toBe(true);
    expect(validateBeliefEvent({ type: 'updated', belief_id: 'b1' }).ok).toBe(true);
    expect(validateGoalEvent({ type: 'assessment', reason: 'ok' }).ok).toBe(true);
    expect(validateChannelEnvelope({ id: 'msg-1', text: 'hello' }).ok).toBe(true);
    expect(validateEvolutionEvent({
      id: 'evt-test',
      type: 'intel_pipeline',
      recorded_at: '2026-06-13T00:00:00.000Z',
      cycle_id: 'cycle-test',
      status: 'ok',
      extra_field: 'allowed',
    }).ok).toBe(true);
    expect(validateEvidenceEnvelope({
      id: 'receipt-test',
      kind: 'action_receipts',
      type: 'record_observation',
      occurred_at: '2026-06-13T00:00:00.000Z',
      provenance: { store: 'action_receipts', file: 'intelligence/action_receipts/action-receipts.jsonl', id: 'receipt-test' },
      payload: { id: 'receipt-test' },
    }).ok).toBe(true);
    expect(validateEvidenceBatchClaim({
      batch_id: 'batch-test',
      reactor: 'cognitive',
      claimed_at: '2026-06-13T00:00:00.000Z',
      deadline_at: '2026-06-13T00:05:00.000Z',
      event_ids: ['evt-1'],
      status: 'claimed',
    }).ok).toBe(true);
    expect(validateAgentRateLedger({
      version: 1,
      entries: [{ ts: 1_700_000_000_000, cycle_id: 'cycle-test', decision_id: 'd1' }],
    }).ok).toBe(true);
    expect(validateAgentRateLedger({ version: 1, entries: [{ ts: 'bad' }] }).ok).toBe(false);
    expect(validateEvidenceBatchClaim({
      batch_id: 'batch-retry',
      reactor: 'cognitive',
      claimed_at: '2026-06-13T00:00:00.000Z',
      deadline_at: '2026-06-13T00:05:00.000Z',
      event_ids: ['evt-1'],
      status: 'failed',
      attempt: 2,
      stream_cursor: 'evt-1',
    }).ok).toBe(true);
    expect(validateBatchCheckpoint({
      batch_id: 'batch-cp',
      reactor: 'cognitive',
      written_at: '2026-06-13T00:00:00.000Z',
      stage: 'committed',
      event_ids: ['evt-1'],
      queued_decision_ids: ['cycle-test:0'],
      honesty: { status: 'ok', findings_count: 0 },
    }).ok).toBe(true);
    expect(validateWakeIntent({
      id: 'wake-test',
      kind: 'cognitive',
      subject: 'alpha',
      created_at: '2026-06-13T00:00:00.000Z',
      updated_at: '2026-06-13T00:00:00.000Z',
      status: 'pending',
      reason: 'operator_brief',
      merge_key: 'alpha:cognitive',
    }).ok).toBe(true);
    expect(validateEvidenceEnvelope({
      id: 'evt-1',
      kind: 'evolution_events',
      type: 'reactor_pipeline',
      occurred_at: '2026-06-13T00:00:00.000Z',
      evidence_key: evidenceKey('evolution_events', 'evt-1'),
      producer: 'cognitive',
      activation_targets: ['rule'],
      provenance: { store: 'evolution_events' },
    }).ok).toBe(true);
    expect(validateEvidenceBatchClaim({
      batch_id: 'batch-keys',
      reactor: 'rule',
      claimed_at: '2026-06-13T00:00:00.000Z',
      deadline_at: '2026-06-13T00:05:00.000Z',
      event_ids: ['evt-1'],
      evidence_keys: ['action_receipts:receipt-1'],
      status: 'released',
    }).ok).toBe(true);
    expect(validateExecIntent({
      id: 'intent-abc',
      key: 'd1#1',
      execution_id: 'exec-1',
      decision_id: 'd1',
      status: 'prepared',
      created_at: '2026-06-13T00:00:00.000Z',
    }).ok).toBe(true);
    expect(validateExecResult({
      execution_id: 'exec-1',
      written_at: '2026-06-13T00:00:00.000Z',
      verify_status: 'pending_verify',
      executed: [],
    }).ok).toBe(true);
    expect(validateWakeIntent({
      id: 'bad',
      kind: 'cognitive',
      subject: 'alpha',
      created_at: '2026-06-13T00:00:00.000Z',
      updated_at: '2026-06-13T00:00:00.000Z',
      status: 'pending',
      reason: 'x',
      merge_key: 'alpha:cognitive',
    }).ok).toBe(false);
  });

  it('rejects illegal producer/targets and accepts legacy event_ids-only claims', () => {
    expect(validateEvidenceEnvelope({
      id: 'evt-1',
      kind: 'evolution_events',
      type: 'reactor_pipeline',
      occurred_at: '2026-06-13T00:00:00.000Z',
      producer: 'not-a-producer',
      provenance: { store: 'evolution_events' },
    }).ok).toBe(false);
    expect(validateEvidenceEnvelope({
      id: 'evt-1',
      kind: 'evolution_events',
      type: 'reactor_pipeline',
      occurred_at: '2026-06-13T00:00:00.000Z',
      producer: 'cognitive',
      producer_batch_id: 'batch-abc',
      activation_targets: [''],
      provenance: { store: 'evolution_events' },
    }).ok).toBe(false);
    expect(validateEvolutionEvent({
      id: 'evt-test',
      type: 'belief_update',
      recorded_at: '2026-06-13T00:00:00.000Z',
      producer: 'rule',
      activation_targets: ['cognitive'],
      producer_batch_id: 'batch-rule-1',
    }).ok).toBe(true);
    expect(validateEvolutionEvent({
      id: 'evt-test',
      type: 'belief_update',
      recorded_at: '2026-06-13T00:00:00.000Z',
      producer: 'unknown-reactor',
    }).ok).toBe(false);
    expect(validateEvidenceBatchClaim({
      batch_id: 'batch-legacy',
      reactor: 'cognitive',
      claimed_at: '2026-06-13T00:00:00.000Z',
      deadline_at: '2026-06-13T00:05:00.000Z',
      event_ids: ['evt-1'],
      status: 'claimed',
    }).ok).toBe(true);
    expect(validateBatchCheckpoint({
      batch_id: 'batch-legacy-cp',
      reactor: 'cognitive',
      written_at: '2026-06-13T00:00:00.000Z',
      stage: 'claimed',
      event_ids: ['evt-1'],
    }).ok).toBe(true);
    expect(evidenceKey('action_receipts', 'shared')).not.toBe(evidenceKey('verify_reports', 'shared'));
  });

  it('validates evolution_event required fields and evt- prefix', () => {
    expect(validateEvolutionEvent({
      type: 'intel_pipeline',
      recorded_at: '2026-06-13T00:00:00.000Z',
    }).ok).toBe(false);
    expect(validateEvolutionEvent({
      id: 'evt-test',
      recorded_at: '2026-06-13T00:00:00.000Z',
    }).ok).toBe(false);
    expect(validateEvolutionEvent({
      id: 'bad-id',
      type: 'intel_pipeline',
      recorded_at: '2026-06-13T00:00:00.000Z',
    }).errors.join('\n')).toContain('evt- prefix');
    expect(validateEvolutionEvent({
      id: 'evt-test',
      type: 'intel_pipeline',
      recorded_at: '2026-06-13T00:00:00.000Z',
      status: 1,
    }).errors.join('\n')).toContain('status');

    const missingType = validateEvolutionEvent({
      id: 'evt-test',
      recorded_at: '2026-06-13T00:00:00.000Z',
    });
    const warnings = [];
    expect(handleContractValidation('evolution_event', missingType, {
      mode: 'warn',
      logger: { warn: (msg) => warnings.push(msg) },
    })).toBe(missingType);
    expect(warnings[0]).toContain('evolution_event contract invalid');
    expect(() => handleContractValidation('evolution_event', missingType, { mode: 'strict' }))
      .toThrow(/evolution_event contract invalid/);
  });

  it('reports contract errors without throwing unless strict mode is requested', () => {
    const result = validateDecision({
      id: 'cycle-test:0',
      status: 'pending',
      action: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('action.type');

    const warnings = [];
    expect(handleContractValidation('decision', result, {
      mode: 'warn',
      logger: { warn: (msg) => warnings.push(msg) },
    })).toBe(result);
    expect(warnings[0]).toContain('decision contract invalid');

    expect(() => handleContractValidation('decision', result, { mode: 'strict' }))
      .toThrow(/decision contract invalid/);
    expect(() => assertValidContract('decision', result)).toThrow(/decision contract invalid/);
  });

  it('defaults unknown modes to warn and honors strict mode', () => {
    expect(contractModeFromEnv({ JEA_CONTRACT_MODE: 'strict' })).toBe('strict');
    expect(contractModeFromEnv({ JEA_CONTRACT_MODE: 'warn' })).toBe('warn');
    expect(contractModeFromEnv({ JEA_CONTRACT_MODE: 'unexpected' })).toBe('warn');
  });
});
