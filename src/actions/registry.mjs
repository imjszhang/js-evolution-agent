import {
  ActionTypeRegistry,
  ActionTypeSpec,
} from 'js-evolution-engine';

export const actionRegistry = new ActionTypeRegistry({ includeBuiltins: false });

actionRegistry.register(new ActionTypeSpec({
  name: 'record_observation',
  description: 'Record a low-risk intelligence observation.',
  promptHint: 'Record an observation through the Phase 2 execution agent. Prefer intent-level params (content/source/subject/kind/tags are accepted for compatibility). The agent should return writes.observations; the host validates and persists those records.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'buffer',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'propose_probe',
  description: 'Create a bounded experiment proposal without executing external side effects.',
  promptHint: 'Propose a bounded probe through the Phase 2 execution agent (params: target or resource intent, hypothesis, success_signal, failure_signal, death_boundary). The agent should return writes.probe_proposals; avoid guessing physical data/... paths when a runtime/data resource intent is enough.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'run_probe',
  description: 'Run a sandboxed read-only probe or investigation and persist structured evidence.',
  promptHint: 'Run an agent-executed read-only investigation (prefer params: objective, acceptance, boundary, resource intent, optional targets/initial_targets). The Phase 2 agent returns evidence and optional writes.probe_results. Legacy host-controlled probe fallback is disabled by default and requires explicit allow_legacy_fallback or diagnostic_fallback. Avoid hard-coding data/... paths unless the resource root is explicit.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_execute',
  description: 'Delegate an open-ended execution task to an LLM/agent with minimal structured boundaries and auditable receipts.',
  promptHint: 'Delegate directly to an agent (params: objective, context, mode=observe|propose|patch_proposal|sandbox_patch|core_apply, boundary, acceptance). Return the standard agent action result with evidence/writes/verification_hints. Do not set params.provider unless a specific action must override JEA_AGENT_PROVIDER. Provider overrides may be llm_only|claude_code_sdk|cursor_sdk|cli_agent.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'write_retrospective',
  description: 'Write a review for a completed or failed evolution attempt.',
  promptHint: 'Write a retrospective through the Phase 2 execution agent (params: summary, outcome, lessons, next_actions accepted for compatibility). The agent should return writes.retrospectives; the host validates and persists those learning records.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'buffer',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'request_core_review',
  description: 'Record a core-layer change request for human review only.',
  promptHint: 'Request core review (params: target, rationale, risks, approval_needed)',
  defaultRisk: 'high',
  defaultPriority: 'high',
  autoExecutable: false,
  layer: 'core',
}));

