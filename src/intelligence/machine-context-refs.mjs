/**
 * Host-rendered machine-context keys citable as `[machine_context:<key>]`
 * in Intel report Seen sections. These are per-cycle rendered runtime state,
 * not intelligence-store records: the honesty auditor validates keys against
 * this enum, and `jea audit evidence` skips machine_context refs entirely.
 */
export const MACHINE_CONTEXT_IDS = Object.freeze([
  'decision_queue',
  'active_goals',
  'standing_memory',
  'current_beliefs',
  'source_counts',
  'operator_intent_briefs',
  'cycle_stage',
]);
