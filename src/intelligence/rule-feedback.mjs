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
export const DEFAULT_WINDOW_EVIDENCE = 24;
export const DEFAULT_DEAD_STREAK = 3;
export const DEFAULT_DEGRADED_STREAK = 2;
export const DEFAULT_ESCALATE_STREAK = 5;
export const DEFAULT_MUTATE_COOLDOWN = 2;
export const RULE_FEEDBACK_STREAK_UNITS = Object.freeze(['cycle', 'evidence']);

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

function envInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envIntAllowZero(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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

function goalEventTimeMs(event) {
  const raw = event?.recorded_at || event?.created_at || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function patchTouchesGoalId(patch, goalId) {
  if (!patch || !goalId) return false;
  if (patch.op === 'update_child' || patch.op === 'remove_child') {
    return patch.child_id === goalId;
  }
  if (patch.op === 'add_child') {
    return patch.child?.id === goalId;
  }
  return false;
}

function findLastMutatePatchForGoal(goalEvents = [], goalId) {
  for (const event of goalEvents) {
    if (event?.type !== 'patched' || event?.rule_status !== 'mutate') continue;
    const patches = Array.isArray(event.patches) ? event.patches : [];
    if (!patches.some((patch) => patchTouchesGoalId(patch, goalId))) continue;
    return {
      cycle_id: event.cycle_id ?? null,
      recorded_at: event.recorded_at ?? event.created_at ?? null,
      recorded_at_ms: goalEventTimeMs(event),
    };
  }
  return null;
}

function countSignedBucketsSinceMutate(signedBuckets = [], mutateAtMs = 0) {
  if (!mutateAtMs) return signedBuckets.length;
  return signedBuckets.filter((bucket) => (bucket.receipt_time_ms ?? 0) > mutateAtMs).length;
}

/**
 * Signature of the last signed bucket at or before mutate time (pre-mutate regime).
 */
function signatureBeforeMutate(signedBuckets = [], mutateAtMs = 0) {
  if (!mutateAtMs || !signedBuckets.length) return null;
  let last = null;
  for (const bucket of signedBuckets) {
    if ((bucket.receipt_time_ms ?? 0) <= mutateAtMs) last = bucket;
  }
  return last?.signature ?? null;
}

/**
 * Whether the last mutate changed the result signature after cooldown.
 * null = unknown (no mutate, or still in cooldown); true/false once observable.
 */
export function computeMutateEffective({
  lastMutatePatch = null,
  cyclesSinceMutate = null,
  mutateCooldown = DEFAULT_MUTATE_COOLDOWN,
  signedBuckets = [],
  currentSignature = null,
} = {}) {
  if (!lastMutatePatch) return null;
  if (cyclesSinceMutate == null || cyclesSinceMutate < mutateCooldown) return null;
  const before = signatureBeforeMutate(signedBuckets, lastMutatePatch.recorded_at_ms || 0);
  if (!before || !currentSignature) return null;
  return before !== currentSignature;
}

/**
 * Global cycle ids newest-first from receipts (by newest receipt time in each cycle).
 */
function globalCycleIdsNewestFirst(receipts = []) {
  const cycleNewestMs = new Map();
  for (const receipt of receipts) {
    const cycleId = receiptCycleId(receipt);
    if (!cycleId) continue;
    const ms = receiptTimeMs(receipt);
    const prev = cycleNewestMs.get(cycleId);
    if (prev == null || ms > prev) cycleNewestMs.set(cycleId, ms);
  }
  return [...cycleNewestMs.entries()]
    .sort((a, b) => (b[1] - a[1]) || String(b[0]).localeCompare(String(a[0])))
    .map(([cycleId]) => cycleId);
}

/**
 * Trailing cycles (newest-first global sequence) with no receipt for this goal.
 * Window-limited; 0 when the newest cycle served this goal.
 */
export function computeStarvedStreak({
  globalCycleIdsNewestFirst: cycleIds = [],
  goalCycleIds = new Set(),
  windowCycles = DEFAULT_WINDOW_CYCLES,
} = {}) {
  if (!cycleIds.length) return 0;
  const recent = cycleIds.slice(0, windowCycles);
  let streak = 0;
  for (const cycleId of recent) {
    if (goalCycleIds.has(cycleId)) break;
    streak += 1;
  }
  return streak;
}

export function resolveRuleFeedbackConfig(env = process.env) {
  const rawUnit = String(env.JEA_RULE_FEEDBACK_STREAK_UNIT || 'cycle').trim().toLowerCase();
  const streakUnit = RULE_FEEDBACK_STREAK_UNITS.includes(rawUnit) ? rawUnit : 'cycle';
  const windowCycles = envInt('JEA_RULE_FEEDBACK_WINDOW', DEFAULT_WINDOW_CYCLES, env);
  const windowEvidence = envInt('JEA_RULE_FEEDBACK_WINDOW_EVIDENCE', DEFAULT_WINDOW_EVIDENCE, env);
  return {
    streakUnit,
    windowCycles,
    windowEvidence,
    window: streakUnit === 'evidence' ? windowEvidence : windowCycles,
    deadStreak: envInt('JEA_RULE_FEEDBACK_DEAD_STREAK', DEFAULT_DEAD_STREAK, env),
    escalateStreak: envInt('JEA_RULE_FEEDBACK_ESCALATE_STREAK', DEFAULT_ESCALATE_STREAK, env),
    receiptLimit: envInt('JEA_RULE_FEEDBACK_RECEIPT_LIMIT', DEFAULT_RECEIPT_LIMIT, env),
    mutateCooldown: envIntAllowZero('JEA_RULE_FEEDBACK_MUTATE_COOLDOWN', DEFAULT_MUTATE_COOLDOWN, env),
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

function receiptBucketId(receipt, index = 0) {
  return String(receipt?.id || `receipt-anon-${receiptTimeMs(receipt)}-${index}`);
}

/**
 * Build ordered feedback buckets.
 * cycle: one best receipt per cycle (legacy behavior).
 * evidence: one serving receipt per bucket.
 */
export function buildGoalReceiptBuckets(receipts = [], {
  streakUnit = 'cycle',
  window = DEFAULT_WINDOW_CYCLES,
} = {}) {
  const newestFirst = [...receipts].sort((a, b) => receiptTimeMs(b) - receiptTimeMs(a));
  const groups = new Map();
  newestFirst.forEach((receipt, index) => {
    const key = streakUnit === 'evidence'
      ? receiptBucketId(receipt, index)
      : receiptCycleId(receipt);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(receipt);
  });
  const recentKeys = [...groups.keys()].slice(0, window).reverse();
  return recentKeys.map((bucketId) => {
    const bucketReceipts = groups.get(bucketId) || [];
    let best = null;
    let bestScore = -1;
    let bestExtracted = null;
    for (const receipt of bucketReceipts) {
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
      bucket_id: bucketId,
      cycle_id: receiptCycleId(best),
      receipt_id: best?.id ?? null,
      receipt_time_ms: receiptTimeMs(best),
      signature: extracted.signature,
      kv: signatureKv?.length ? signatureKv : (extracted.focus?.length ? extracted.focus : extracted.kv),
      focus_kv: extracted.focus,
      canonical: extracted.canonical,
      success: receiptSuccess(best),
    };
  });
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
 * Build serves_goal → enabled guard map from registry guards config.
 * @param {object[]} mechanicalGuards
 * @returns {Map<string, object>}
 */
export function buildMechanicalGuardMap(mechanicalGuards = []) {
  const map = new Map();
  for (const guard of Array.isArray(mechanicalGuards) ? mechanicalGuards : []) {
    if (!guard || guard.enabled === false || !guard.id) continue;
    const servesGoal = guard?.action?.serves_goal ?? guard?.serves_goal ?? null;
    if (!servesGoal || typeof servesGoal !== 'string') continue;
    map.set(servesGoal, {
      guard_id: String(guard.id),
      serves_goal: servesGoal,
      every_cycles: Math.max(1, Math.trunc(Number(guard.every_cycles) || 1)),
      action_type: guard?.action?.type ?? null,
    });
  }
  return map;
}

/**
 * Trailing consecutive success streak (newest-first) from cycle buckets.
 * Bucket success is best-receipt result.success for that cycle.
 */
export function computeHealthyStreak(bucketsNewestFirst = []) {
  let streak = 0;
  for (const bucket of bucketsNewestFirst) {
    if (bucket?.success !== true) break;
    streak += 1;
  }
  return streak;
}

/**
 * Trailing consecutive failure streak (newest-first).
 */
export function computeFailureStreak(bucketsNewestFirst = []) {
  let streak = 0;
  for (const bucket of bucketsNewestFirst) {
    if (bucket?.success !== false) break;
    streak += 1;
  }
  return streak;
}

function receiptSuccess(receipt) {
  if (!receipt) return null;
  if (receipt.result?.success === true) return true;
  if (receipt.result?.success === false) return false;
  return null;
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
  mechanicalGuards = null,
  env = process.env,
} = {}) {
  const cfg = resolveRuleFeedbackConfig(env);
  const streakUnit = cfg.streakUnit;
  const window = windowCycles ?? cfg.window;
  const dead = deadStreak ?? cfg.deadStreak;
  const escalate = escalateStreak ?? cfg.escalateStreak;
  const mutateCooldown = cfg.mutateCooldown;
  const guardMap = buildMechanicalGuardMap(mechanicalGuards);

  const goals = flattenGoalNodes(activeGoals);
  const childGoals = goals.filter((g) => g?.id && g.id !== activeGoals?.id);
  const activeChildIds = new Set(childGoals.map((g) => g.id));
  // js-intel-store returns chronological ascending (oldest→newest). Sort newest-first.
  const receipts = [...(store?.readActionReceipts?.({ limit: cfg.receiptLimit }) ?? [])]
    .sort((a, b) => receiptTimeMs(b) - receiptTimeMs(a));
  const goalEvents = [...(store?.readGoalEvents?.({ limit: 40 }) ?? [])]
    .sort((a, b) => receiptTimeMs(b) - receiptTimeMs(a));

  // Group serving receipts by goal. Bucket strategy is applied per goal below.
  const byGoal = new Map();
  for (const receipt of receipts) {
    const goalId = receiptGoalId(receipt);
    if (!goalId) continue;
    if (streakUnit === 'cycle' && !receiptCycleId(receipt)) continue;
    if (!byGoal.has(goalId)) byGoal.set(goalId, []);
    byGoal.get(goalId).push(receipt);
  }

  const globalCyclesNewestFirst = globalCycleIdsNewestFirst(receipts);
  const globalEvidenceNewestFirst = receipts
    .filter((receipt) => receiptGoalId(receipt))
    .map((receipt, index) => ({
      bucket_id: receiptBucketId(receipt, index),
      goal_id: receiptGoalId(receipt),
    }));
  const stats = [];
  const goalIds = new Set([
    ...childGoals.map((g) => g.id),
    ...byGoal.keys(),
  ]);

  for (const goalId of goalIds) {
    const goal = childGoals.find((g) => g.id === goalId) ?? goals.find((g) => g.id === goalId) ?? { id: goalId };
    const goalReceipts = byGoal.get(goalId) ?? [];
    const buckets = buildGoalReceiptBuckets(goalReceipts, {
      streakUnit,
      window,
    });
    const goalCycleIds = new Set(goalReceipts.map(receiptCycleId).filter(Boolean));
    const goalEvidenceIds = new Set(
      globalEvidenceNewestFirst
        .filter((item) => item.goal_id === goalId)
        .map((item) => item.bucket_id),
    );

    // Null-signature cycles (e.g. unrelated evidence-audit summaries) must not
    // break a sticky-law death streak — drop them from streak/gain calculation.
    const signedBuckets = buckets.filter((b) => b.signature);
    const { streak, signature, constant_keys } = computeSignatureStreak(signedBuckets);
    const prev = signedBuckets.length >= 2 ? signedBuckets[signedBuckets.length - 2] : null;
    const curr = signedBuckets.length ? signedBuckets[signedBuckets.length - 1] : null;
    const information_gain = computeInformationGain(prev, curr);
    const bucketsNewestFirst = [...buckets].reverse();
    const healthy_streak = computeHealthyStreak(bucketsNewestFirst);
    const failure_streak = computeFailureStreak(bucketsNewestFirst);
    const mechanically_maintained = guardMap.has(goalId);
    const maintaining_guard = mechanically_maintained ? guardMap.get(goalId) : null;

    let feedback_state = classifyFeedbackState(streak, information_gain, {
      deadStreak: dead,
      constantKeys: constant_keys,
    });
    // Mechanically maintained + trailing success: constant signature is expected
    // (guard probes are rhythmically identical when healthy). Force live.
    if (mechanically_maintained && healthy_streak > 0 && failure_streak === 0) {
      feedback_state = 'live';
    }
    const stuck = carryoverStuckForGoal(carryoverDoc, goalId);
    const consecutive_learn = consecutiveLearnStreak(goalEvents);
    const is_root = goalId === activeGoals?.id;
    const is_guard = isGuardGoal(goal);
    const in_active_tree = is_root || childGoals.some((g) => g.id === goalId);
    const last_mutate_patch = findLastMutatePatchForGoal(goalEvents, goalId);
    const units_since_mutate = last_mutate_patch
      ? countSignedBucketsSinceMutate(signedBuckets, last_mutate_patch.recorded_at_ms)
      : null;
    const mutate_cooldown = Boolean(
      mutateCooldown > 0
      && last_mutate_patch
      && feedback_state === 'dead'
      && units_since_mutate != null
      && units_since_mutate < mutateCooldown,
    );
    if (mutate_cooldown) {
      feedback_state = 'degraded';
    }
    const mutate_effective = computeMutateEffective({
      lastMutatePatch: last_mutate_patch,
      cyclesSinceMutate: units_since_mutate,
      mutateCooldown,
      signedBuckets,
      currentSignature: signature,
    });
    // Starved exemption: mechanically maintained goals (not role=guard).
    // Unmaintained guard goals participate in starved detection.
    const starved_streak = (!in_active_tree || is_root || mechanically_maintained)
      ? 0
      : computeStarvedStreak(streakUnit === 'evidence'
        ? {
          globalCycleIdsNewestFirst: globalEvidenceNewestFirst.map((item) => item.bucket_id),
          goalCycleIds: goalEvidenceIds,
          windowCycles: window,
        }
        : {
          globalCycleIdsNewestFirst: globalCyclesNewestFirst,
          goalCycleIds,
          windowCycles: window,
        });
    const starved = in_active_tree && !is_root && !mechanically_maintained && starved_streak >= dead;
    const escalate_eligible = (feedback_state === 'dead' && streak >= escalate)
      || (starved && starved_streak >= escalate);

    stats.push({
      goal_id: goalId,
      goal_name: goal?.name ?? null,
      is_guard,
      is_root,
      mechanically_maintained,
      maintaining_guard_id: maintaining_guard?.guard_id ?? null,
      healthy_streak,
      failure_streak,
      feedback_state,
      constant_signature_streak: streak,
      constant_signature: signature,
      constant_keys,
      information_gain,
      streak_unit: streakUnit,
      units_observed: buckets.length,
      cycles_observed: buckets.length,
      recent_cycles: buckets.map((b) => b.cycle_id),
      recent_buckets: buckets.map((b) => b.bucket_id),
      latest_receipt_id: curr?.receipt_id ?? null,
      carryover_stuck: stuck,
      consecutive_learn,
      last_mutate_cycle: last_mutate_patch?.cycle_id ?? null,
      units_since_mutate,
      cycles_since_mutate: units_since_mutate,
      mutate_cooldown,
      mutate_effective,
      starved_streak,
      starved,
      escalate_eligible,
    });
  }

  // Mechanical guards summary (including guards whose serves_goal is not in active tree).
  const mechanical_guards = [...guardMap.values()].map((g) => {
    const goalStat = stats.find((s) => s.goal_id === g.serves_goal) ?? null;
    const inTree = activeChildIds.has(g.serves_goal);
    let recent_status = 'unknown';
    if (goalStat) {
      if (goalStat.failure_streak > 0) recent_status = 'failed';
      else if (goalStat.healthy_streak > 0) recent_status = 'ok';
      else if (goalStat.cycles_observed === 0) recent_status = 'no_receipts';
    } else if (!inTree) {
      recent_status = 'no_active_goal';
    }
    return {
      guard_id: g.guard_id,
      serves_goal: g.serves_goal,
      every_cycles: g.every_cycles,
      action_type: g.action_type,
      goal_in_active_tree: inTree,
      recent_status,
      healthy_streak: goalStat?.healthy_streak ?? 0,
      failure_streak: goalStat?.failure_streak ?? 0,
      feedback_state: goalStat?.feedback_state ?? null,
      eligible_for_retirement: Boolean(
        inTree
        && goalStat
        && goalStat.mechanically_maintained
        && goalStat.healthy_streak >= dead
        && goalStat.feedback_state === 'live',
      ),
      // Rebirth only when mechanism is failing and no active goal covers it.
      // Healthy retired goals (guard still succeeding) must NOT request rebirth.
      eligible_for_rebirth: Boolean(
        !inTree && (goalStat?.failure_streak ?? 0) >= dead,
      ),
    };
  });

  // Sort: dead/starved first, then degraded, then by streak desc.
  const order = { dead: 0, degraded: 1, live: 2 };
  stats.sort((a, b) => {
    const aRank = a.starved && a.feedback_state === 'live' ? 0.5 : order[a.feedback_state];
    const bRank = b.starved && b.feedback_state === 'live' ? 0.5 : order[b.feedback_state];
    return (aRank - bRank)
      || (b.starved_streak - a.starved_streak)
      || (b.constant_signature_streak - a.constant_signature_streak);
  });

  return {
    config: {
      streak_unit: streakUnit,
      window: window,
      window_cycles: streakUnit === 'cycle' ? window : null,
      window_evidence: streakUnit === 'evidence' ? window : null,
      dead_streak: dead,
      escalate_streak: escalate,
      mutate_cooldown: mutateCooldown,
    },
    generated_at: new Date().toISOString(),
    goals: stats,
    mechanical_guards,
    summary: {
      dead: stats.filter((s) => s.feedback_state === 'dead').length,
      degraded: stats.filter((s) => s.feedback_state === 'degraded').length,
      live: stats.filter((s) => s.feedback_state === 'live').length,
      starved: stats.filter((s) => s.starved).length,
      escalate_eligible: stats.filter((s) => s.escalate_eligible).length,
      mechanically_maintained: stats.filter((s) => s.mechanically_maintained).length,
      eligible_for_retirement: mechanical_guards.filter((g) => g.eligible_for_retirement).length,
      eligible_for_rebirth: mechanical_guards.filter((g) => g.eligible_for_rebirth).length,
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
    // Cosmetic / ineffective prior mutate (same signature regime) does not suppress
    // escalation even when this cycle also mutates the same goal.
    const mutateExempts = mutatedThisCycle && stat.mutate_effective !== false;
    if (mutateExempts && patchedThisGoal) continue;
    // If assess said mutate and calibrate applied any patch touching this goal, skip.
    // Also skip if mutate applied a tree-level rewrite (proposed_goal) covering it —
    // conservative: only skip when this child was explicitly patched.
    const treeRewriteModes = new Set(['replace', 'full_replace']);
    if (mutateExempts && !appliedChildIds.size && treeRewriteModes.has(calibrateResult?.mode)) {
      continue;
    }
    escalations.push(stat);
  }
  return escalations;
}

export function buildRuleFeedbackQuestionText(stat) {
  const unit = stat?.streak_unit === 'evidence' ? 'serving evidence records' : 'cycles';
  const keys = (stat.constant_keys || [])
    .slice(0, 8)
    .map((p) => `${p.key}=${p.value}`)
    .join(', ');
  if (stat?.starved && stat.feedback_state !== 'dead') {
    return [
      `Outcome goal starvation detected for ${stat.goal_id}`
        + (stat.goal_name ? ` (${stat.goal_name})` : '')
        + '.',
      `No action_receipt served this goal for ${stat.starved_streak} consecutive ${unit}`
        + ' (starved_streak at escalate threshold).',
      'Please decide whether the goal exit path / observation point needs revision',
      '(Cyber-Taoist: outcome pressure lost — conventional transactions never feed this goal).',
      'Prefer mutating the exit condition into a path reachable by allowed actions.',
    ].join(' ');
  }
  return [
    `Rule feedback death detected for goal ${stat.goal_id}`
      + (stat.goal_name ? ` (${stat.goal_name})` : '')
      + '.',
    `Constant result signature persisted for ${stat.constant_signature_streak} ${unit}`
      + (keys ? ` with keys: ${keys}` : '')
      + '; information_gain=0.'
      + (stat.mutate_effective === false
        ? ' Prior mutate did not change the signature (mutate_effective=false).'
        : ''),
    'Please decide whether this acceptance criterion observation point needs revision',
    '(Cyber-Taoist: law lagged, conventional transactions no longer produce useful feedback).',
    'Prefer revising the observation point while keeping the guard function (守功能、破形态).',
  ].join(' ');
}

/**
 * Compact prompt block for Decide (dead / degraded / starved / mechanized goals).
 * Informational — no new required JSON fields.
 */
export function formatRuleFeedbackForPrompt(ruleFeedbackStats = null, language = 'zh') {
  const isEn = language === 'en';
  const streakUnit = ruleFeedbackStats?.config?.streak_unit || 'cycle';
  const goals = Array.isArray(ruleFeedbackStats?.goals) ? ruleFeedbackStats.goals : [];
  const notable = goals.filter((g) => g?.feedback_state === 'dead'
    || g?.feedback_state === 'degraded'
    || g?.starved
    || g?.mechanically_maintained);
  const header = isEn
    ? [
      '## Rule Feedback Health',
      '',
      'Mechanical per-goal feedback health (dead / degraded / starved / mechanized).',
      'Do not repeat the same probe unchanged for a goal with a constant or starved streak;',
      'if taking no action, explain under deferred or goal_coverage.not_covered.',
      'Goals marked mechanically_maintained are already served by evolution.guards — do not re-queue the same probe.',
    ].join('\n')
    : [
      '## Rule Feedback Health',
      '',
      '机械目标反馈健康度（dead / degraded / starved / mechanized）。',
      '签名恒定或 starved 的 goal 不应原样重复同一探针；若不行动，须在 deferred 或 goal_coverage.not_covered 说明。',
      '标注 mechanically_maintained 的目标已由 evolution.guards 机械维持——勿再入队相同探针。',
    ].join('\n');

  if (!notable.length) {
    return `${header}\n\n${isEn ? '(none notable)' : '（无异常）'}`;
  }

  const lines = notable.map((g) => {
    const keys = (g.constant_keys || [])
      .slice(0, 4)
      .map((p) => `${p.key}=${p.value}`)
      .join(',');
    const parts = [
      g.goal_id,
      `state=${g.feedback_state}`,
      `unit=${g.streak_unit || streakUnit}`,
      g.mechanically_maintained
        ? `mechanically_maintained${g.maintaining_guard_id ? `(${g.maintaining_guard_id})` : ''}`
        : null,
      g.healthy_streak ? `healthy_streak=${g.healthy_streak}` : null,
      g.starved ? `starved_streak=${g.starved_streak}` : null,
      g.constant_signature_streak
        ? `sig_streak=${g.constant_signature_streak}`
        : null,
      keys ? `keys=${keys}` : null,
      g.mutate_effective === false ? 'mutate_effective=false' : null,
      g.mutate_cooldown ? 'mutate_cooldown' : null,
    ].filter(Boolean);
    return `- ${parts.join(' | ')}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}
