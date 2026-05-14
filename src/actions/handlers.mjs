import { runReadOnlyProbe } from './probe-runner.mjs';
import { runAgenticAction } from './agent-adapter.mjs';

function requireParams(action, fields) {
  const missing = fields.filter((field) => action?.params?.[field] == null && action?.[field] == null);
  if (missing.length) {
    throw new Error(`missing required field(s): ${missing.join(', ')}`);
  }
}

const DIRECT_AGENT_EXECUTE_REQUIRED_PARAMS = [
  'objective',
  'mode',
  'boundary',
  'acceptance',
  'escape_hatch_reason',
];

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function storeFrom(ctx) {
  const store = ctx?.host?.intelligenceStore;
  if (!store) throw new Error('host.intelligenceStore is not configured');
  return store;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function objectHasContent(value) {
  const obj = asObject(value);
  return Object.values(obj).some((item) => {
    if (Array.isArray(item)) return item.length > 0;
    if (item && typeof item === 'object') return Object.keys(item).length > 0;
    return item != null && item !== '';
  });
}

function listCount(value) {
  const obj = asObject(value);
  return Object.values(obj).reduce((sum, item) => {
    if (Array.isArray(item)) return sum + item.length;
    if (item && typeof item === 'object') return sum + Object.keys(item).length;
    return sum + (item == null || item === '' ? 0 : 1);
  }, 0);
}

function agentStatusToProbeStatus(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'requires_human_review') return 'blocked';
  return status || 'inconclusive';
}

function summarizeAgenticExecution(agentResult = {}) {
  const agent = agentResult.agent ?? {};
  const outputs = asObject(agent.outputs);
  const evidence = asObject(agent.evidence ?? outputs.evidence);
  const writes = asObject(agent.writes ?? outputs.writes);
  return {
    success: !!agentResult.success,
    deferred: !!agentResult.deferred,
    provider: agentResult.provider ?? agent.provider ?? 'llm_only',
    status: agent.status ?? (agentResult.deferred ? 'deferred' : (agentResult.success ? 'completed' : 'failed')),
    message: agentResult.message ?? agentResult.error ?? agent.summary ?? '',
    requires_approval: !!agent.requires_approval,
    action_type: agent.action_type ?? null,
    action_id: agent.action_id ?? null,
    served_goal: agent.served_goal ?? null,
    evidence,
    writes,
    verification_hints: agent.verification_hints ?? [],
    next_actions: agent.next_actions ?? [],
    outputs,
    created_files: agent.created_files ?? [],
    modified_files: agent.modified_files ?? [],
    test_results: agent.test_results ?? [],
    agent,
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
      boundary: getField(action, 'boundary') ?? undefined,
      cwd: getField(action, 'cwd') ?? undefined,
      approval_granted: getField(action, 'approval_granted') ?? undefined,
      approved: getField(action, 'approved') ?? undefined,
      allowedTools: getField(action, 'allowedTools') ?? getField(action, 'allowed_tools') ?? undefined,
      disallowedTools: getField(action, 'disallowedTools') ?? getField(action, 'disallowed_tools') ?? undefined,
      permissionMode: getField(action, 'permissionMode') ?? getField(action, 'permission_mode') ?? undefined,
      maxTurns: getField(action, 'maxTurns') ?? getField(action, 'max_turns') ?? undefined,
      objective: objective ?? [
        `Execute the Phase 2 action '${action?.type ?? 'unknown'}' as an autonomous execution agent.`,
        action?.description ? `Description: ${action.description}` : '',
      ].filter(Boolean).join('\n'),
      context: {
        phase: 'exec',
        contract: [
          'Execute the action intent and return the final auditable action result.',
          'Do not mutate project files unless the action boundary explicitly permits it.',
          'For host-backed writes, return explicit writes.* records; the host will validate and persist only those records.',
          'For investigations, return explicit evidence.* records. Do not rely on a hard-coded local finalizer to decide the final outcome.',
        ],
        action,
      },
      acceptance: acceptance ?? 'Return a JSON action result with status, summary, evidence, writes, verification_hints, and next_actions.',
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
    requires_approval: !!agenticExecution.requires_approval,
    evidence: agenticExecution.evidence ?? {},
    writes: agenticExecution.writes ?? {},
    verification_hints: agenticExecution.verification_hints ?? [],
    next_actions: agenticExecution.next_actions ?? [],
    agentic_execution: agenticExecution,
    error: agenticExecution.error,
  };
}

