/**
 * 0.3.0 Reactor backlog baseline schema and fixture profiles (#209).
 * Measurement-only: these constants do not change runtime scheduling.
 */

export const BASELINE_SCHEMA_VERSION = 'reactor-backlog-baseline.v1';
export const BASELINE_ISSUE = 209;
export const BASELINE_PARENT_ISSUE = 208;
export const CURRENT_COGNITIVE_BATCH_LIMIT = 16;
export const LLM_CALLS_PER_BATCH = Object.freeze({
  report: 1,
  decide: 1,
  investigate: 0,
});
export const REALTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FIXTURE_NOW_ISO = '2026-08-25T04:00:00.000Z';
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);
export const FIXTURE_SEED = 209;
export const FIXTURE_SUBJECT = 'baseline-reactor';

export const AGE_BUCKETS = Object.freeze([
  'lt_1h',
  'h1_24h',
  'd1_7d',
  'd7_30d',
  'd30_90d',
  'gt_90d',
  'unknown',
]);

export const POPULATION_IDS = Object.freeze([
  'handled_covered',
  'realtime_candidate',
  'replay_candidate',
  'unknown_legacy',
  'not_reactor_work',
]);

export const REACTORS = Object.freeze(['cognitive', 'rule', 'memory']);

/** Documented agentank-tank 0.2.x incident shape. No live runtime is copied. */
export const INCIDENT_SHAPE = Object.freeze({
  name: 'agentank-tank-0.2.x',
  documented_at: '2026-08-15',
  documented_pending: 43272,
  documented_handled_claims: 4,
  documented_oldest_unclaimed_days: 90.7,
  documented_health: 'reactor_backlog_stalled',
  note: 'Synthetic analogue of the documented S0 backlog shape. Secrets and live ~/.jea data are never read or committed.',
});

const BASE_RECIPE = Object.freeze({
  channel_lifecycle: 80,
  channel_messages: 12,
  action_receipts: 40,
  verify_reports: 6,
  operator_briefs_pending: 3,
  operator_briefs_processed: 2,
  operator_facts: 2,
  operator_questions: 2,
  belief_events: 8,
  goal_events: 6,
  evolution_exec: 10,
  evolution_cognitive: 8,
  evolution_budget: 4,
  reports: 4,
  intel_observations: 8,
  probe_results: 6,
  legacy_anonymous: 4,
  handled_marker_backed: 10,
  handled_covered_index_only: 8,
  failed_released: 6,
  claimed_open: 1,
  failed_tasks: 4,
});

function scaleCount(base, scale, cap = Number.POSITIVE_INFINITY) {
  return Math.min(cap, Math.max(1, Math.round(base * scale)));
}

export function estimatedAuthorityCount(recipe) {
  return (
    recipe.channel_lifecycle
    + recipe.channel_messages
    + recipe.action_receipts
    + recipe.verify_reports
    + recipe.operator_briefs_pending
    + recipe.operator_briefs_processed
    + recipe.operator_facts
    + recipe.operator_questions
    + recipe.belief_events
    + recipe.goal_events
    + recipe.evolution_exec
    + recipe.evolution_cognitive
    + recipe.evolution_budget
    + recipe.reports
    + recipe.intel_observations
    + recipe.probe_results
    + recipe.legacy_anonymous
  );
}

export function recipeForProfile(profile = 'smoke') {
  const scale = FIXTURE_PROFILES[profile]?.scale;
  if (!Number.isFinite(scale)) {
    throw new Error(`Unknown baseline fixture profile: ${profile}`);
  }
  const jsonDirCap = profile === 'tiny' ? 20 : profile === 'smoke' ? 80 : 240;
  return {
    channel_lifecycle: scaleCount(BASE_RECIPE.channel_lifecycle, scale),
    channel_messages: scaleCount(BASE_RECIPE.channel_messages, scale),
    action_receipts: scaleCount(BASE_RECIPE.action_receipts, scale),
    verify_reports: scaleCount(BASE_RECIPE.verify_reports, scale, jsonDirCap),
    operator_briefs_pending: scaleCount(BASE_RECIPE.operator_briefs_pending, scale, jsonDirCap),
    operator_briefs_processed: scaleCount(BASE_RECIPE.operator_briefs_processed, scale, jsonDirCap),
    operator_facts: scaleCount(BASE_RECIPE.operator_facts, scale, jsonDirCap),
    operator_questions: scaleCount(BASE_RECIPE.operator_questions, scale, jsonDirCap),
    belief_events: scaleCount(BASE_RECIPE.belief_events, scale),
    goal_events: scaleCount(BASE_RECIPE.goal_events, scale),
    evolution_exec: scaleCount(BASE_RECIPE.evolution_exec, scale),
    evolution_cognitive: scaleCount(BASE_RECIPE.evolution_cognitive, scale),
    evolution_budget: scaleCount(BASE_RECIPE.evolution_budget, scale),
    reports: scaleCount(BASE_RECIPE.reports, scale),
    intel_observations: scaleCount(BASE_RECIPE.intel_observations, scale),
    probe_results: scaleCount(BASE_RECIPE.probe_results, scale),
    legacy_anonymous: scaleCount(BASE_RECIPE.legacy_anonymous, scale, jsonDirCap),
    handled_marker_backed: scaleCount(BASE_RECIPE.handled_marker_backed, scale),
    handled_covered_index_only: scaleCount(BASE_RECIPE.handled_covered_index_only, scale),
    failed_released: scaleCount(BASE_RECIPE.failed_released, scale),
    claimed_open: Math.min(2, scaleCount(BASE_RECIPE.claimed_open, 1)),
    failed_tasks: scaleCount(BASE_RECIPE.failed_tasks, Math.min(scale, 4), 24),
  };
}

export const FIXTURE_PROFILES = Object.freeze({
  tiny: Object.freeze({
    scale: 1,
    purpose: 'Focused unit tests and schema smoke',
    recommended_for: ['unit', 'schema'],
  }),
  smoke: Object.freeze({
    scale: 12,
    purpose: 'CI-stable local/CI smoke with every population present',
    recommended_for: ['ci', 'pr-smoke'],
  }),
  large: Object.freeze({
    scale: 120,
    purpose: 'Tens of thousands of envelopes; local 0.3.0 threshold fixture',
    recommended_for: ['local-threshold', 'projection-cost'],
  }),
  incident: Object.freeze({
    scale: 210,
    purpose: 'Synthetic analogue of the documented ~43k agentank-tank backlog',
    recommended_for: ['certification-soak'],
  }),
});
