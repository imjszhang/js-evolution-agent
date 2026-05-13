import { runReadOnlyProbe } from './probe-runner.mjs';
import { runAgenticAction } from './agent-adapter.mjs';

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

function summarizeAgenticExecution(agentResult = {}) {
  const agent = agentResult.agent ?? {};
  return {
    success: !!agentResult.success,
    deferred: !!agentResult.deferred,
    provider: agentResult.provider ?? agent.provider ?? 'llm_only',
    status: agent.status ?? (agentResult.deferred ? 'deferred' : (agentResult.success ? 'completed' : 'failed')),
    message: agentResult.message ?? agentResult.error ?? agent.summary ?? '',
    requires_approval: !!agent.requires_approval,
    verification_hints: agent.verification_hints ?? [],
    next_actions: agent.next_actions ?? [],
    outputs: agent.outputs ?? {},
    error: agentResult.error ?? null,
  };
}

async function runPhase2Agent(action, ctx, {
  mode = 'observe',
  objective = null,
  acceptance = null,
} = {}) {
  const agentAction = {
    type: 'agent_execute',
    description: `Agentic Phase 2 execution for ${action?.type ?? 'unknown action'}`,
    params: {
      provider: getField(action, 'provider') ?? undefined,
      mode,
      objective: objective ?? [
        `Execute the Phase 2 action '${action?.type ?? 'unknown'}' as an autonomous execution agent.`,
        action?.description ? `Description: ${action.description}` : '',
      ].filter(Boolean).join('\n'),
      context: {
        phase: 'exec',
        contract: [
          'Interpret the action intent and decide whether the local finalizer/tool should proceed.',
          'Do not mutate project files unless the action boundary explicitly permits it.',
          'For tool-backed actions, return execution guidance; the host will perform the controlled final write/read step.',
        ],
        action,
      },
      acceptance: acceptance ?? 'Return a JSON receipt stating whether the action is safe and useful to execute, plus concise guidance for the local finalizer.',
    },
  };

  const agentResult = await runAgenticAction(agentAction, ctx);
  return summarizeAgenticExecution(agentResult);
}

function agentBlockedResult(agenticExecution) {
  return {
    success: false,
    deferred: !!agenticExecution.deferred,
    message: agenticExecution.message || agenticExecution.error || 'agentic Phase 2 execution did not approve local finalization',
    status: agenticExecution.status,
    provider: agenticExecution.provider,
    agentic_execution: agenticExecution,
    error: agenticExecution.error,
  };
}

export const actionHandlers = {
  async record_observation(action, ctx) {
    requireParams(action, ['content']);
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Review and execute a low-risk intelligence observation write. Confirm the observation should be persisted as a controlled Phase 2 finalizer.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const observation = {
      source: getField(action, 'source') ?? 'oada-action',
      subject: getField(action, 'subject') ?? action.description ?? 'unspecified',
      kind: getField(action, 'kind') ?? 'evolution_signal',
      content: getField(action, 'content'),
      confidence: getField(action, 'confidence') ?? 'medium',
      tags: getField(action, 'tags') ?? ['js-evolution-agent'],
    };
    const written = store.ingestObservation(observation);
    const result = {
      success: written > 0,
      message: `recorded ${written} observation(s)`,
      agentic_execution: agenticExecution,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async propose_probe(action, ctx) {
    requireParams(action, ['hypothesis', 'success_signal', 'failure_signal', 'death_boundary']);
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Review and execute a bounded probe proposal write. Confirm the proposal is useful, bounded, and safe to persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
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
      agentic_execution: agenticExecution,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async run_probe(action, ctx) {
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'observe',
      objective: 'Execute this read-only probe as an agentic Phase 2 investigation. Understand the objective, paths, and expected evidence before the host runs its controlled read-only probe finalizer.',
      acceptance: 'Return JSON describing what evidence the read-only probe should collect, whether the target/path semantics are plausible, and any warnings for verification.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
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
      agentic_execution: agenticExecution,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async agent_execute(action, ctx) {
    requireParams(action, ['objective']);
    const store = storeFrom(ctx);
    const agentResult = await runAgenticAction(action, ctx);
    const agent = agentResult.agent ?? {};
    const result = {
      success: !!agentResult.success,
      deferred: !!agentResult.deferred,
      message: agentResult.message ?? agentResult.error ?? agent.summary ?? 'agent execution completed',
      provider: agentResult.provider ?? agent.provider ?? (action?.params?.provider ?? 'llm_only'),
      status: agent.status ?? (agentResult.deferred ? 'deferred' : (agentResult.success ? 'completed' : 'failed')),
      requires_approval: !!agent.requires_approval,
      created_files: agent.created_files ?? [],
      modified_files: agent.modified_files ?? [],
      test_results: agent.test_results ?? [],
      verification_hints: agent.verification_hints ?? [],
      next_actions: agent.next_actions ?? [],
      agent,
      error: agentResult.error,
    };

    store.recordEvolutionEvent({
      type: 'agent_execute',
      action_type: action.type,
      provider: result.provider,
      status: result.status,
      objective: getField(action, 'objective') ?? action.description ?? 'unspecified',
      mode: getField(action, 'mode') ?? 'propose',
      requires_approval: result.requires_approval,
      summary: result.message,
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async write_retrospective(action, ctx) {
    requireParams(action, ['summary']);
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Review and execute a retrospective write. Confirm the summary, lessons, and next actions should be persisted as learning memory.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const review = {
      summary: getField(action, 'summary'),
      outcome: getField(action, 'outcome') ?? 'reviewed',
      lessons: getField(action, 'lessons') ?? [],
      next_actions: getField(action, 'next_actions') ?? [],
      action_type: action.type,
    };
    const written = store.recordRetrospective(review);
    const result = {
      success: written > 0,
      message: 'retrospective recorded',
      agentic_execution: agenticExecution,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async request_core_review(action, ctx) {
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'core_apply',
      objective: 'Review a core-layer change request and decide whether it should be recorded for human review. Do not execute any mutation.',
    });
    if (!agenticExecution.success && !agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
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
      agentic_execution: agenticExecution,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },
};

const baseActionVerifiers = Object.fromEntries(
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

export const actionVerifiers = {
  ...baseActionVerifiers,
  agent_execute: {
    verify(action, result) {
      const hasReceipt = Boolean(result?.provider && result?.status && result?.agent);
      const needsHuman = Boolean(result?.requires_approval);
      return {
        action,
        metric: 'agent_receipt',
        value: {
          success: !!result?.success,
          provider: result?.provider ?? null,
          status: result?.status ?? 'unknown',
          requires_approval: needsHuman,
          message: result?.message ?? '',
          modified_files: result?.modified_files ?? [],
          created_files: result?.created_files ?? [],
          test_results: result?.test_results ?? [],
          verification_hints: result?.verification_hints ?? [],
        },
        status: result?.success && hasReceipt && !needsHuman
          ? 'improved'
          : (hasReceipt ? 'partial' : 'blocked'),
      };
    },
  },
};