function agentActionResult(action, agenticExecution, overrides = {}) {
  return {
    success: agenticExecution.success && !agenticExecution.requires_approval,
    provider: agenticExecution.provider,
    status: agenticExecution.status,
    requires_approval: agenticExecution.requires_approval,
    message: agenticExecution.message,
    action_type: agenticExecution.action_type ?? action?.type ?? 'unknown',
    action_id: agenticExecution.action_id ?? action?.id ?? null,
    served_goal: agenticExecution.served_goal ?? action?.serves_goal ?? null,
    evidence: agenticExecution.evidence ?? {},
    writes: agenticExecution.writes ?? {},
    verification_hints: agenticExecution.verification_hints ?? [],
    next_actions: agenticExecution.next_actions ?? [],
    agent: agenticExecution.agent ?? null,
    agentic_execution: agenticExecution,
    fallback_used: false,
    ...overrides,
  };
}

function legacyFallbackAllowed(action) {
  return Boolean(getField(action, 'allow_legacy_fallback') || getField(action, 'diagnostic_fallback'));
}

function explicitApproval(action) {
  const boundary = asObject(getField(action, 'boundary'));
  return Boolean(
    getField(action, 'approval_granted')
      || getField(action, 'approved')
      || boundary.approval_granted
      || boundary.approved,
  );
}

function sandboxConfigured(action) {
  const boundary = asObject(getField(action, 'boundary'));
  return Boolean(getField(action, 'cwd') || boundary.cwd || boundary.sandbox || boundary.worktree);
}

function coreApplyPolicy() {
  const value = String(process.env.JEA_CORE_APPLY_POLICY ?? 'review').trim().toLowerCase();
  return ['disabled', 'review', 'auto'].includes(value) ? value : 'review';
}

function coreApplyAudit(result = {}) {
  const evidence = asObject(result.evidence);
  const outputs = asObject(result.outputs);
  const writes = asObject(result.writes);
  const changedFiles = [
    ...asArray(result.modified_files),
    ...asArray(result.created_files),
    ...asArray(evidence.changed_files),
    ...asArray(outputs.changed_files),
  ];
  const testResults = [
    ...asArray(result.test_results),
    ...asArray(evidence.test_results),
    ...asArray(evidence.tests_run),
    ...asArray(outputs.test_results),
    ...asArray(outputs.tests_run),
  ];
  const diffSummary = evidence.diff_summary ?? outputs.diff_summary ?? writes.diff_summary ?? null;
  const rollbackPlan = evidence.rollback_plan ?? outputs.rollback_plan ?? writes.rollback_plan ?? null;
  const deathBoundaryResult = evidence.death_boundary_result ?? outputs.death_boundary_result ?? writes.death_boundary_result ?? null;
  return {
    changed_files: changedFiles,
    diff_summary: diffSummary,
    test_results: testResults,
    rollback_plan: rollbackPlan,
    death_boundary_result: deathBoundaryResult,
    complete: changedFiles.length > 0 && Boolean(diffSummary) && testResults.length > 0 && Boolean(rollbackPlan),
  };
}

function missingAgentArtifactsResult(action, agenticExecution, artifactKind) {
  return agentActionResult(action, agenticExecution, {
    success: false,
    status: agenticExecution.status === 'completed' ? 'blocked' : agenticExecution.status,
    message: `agent-first execution returned no ${artifactKind}; legacy finalizer is disabled unless allow_legacy_fallback is set`,
    missing_agent_artifacts: artifactKind,
    fallback_available: true,
  });
}

function persistObservationWrites(store, action, agenticExecution) {
  const observations = asArray(agenticExecution.writes?.observations);
  if (!observations.length) return 0;
  return store.ingestObservation(observations.map((observation) => ({
    source: observation.source ?? 'agent_phase2',
    subject: observation.subject ?? action.description ?? action.type ?? 'unspecified',
    kind: observation.kind ?? 'evolution_signal',
    content: observation.content ?? observation.summary ?? agenticExecution.message,
    confidence: observation.confidence ?? 'medium',
    tags: observation.tags ?? ['agent-first'],
    ...observation,
  })));
}

function persistRetrospectiveWrites(store, action, agenticExecution) {
  const retrospectives = asArray(agenticExecution.writes?.retrospectives);
  if (!retrospectives.length) return 0;
  let written = 0;
  for (const review of retrospectives) {
    written += store.recordRetrospective({
      summary: review.summary ?? agenticExecution.message,
      outcome: review.outcome ?? agenticExecution.status ?? 'reviewed',
      lessons: review.lessons ?? [],
      next_actions: review.next_actions ?? agenticExecution.next_actions ?? [],
      action_type: action.type,
      ...review,
    });
  }
  return written;
}

