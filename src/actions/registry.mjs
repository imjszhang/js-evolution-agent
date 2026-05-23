import {
  ActionTypeRegistry,
  ActionTypeSpec,
} from 'js-evolution-engine';

export const actionRegistry = new ActionTypeRegistry({ includeBuiltins: false });

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_run',
  description: 'Run an autonomous code agent from a primary cwd with explicit runtime permissions and a receipt contract.',
  promptHint: 'Preferred execution primitive. Params must include run_spec with primary_cwd_kind or primary_cwd, permission_profile=read_only|workspace_write|remote_write_review, intent, context, and expected_output. Use one primary cwd; place only necessary reference roots in additional_directories. Subject-specific commands are tool capabilities inside the agent run, not action types.',
  defaultRisk: 'medium',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

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
  promptHint: 'Run an agent-executed read-only investigation (prefer params: objective, acceptance, boundary, resource intent, optional targets/initial_targets). If the probe targets local files, set params.cwd to the real project root for those files and describe target paths relative to that cwd. The Phase 2 agent returns evidence and optional writes.probe_results. Boundary text is an operating contract, not a filesystem sandbox; host preflight may block local fallback probes but does not prove provider-level isolation. Do not include secret file contents in evidence; report sensitive targets as accessible/blocked plus redacted metadata only. Legacy host-controlled probe fallback is disabled by default and requires explicit allow_legacy_fallback or diagnostic_fallback. Avoid hard-coding data/... paths unless the resource root is explicit.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_execute',
  description: 'Escape-hatch delegation for open-ended agent work that no dedicated action type can represent.',
  promptHint: 'Use only when record_observation, propose_probe, run_probe, write_retrospective, or request_core_review do not fit. Required params: objective, mode=observe|propose|patch_proposal|sandbox_patch|core_apply, boundary, acceptance, escape_hatch_reason. For local file work, also set params.cwd to the real project root where the target files live and describe file paths relative to that cwd; cwd is the execution directory, not just prose. Boundary text is not a sandbox unless backed by cwd/sandbox/worktree or provider enforcement. Return the standard agent action result with evidence/writes/verification_hints, never raw secrets. Do not set params.provider unless a specific action must override JEA_AGENT_PROVIDER. Provider overrides may be llm_only|claude_code_sdk|cursor_sdk|cli_agent.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'write_retrospective',
  description: 'Write a review for a completed or failed evolution attempt.',
  promptHint: 'Write a host-backed retrospective learning record. Required params: summary; optional params: outcome, lessons, next_actions. This is a structured learning write, not a file investigation: do not read files, do not set cwd, and do not use it to gather new evidence. If more evidence is needed, schedule run_probe first, then write_retrospective only records the conclusion.',
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

actionRegistry.register(new ActionTypeSpec({
  name: 'lane_status',
  description: 'Check the active subject target repo lane without mutating Git state.',
  promptHint: 'Use this before repo evolution work. It reports whether the subject Repo/Base Branch/Lane are configured, the target repo is a Git repo, the base/lane branches exist, and the worktree is clean.',
  defaultRisk: 'low',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'lane_observe',
  description: 'Run the configured read-only lane observation command in the subject target repo.',
  promptHint: 'Runs the subject Run Command on the active lane when configured and records stdout/stderr as evidence. Use for actual project usage probes that do not mutate source.',
  defaultRisk: 'low',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'lane_verify',
  description: 'Run the configured lane test command in the subject target repo.',
  promptHint: 'Runs the subject Test Command on the active lane and records exit status plus stdout/stderr as verification evidence before integrating work.',
  defaultRisk: 'low',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'github_open_lane_pr',
  description: 'Push a work branch and open a GitHub pull request back to the active subject lane.',
  promptHint: 'Use only after local verification passes. Required params: head_branch. The PR base is the configured subject lane, defaults to draft, and does not merge automatically.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'core',
}));

