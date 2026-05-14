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
  description: 'Run a bounded read-only probe or investigation and persist structured evidence.',
  promptHint: 'Run an agent-executed read-only investigation (prefer params: objective, acceptance, boundary, resource intent, optional targets/initial_targets). The Phase 2 agent returns evidence and optional writes.probe_results. Boundary text is an operating contract, not a filesystem sandbox; host preflight may block local fallback probes but does not prove provider-level isolation. Do not include secret file contents in evidence; report sensitive targets as accessible/blocked plus redacted metadata only. Legacy host-controlled probe fallback is disabled by default and requires explicit allow_legacy_fallback or diagnostic_fallback. Avoid hard-coding data/... paths unless the resource root is explicit.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_execute',
  description: 'Escape-hatch delegation for open-ended agent work that no dedicated action type can represent.',
  promptHint: 'Use only when record_observation, propose_probe, run_probe, write_retrospective, or request_core_review do not fit. Required params: objective, mode=observe|propose|patch_proposal|sandbox_patch|core_apply, boundary, acceptance, escape_hatch_reason. Boundary text is not a sandbox unless backed by cwd/sandbox/worktree or provider enforcement. Return the standard agent action result with evidence/writes/verification_hints, never raw secrets. Do not set params.provider unless a specific action must override JEA_AGENT_PROVIDER. Provider overrides may be llm_only|claude_code_sdk|cursor_sdk|cli_agent.',
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
  promptHint: 'Request core review (params: target, rationale, risks, approval_needed). Record the request for human review only; do not include raw secrets in rationale or evidence.',
  defaultRisk: 'high',
  defaultPriority: 'high',
  autoExecutable: false,
  layer: 'core',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'core_apply',
  description: 'Apply a core-layer change under the configured core apply policy.',
  promptHint: 'Apply a core change only when JEA_CORE_APPLY_POLICY and action approval allow it. Required params: target, rationale, boundary, acceptance, death_boundary. Return evidence with changed_files, diff_summary, tests_run/test_results, rollback_plan, and death_boundary_result. Never include raw secrets.',
  defaultRisk: 'high',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'core',
}));