function persistProbeProposalWrites(store, action, agenticExecution) {
  const proposals = asArray(
    agenticExecution.writes?.probe_proposals
      ?? agenticExecution.writes?.proposals
      ?? agenticExecution.writes?.probe_events,
  );
  if (!proposals.length) return { written: 0, probeId: null };
  let written = 0;
  let firstProbeId = null;
  for (const proposal of proposals) {
    const probeId = proposal.probe_id ?? action.id ?? `probe-${Date.now()}`;
    firstProbeId ??= probeId;
    const event = {
      type: proposal.type ?? 'probe_proposed',
      action_type: action.type,
      target: proposal.target ?? getField(action, 'target') ?? action.description ?? 'unspecified',
      hypothesis: proposal.hypothesis ?? getField(action, 'hypothesis'),
      success_signal: proposal.success_signal ?? getField(action, 'success_signal'),
      failure_signal: proposal.failure_signal ?? getField(action, 'failure_signal'),
      death_boundary: proposal.death_boundary ?? getField(action, 'death_boundary'),
      status: proposal.status ?? 'proposed_only',
      ...proposal,
    };
    written += store.recordProbeEvent(probeId, event);
    written += store.recordEvolutionEvent({ ...event, probe_id: probeId });
  }
  return { written, probeId: firstProbeId };
}

function persistProbeResultWrites(store, action, agenticExecution) {
  const explicitResults = asArray(agenticExecution.writes?.probe_results);
  const shouldSynthesize = !explicitResults.length && objectHasContent(agenticExecution.evidence);
  const probeResults = shouldSynthesize
    ? [{
      probe_id: action.probe_id ?? action.id ?? `probe-${Date.now()}`,
      probe_type: getField(action, 'probe_type') ?? 'agent_investigation',
      target: getField(action, 'target') ?? getField(action, 'targets') ?? action.description ?? 'agent-evidence',
      status: agentStatusToProbeStatus(agenticExecution.status),
      success: agenticExecution.success && !agenticExecution.requires_approval,
      summary: agenticExecution.message,
      evidence: agenticExecution.evidence,
    }]
    : explicitResults;
  if (!probeResults.length) return { written: 0, probeId: null, synthesized: false };

  let written = 0;
  let firstProbeId = null;
  for (const raw of probeResults) {
    const probeId = raw.probe_id ?? raw.id ?? action.probe_id ?? action.id ?? `probe-${Date.now()}`;
    firstProbeId ??= probeId;
    const probeResult = {
      probe_id: probeId,
      probe_type: raw.probe_type ?? getField(action, 'probe_type') ?? 'agent_investigation',
      target: raw.target ?? getField(action, 'target') ?? getField(action, 'targets') ?? action.description ?? 'agent-evidence',
      status: raw.status ?? agentStatusToProbeStatus(agenticExecution.status),
      success: raw.success ?? (agenticExecution.success && !agenticExecution.requires_approval),
      summary: raw.summary ?? agenticExecution.message,
      evidence: raw.evidence ?? agenticExecution.evidence ?? {},
      ...raw,
    };
    const event = {
      type: `probe_${probeResult.status}`,
      action_type: action.type,
      probe_id: probeId,
      probe_type: probeResult.probe_type,
      target: probeResult.target,
      status: probeResult.status,
      summary: probeResult.summary,
    };
    written += store.recordProbeEvent(probeId, event);
    written += store.recordProbeResult(probeResult);
    written += store.recordEvolutionEvent(event);
  }
  return { written, probeId: firstProbeId, synthesized: shouldSynthesize };
}

function persistCoreReviewWrites(store, action, agenticExecution) {
  const reviews = asArray(agenticExecution.writes?.core_reviews);
  if (!reviews.length) return 0;
  let written = 0;
  for (const review of reviews) {
    written += store.recordEvolutionEvent({
      type: 'core_review_requested',
      action_type: action.type,
      target: review.target ?? getField(action, 'target') ?? action.description ?? 'unspecified',
      rationale: review.rationale ?? getField(action, 'rationale') ?? action.rationale ?? '',
      risks: review.risks ?? getField(action, 'risks') ?? [],
      approval_needed: true,
      status: 'requires_human_review',
      ...review,
    });
  }
  return written;
}

