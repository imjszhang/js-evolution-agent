/**
 * Mechanical rule-feedback health stats for Cyber-Taoist goal calibration.
 *
 * Detects "feedback death": a goal's serving receipts produce a constant
 * result signature with zero information gain across consecutive cycles.
 */

import { createHash } from 'node:crypto';
import { normalizeCarryoverTextKey } from '../evolution/carryover.mjs';

export const DEFAULT_RECEIPT_LIMIT = 120;
export const DEFAULT_WINDOW_CYCLES = 8;
export const DEFAULT_DEAD_STREAK = 3;
export const DEFAULT_DEGRADED_STREAK = 2;
export const DEFAULT_ESCALATE_STREAK = 5;

const KV_RE = /\b([a-zA-Z_][a-zA-Z0-9_.]{1,64})\s*(?:=|:)\s*([^\s,;|/"'`]+)/g;

/**
 * Primary law-acceptance keys for death-detection signature.
 * Win-more metrics (isranked/successful_pages) and drifting counters must not
 * dilute a stuck acceptance failure such as free_text_clean=KEY_ABSENT.
 */
const SIGNATURE_CORE_KEYS = new Set([
  'free_text_clean',
  'memory_policy.free_text_clean',
  'audit_ok',
  'memory_policy.audit_ok',
  'verify_pipeline',
  'verify_pipeline_mechanical',
]);

/** Keys that alone can establish a death signature when stuck on a failure value. */
const STICKY_LAW_KEYS = new Set([
  'free_text_clean',
  'verify_pipeline',
  'verify_pipeline_mechanical',
]);

/** Broader focus keys retained in stats output for assessor context. */
const SIGNATURE_FOCUS_KEYS = new Set([
  ...SIGNATURE_CORE_KEYS,
  'typed_evidence_refs',
  'typed',
  'evidence_refs',
  'gate.std.max',
  'successful_pages',
  'isranked',
  'is_ranked',
]);

/** Narrative forms: "free_text_clean field absent" / "free_text_clean 字段 absent". */
const NARRATIVE_ABSENT_RE = /\b(free_text_clean|memory_policy\.free_text_clean)\b[^.\n]{0,40}\b(absent|missing|不存在|缺失|key_absent)\b/gi;

/**
 * Bare token form without '=' / ':' :
 * "free_text_clean KEY_ABSENT" / "free_text_clean NOT_ACCEPTABLE_AS_CLEAN"
 */
const BARE_STATUS_RE = /\b(free_text_clean|memory_policy\.free_text_clean|audit_ok|memory_policy\.audit_ok|verify_pipeline|verify_pipeline_mechanical)\b\s+(KEY_ABSENT|NOT_ACCEPTABLE_AS_CLEAN|FAIL|FAILED|PASS|TRUE|FALSE)\b/gi;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeSignatureValue(raw) {
  let value = String(raw ?? '').toLowerCase().trim();
  value = value.replace(/[)\]}'".,;:：；。、！!]+$/g, '');
  // Collapse common boolean / status synonyms.
  if (value === 'key_absent' || value === 'not_acceptable_as_clean') return value;
  if (value.startsWith('key_absent')) return 'key_absent';
  if (value.startsWith('true')) return 'true';
  if (value.startsWith('false')) return 'false';
  if (value.startsWith('fail')) return 'fail';
  if (value.startsWith('pass')) return 'pass';
  // Keep short numeric / token values only.
  if (value.length > 40) value = value.slice(0, 40);
  return value;
}

function normalizeSignatureKey(raw) {
  return String(raw ?? '').toLowerCase().trim();
}

function receiptTimeMs(receipt) {
  const raw = receipt?.recorded_at || receipt?.timestamp || receipt?.result?.finished_at || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function resolveRuleFeedbackConfig(env = process.env) {
  return {
    windowCycles: envInt('JEA_RULE_FEEDBACK_WINDOW', DEFAULT_WINDOW_CYCLES),
    deadStreak: envInt('JEA_RULE_FEEDBACK_DEAD_STREAK', DEFAULT_DEAD_STREAK),
    escalateStreak: envInt('JEA_RULE_FEEDBACK_ESCALATE_STREAK', DEFAULT_ESCALATE_STREAK),
    receiptLimit: envInt('JEA_RULE_FEEDBACK_RECEIPT_LIMIT', DEFAULT_RECEIPT_LIMIT),
  };
}

function flattenGoalNodes(goals) {
  if (!goals) return [];
  const out = [];
  const visit = (node) => {
    if (!node) return;
    out.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(goals);
  return out;
}

export function isGuardGoal(goal) {
  if (!goal || typeof goal !== 'object') return false;
  if (String(goal.role || '').toLowerCase() === 'guard') return true;
  const id = String(goal.id || '');
  return id.startsWith('guard-') || id.startsWith('monitor-');
}

function receiptText(receipt) {
  const result = receipt?.result ?? {};
  return [result.summary, result.message, result.error]
    .filter((v) => v != null && String(v).trim())
    .map((v) => String(v))
    .join('\n');
}

/**
 * Extract normalized key=value pairs from a receipt result text.
 * Death signature prefers sticky law keys (e.g. free_text_clean) over noisy core sets.
 */
export function extractResultSignature(receipt) {
  const text = receiptText(receipt);
  const kvMap = new Map();
  if (text) {
    KV_RE.lastIndex = 0;
    let match;
    while ((match = KV_RE.exec(text)) !== null) {
      const key = normalizeSignatureKey(match[1]);
      const value = normalizeSignatureValue(match[2]);
      if (!key || !value) continue;
      // Keep first occurrence; later duplicates ignored for stability.
      if (!kvMap.has(key)) kvMap.set(key, value);
    }
    NARRATIVE_ABSENT_RE.lastIndex = 0;
    let narrative;
    while ((narrative = NARRATIVE_ABSENT_RE.exec(text)) !== null) {
      const key = normalizeSignatureKey(narrative[1]);
      if (key && !kvMap.has(key)) kvMap.set(key, 'key_absent');
      if (key === 'memory_policy.free_text_clean' && !kvMap.has('free_text_clean')) {
        kvMap.set('free_text_clean', 'key_absent');
      }
    }
    BARE_STATUS_RE.lastIndex = 0;
    let bare;
    while ((bare = BARE_STATUS_RE.exec(text)) !== null) {
      const key = normalizeSignatureKey(bare[1]);
      const value = normalizeSignatureValue(bare[2]);
      if (!key || !value) continue;
      if (!kvMap.has(key)) kvMap.set(key, value);
      if (key === 'memory_policy.free_text_clean' && !kvMap.has('free_text_clean')) {
        kvMap.set('free_text_clean', value);
      }
      if (key === 'memory_policy.audit_ok' && !kvMap.has('audit_ok')) {
        kvMap.set('audit_ok', value);
      }
    }
  }
  // Alias collapse: typed → typed_evidence_refs when both absent/present.
  if (kvMap.has('typed') && !kvMap.has('typed_evidence_refs')) {
    kvMap.set('typed_evidence_refs', kvMap.get('typed'));
  }
  if (kvMap.has('memory_policy.free_text_clean') && !kvMap.has('free_text_clean')) {
    kvMap.set('free_text_clean', kvMap.get('memory_policy.free_text_clean'));
  }
  if (kvMap.has('memory_policy.audit_ok') && !kvMap.has('audit_ok')) {
    kvMap.set('audit_ok', kvMap.get('memory_policy.audit_ok'));
  }

  const keys = [...kvMap.keys()].sort();
  const kv = keys.map((k) => ({ key: k, value: kvMap.get(k) }));
  const focusPairs = kv.filter((pair) => SIGNATURE_FOCUS_KEYS.has(pair.key));
  const corePairs = kv.filter((pair) => SIGNATURE_CORE_KEYS.has(pair.key));
  // free_text_clean alone is the primary stuck-law signal; including verify_*
  // beside it would break an otherwise constant KEY_ABSENT death streak.
  const freeText = corePairs.filter((pair) => pair.key === 'free_text_clean');
  const stickyPairs = freeText.length
    ? freeText
    : corePairs.filter((pair) => STICKY_LAW_KEYS.has(pair.key));
  const signaturePairs = stickyPairs.length
    ? stickyPairs
    : (corePairs.length ? corePairs : focusPairs);
  const canonical = signaturePairs.map((pair) => `${pair.key}=${pair.value}`).join('|');
  const signature = canonical
    ? createHash('sha256').update(canonical).digest('hex').slice(0, 16)
    : null;
  return {
    kv,
    signature,
    keys,
    canonical,
    focus: focusPairs,
    core: corePairs,
    sticky: stickyPairs,
  };
}

function receiptSignatureScore(receipt) {
  const extracted = extractResultSignature(receipt);
  let score = 0;
  if (extracted.sticky?.length) score += 100 + extracted.sticky.length * 10;
  else if (extracted.core?.length) score += 40 + extracted.core.length * 5;
  else if (extracted.signature) score += 10;
  if (receipt?.action_type === 'agent_run' || receipt?.action?.type === 'agent_run') score += 2;
  // Tiny time tie-break: newer preferred among equal scores.
  score += Math.min(1, receiptTimeMs(receipt) / 1e15);
  return { score, extracted };
}

function receiptGoalId(receipt) {
  return receipt?.action?.serves_goal
    ?? receipt?.result?.served_goal
    ?? null;
}

function receiptCycleId(receipt) {
  return receipt?.cycle_id
    ?? receipt?.exec_cycle_id
    ?? receipt?.intel_cycle_id
    ?? null;
}

/**
 * Count how many trailing cycle-buckets share the same signature.
 */
export function computeSignatureStreak(cycleBuckets = []) {
  if (!cycleBuckets.length) return { streak: 0, signature: null, constant_keys: [] };
  const newest = cycleBuckets[cycleBuckets.length - 1];
  if (!newest?.signature) return { streak: 0, signature: null, constant_keys: [] };
  let streak = 0;
  for (let i = cycleBuckets.length - 1; i >= 0; i -= 1) {
    if (cycleBuckets[i].signature !== newest.signature) break;
    streak += 1;
  }
  return {
    streak,
    signature: newest.signature,
    constant_keys: newest.kv ?? [],
  };
}

/**
 * Information gain = count of kv keys whose value changed or appeared/disappeared
 * between previous and current cycle bucket.
 */
export function computeInformationGain(prevBucket, currBucket) {
  if (!currBucket) return 0;
  if (!prevBucket) return (currBucket.kv || []).length;
  const prev = new Map((prevBucket.kv || []).map((p) => [p.key, p.value]));
  const curr = new Map((currBucket.kv || []).map((p) => [p.key, p.value]));
  const keys = new Set([...prev.keys(), ...curr.keys()]);
  let gain = 0;
  for (const key of keys) {
    if (prev.get(key) !== curr.get(key)) gain += 1;
  }
  return gain;
}

const FAILURE_SIGNATURE_VALUES = new Set([
  'key_absent',
  'false',
  'fail',
  'failed',
  'not_acceptable_as_clean',
  'absent',
  'missing',
]);

function signatureLooksLikeFailure(constantKeys = []) {
  if (!Array.isArray(constantKeys) || !constantKeys.length) return false;
  // Any sticky/core failure value ⇒ candidate for feedback death.
  return constantKeys.some((pair) => FAILURE_SIGNATURE_VALUES.has(String(pair?.value || '')));
}

function classifyFeedbackState(
  streak,
  informationGain,
  { deadStreak, degradedStreak = DEFAULT_DEGRADED_STREAK, constantKeys = [] } = {},
) {
  // Constant success is not "feedback death" — only stuck failure / absent signals.
  if (
    streak >= deadStreak
    && informationGain === 0
    && signatureLooksLikeFailure(constantKeys)
  ) {
    return 'dead';
  }
  if (streak >= degradedStreak && signatureLooksLikeFailure(constantKeys)) return 'degraded';
  return 'live';
}

function carryoverStuckForGoal(carryoverDoc, goalId) {
  const items = Array.isArray(carryoverDoc?.items) ? carryoverDoc.items : [];
  const goalKey = normalizeCarryoverTextKey(goalId || '');
  const stuck = items
    .filter((item) => item?.source === 'mechanical')
    .filter((item) => {
      const textKey = normalizeCarryoverTextKey(item.text);
      if (!goalKey) return Number(item.seen_count || 1) >= 2;
      return textKey.includes(goalKey) || String(item.text || '').includes(goalId);
    })
    .map((item) => ({
      text: item.text,
      origin: item.origin ?? null,
      fingerprint: item.fingerprint ?? null,
      first_seen_cycle: item.first_seen_cycle ?? null,
      seen_count: Number(item.seen_count) || 1,
    }));
  const maxSeen = stuck.reduce((max, item) => Math.max(max, item.seen_count), 0);
  return { items: stuck, max_seen_count: maxSeen };
}

function consecutiveLearnStreak(goalEvents = []) {
  // readGoalEvents returns newest-first; root assessments apply tree-wide.
  const newestFirst = (Array.isArray(goalEvents) ? goalEvents : [])
    .filter((e) => e?.type === 'assessment');
  let streak = 0;
  for (const event of newestFirst) {
    if (event.rule_status === 'learn') streak += 1;
    else break;
  }
  return streak;
}

/**
 * Build per-goal mechanical rule feedback stats.
 */
export function computeRuleFeedbackStats({
  store,
  activeGoals,
  carryoverDoc = null,
  windowCycles = null,
  deadStreak = null,
  escalateStreak = null,
  env = process.env,
} = {}) {
  const cfg = resolveRuleFeedbackConfig(env);
  const window = windowCycles ?? cfg.windowCycles;
  const dead = deadStreak ?? cfg.deadStreak;
  const escalate = escalateStreak ?? cfg.escalateStreak;

  const goals = flattenGoalNodes(activeGoals);
  const childGoals = goals.filter((g) => g?.id && g.id !== activeGoals?.id);
  // js-intel-store returns chronological ascending (oldest→newest). Sort newest-first.
  const receipts = [...(store?.readActionReceipts?.({ limit: cfg.receiptLimit }) ?? [])]
    .sort((a, b) => receiptTimeMs(b) - receiptTimeMs(a));
  const goalEvents = [...(store?.readGoalEvents?.({ limit: 40 }) ?? [])]
    .sort((a, b) => receiptTimeMs(b) - receiptTimeMs(a));

  // Group receipts by goal → cycle (newest receipts first after sort).
  const byGoal = new Map();
  for (const receipt of receipts) {
    const goalId = receiptGoalId(receipt);
    if (!goalId) continue;
    const cycleId = receiptCycleId(receipt);
    if (!cycleId) continue;
    if (!byGoal.has(goalId)) byGoal.set(goalId, new Map());
    const cycles = byGoal.get(goalId);
    if (!cycles.has(cycleId)) cycles.set(cycleId, []);
    cycles.get(cycleId).push(receipt);
  }

  const stats = [];
  const goalIds = new Set([
    ...childGoals.map((g) => g.id),
    ...byGoal.keys(),
  ]);

  for (const goalId of goalIds) {
    const goal = childGoals.find((g) => g.id === goalId) ?? goals.find((g) => g.id === goalId) ?? { id: goalId };
    const cycleMap = byGoal.get(goalId) ?? new Map();
    // Map insertion follows newest-first receipt walk → keys are newest-first.
    const cycleIdsNewestFirst = [...cycleMap.keys()];
    // Chronological buckets (oldest→newest) within the recent window.
    const recentCycleIds = cycleIdsNewestFirst.slice(0, window).reverse();
    const buckets = recentCycleIds.map((cycleId) => {
      const cycleReceipts = cycleMap.get(cycleId) || [];
      // Prefer receipts that carry sticky law keys (e.g. free_text_clean=KEY_ABSENT).
      let best = null;
      let bestScore = -1;
      let bestExtracted = null;
      for (const receipt of cycleReceipts) {
        const { score, extracted } = receiptSignatureScore(receipt);
        if (score > bestScore) {
          bestScore = score;
          best = receipt;
          bestExtracted = extracted;
        }
      }
      const extracted = bestExtracted || extractResultSignature(best);
      const signatureKv = extracted.sticky?.length
        ? extracted.sticky
        : (extracted.core?.length ? extracted.core : extracted.focus);
      return {
        cycle_id: cycleId,
        receipt_id: best?.id ?? null,
        signature: extracted.signature,
        kv: signatureKv?.length ? signatureKv : (extracted.focus?.length ? extracted.focus : extracted.kv),
        focus_kv: extracted.focus,
        canonical: extracted.canonical,
      };
    });

    // Null-signature cycles (e.g. unrelated evidence-audit summaries) must not
    // break a sticky-law death streak — drop them from streak/gain calculation.
    const signedBuckets = buckets.filter((b) => b.signature);
    const { streak, signature, constant_keys } = computeSignatureStreak(signedBuckets);
    const prev = signedBuckets.length >= 2 ? signedBuckets[signedBuckets.length - 2] : null;
    const curr = signedBuckets.length ? signedBuckets[signedBuckets.length - 1] : null;
    const information_gain = computeInformationGain(prev, curr);
    const feedback_state = classifyFeedbackState(streak, information_gain, {
      deadStreak: dead,
      constantKeys: constant_keys,
    });
    const stuck = carryoverStuckForGoal(carryoverDoc, goalId);
    const consecutive_learn = consecutiveLearnStreak(goalEvents);

    stats.push({
      goal_id: goalId,
      goal_name: goal?.name ?? null,
      is_guard: isGuardGoal(goal),
      feedback_state,
      constant_signature_streak: streak,
      constant_signature: signature,
      constant_keys,
      information_gain,
      cycles_observed: buckets.length,
      recent_cycles: buckets.map((b) => b.cycle_id),
      latest_receipt_id: curr?.receipt_id ?? null,
      carryover_stuck: stuck,
      consecutive_learn,
      escalate_eligible: feedback_state === 'dead' && streak >= escalate,
    });
  }

  // Sort: dead first, then degraded, then by streak desc.
  const order = { dead: 0, degraded: 1, live: 2 };
  stats.sort((a, b) => (order[a.feedback_state] - order[b.feedback_state])
    || (b.constant_signature_streak - a.constant_signature_streak));

  return {
    config: { window_cycles: window, dead_streak: dead, escalate_streak: escalate },
    generated_at: new Date().toISOString(),
    goals: stats,
    summary: {
      dead: stats.filter((s) => s.feedback_state === 'dead').length,
      degraded: stats.filter((s) => s.feedback_state === 'degraded').length,
      live: stats.filter((s) => s.feedback_state === 'live').length,
      escalate_eligible: stats.filter((s) => s.escalate_eligible).length,
    },
  };
}

/**
 * Decide which dead goals should open an operator question after calibrate.
 * Escalates when feedback is dead with streak >= escalate, and this cycle
 * did not mutate/apply a patch for that goal.
 */
export function selectRuleFeedbackEscalations({
  ruleFeedbackStats = null,
  assessment = null,
  calibrateResult = null,
  pendingQuestions = [],
} = {}) {
  const goals = Array.isArray(ruleFeedbackStats?.goals) ? ruleFeedbackStats.goals : [];
  const ruleStatus = assessment?.rule_status ?? null;
  const appliedChildIds = new Set(
    (calibrateResult?.applied_patches || [])
      .map((p) => p?.child_id)
      .filter(Boolean),
  );
  const mutatedThisCycle = ruleStatus === 'mutate'
    && calibrateResult?.status === 'applied';

  const pendingGoalIds = new Set(
    (Array.isArray(pendingQuestions) ? pendingQuestions : [])
      .filter((q) => q?.trigger === 'rule_feedback_dead')
      .map((q) => q?.metadata?.goal_id)
      .filter(Boolean),
  );

  const escalations = [];
  for (const stat of goals) {
    if (!stat?.escalate_eligible) continue;
    if (pendingGoalIds.has(stat.goal_id)) continue;
    const patchedThisGoal = appliedChildIds.has(stat.goal_id);
    if (mutatedThisCycle && patchedThisGoal) continue;
    // If assess said mutate and calibrate applied any patch touching this goal, skip.
    // Also skip if mutate applied a tree-level rewrite (proposed_goal) covering it —
    // conservative: only skip when this child was explicitly patched.
    if (mutatedThisCycle && !appliedChildIds.size && calibrateResult?.mode === 'replace') {
      continue;
    }
    escalations.push(stat);
  }
  return escalations;
}

export function buildRuleFeedbackQuestionText(stat) {
  const keys = (stat.constant_keys || [])
    .slice(0, 8)
    .map((p) => `${p.key}=${p.value}`)
    .join(', ');
  return [
    `Rule feedback death detected for goal ${stat.goal_id}`
      + (stat.goal_name ? ` (${stat.goal_name})` : '')
      + '.',
    `Constant result signature persisted for ${stat.constant_signature_streak} cycles`
      + (keys ? ` with keys: ${keys}` : '')
      + '; information_gain=0.',
    'Please decide whether this acceptance criterion observation point needs revision',
    '(Cyber-Taoist: law lagged, conventional transactions no longer produce useful feedback).',
    'Prefer revising the observation point while keeping the guard function (守功能、破形态).',
  ].join(' ');
}
