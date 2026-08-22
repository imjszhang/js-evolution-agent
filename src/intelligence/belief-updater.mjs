import { readFileSync } from 'node:fs';
import { extractBeliefContext } from '../contracts/belief-context.mjs';
import { chatMessages, extractJsonFromText } from '../ai/messages.mjs';
import {
  buildPromptCacheMetadata,
  markPromptCacheInvariant,
} from '../ai/prompt-cache-metadata.mjs';
import {
  BELIEF_CHANGES,
  BELIEF_CONFIDENCE,
  BELIEF_STATUSES,
  emptyCurrentBeliefs,
  normalizeCurrentBeliefs,
  partitionBeliefs,
  summarizeBeliefForPrompt,
} from './beliefs.mjs';
import { summarizeVerificationReport } from './goal-assessor.mjs';

const BELIEF_UPDATE_PROMPT_MAX_CHARS = 120000;
const RECENTLY_REFUTED_LIMIT = 10;

function clip(value, max = 8000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function flattenGoals(goals) {
  if (!goals) return [];
  const out = [];
  const visit = (node) => {
    if (!node) return;
    out.push({
      id: node.id,
      name: node.name,
      intent: node.intent,
      good_signal: node.good_signal,
      bad_signal: node.bad_signal,
    });
    for (const child of node.children || []) visit(child);
  };
  visit(goals);
  return out;
}

function summarizeAction(action = {}) {
  const runSpec = action?.params?.run_spec
    ?? action?.params?.runSpec
    ?? action?.run_spec
    ?? action?.runSpec
    ?? {};
  const context = extractBeliefContext(action);
  return {
    type: action.type ?? null,
    description: clip(action.description ?? '', 240),
    serves_goal: action.serves_goal ?? null,
    belief_id: context.belief_id ?? null,
    belief_relation: context.belief_relation ?? null,
    expected_belief_claim: clip(context.expected_belief_claim ?? '', 240),
    expected_belief_update: clip(context.expected_belief_update ?? '', 240),
    intent: clip(runSpec.intent ?? '', 240),
  };
}

function summarizeReceipt(receipt = {}) {
  const result = receipt.result ?? {};
  return {
    id: receipt.id ?? null,
    action_type: receipt.action_type ?? receipt.action?.type ?? null,
    status: result.status ?? null,
    success: result.success ?? null,
    message: clip(result.message ?? result.error ?? '', 240),
    decision_id: receipt.decision_id ?? null,
    belief_id: receipt.belief_id ?? null,
    belief_relation: receipt.belief_relation ?? extractBeliefContext(receipt.action).belief_relation ?? null,
    expected_belief_claim: clip(
      receipt.expected_belief_claim
        ?? extractBeliefContext(receipt.action).expected_belief_claim
        ?? '',
      240,
    ),
  };
}

function compactBeliefEntry(belief) {
  return {
    id: belief?.id ?? null,
    claim: belief?.claim ?? '',
    status: belief?.status ?? 'active',
  };
}

/** Compress beliefs for the updater prompt so cycle evidence is not truncated away. */
export function compressBeliefsForPrompt(beliefsDoc) {
  const doc = normalizeCurrentBeliefs(beliefsDoc);
  const parts = partitionBeliefs(doc.beliefs || []);
  return {
    exists: doc.exists,
    resource_kind: doc.resource_kind,
    resource_scope: doc.resource_scope,
    canonical_path: doc.canonical_path,
    source_role: doc.source_role,
    schema_version: doc.schema_version,
    updated_at: doc.updated_at,
    source_cycle_id: doc.source_cycle_id,
    beliefs: {
      active: parts.active.map(summarizeBeliefForPrompt),
      validated: parts.validated.map(summarizeBeliefForPrompt),
      recently_refuted: parts.recentlyRefuted.slice(-RECENTLY_REFUTED_LIMIT).map(compactBeliefEntry),
      retired: parts.retired.map(compactBeliefEntry),
    },
    counts: {
      active: parts.active.length,
      validated: parts.validated.length,
      refuted: parts.recentlyRefuted.length,
      retired: parts.retired.length,
      total: (doc.beliefs || []).length,
    },
  };
}

export function fallbackBeliefUpdate(reason = 'Belief update unavailable') {
  return {
    status: 'skipped',
    reason,
    updates: [],
  };
}

export function buildBeliefUpdateContext({
  activeGoals,
  currentBeliefs = null,
  intelResult = null,
  execResult = null,
  verification = null,
  verificationReportPath = null,
  store = null,
  operatorAssertions = [],
  receipts: suppliedReceipts = null,
  evidenceRefs = null,
} = {}) {
  const beliefsDoc = normalizeCurrentBeliefs(currentBeliefs ?? store?.readCurrentBeliefs?.() ?? null);
  const receipts = Array.isArray(suppliedReceipts)
    ? suppliedReceipts
    : store?.readActionReceipts
    ? store.readActionReceipts({ limit: 20 }).filter((r) => {
      const cycleId = execResult?.cycle_id ?? intelResult?.cycle_id ?? null;
      if (!cycleId) return true;
      return r.cycle_id === cycleId
        || r.exec_cycle_id === cycleId
        || r.intel_cycle_id === intelResult?.cycle_id;
    })
    : [];

  // Evidence first: large belief docs used to truncate receipts/verification out of the prompt.
  // current_beliefs stays full here for applyBeliefUpdates; prompt path compresses via
  // compressBeliefsForPrompt before JSON serialization.
  return {
    cycle: {
      intel_cycle_id: intelResult?.cycle_id ?? null,
      exec_cycle_id: execResult?.cycle_id ?? null,
    },
    analysis: {
      decision: intelResult?.analysis?.decision ?? null,
      rationale: clip(intelResult?.analysis?.rationale ?? '', 800),
    },
    actions: asArray(intelResult?.actions).map(summarizeAction),
    receipts: receipts.map(summarizeReceipt),
    verification: summarizeVerificationReport(verificationReportPath),
    semantic: verification?.semantic ?? null,
    active_goals: activeGoals,
    active_goals_flat: flattenGoals(activeGoals),
    current_beliefs: beliefsDoc,
    settlement_evidence_refs: Array.isArray(evidenceRefs) ? evidenceRefs : null,
    operator_assertions: asArray(operatorAssertions).map((fact) => ({
      fact_id: fact.id ?? fact.fact_id ?? null,
      content: fact.content ?? fact.summary ?? fact.claim ?? '',
      injected_by_cycle: fact.injected_by_cycle ?? null,
      confidence: fact.confidence ?? 'high',
    })),
  };
}

export function buildBeliefUpdatePromptContext(context = {}) {
  if (!context || typeof context !== 'object') return {};
  return {
    ...context,
    current_beliefs: compressBeliefsForPrompt(context.current_beliefs),
  };
}

export function buildBeliefUpdatePrompt({ context, language = 'zh' } = {}) {
  const promptContext = buildBeliefUpdatePromptContext(context);
  const contextJson = clip(JSON.stringify(promptContext, null, 2), BELIEF_UPDATE_PROMPT_MAX_CHARS);
  if (language !== 'en') {
    return `你是 js-evolution-agent 的信念更新器。根据本轮执行与验证证据，更新 current_beliefs。

硬约束：
- 只返回一个 JSON 对象，不要 Markdown，不要代码块。
- 只能基于 Machine Context 中的 receipts、verification、semantic 与 actions 更新信念。
- 没有 evidence_refs 支撑时，不得把 confidence 提升为 high，也不得把 status 改为 validated。
- refuted 信念不能无证据 reopen；reopen 必须说明新的 seen 证据。
- create 新 belief 必须有 goal_id、claim、next_test。
- unchanged 也要写出 reason。
- 不要把 report 叙事直接当事实；优先使用 verify_report 与 action_receipt。
- 若 Machine Context 含 operator_assertions：它们是本轮默认为真的一次性操作者种子。你必须为每一条输出 operator_fact_digestions 项：
  - supported：本轮证据支持 → 将进入 validated 信念
  - untested：本轮未测到 → 将进入 active 高置信信念（标记未验证）
  - contradicted：本轮证据矛盾 → 不入库为真，系统会向操作者提问；请给出 question 文案
  不得省略任何 assertion；宿主会对漏项机械按 untested 补齐。

JSON schema:
{
  "status": "updated|skipped|failed",
  "reason": "string",
  "updates": [
    {
      "belief_id": "string|null",
      "change": "create|strengthen|weaken|validate|refute|unchanged|retire|reopen",
      "goal_id": "string|null",
      "claim": "string|null",
      "confidence": "low|medium|high|null",
      "status": "active|validated|refuted|retired|null",
      "next_test": "string|null",
      "recheck_trigger": "string|null",
      "reason": "string",
      "evidence_refs": ["action_receipt:...", "verify_report:..."]
    }
  ],
  "operator_fact_digestions": [
    {
      "fact_id": "string",
      "outcome": "supported|untested|contradicted",
      "reason": "string",
      "goal_id": "string|null",
      "claim": "string|null",
      "next_test": "string|null",
      "evidence_refs": ["action_receipt:...", "verify_report:..."],
      "question": "string|null"
    }
  ]
}

=== Machine Context ===
${contextJson}`;
  }

  return `You are the belief updater for js-evolution-agent. Update current_beliefs from execution and verification evidence in this cycle.

Hard constraints:
- Return only one JSON object. No Markdown, no code fence.
- Update beliefs only from receipts, verification, semantic results, and actions in Machine Context.
- Do not raise confidence to high or set status to validated without evidence_refs.
- Do not reopen refuted beliefs without new seen evidence and an explicit reopen change.
- create requires goal_id, claim, and next_test.
- unchanged updates still require reason.
- Prefer verify_report and action_receipt over report narrative.
- If Machine Context includes operator_assertions: they are one-shot operator seeds that were default-true this cycle. Emit one operator_fact_digestions row per assertion:
  - supported: cycle evidence supports it → becomes a validated belief
  - untested: not tested this cycle → becomes an active high-confidence belief (marked unverified)
  - contradicted: cycle evidence contradicts it → do not store as true; system will ask the operator; provide question text
  Do not omit any assertion; the host mechanically fills omissions as untested.

JSON schema:
{
  "status": "updated|skipped|failed",
  "reason": "string",
  "updates": [
    {
      "belief_id": "string|null",
      "change": "create|strengthen|weaken|validate|refute|unchanged|retire|reopen",
      "goal_id": "string|null",
      "claim": "string|null",
      "confidence": "low|medium|high|null",
      "status": "active|validated|refuted|retired|null",
      "next_test": "string|null",
      "recheck_trigger": "string|null",
      "reason": "string",
      "evidence_refs": ["action_receipt:...", "verify_report:..."]
    }
  ],
  "operator_fact_digestions": [
    {
      "fact_id": "string",
      "outcome": "supported|untested|contradicted",
      "reason": "string",
      "goal_id": "string|null",
      "claim": "string|null",
      "next_test": "string|null",
      "evidence_refs": ["action_receipt:...", "verify_report:..."],
      "question": "string|null"
    }
  ]
}

=== Machine Context ===
${contextJson}`;
}

export function parseBeliefUpdate(raw) {
  const parsed = extractJsonFromText(raw);
  const status = ['updated', 'skipped', 'failed'].includes(parsed.status) ? parsed.status : 'updated';
  const updates = asArray(parsed.updates).map((item) => ({
    belief_id: item?.belief_id ?? null,
    change: BELIEF_CHANGES.has(item?.change) ? item.change : 'unchanged',
    goal_id: item?.goal_id ?? null,
    claim: item?.claim ?? null,
    confidence: BELIEF_CONFIDENCE.has(item?.confidence) ? item.confidence : null,
    status: BELIEF_STATUSES.has(item?.status) ? item.status : null,
    next_test: item?.next_test ?? null,
    recheck_trigger: item?.recheck_trigger ?? null,
    reason: String(item?.reason || parsed.reason || 'No reason provided.'),
    evidence_refs: asArray(item?.evidence_refs).map(String),
    origin: item?.origin ?? null,
    origin_fact_id: item?.origin_fact_id ?? null,
    origin_verification: item?.origin_verification ?? null,
  }));
  const operatorFactDigestions = asArray(parsed.operator_fact_digestions).map((item) => ({
    fact_id: item?.fact_id ?? item?.id ?? null,
    outcome: ['supported', 'untested', 'contradicted'].includes(item?.outcome)
      ? item.outcome
      : 'untested',
    reason: String(item?.reason || '').trim() || null,
    goal_id: item?.goal_id ?? null,
    claim: item?.claim ?? null,
    next_test: item?.next_test ?? null,
    evidence_refs: asArray(item?.evidence_refs).map(String),
    question: item?.question ?? null,
  })).filter((item) => item.fact_id);
  return {
    status,
    reason: String(parsed.reason || 'Belief update parsed.'),
    updates,
    operator_fact_digestions: operatorFactDigestions,
  };
}

function nextConfidence(current = 'medium', change = 'unchanged') {
  const order = ['low', 'medium', 'high'];
  const idx = Math.max(0, order.indexOf(current));
  if (change === 'strengthen' || change === 'validate') return order[Math.min(idx + 1, order.length - 1)];
  if (change === 'weaken' || change === 'refute') return order[Math.max(idx - 1, 0)];
  return current;
}

function cloneBelief(belief) {
  return JSON.parse(JSON.stringify(belief));
}

export function applyBeliefUpdates(currentBeliefsDoc, updates = [], {
  cycleId = null,
  source = 'post_verify_belief_update',
  producer = null,
  activationTargets = null,
  causalIdentity = {},
} = {}) {
  const base = normalizeCurrentBeliefs(currentBeliefsDoc);
  const beliefsById = new Map((base.beliefs || []).map((b) => [b.id, cloneBelief(b)]));
  const events = [];
  const now = new Date().toISOString();

  for (const update of updates) {
    const change = update.change ?? 'unchanged';
    if (change === 'create') {
      const id = update.belief_id || `belief-${Date.now()}-${events.length + 1}`;
      const after = {
        id,
        goal_id: update.goal_id,
        claim: update.claim,
        status: update.status || 'active',
        confidence: update.confidence || 'medium',
        evidence_refs: update.evidence_refs || [],
        next_test: update.next_test,
        recheck_trigger: update.recheck_trigger ?? null,
        origin: update.origin ?? null,
        origin_fact_id: update.origin_fact_id ?? null,
        origin_verification: update.origin_verification ?? null,
        last_change: {
          cycle_id: cycleId,
          change,
          reason: update.reason,
          changed_at: now,
        },
      };
      beliefsById.set(id, after);
      events.push({
        ...causalIdentity,
        cycle_id: cycleId,
        belief_id: id,
        change,
        reason: update.reason,
        evidence_refs: update.evidence_refs || [],
        source,
        ...(producer ? { producer } : {}),
        ...(Array.isArray(activationTargets) ? { activation_targets: activationTargets } : {}),
        before: null,
        after,
      });
      continue;
    }

    const beliefId = update.belief_id;
    if (!beliefId || !beliefsById.has(beliefId)) continue;
    const before = cloneBelief(beliefsById.get(beliefId));
    const after = cloneBelief(before);
    if (update.claim) after.claim = update.claim;
    if (update.goal_id) after.goal_id = update.goal_id;
    if (update.next_test != null) after.next_test = update.next_test;
    if (update.recheck_trigger != null) after.recheck_trigger = update.recheck_trigger;
    if (update.origin != null) after.origin = update.origin;
    if (update.origin_fact_id != null) after.origin_fact_id = update.origin_fact_id;
    if (update.origin_verification != null) after.origin_verification = update.origin_verification;
    if (update.status) after.status = update.status;
    else if (change === 'validate') after.status = 'validated';
    else if (change === 'refute') after.status = 'refuted';
    else if (change === 'retire') after.status = 'retired';
    else if (change === 'reopen') after.status = 'active';
    after.confidence = update.confidence || nextConfidence(before.confidence, change);
    if (update.evidence_refs?.length) {
      after.evidence_refs = [...new Set([...(before.evidence_refs || []), ...update.evidence_refs])];
    }
    after.last_change = {
      cycle_id: cycleId,
      change,
      reason: update.reason,
      changed_at: now,
    };
    beliefsById.set(beliefId, after);
    events.push({
      ...causalIdentity,
      cycle_id: cycleId,
      belief_id: beliefId,
      change,
      reason: update.reason,
      evidence_refs: update.evidence_refs || [],
      source,
      ...(producer ? { producer } : {}),
      ...(Array.isArray(activationTargets) ? { activation_targets: activationTargets } : {}),
      before,
      after,
    });
  }

  return {
    currentBeliefs: {
      schema_version: 1,
      updated_at: now,
      source_cycle_id: cycleId,
      beliefs: [...beliefsById.values()],
    },
    events,
  };
}

export async function updateBeliefsWithAi({
  aiClient,
  activeGoals,
  intelResult,
  execResult,
  verification,
  verificationReportPath = null,
  store,
  language = 'zh',
  logger = null,
  operatorAssertions = [],
  goalIds = null,
  canCommit = null,
  producer = null,
  activationTargets = null,
  causalIdentity = null,
  receipts = null,
  evidenceRefs = null,
  settlement = null,
  faultInjector = null,
} = {}) {
  if (settlement?.settlement_id && typeof store?.commitBeliefEffect === 'function') {
    const resumed = store.commitBeliefEffect({ settlement, faultInjector });
    if (resumed) {
      return {
        ...(resumed.result ?? {}),
        currentBeliefs: resumed.currentBeliefs,
        eventsWritten: 0,
        reused: true,
      };
    }
  }
  const context = buildBeliefUpdateContext({
    activeGoals,
    intelResult,
    execResult,
    verification,
    verificationReportPath,
    store,
    operatorAssertions,
    receipts,
    evidenceRefs,
  });
  const prompt = buildBeliefUpdatePrompt({ context, language });
  const stablePrompt = buildBeliefUpdatePrompt({ context: {}, language });
  const promptCache = buildPromptCacheMetadata({
    profile: 'belief_update',
    messages: [{ role: 'user', content: prompt }],
    stablePrefix: stablePrompt,
    dynamicPayload: JSON.stringify(context, null, 2),
  });
  const promptCacheInvariant = markPromptCacheInvariant({
    scope: 'belief_update',
    metadata: promptCache,
    logger,
  });

  if (!aiClient || (typeof aiClient.chat !== 'function' && typeof aiClient.chatMessages !== 'function')) {
    return {
      source: 'fallback',
      context,
      prompt,
      prompt_cache: {
        ...promptCache,
        invariant: promptCacheInvariant,
      },
      result: {
        ...fallbackBeliefUpdate('AI client unavailable.'),
        operator_fact_digestions: [],
      },
      currentBeliefs: normalizeCurrentBeliefs(store?.readCurrentBeliefs?.() ?? emptyCurrentBeliefs()),
      eventsWritten: 0,
    };
  }

  try {
    const raw = await chatMessages(aiClient, [{ role: 'user', content: prompt }]);
    const parsed = parseBeliefUpdate(raw);
    const cycleId = execResult?.cycle_id ?? intelResult?.cycle_id ?? null;
    const allowedGoals = Array.isArray(goalIds) && goalIds.length
      ? new Set(goalIds)
      : null;
    let filteredUpdates = allowedGoals
      ? (parsed.updates || []).filter((update) => !update.goal_id || allowedGoals.has(update.goal_id))
      : parsed.updates;
    if (Array.isArray(evidenceRefs)) {
      const exactRefs = [...new Set(evidenceRefs.map(String))];
      filteredUpdates = filteredUpdates.map((update) => {
        const next = { ...update, evidence_refs: exactRefs };
        if (
          ['validate', 'refute', 'reopen'].includes(next.change)
          && exactRefs.length === 0
        ) {
          return {
            ...next,
            change: 'unchanged',
            status: null,
            reason: `${next.reason} (settlement rejected: exact evidence refs missing)`,
          };
        }
        return next;
      });
    }
    const applyTo = (currentBeliefs) => applyBeliefUpdates(currentBeliefs, filteredUpdates, {
        cycleId,
        producer,
        activationTargets,
        causalIdentity: {
          ...(causalIdentity ?? {
            producer_batch_id: verification?.producer_batch_id ?? execResult?.producer_batch_id ?? null,
            reaction_id: verification?.reaction_id ?? execResult?.reaction_id ?? null,
            decision_id: verification?.decision_id ?? execResult?.decision_id ?? null,
            execution_id: verification?.execution_id ?? execResult?.execution_id ?? null,
          }),
          ...(settlement ?? {}),
        },
      });
    let applied = applyTo(context.current_beliefs);
    let eventsWritten = 0;
    if (store && parsed.status !== 'failed') {
      if (typeof canCommit === 'function' && !canCommit()) {
        const error = new Error('reactor_task_lease_lost');
        error.code = 'lease_lost';
        throw error;
      }
      if (settlement?.settlement_id && typeof store.commitBeliefEffect === 'function') {
        const effectResult = {
          source: 'ai',
          result: parsed,
        };
        const committed = store.commitBeliefEffect({
          settlement,
          faultInjector,
          prepare: (latestCurrentBeliefs) => {
            applied = applyTo(latestCurrentBeliefs);
            return {
              ...applied,
              effectResult,
            };
          },
        });
        applied = {
          currentBeliefs: committed.currentBeliefs,
          events: [],
        };
        eventsWritten = committed.eventsWritten;
      } else if (parsed.updates.length) {
        store.recordCurrentBeliefs(applied.currentBeliefs);
        for (const event of applied.events) {
          eventsWritten += store.recordBeliefEvent(event);
        }
      }
    }
    return {
      source: 'ai',
      context,
      prompt,
      prompt_cache: {
        ...promptCache,
        invariant: promptCacheInvariant,
      },
      result: parsed,
      currentBeliefs: applied.currentBeliefs,
      eventsWritten,
    };
  } catch (e) {
    if (settlement?.settlement_id) throw e;
    const msg = e?.message || String(e);
    logger?.warn?.(`[beliefs] AI update failed: ${msg}; keeping previous beliefs`);
    return {
      source: 'fallback',
      context,
      prompt,
      prompt_cache: {
        ...promptCache,
        invariant: promptCacheInvariant,
      },
      result: {
        ...fallbackBeliefUpdate(`AI update failed: ${msg}`),
        operator_fact_digestions: [],
      },
      currentBeliefs: normalizeCurrentBeliefs(store?.readCurrentBeliefs?.() ?? emptyCurrentBeliefs()),
      eventsWritten: 0,
    };
  }
}

/**
 * Retire active/validated beliefs bound to removed goal child ids (goal patch path).
 */
export function retireBeliefsForGoalIds(store, goalIds, {
  cycleId = null,
  reason = null,
  source = 'goal_patch',
} = {}) {
  const ids = new Set((goalIds || []).filter(Boolean));
  if (!ids.size || !store?.readCurrentBeliefs) {
    return { retirements: [], eventsWritten: 0, currentBeliefs: null };
  }

  const doc = normalizeCurrentBeliefs(store.readCurrentBeliefs());
  const updates = [];
  for (const belief of doc.beliefs || []) {
    if (!ids.has(belief.goal_id)) continue;
    if (belief.status !== 'active' && belief.status !== 'validated') continue;
    updates.push({
      belief_id: belief.id,
      change: 'retire',
      reason: reason || `goal_patch_remove_child:${belief.goal_id}`,
    });
  }

  if (!updates.length) {
    return { retirements: [], eventsWritten: 0, currentBeliefs: doc };
  }

  const applied = applyBeliefUpdates(doc, updates, { cycleId, source });
  if (store.recordCurrentBeliefs) {
    store.recordCurrentBeliefs(applied.currentBeliefs);
  }
  let eventsWritten = 0;
  if (store.recordBeliefEvent) {
    for (const event of applied.events) {
      eventsWritten += store.recordBeliefEvent(event);
    }
  }
  const retirements = applied.events.map((event) => ({
    belief_id: event.belief_id,
    goal_id: event.after?.goal_id ?? event.before?.goal_id ?? null,
    cycle_id: cycleId,
  }));
  return { retirements, eventsWritten, currentBeliefs: applied.currentBeliefs };
}

export async function updateActiveBeliefs(root, {
  cycleId = null,
  intelResult = null,
  execResult = null,
  verification = null,
  verificationReportPath = null,
  activeGoals = null,
  store = null,
  aiClient = null,
  agentContextDocs = [],
  logger = null,
  runtimeRoot = null,
  operatorAssertions = null,
  goalIds = null,
  canCommit = null,
  producer = null,
  activationTargets = null,
  causalIdentity = null,
  receipts = null,
  evidenceRefs = null,
  settlement = null,
} = {}) {
  const { getActiveGoals } = await import('../cli/commands/goals.mjs');
  const { getProjectRoot } = await import('../infra/project.mjs');
  const { join } = await import('node:path');
  const { createIntelligenceStore } = await import('./store.mjs');
  const { runtimeInfoForDefaultSubject } = await import('../infra/subjects.mjs');
  const { detectLanguage } = await import('./report-builder.mjs');
  const { loadDigestibleOperatorFacts, applyOperatorFactDigestions } = await import('./operator-fact-digestion.mjs');

  const projectRoot = root || getProjectRoot();
  const active = activeGoals ? { goals: activeGoals } : getActiveGoals(projectRoot);
  const runtime = runtimeInfoForDefaultSubject(projectRoot);
  const resolvedRuntimeRoot = runtimeRoot || runtime.runtimeRoot;
  const intelligenceStore = store ?? createIntelligenceStore({
    baseDir: join(resolvedRuntimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });

  let cfg = { aiClient, agentContextDocs, host: { logger } };
  if (!aiClient) {
    const { default: loadConfig } = await import('../../oada.config.mjs');
    cfg = await loadConfig({ cwd: projectRoot });
  }

  const subjectDoc = Array.isArray(cfg.agentContextDocs)
    ? cfg.agentContextDocs.find((d) => d?.id?.includes(':subject:'))
    : null;
  const language = detectLanguage(subjectDoc?.text);

  const assertions = Array.isArray(operatorAssertions)
    ? operatorAssertions
    : (resolvedRuntimeRoot
      ? loadDigestibleOperatorFacts(resolvedRuntimeRoot, {
        factIds: intelResult?.injected_operator_fact_ids ?? null,
      })
      : []);

  const updated = await updateBeliefsWithAi({
    aiClient: cfg.aiClient,
    activeGoals: active.goals,
    intelResult,
    execResult,
    verification,
    verificationReportPath,
    store: intelligenceStore,
    language,
    logger: cfg.host?.logger ?? logger,
    operatorAssertions: assertions,
    goalIds,
    canCommit,
    producer,
    activationTargets,
    causalIdentity,
    receipts,
    evidenceRefs,
    settlement,
  });

  let digestion = null;
  const resolvedCycleId = cycleId ?? execResult?.cycle_id ?? intelResult?.cycle_id ?? null;
  // Digestion runs only when belief update itself succeeded (or skipped with no AI).
  // On failed belief_update, facts stay pending for the next cycle.
  if (
    resolvedRuntimeRoot
    && assertions.length
    && updated.result?.status !== 'failed'
  ) {
    digestion = applyOperatorFactDigestions({
      runtimeRoot: resolvedRuntimeRoot,
      store: intelligenceStore,
      cycleId: resolvedCycleId,
      digestions: updated.result?.operator_fact_digestions ?? [],
      pendingFacts: assertions,
      currentBeliefs: updated.currentBeliefs,
    });
    if (digestion.currentBeliefs) {
      updated.currentBeliefs = digestion.currentBeliefs;
    }
  }

  if (updated.result.status !== 'failed' && intelligenceStore?.recordEvolutionEvent) {
    intelligenceStore.recordEvolutionEvent({
      type: 'belief_update',
      status: updated.result.status,
      cycle_id: resolvedCycleId,
      source: updated.source,
      updates_count: updated.result.updates?.length ?? 0,
      events_written: updated.eventsWritten,
      reason: updated.result.reason,
      operator_facts_digested: digestion?.digested?.length ?? 0,
      operator_questions_opened: digestion?.questions_opened?.length ?? 0,
      ...(producer ? { producer } : {}),
      ...(Array.isArray(activationTargets) ? { activation_targets: activationTargets } : {}),
    });
  }

  return {
    runtime: { ...runtime, runtimeRoot: resolvedRuntimeRoot },
    ...updated,
    operator_fact_digestion: digestion,
  };
}