export const actionHandlers = {
  async record_observation(action, ctx) {
    requireParams(action, ['content']);
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Execute a low-risk intelligence observation write. Return writes.observations with the exact observation records the host should persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWritten = persistObservationWrites(store, action, agenticExecution);
    if (agentWritten > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agenticExecution.status ?? 'recorded',
        message: `recorded ${agentWritten} observation(s) from agent writes`,
        writes_applied: { observations: agentWritten },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'writes.observations');
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
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async propose_probe(action, ctx) {
    requireParams(action, ['hypothesis', 'success_signal', 'failure_signal', 'death_boundary']);
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Execute a bounded probe proposal write. Return writes.probe_proposals with the proposal events the host should persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWrites = persistProbeProposalWrites(store, action, agenticExecution);
    if (agentWrites.written > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agenticExecution.status ?? 'proposed_only',
        message: `probe proposal recorded from agent writes: ${agentWrites.probeId}`,
        probe_id: agentWrites.probeId,
        writes_applied: { probe_proposals: agentWrites.written },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'writes.probe_proposals');
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
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async run_probe(action, ctx) {
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'observe',
      objective: 'Execute this read-only probe as an agentic Phase 2 investigation. Return evidence describing what was actually checked and writes.probe_results if structured probe evidence should be persisted.',
      acceptance: 'Return JSON with status, summary, evidence, optional writes.probe_results, verification_hints, and next_actions. Do not rely on the host to infer the final outcome from the original target fields.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentProbeWrites = persistProbeResultWrites(store, action, agenticExecution);
    if (agentProbeWrites.written > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agentStatusToProbeStatus(agenticExecution.status),
        message: agenticExecution.message || 'agent probe evidence recorded',
        probe_id: agentProbeWrites.probeId,
        probe_type: getField(action, 'probe_type') ?? 'agent_investigation',
        outcome_success: true,
        writes_applied: { probe_results: agentProbeWrites.written },
        synthesized_probe_result: agentProbeWrites.synthesized,
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'evidence or writes.probe_results');
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
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async agent_execute(action, ctx) {
    requireParams(action, DIRECT_AGENT_EXECUTE_REQUIRED_PARAMS);
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
      action_type: agent.action_type ?? action.type,
      action_id: agent.action_id ?? action.id ?? null,
      served_goal: agent.served_goal ?? action.serves_goal ?? null,
      evidence: agent.evidence ?? {},
      writes: agent.writes ?? {},
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
      objective: 'Execute a retrospective write. Return writes.retrospectives with the learning records the host should persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWritten = persistRetrospectiveWrites(store, action, agenticExecution);
    if (agentWritten > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agenticExecution.status ?? 'recorded',
        message: `retrospective recorded from agent writes (${agentWritten})`,
        writes_applied: { retrospectives: agentWritten },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'writes.retrospectives');
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
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async core_apply(action, ctx) {
    requireParams(action, ['target', 'rationale', 'boundary', 'acceptance', 'death_boundary']);
    const store = storeFrom(ctx);
    const policy = coreApplyPolicy();
    const approved = explicitApproval(action);
    const hasSandbox = sandboxConfigured(action);

    if (policy === 'disabled') {
      const result = {
        success: false,
        status: 'requires_human_review',
        message: 'core_apply is disabled by JEA_CORE_APPLY_POLICY; request_core_review or patch proposal is required',
        requires_approval: true,
        provider: null,
        policy,
        evidence: {},
        writes: {},
        fallback_used: false,
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (policy === 'review' && !approved && !hasSandbox) {
      const result = {
        success: true,
        status: 'requires_human_review',
        message: 'core_apply requires explicit approval or a sandbox/worktree when JEA_CORE_APPLY_POLICY=review',
        requires_approval: true,
        provider: null,
        policy,
        evidence: {
          policy,
          target: getField(action, 'target') ?? action.description ?? 'unspecified',
          rationale: getField(action, 'rationale') ?? action.rationale ?? '',
        },
        writes: {},
        verification_hints: ['grant approval_granted=true, provide boundary.sandbox/worktree, or set JEA_CORE_APPLY_POLICY=auto'],
        fallback_used: false,
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'core_apply',
      objective: [
        'Execute this approved core-layer change as an auditable core_apply action.',
        'Return changed_files, diff_summary, tests_run or test_results, rollback_plan, and death_boundary_result.',
        'If you cannot safely apply the change, return requires_human_review with a patch proposal instead of mutating files.',
      ].join('\n'),
      acceptance: [
        'Return JSON with status, summary, evidence, writes, modified_files/created_files, test_results, verification_hints, next_actions.',
        'Evidence must include diff_summary, rollback_plan, and death_boundary_result.',
      ].join(' '),
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      result.policy = policy;
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const audit = coreApplyAudit(agenticExecution);
    const result = agentActionResult(action, agenticExecution, {
      success: true,
      status: agenticExecution.status ?? 'completed',
      message: agenticExecution.message || 'core_apply completed',
      policy,
      core_apply_audit: audit,
      verification_hints: audit.complete
        ? agenticExecution.verification_hints
        : [
          ...agenticExecution.verification_hints,
          'core_apply receipt is missing changed_files, diff_summary, test_results/tests_run, or rollback_plan',
        ],
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async request_core_review(action, ctx) {
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Record a core-layer review request by returning writes.core_reviews. Do not mutate files and do not apply the requested core change.',
    });
    if (!agenticExecution.success && !agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWritten = persistCoreReviewWrites(store, action, agenticExecution);
    if (agentWritten > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        message: 'core-layer request recorded for human review from agent writes; no mutation executed',
        requires_approval: true,
        status: 'requires_human_review',
        writes_applied: { core_reviews: agentWritten },
      });
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
      message: legacyFallbackAllowed(action)
        ? 'core-layer request recorded for human review via legacy fallback; no mutation executed'
        : 'core-layer request recorded for human review from action params; no mutation executed',
      requires_approval: true,
      status: 'requires_human_review',
      agentic_execution: agenticExecution,
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: legacyFallbackAllowed(action),
      writes_applied: { core_reviews: 1 },
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
        const metric = result?.agentic_execution || result?.agent
          ? 'agent_action_result'
          : 'handler_receipt';
        const requiresApproval = Boolean(result?.requires_approval);
        const evidence_count = listCount(result?.evidence);
        const writes_count = listCount(result?.writes);
        const status = result?.success && !requiresApproval
          ? (type === 'run_probe' && !result?.fallback_used && evidence_count === 0 && writes_count === 0 ? 'partial' : 'improved')
          : (type === 'request_core_review' && result?.success && requiresApproval ? 'improved' : (requiresApproval ? 'partial' : 'blocked'));
        return {
          action,
          metric,
          value: {
            success: !!result?.success,
            status: result?.status ?? 'recorded',
            message: result?.message ?? '',
            provider: result?.provider ?? result?.agentic_execution?.provider ?? null,
            requires_approval: requiresApproval,
            fallback_used: !!result?.fallback_used,
            evidence_count,
            writes_count,
            verification_hints: result?.verification_hints ?? result?.agentic_execution?.verification_hints ?? [],
          },
          status,
        };
      },
    },
  ]),
);

export const actionVerifiers = {
  ...baseActionVerifiers,
  core_apply: {
    verify(action, result) {
      const audit = result?.core_apply_audit ?? coreApplyAudit(result ?? {});
      const requiresApproval = Boolean(result?.requires_approval);
      const evidence_count = listCount(result?.evidence);
      const writes_count = listCount(result?.writes);
      const base = {
        action,
        metric: result?.agentic_execution || result?.agent ? 'agent_action_result' : 'handler_receipt',
        value: {
          success: !!result?.success,
          status: result?.status ?? 'unknown',
          message: result?.message ?? '',
          provider: result?.provider ?? result?.agentic_execution?.provider ?? null,
          requires_approval: requiresApproval,
          fallback_used: !!result?.fallback_used,
          evidence_count,
          writes_count,
          policy: result?.policy ?? coreApplyPolicy(),
          audit,
          verification_hints: result?.verification_hints ?? result?.agentic_execution?.verification_hints ?? [],
        },
      };
      if (!result?.success) return { ...base, status: requiresApproval ? 'partial' : 'blocked' };
      if (requiresApproval) return { ...base, status: 'partial' };
      return { ...base, status: audit.complete ? 'improved' : 'partial' };
    },
  },
  agent_execute: {
    verify(action, result) {
      const hasReceipt = Boolean(result?.provider && result?.status && result?.agent);
      const needsHuman = Boolean(result?.requires_approval);
      const evidence_count = listCount(result?.evidence);
      const writes_count = listCount(result?.writes);
      return {
        action,
        metric: 'agent_action_result',
        value: {
          success: !!result?.success,
          provider: result?.provider ?? null,
          status: result?.status ?? 'unknown',
          requires_approval: needsHuman,
          message: result?.message ?? '',
          evidence_count,
          writes_count,
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

