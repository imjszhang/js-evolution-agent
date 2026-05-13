import {
  ActionTypeRegistry,
  ActionTypeSpec,
} from 'js-evolution-engine';

export const actionRegistry = new ActionTypeRegistry({ includeBuiltins: false });

actionRegistry.register(new ActionTypeSpec({
  name: 'record_observation',
  description: 'Record a low-risk intelligence observation.',
  promptHint: 'Record an observation (params: source, subject, kind, content, confidence, tags). Phase 2 first asks the execution agent to review the action, then the host persists the observation through the controlled local finalizer.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'buffer',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'propose_probe',
  description: 'Create a bounded experiment proposal without executing external side effects.',
  promptHint: 'Propose a probe (params: target, hypothesis, success_signal, failure_signal, death_boundary). Phase 2 first asks the execution agent to review the proposal, then the host persists the bounded proposal through the controlled local finalizer.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'run_probe',
  description: 'Run a sandboxed read-only probe or investigation and persist structured evidence.',
  promptHint: 'Run an agent-reviewed read-only probe/investigation (prefer params: objective, plan, targets/initial_targets; optional probe_type=file_exists|jsonl_validate|keyword_search|investigation, keywords, required_fields, budget). Phase 2 first asks the execution agent to interpret the action and path/evidence intent, then the host runs the controlled read-only probe finalizer and records evidence. Use agent_execute only when the action itself should be delegated as an open-ended agent task rather than finalized by the probe tool.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_execute',
  description: 'Delegate an open-ended execution task to an LLM/agent with minimal structured boundaries and auditable receipts.',
  promptHint: 'Delegate to an agent (params: objective, context, mode=observe|propose|patch_proposal|sandbox_patch|core_apply, boundary, acceptance). Do not set params.provider unless a specific action must override the host default; the default provider is configured by JEA_AGENT_PROVIDER. Provider overrides may be llm_only|claude_code_sdk|cursor_sdk|cli_agent. Claude SDK supports settingSources=user|project|local. Cursor SDK currently supports local runtime with CURSOR_API_KEY, optional model and settingSources, and requires explicit cwd/sandbox/worktree for sandbox_patch). Keep instructions high-level so the agent can choose its own approach.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'write_retrospective',
  description: 'Write a review for a completed or failed evolution attempt.',
  promptHint: 'Write a retrospective (params: summary, outcome, lessons, next_actions). Phase 2 first asks the execution agent to review the learning value, then the host persists the retrospective through the controlled local finalizer.',
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

