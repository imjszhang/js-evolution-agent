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

function countGoals(node, acc = { n: 0 }) {
  if (!node || typeof node !== 'object') return acc.n;
  acc.n += 1;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) countGoals(child, acc);
  return acc.n;
}

function beliefPartitionCounts(currentBeliefs) {
  if (!currentBeliefs?.exists) {
    return { active: 0, validated: 0, refuted: 0, total: 0 };
  }
  const beliefs = Array.isArray(currentBeliefs.beliefs) ? currentBeliefs.beliefs : [];
  const active = beliefs.filter((b) => String(b?.status || '').toLowerCase() === 'active').length;
  const validated = beliefs.filter((b) => String(b?.status || '').toLowerCase() === 'validated').length;
  const refuted = beliefs.filter((b) => String(b?.status || '').toLowerCase() === 'refuted').length;
  return { active, validated, refuted, total: beliefs.length };
}

function briefKindCounts(operatorBriefs = []) {
  const counts = {};
  for (const brief of Array.isArray(operatorBriefs) ? operatorBriefs : []) {
    const kind = String(brief?.kind || 'unknown');
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

/**
 * Host-assembled machine_context Seen bullets (existence / counts only).
 * Never includes operator brief claim text.
 *
 * @param {{
 *   reportContext?: object|null,
 *   queueSummary?: object|null,
 *   operatorBriefs?: Array<object>|null,
 * }} args
 * @returns {string} Markdown bullet body (no heading)
 */
export function buildMachineContextSeenBullets({
  reportContext = null,
  queueSummary = null,
  operatorBriefs = null,
} = {}) {
  const ctx = reportContext || {};
  const queue = queueSummary ?? ctx.decision_queue ?? null;
  const briefs = operatorBriefs ?? ctx.operator_intent_briefs ?? [];
  const bullets = [];

  if (queue && typeof queue === 'object') {
    const pending = Number(queue.pending ?? queue.counts?.pending ?? 0) || 0;
    const inProgress = Number(queue.in_progress ?? queue.counts?.in_progress ?? 0) || 0;
    const completed = Number(queue.completed ?? queue.counts?.completed ?? 0) || 0;
    bullets.push(
      `- [machine_context:decision_queue]: pending=${pending}, in_progress=${inProgress}, completed=${completed}`,
    );
  } else {
    bullets.push('- [machine_context:decision_queue]: decision queue summary unavailable this cycle');
  }

  const goals = ctx.active_goals ?? null;
  if (goals && typeof goals === 'object') {
    const rootName = goals.name || goals.id || '(unnamed)';
    const n = countGoals(goals);
    bullets.push(`- [machine_context:active_goals]: ${n} goal node(s); root=${rootName}`);
  } else {
    bullets.push('- [machine_context:active_goals]: no active goals document');
  }

  const memory = ctx.standing_memory;
  if (memory?.exists) {
    const updated = memory.updated_at || 'unknown';
    bullets.push(`- [machine_context:standing_memory]: present (updated_at=${updated})`);
  } else {
    bullets.push('- [machine_context:standing_memory]: no standing memory yet');
  }

  const beliefCounts = beliefPartitionCounts(ctx.current_beliefs);
  if (beliefCounts.total > 0 || ctx.current_beliefs?.exists) {
    bullets.push(
      `- [machine_context:current_beliefs]: active=${beliefCounts.active}, validated=${beliefCounts.validated}, refuted=${beliefCounts.refuted}`,
    );
  } else {
    bullets.push('- [machine_context:current_beliefs]: no current beliefs document');
  }

  const counts = ctx.source_counts && typeof ctx.source_counts === 'object'
    ? ctx.source_counts
    : null;
  if (counts) {
    const parts = Object.entries(counts)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${k}=${v}`)
      .slice(0, 8);
    bullets.push(
      `- [machine_context:source_counts]: ${parts.length ? parts.join(', ') : 'all sources empty'}`,
    );
  } else {
    bullets.push('- [machine_context:source_counts]: source counts unavailable');
  }

  const kindCounts = briefKindCounts(briefs);
  const briefTotal = Object.values(kindCounts).reduce((a, b) => a + b, 0);
  if (briefTotal > 0) {
    const kindText = Object.entries(kindCounts).map(([k, v]) => `${k}=${v}`).join(', ');
    bullets.push(
      `- [machine_context:operator_intent_briefs]: ${briefTotal} pending brief(s) (${kindText})`,
    );
  } else {
    bullets.push('- [machine_context:operator_intent_briefs]: no pending operator intent briefs');
  }

  const cycle = ctx.current_cycle || {};
  const cycleId = cycle.cycle_id || '(unknown)';
  const stage = cycle.stage || cycle.mode || 'pre_analyze_decide_report';
  bullets.push(`- [machine_context:cycle_stage]: cycle_id=${cycleId}, stage=${stage}`);

  return bullets.join('\n');
}
