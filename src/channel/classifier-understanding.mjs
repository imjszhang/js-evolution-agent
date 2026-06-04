const TEMPORAL_VALUES = new Set(['now', 'next_cycle', 'ongoing']);
const COMPLEXITY_VALUES = new Set(['low', 'medium', 'high']);
const DETERMINISTIC_AGENT_CANDIDATE_KINDS = new Set([
  'reply.message',
  'reply.verification_request',
  'reply.approval_request',
]);

const IMMEDIATE_ACTION_RE = /(?:帮我|请|麻烦|劳烦).{0,20}(?:看一下|看看|查一下|检查一下|分析一下|找一下|调查一下|诊断一下|排查一下|确认一下|核实一下|看|查|检查|分析|找|调查|诊断|排查)|(?:看一下|查一下|检查一下|分析一下|调查一下|诊断一下|排查一下|确认一下|核实一下|帮忙看|帮忙查|帮忙分析|help\s+(?:check|investigate|analy[sz]e|inspect)|please\s+(?:check|investigate|analy[sz]e|inspect))/i;
const NEXT_CYCLE_RE = /(?:下一轮|下轮|下一轮|之后|发布后|跑完后|完成后|等.*(?:完|结束|发布)|follow.?up|next cycle|when.*done)/i;

/**
 * Infer understanding from message text (deterministic classifier path).
 */
export function inferDeterministicUnderstanding(envelope, classification) {
  const content = String(envelope?.content ?? '').trim();
  const lower = content.toLowerCase();
  const wantsImmediate = IMMEDIATE_ACTION_RE.test(content);
  const wantsNextCycle = NEXT_CYCLE_RE.test(lower);

  let temporal = 'now';
  let needsImmediate = false;

  if (classification === 'verification_request') {
    temporal = wantsImmediate && !wantsNextCycle ? 'now' : 'next_cycle';
    needsImmediate = wantsImmediate && temporal === 'now';
  } else if (classification === 'approval_request') {
    temporal = wantsNextCycle ? 'next_cycle' : 'now';
    needsImmediate = wantsImmediate;
  } else if (classification === 'observation') {
    temporal = wantsNextCycle ? 'next_cycle' : 'now';
    needsImmediate = wantsImmediate && !wantsNextCycle;
  } else {
    temporal = 'now';
    needsImmediate = false;
  }

  const userIntent = content.slice(0, 500) || null;
  let actionHint = null;
  if (needsImmediate) {
    actionHint = userIntent ? `Investigate or answer: ${userIntent.slice(0, 300)}` : 'Read-only investigation of operator request';
  }

  return normalizeUnderstanding({
    user_intent: userIntent,
    needs_immediate_action: needsImmediate,
    action_hint: actionHint,
    temporal,
    complexity: needsImmediate ? 'low' : 'low',
  });
}

/**
 * Normalize classifier understanding object from LLM or deterministic output.
 */
export function normalizeUnderstanding(raw, { envelope = null, classification = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    if (envelope && classification) {
      return inferDeterministicUnderstanding(envelope, classification);
    }
    return null;
  }

  let userIntent = String(raw.user_intent ?? '').trim().slice(0, 500) || null;
  let needsImmediate = raw.needs_immediate_action === true;
  let temporal = String(raw.temporal ?? '').trim().toLowerCase();
  if (!TEMPORAL_VALUES.has(temporal)) temporal = 'now';

  let complexity = String(raw.complexity ?? 'low').trim().toLowerCase();
  if (!COMPLEXITY_VALUES.has(complexity)) complexity = 'low';

  let actionHint = String(raw.action_hint ?? '').trim().slice(0, 500) || null;

  if (envelope?.content && classification) {
    const inferred = inferDeterministicUnderstanding(envelope, classification);
    if (!userIntent) {
      userIntent = inferred?.user_intent ?? (String(envelope.content ?? '').trim().slice(0, 500) || null);
    }
    if (raw.needs_immediate_action == null && inferred?.needs_immediate_action) {
      needsImmediate = inferred.needs_immediate_action;
    }
    if (raw.temporal == null && inferred?.temporal) {
      temporal = inferred.temporal;
    }
    if (!actionHint && inferred?.action_hint) {
      actionHint = inferred.action_hint;
    }
  }

  return {
    user_intent: userIntent ?? (envelope ? (String(envelope.content ?? '').trim().slice(0, 500) || null) : null),
    needs_immediate_action: needsImmediate,
    action_hint: actionHint,
    temporal,
    complexity,
  };
}

export function extractUnderstandingFromClassifierItem(item, envelope = null) {
  if (!item) return null;
  const classification = String(item.classification ?? 'observation').trim().toLowerCase();
  if (item.understanding && typeof item.understanding === 'object') {
    return normalizeUnderstanding(item.understanding, { envelope, classification });
  }
  if (envelope) {
    return inferDeterministicUnderstanding(envelope, classification);
  }
  return null;
}

export function candidateNeedsImmediateAction(candidate) {
  return candidate?.understanding?.needs_immediate_action === true;
}

export function candidateEligibleForDeterministicAgent(candidate) {
  if (!DETERMINISTIC_AGENT_CANDIDATE_KINDS.has(candidate?.kind)) return false;
  const u = candidate?.understanding;
  if (!u || u.needs_immediate_action !== true) return false;
  if (u.temporal !== 'now') return false;
  if (u.complexity === 'high') return false;
  const objective = String(u.action_hint ?? u.user_intent ?? candidate?.summary ?? '').trim();
  return objective.length > 0;
}
