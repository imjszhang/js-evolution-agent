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
  description: 'Execute an approved read-only probe and persist structured evidence.',
  promptHint: 'Run a read-only probe (params: probe_type=file_exists|jsonl_validate|keyword_search, target, hypothesis, success_signal, failure_signal, death_boundary, optional keywords/required_fields)',
  defaultRisk: 'low',
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

