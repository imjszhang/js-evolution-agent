import {
  ActionTypeRegistry,
  ActionTypeSpec,
} from 'js-evolution-engine';

export const actionRegistry = new ActionTypeRegistry({ includeBuiltins: false });

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_run',
  description: 'Primary Phase 2 execution primitive: run an autonomous agent from a primary cwd with explicit runtime permissions and a receipt contract.',
  promptHint: '[PRIMARY EXECUTION] Default action for investigations, candidate generation, simulation, code changes, and remote publish prep. Params must include run_spec with primary_cwd_kind or primary_cwd, permission_profile=read_only|workspace_write|remote_write_review, intent, context, and expected_output. Use one primary cwd; place only necessary reference roots in additional_directories. Subject-specific commands (sync, simulate, score, publish) are tool capabilities inside the agent run, not separate action types.',
  defaultRisk: 'medium',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'record_observation',
  description: 'Record a low-risk intelligence observation (host-backed write only).',
  promptHint: '[RECORDING ONLY] Persist an already-formed observation into the intelligence store. Required params: content; optional: source/subject/kind/tags/confidence. Do not use for file reads or investigations—use agent_run first, then record_observation to persist the conclusion. Local host write is the default path; agent-backed write is for advanced compatibility only.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'buffer',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'propose_probe',
  description: 'Create a bounded experiment proposal without executing external side effects (host-backed write only).',
  promptHint: '[RECORDING ONLY] Register a bounded experiment proposal, not execute it. Required params: hypothesis, success_signal, failure_signal, death_boundary; optional: target/resource intent. Do not use to run the experiment—schedule agent_run for execution after the proposal is recorded.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'run_probe',
  description: '[COMPAT] Legacy read-only investigation action; prefer agent_run with permission_profile=read_only.',
  promptHint: '[COMPAT — prefer agent_run] Legacy bounded read-only investigation. New decisions should use agent_run with permission_profile=read_only instead. Only use run_probe for existing queued decisions or when host recording semantics require this type. If the probe targets local files, set params.cwd to the real project root. Returns evidence and optional writes.probe_results. Legacy host-controlled probe fallback requires explicit allow_legacy_fallback or diagnostic_fallback. Do not include secret file contents in evidence.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_execute',
  description: '[COMPAT] Escape-hatch delegation for open-ended agent work; do not prefer in new decisions.',
  promptHint: '[COMPAT — do not prefer] Internal/legacy escape hatch. Use only when agent_run and recording actions cannot represent the work. Required params: objective, mode=observe|propose|patch_proposal|sandbox_patch|core_apply, boundary, acceptance, escape_hatch_reason. New decisions should use agent_run instead. Return the standard agent action result with evidence/writes/verification_hints, never raw secrets.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'write_retrospective',
  description: 'Write a structured retrospective learning record (host-backed write only).',
  promptHint: '[RECORDING ONLY] Persist a structured learning conclusion. Required params: summary; optional: outcome, lessons, next_actions. Do not read files, do not set cwd, and do not gather new evidence. If more evidence is needed, schedule agent_run first, then write_retrospective only records the conclusion.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'buffer',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'request_core_review',
  description: 'Record a core-layer change request for human review only (no mutation).',
  promptHint: '[RECORDING ONLY] Register a core-layer review request for human approval. Params: target, rationale, risks, approval_needed. Does not mutate files or apply changes. Do not include raw secrets in rationale or evidence.',
  defaultRisk: 'high',
  defaultPriority: 'high',
  autoExecutable: false,
  layer: 'core',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'core_apply',
  description: 'Apply an approved core-layer change under JEA_CORE_APPLY_POLICY (not for ordinary lane/repo edits).',
  promptHint: '[CORE ONLY — not for ordinary repo edits] Apply a core-layer change only when JEA_CORE_APPLY_POLICY and explicit approval allow it. Ordinary target-repo changes belong in agent_run + lane worktree, not core_apply. Required params: target, rationale, boundary, acceptance, death_boundary. Return evidence with changed_files, diff_summary, tests_run/test_results, rollback_plan, and death_boundary_result.',
  defaultRisk: 'high',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'core',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'lane_status',
  description: '[SYSTEM] Check the active subject target repo lane without mutating Git state.',
  promptHint: '[SYSTEM — mechanical lane check] Host infrastructure action. Reports whether subject repo/lane/base branch are configured and the worktree is clean. Prefer agent_run for investigative work; use lane_status only when a pure mechanical lane health check is needed before repo evolution.',
  defaultRisk: 'low',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'lane_observe',
  description: '[SYSTEM] Run the configured read-only lane observation command in the subject target repo.',
  promptHint: '[SYSTEM — mechanical observe command] Host infrastructure action. Runs the subject Run Command on the active lane and records stdout/stderr. Prefer agent_run for sync/observe/investigation workflows; use lane_observe only when a pure mechanical command run is required without agent context.',
  defaultRisk: 'low',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'lane_verify',
  description: '[SYSTEM] Run the configured lane test command in the subject target repo.',
  promptHint: '[SYSTEM — mechanical test command] Host infrastructure action. Runs the subject Test Command on the active lane and records exit status plus stdout/stderr. Prefer agent_run when verification is part of a broader execution package; use lane_verify only for a standalone mechanical test run.',
  defaultRisk: 'low',
  defaultPriority: 'high',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'github_open_lane_pr',
  description: '[SYSTEM] Push a work branch and open a GitHub pull request back to the active subject lane.',
  promptHint: '[SYSTEM — mechanical PR open] Host infrastructure action. Use only after local verification passes. Required params: head_branch. PR base is the configured subject lane, defaults to draft, and does not merge automatically. Prefer agent_run for publish-prep workflows that include evidence gathering.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'core',
}));
