import { readFileSync } from 'node:fs';
import { extractJsonFromText } from '../ai/messages.mjs';
import {
  BELIEF_CHANGES,
  BELIEF_CONFIDENCE,
  BELIEF_STATUSES,
  emptyCurrentBeliefs,
  normalizeCurrentBeliefs,
} from './beliefs.mjs';
import { summarizeVerificationReport } from './goal-assessor.mjs';

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
  const runSpec = action?.params?.run_spec ?? {};
  const context = runSpec.context ?? {};
  return {
    type: action.type ?? null,
    description: clip(action.description ?? '', 240),
    serves_goal: action.serves_goal ?? null,
    belief_id: context.belief_id ?? null,
    belief_relation: context.belief_relation ?? null,
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
} = {}) {
  const beliefsDoc = normalizeCurrentBeliefs(currentBeliefs ?? store?.readCurrentBeliefs?.() ?? null);
  const receipts = store?.readActionReceipts
    ? store.readActionReceipts({ limit: 20 }).filter((r) => {
      const cycleId = execResult?.cycle_id ?? intelResult?.cycle_id ?? null;
      if (!cycleId) return true;
      return r.cycle_id === cycleId
        || r.exec_cycle_id === cycleId
        || r.intel_cycle_id === intelResult?.cycle_id;
    })
    : [];

  return {
    cycle: {
      intel_cycle_id: intelResult?.cycle_id ?? null,
      exec_cycle_id: execResult?.cycle_id ?? null,
    },
    active_goals: activeGoals,
    active_goals_flat: flattenGoals(activeGoals),
    current_beliefs: beliefsDoc,
    actions: asArray(intelResult?.actions).map(summarizeAction),
    receipts: receipts.map(summarizeReceipt),
    verification: summarizeVerificationReport(verificationReportPath),
    semantic: verification?.semantic ?? null,
    analysis: {
      decision: intelResult?.analysis?.decision ?? null,
      rationale: clip(intelResult?.analysis?.rationale ?? '', 800),
    },
  };
}

export function buildBeliefUpdatePrompt({ context, language = 'zh' } = {}) {
  const contextJson = clip(JSON.stringify(context, null, 2), 120000);
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
  }));
  return {
    status,
    reason: String(parsed.reason || 'Belief update parsed.'),
    updates,
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
        last_change: {
          cycle_id: cycleId,
          change,
          reason: update.reason,
          changed_at: now,
        },
      };
      beliefsById.set(id, after);
      events.push({
        cycle_id: cycleId,
        belief_id: id,
        change,
        reason: update.reason,
        evidence_refs: update.evidence_refs || [],
        source,
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
      cycle_id: cycleId,
      belief_id: beliefId,
      change,
      reason: update.reason,
      evidence_refs: update.evidence_refs || [],
      source,
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
} = {}) {
  const context = buildBeliefUpdateContext({
    activeGoals,
    intelResult,
    execResult,
    verification,
    verificationReportPath,
    store,
  });

  if (!aiClient || typeof aiClient.chat !== 'function') {
    return {
      source: 'fallback',
      context,
      result: fallbackBeliefUpdate('AI client unavailable.'),
      currentBeliefs: normalizeCurrentBeliefs(store?.readCurrentBeliefs?.() ?? emptyCurrentBeliefs()),
      eventsWritten: 0,
    };
  }

  const prompt = buildBeliefUpdatePrompt({ context, language });
  try {
    const raw = await aiClient.chat(prompt);
    const parsed = parseBeliefUpdate(raw);
    const cycleId = execResult?.cycle_id ?? intelResult?.cycle_id ?? null;
    const applied = applyBeliefUpdates(context.current_beliefs, parsed.updates, { cycleId });
    let eventsWritten = 0;
    if (store && parsed.status !== 'failed' && parsed.updates.length) {
      store.recordCurrentBeliefs(applied.currentBeliefs);
      for (const event of applied.events) {
        eventsWritten += store.recordBeliefEvent(event);
      }
    }
    return {
      source: 'ai',
      context,
      prompt,
      result: parsed,
      currentBeliefs: applied.currentBeliefs,
      eventsWritten,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    logger?.warn?.(`[beliefs] AI update failed: ${msg}; keeping previous beliefs`);
    return {
      source: 'fallback',
      context,
      prompt,
      result: fallbackBeliefUpdate(`AI update failed: ${msg}`),
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
} = {}) {
  const { getActiveGoals } = await import('../cli/commands/goals.mjs');
  const { getProjectRoot } = await import('../cli/utils/project.mjs');
  const { join } = await import('node:path');
  const { createIntelligenceStore } = await import('./store.mjs');
  const { runtimeInfoForDefaultSubject } = await import('../cli/utils/subjects.mjs');
  const { detectLanguage } = await import('./report-builder.mjs');

  const projectRoot = root || getProjectRoot();
  const active = activeGoals ? { goals: activeGoals } : getActiveGoals(projectRoot);
  const runtime = runtimeInfoForDefaultSubject(projectRoot);
  const intelligenceStore = store ?? createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
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
  });

  if (updated.result.status !== 'failed' && intelligenceStore?.recordEvolutionEvent) {
    intelligenceStore.recordEvolutionEvent({
      type: 'belief_update',
      status: updated.result.status,
      cycle_id: cycleId ?? execResult?.cycle_id ?? intelResult?.cycle_id ?? null,
      source: updated.source,
      updates_count: updated.result.updates?.length ?? 0,
      events_written: updated.eventsWritten,
      reason: updated.result.reason,
    });
  }

  return {
    runtime,
    ...updated,
  };
}
