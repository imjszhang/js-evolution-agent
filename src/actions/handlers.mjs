import { runReadOnlyProbe } from './probe-runner.mjs';

function requireParams(action, fields) {
  const missing = fields.filter((field) => action?.params?.[field] == null && action?.[field] == null);
  if (missing.length) {
    throw new Error(`missing required field(s): ${missing.join(', ')}`);
  }
}

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function storeFrom(ctx) {
  const store = ctx?.host?.intelligenceStore;
  if (!store) throw new Error('host.intelligenceStore is not configured');
  return store;
}

export const actionHandlers = {
  record_observation(action, ctx) {
    requireParams(action, ['content']);
    const store = storeFrom(ctx);
    const observation = {
      source: getField(action, 'source') ?? 'oada-action',
      subject: getField(action, 'subject') ?? action.description ?? 'unspecified',
      kind: getField(action, 'kind') ?? 'evolution_signal',
      content: getField(action, 'content'),
      confidence: getField(action, 'confidence') ?? 'medium',
      tags: getField(action, 'tags') ?? ['js-evolution-agent'],
    };
    const written = store.ingestObservation(observation);
    const result = { success: written > 0, message: `recorded ${written} observation(s)` };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  propose_probe(action, ctx) {
    requireParams(action, ['hypothesis', 'success_signal', 'failure_signal', 'death_boundary']);
    const store = storeFrom(ctx);
    const probeId = getField(action, 'probe_id') ?? action.id ?? `probe-${Date.now()}`;
    const event = {
      type: 'probe_proposed',
      action_type: action.type,
      target: getField(action, 'target') ?? action.description ?? 'unspecified',
      hypothesis: getField(action, 'hypothesis'),
      success_signal: getField(action, 'success_signal'),
      failure_signal: getField(action, 'failure_signal'),
      death_boundary: getField(action, 'death_boundary'),
      status: 'proposed_only',
    };
    store.recordProbeEvent(probeId, event);
    store.recordEvolutionEvent({ ...event, probe_id: probeId });
    const result = {
      success: true,
      message: `probe proposal recorded: ${probeId}`,
      probe_id: probeId,
      status: 'proposed_only',
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  run_probe(action, ctx) {
    requireParams(action, ['probe_type', 'target', 'hypothesis', 'success_signal', 'failure_signal', 'death_boundary']);
    const store = storeFrom(ctx);
    const probeResult = runReadOnlyProbe(action, ctx);
    const event = {
      type: `probe_${probeResult.status}`,
      action_type: action.type,
      probe_id: probeResult.probe_id,
      probe_type: probeResult.probe_type,
      target: probeResult.target,
      status: probeResult.status,
      summary: probeResult.summary,
    };

    store.recordProbeEvent(probeResult.probe_id, event);
    store.recordProbeResult(probeResult);
    store.recordEvolutionEvent(event);

    const result = {
      success: true,
      message: probeResult.summary,
      probe_id: probeResult.probe_id,
      status: probeResult.status,
      probe_type: probeResult.probe_type,
      outcome_success: probeResult.success,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  write_retrospective(action, ctx) {
    requireParams(action, ['summary']);
    const store = storeFrom(ctx);
    const review = {
      summary: getField(action, 'summary'),
      outcome: getField(action, 'outcome') ?? 'reviewed',
      lessons: getField(action, 'lessons') ?? [],
      next_actions: getField(action, 'next_actions') ?? [],
      action_type: action.type,
    };
    const written = store.recordRetrospective(review);
    const result = { success: written > 0, message: 'retrospective recorded' };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  request_core_review(action, ctx) {
    const store = storeFrom(ctx);
    const event = {
      type: 'core_review_requested',
      action_type: action.type,
      target: getField(action, 'target') ?? action.description ?? 'unspecified',
      rationale: getField(action, 'rationale') ?? action.rationale ?? '',
      risks: getField(action, 'risks') ?? [],
      approval_needed: true,
      status: 'requires_human_review',
    };
    store.recordEvolutionEvent(event);
    const result = {
      success: true,
      message: 'core-layer request recorded for human review; no mutation executed',
      requires_approval: true,
      status: 'requires_human_review',
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },
};

export const actionVerifiers = Object.fromEntries(
  Object.keys(actionHandlers).map((type) => [
    type,
    {
      verify(action, result) {
        return {
          action,
          metric: 'handler_receipt',
          value: {
            success: !!result?.success,
            status: result?.status ?? 'recorded',
            message: result?.message ?? '',
          },
          status: result?.success ? 'improved' : 'partial',
        };
      },
    },
  ]),
);

