import {
  ActionTypeRegistry,
  ActionTypeSpec,
} from 'js-evolution-engine';

export const actionRegistry = new ActionTypeRegistry({ includeBuiltins: false });

actionRegistry.register(new ActionTypeSpec({
  name: 'record_observation',
  description: 'Record a low-risk intelligence observation.',
  promptHint: 'Record an observation (params: source, subject, kind, content, confidence, tags)',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'buffer',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'propose_probe',
  description: 'Create a bounded experiment proposal without executing external side effects.',
  promptHint: 'Propose a probe (params: target, hypothesis, success_signal, failure_signal, death_boundary)',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'run_probe',
  description: 'Run a sandboxed read-only probe or investigation and persist structured evidence.',
  promptHint: 'Run a read-only probe/investigation (prefer params: objective, plan, targets/initial_targets; optional probe_type=file_exists|jsonl_validate|keyword_search|investigation, keywords, required_fields, budget). The runner may inspect project-local non-sensitive text files and records evidence.',
  defaultRisk: 'low',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'agent_execute',
  description: 'Delegate an open-ended execution task to an LLM/agent with minimal structured boundaries and auditable receipts.',
  promptHint: 'Delegate to an agent (params: objective, context, mode=observe|propose|patch_proposal|sandbox_patch|core_apply, boundary, acceptance; optional provider=llm_only|claude_code_sdk|cursor_sdk|cli_agent; for Claude SDK optional settingSources=user|project|local, default user+project+local). Keep instructions high-level so the agent can choose its own approach.',
  defaultRisk: 'medium',
  defaultPriority: 'medium',
  autoExecutable: true,
  layer: 'probe',
}));

actionRegistry.register(new ActionTypeSpec({
  name: 'write_retrospective',
  description: 'Write a review for a completed or failed evolution attempt.',
  promptHint: 'Write a retrospective (params: summary, outcome, lessons, next_actions)',
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

