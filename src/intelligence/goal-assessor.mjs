import { readFileSync } from 'node:fs';
import { chatMessages, extractJsonFromText } from '../ai/messages.mjs';
import {
  buildPromptCacheMetadata,
  markPromptCacheInvariant,
} from '../ai/prompt-cache-metadata.mjs';
import { assessGoals, detectLanguage, gatherEvidence } from './report-builder.mjs';
import { normalizeCurrentBeliefs, partitionBeliefs } from './beliefs.mjs';
import { normalizeGoalPatches } from './goal-patches.mjs';
import { mapRuleStatusToAssessmentStatus, normalizeRuleStatus } from './goal-calibrate-policy.mjs';

const VALID_STATUSES = new Set(['keep', 'refine', 'split', 'replace', 'retire', 'insufficient_evidence']);
const VALID_RULE_STATUSES = new Set(['continue', 'learn', 'mutate', 'stop', 'insufficient_evidence']);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

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

function filterGoalTree(goals, goalIds = null) {
  if (!goals || !Array.isArray(goalIds) || !goalIds.length) return goals;
  const due = new Set(goalIds);
  const visit = (node) => {
    if (!node) return null;
    const children = (node.children || []).map(visit).filter(Boolean);
    if (!due.has(node.id) && !children.length) return null;
    return { ...node, children };
  };
  return visit(goals);
}

function pickDoc(docs, idPrefix) {
  if (!Array.isArray(docs)) return null;
  return docs.find((d) => typeof d?.id === 'string' && d.id.startsWith(idPrefix)) || null;
}

/** Full-text injection for every agentContextDocs entry (order preserved). */
export function formatAgentContextDocs(agentContextDocs) {
  const docs = Array.isArray(agentContextDocs) ? agentContextDocs.filter((d) => d?.text != null) : [];
  if (!docs.length) return '(missing: agentContextDocs is empty)';
  const parts = docs.map((d, i) => {
    const id = d?.id ?? 'unknown-id';
    const src = d?.source ?? 'n/a';
    return [
      `=== Agent context document ${i + 1} (id=${id}, source=${src}) ===`,
      String(d.text),
    ].join('\n');
  });
  return parts.join('\n\n');
}

function readReportMarkdown(reportRecord) {
  if (!reportRecord?.md_path) return '';
  try {
    return readFileSync(reportRecord.md_path, 'utf-8');
  } catch {
    return '';
  }
}

function clip(value, max = 6000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text;
}

function readVerificationReport(reportPath) {
  if (!reportPath) return { verification: null, error: null };
  try {
    return {
      verification: JSON.parse(readFileSync(reportPath, 'utf-8')),
      error: null,
    };
  } catch (e) {
    return {
      verification: null,
      error: e?.message || String(e),
    };
  }
}

function verifyReportId(reportPath) {
  if (!reportPath) return null;
  const filename = String(reportPath).split(/[\\/]/).pop() || '';
  return filename.replace(/\.json$/i, '') || null;
}

function conversationContextPathForReport(reportRecord) {
  if (!reportRecord?.md_path || !reportRecord?.cycle_id) return null;
  const normalized = String(reportRecord.md_path).replace(/\\/g, '/');
  const marker = '/data/intelligence/reports/';
  const idx = normalized.indexOf(marker);
  if (idx < 0) return null;
  const runtimeRoot = String(reportRecord.md_path).slice(0, idx);
  return `${runtimeRoot}/data/evolution/records/${reportRecord.cycle_id}/conversation_context.json`;
}

function readGoalSuggestions(reportRecord) {
  const path = conversationContextPathForReport(reportRecord);
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const suggestions = parsed?.analysis?.goal_suggestions;
    return Array.isArray(suggestions) ? suggestions.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function summarizeVerificationItem(item) {
  const action = item?.action ?? {};
  const value = item?.value ?? item?.result ?? {};
  return {
    action_type: action.type ?? item?.action_type ?? null,
    description: clip(action.description ?? '', 240),
    priority: action.priority ?? null,
    metric: item?.metric ?? null,
    verification_status: item?.status ?? null,
    result_success: value?.success ?? null,
    result_status: value?.status ?? null,
    result_message: clip(value?.message ?? value?.error ?? '', 240),
    provider: value?.provider ?? null,
    fallback_used: value?.fallback_used ?? null,
    evidence_count: value?.evidence_count ?? null,
    writes_count: value?.writes_count ?? null,
    boundary_risk: value?.boundary_risk ?? null,
  };
}

function summarizeSemanticVerification(semantic) {
  if (!semantic) return null;
  const result = semantic.result ?? {};
  return {
    status: semantic.status ?? null,
    source: semantic.source ?? null,
    precedence: 'latest_semantic_verification_over_older_report_or_diary_claims',
    overall_summary: clip(result.overall_summary ?? semantic.error ?? '', 800),
    next_cycle_focus: Array.isArray(result.next_cycle_focus)
      ? result.next_cycle_focus.slice(0, 8).map((item) => clip(item, 240))
      : [],
    verified: Array.isArray(result.semantic_verified)
      ? result.semantic_verified.slice(0, 8).map((item) => ({
        action_type: item.action_type ?? null,
        final_status: item.final_status ?? null,
        confidence: item.confidence ?? null,
        evidence_summary: clip(item.evidence_summary ?? '', 360),
        evidence_count: item.evidence_count ?? null,
        writes_count: item.writes_count ?? null,
        fallback_used: item.fallback_used ?? null,
        boundary_risk: item.boundary_risk ?? null,
      }))
      : [],
  };
}

export function summarizeVerificationReport(reportPath) {
  if (!reportPath) return null;
  const { verification, error } = readVerificationReport(reportPath);
  const reportId = verifyReportId(reportPath);
  if (!verification) {
    return {
      report_id: reportId,
      ref: reportId ? `verify_report:${reportId}` : null,
      report_path: reportPath,
      read_error: error,
      verified_count: 0,
      pending_count: 0,
      verified: [],
      pending: [],
    };
  }
  const verified = Array.isArray(verification?.verified) ? verification.verified : [];
  const pending = Array.isArray(verification?.pending) ? verification.pending : [];
  const semantic = summarizeSemanticVerification(verification?.semantic);

  return {
    report_id: reportId,
    ref: reportId ? `verify_report:${reportId}` : null,
    report_path: reportPath ?? null,
    timestamp: verification?.timestamp ?? null,
    verified_count: verified.length,
    pending_count: pending.length,
    semantic,
    verified: verified.map(summarizeVerificationItem),
    pending: pending.map(summarizeVerificationItem),
  };
}

export function fallbackGoalAssessment(reason = 'AI goal assessment unavailable') {
  return {
    status: 'insufficient_evidence',
    rule_status: 'insufficient_evidence',
    confidence: 'low',
    reason,
    evidence_refs: [],
    goal_patches: [],
    proposed_goal: null,
    risk: 'Do not change the active goal without a parseable, evidence-backed assessment.',
  };
}

export function buildGoalAssessmentContext({
  activeGoals,
  reportRecord,
  reportMarkdown = null,
  verificationReportPath = null,
  store,
  goalEventsLimit = 10,
  ruleFeedbackStats = null,
  goalIds = null,
} = {}) {
  const scopedActiveGoals = filterGoalTree(activeGoals, goalIds);
  const goals = flattenGoals(scopedActiveGoals);
  const evidence = gatherEvidence(store);
  const machineAssessment = assessGoals(goals, evidence);
  const recentGoalEvents = store?.readGoalEvents?.({ limit: goalEventsLimit }) ?? [];
  const currentBeliefs = normalizeCurrentBeliefs(store?.readCurrentBeliefs?.() ?? null);
  const beliefPartitions = partitionBeliefs(currentBeliefs.beliefs ?? []);
  const markdown = reportMarkdown ?? readReportMarkdown(reportRecord);

  return {
    active_goals: scopedActiveGoals,
    due_goal_ids: Array.isArray(goalIds) ? goalIds : null,
    flat_goals: goals,
    current_beliefs: {
      active: beliefPartitions.active,
      validated: beliefPartitions.validated,
      recently_refuted: beliefPartitions.recentlyRefuted,
    },
    report: reportRecord ? {
      id: reportRecord.id ?? null,
      cycle_id: reportRecord.cycle_id ?? null,
      generated_at: reportRecord.generated_at ?? reportRecord.recorded_at ?? null,
      md_path: reportRecord.md_path ?? null,
      tldr: reportRecord.tldr ?? '',
      source: reportRecord.source ?? null,
      language: reportRecord.language ?? null,
      action_count: reportRecord.action_count ?? null,
      evidence_obs_count: reportRecord.evidence_obs_count ?? null,
      evidence_probe_count: reportRecord.evidence_probe_count ?? null,
      evidence_retro_count: reportRecord.evidence_retro_count ?? null,
    } : null,
    report_markdown: clip(markdown),
    goal_suggestions: readGoalSuggestions(reportRecord),
    verification: summarizeVerificationReport(verificationReportPath),
    evidence,
    recent_goal_events: recentGoalEvents,
    machine_assessment: machineAssessment,
    rule_feedback_stats: ruleFeedbackStats,
  };
}

export function buildGoalAssessmentPrompt({
  context,
  agentContextDocs = [],
  language = null,
} = {}) {
  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || pickDoc(agentContextDocs, 'subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);
  const outputLanguage = language ?? detectLanguage(subjectDoc?.text);
  const isZh = outputLanguage !== 'en';
  const contextJson = JSON.stringify(context, null, 2);
  const authorityBlock = formatAgentContextDocs(agentContextDocs);

  if (isZh) {
    return `你是 js-evolution-agent 的规则更新审计员。你的任务不是简单判断目标是否“还能验证”，而是依据 Cyber-Taoist 第一性原理判断当前法则是否仍能通过交易产生有效后果，并在失败产生信息时给出目标校准建议。

第一步：请先完整阅读下方「权威文献 agentContextDocs」中的每一份文档全文（Cyber-Taoist 宪章、应用指南与本主体策略等）。**这是你判定的顶层依据：**你的 status、confidence、reason、risk 以及若有 proposed_goal，必须与这些文献相容；不得以情报材料为由提出与文献相冲突的目标。若情报不足以在文献约束下做决定，必须使用 insufficient_evidence。

第二步：在文献约束之内，再结合下方「情报与机器材料」评估当前法则的交易反馈状态。优先回答：当前法则是否仍产生有效交易反馈？失败是否已经形成可沉淀的新信息？守护层是否稳定到足以继续低风险学习？

rule_status 语义：
- continue：当前目标/法则仍产生有效交易反馈，不改目标。
- learn：反馈不足、证据缺口或感知滞后阻碍判断，下一轮应自动进入只读学习、诊断、反馈回路校准。
- mutate：成果指标持续失败且失败已产生信息，或**法则反馈死亡**（验收条款连续多轮恒定零信息反馈），旧法则已被后果证伪，应自动更新子目标条款，进入规则更新期。
- stop：凭据、边界、记忆审计等核心守护失败，暂停成果探索，先恢复核心连续性。
- insufficient_evidence：情报不足以判断法则状态。

三分失败判据（必须先区分，再选 rule_status）：
1. **世界未达标**：交易反馈清晰（结果签名随世界变化），只是尚未达到 good_signal → learn 或 continue；继续诊断/等待，不改验收条款。
2. **通道故障**：transient 的外部/配置故障（如临时 HTTP 502）→ 修通道，不改法则；可用 learn 描述通道修复，不得 mutate 验收条款。
3. **法则反馈死亡**：rule_feedback_stats 中某子目标 feedback_state="dead"（constant_signature_streak 达阈值且 information_gain=0），**或**未被机械维持的子目标 starved=true（饥饿阈值见 config.starved_streak / starved_window_hours，与 dead_streak **解耦**；streak_unit=cycle|evidence；starved_strategy=global_count|wall_clock）→ 按宪章第九条/第十三条，常规交易已无法提供真实反馈，必须 rule_status="mutate"，并用 update_child 修订该条款的观测点或退出条件；**不得再以 learn 等待**。reason 必须点名该 goal_id 的 feedback_state / streak_unit / streak / constant_keys 或 starved_streak/starved_hours。
   - 若该 goal 的 mutate_cooldown=true，表示上一轮已 mutate 修订观测点、正在等待新签名生效；**不要重复 mutate 同一观测点**，优先 continue 或 learn 等待反馈变化。
   - 若 mutate_effective=false，表示上一轮 mutate 未改变结果签名（化妆式修订）；不得再以同类文本补丁敷衍，必须改写可观测口径或可达退出路径。
   - 若 is_root=true 且 feedback_state="dead"，update_child 无法修改 root 本身；须用 proposed_goal 整树换代（status=replace），goal_patches 应为 []。

守破分层（mutate 时强制）：
- 守功能、破形态：守护子目标（role=guard 或 id 前缀 guard-/monitor-）不可 remove_child；只能 update_child 把观测点换成 receipt 证明**实际可观测**的口径。此禁止**仅适用于 rule_status=mutate**。
- mutate patch 的 evidence_refs 必须引用产生恒定签名的 action_receipt（可用 rule_feedback_stats.latest_receipt_id）。
- update_child 的 intent/good_signal/bad_signal 应引用 belief id 或 receipt ref，**不要**把每轮失败细节原文复制进 intent（避免法则被失败叙事宪法化）。

法则化退役/重生（宪章第十三条第 5 步：成功经验沉淀为新法则；与 mutate 守破分层独立）：
- 读取 rule_feedback_stats.mechanical_guards（及 goals[].mechanically_maintained / healthy_streak）。这些目标已被 evolution.guards 机械维持。
- **退役**：若某条 mechanical_guards.eligible_for_retirement=true（或 mechanically_maintained=true 且 healthy_streak ≥ config.dead_streak 且 feedback_state=live），该目标观测行为已默认达成，应从 active 树移除。输出 rule_status="continue"、status="refine"、goal_patches 含 remove_child；reason 必须写明 mechanized retirement 并引用 guard_id。这不是 mutate，允许 remove_child。
- **重生**：若某条 mechanical_guards.eligible_for_rebirth=true（机制连续失败且 serves_goal 无 active goal 覆盖），应 add_child 重开守护目标（role=guard），rule_status 视严重度可为 stop 或 learn；reason 写明机制失败与 guard_id。
- 健康且已退役（goal_in_active_tree=false 且 recent_status=ok / healthy_streak>0）是期望稳态——**不要**重开目标。
- 未被机械维持的守护目标（mechanically_maintained=false）仍由 Decide 喂养，参与 starved 检测；勿与法则化退役混淆。

硬约束：
- 只做判定，不执行修改。
- 必须以 agentContextDocs 为最高层级约束来判断目标是否合理、可验证、是否偏离主体边界。
- 没有来自情报侧的可用证据（观察、回顾、报告、事件等）支撑具体结论时：不得轻易建议 replace/split；若仅能依据文献得出「尚需等待证据」，则用 insufficient_evidence，且 confidence 为 low。
- 能收敛，不扩展；目标越可验证越好；proposed_goal 必须仍符合文献与主体策略。
- status 保持兼容旧工作流；rule_status 是本轮第一性原理判断。若 rule_status=learn 或 mutate，status 通常应为 refine（整树重组才用 replace）。
- 不得把“目标正确触发人工介入/停止发布”直接当成 continue/keep。若触发原因是成果法则失败、模拟失真、真实反馈脱钩，且守护层稳定，必须输出 rule_status="learn" 或 rule_status="mutate"，并给出 goal_patches。
- rule_status="learn" 的 goal_patches 只能描述只读探针、诊断、反馈回路校准、replay/challenge/rank/rankScore 相关性分析；必须显式禁止发布、远端写入和 POST /api/agent/tank/code。
- rule_status="mutate" 的 goal_patches 应把失败反馈沉淀为新成果法则或修订已死亡的验收观测点，例如真实反馈门禁、challenge/replay 相关性门禁、底层行为策略假设验证、或把不可观测字段改为可观测口径；不得绕过主体发布审批；不得删除守护功能本身。
- 降标或收缩目标只允许作为恢复期策略，不能永久替代原始主目标的成果压力。若当前目标已从「成果目标」（例如胜率、排名、真实反馈改善、策略能力提升）降为「过程目标」（例如凭据合规、审计、仅观察），必须判断这些过程目标是否已经完成、稳定或可持续。
- 当恢复期子目标已经达成或连续多轮可维持时，不应仅因低标准目标仍可验证就继续 keep；应优先建议 refine，把目标重新升回能推动原始主目标的成果指标。
- 若 active_goals 的子目标全部是前置条件、合规、审计或观察类任务，而缺少直接衡量主体效果的成果指标，必须在 reason 中明确指出 "goal_pressure_loss"。除非有明确证据表明主体仍处于阻塞恢复期，否则应输出 status="refine"。
- refine 可以保留安全、凭据、审计类子目标作为守护条件，但 proposed_goal 必须至少包含一个成果压力子目标，例如模拟质量提升、真实 matchCount/rank 反馈、发布后表现改善或策略能力提升。
- 如果连续多个 cycle 为 keep，但顶层成果指标没有改善（例如 matchCount、rank、胜率或模拟质量长期停滞），不得仅因目标「仍可验证」而 keep；必须评估是否需要升标、收紧门禁或新增成果型子目标。
- 评估 safe-runtime 时必须区分「agent 行为合规」「宿主预检阻断」和「provider/文件系统硬隔离」；verify_report 中的 boundary_risk 可作为边界风险证据，但不得把软约束误判为硬隔离。
- 若 verification.semantic 存在，最新 semantic verification 优先于旧 report、diary 或 remembered agent claim。它仍不是 Seen 事实；它是最近执行结果的解释层证据，应用来覆盖旧推断而不是放大旧推断。
- evidence_refs：须引用支持你结论的情报条目（intel_report / verify_report / observation / probe_result / retrospective / goal_event / evolution_event / belief_event / action_receipt）。若某项判断主要依据某一权威文献中的原则，也请用 type 为 agent_context、id 为该文档 id、ref 为该文档 id 前加前缀 agent_context: 一并列出，使理由可追溯。
- 如果某个 goal 下 active beliefs 全部 refuted/blocked，或 belief 长期无法产生 evidence，应在 reason 中指出 strategy pressure 或 goal pressure 失衡。
- 没有可用的 evidence_refs（含 agent_context）时 confidence 必须为 low。
- reason 必须用中文简述：结合了哪些文献要点 + 哪些情报事实；若使用了 rule_feedback_stats，必须写明相关 goal 的 feedback_state。
- 局部变化（增删改单个子目标）优先使用 goal_patches，不要同时填写 proposed_goal。仅主目标 intent 换代或整树重组时才用 proposed_goal。
- goal_patches 与 proposed_goal 互斥；若使用 goal_patches，proposed_goal 必须为 null。
- split 语义请用 remove_child + add_child 的 patch 列表表达；每个 add_child 的 child 必须带 role: "outcome" 或 "guard"。
- 发现子目标 role 误分类（例如成果子目标被标为 guard，或守护子目标被标为 outcome）时，用 update_child 设置 fields.role 为 "outcome" 或 "guard" 修正；不要用 remove+add 仅为了改 role。
- 目标树仅有一层子目标（扁平结构，不支持嵌套 children）。add_child 的 parent_id 必须为 null（或根目标 id），不得指向其他 child_id。若守护机制针对特定成果子目标，应作为根级 sibling 添加并在 intent 中写明关联，或使用 update_child 更新该子目标。
- patch 顺序建议先 remove_child，再 update_child，最后 add_child。
- 只返回一个 JSON 对象，不要 Markdown，不要代码块。

JSON schema:
{
  "status": "keep | refine | split | replace | retire | insufficient_evidence",
  "rule_status": "continue | learn | mutate | stop | insufficient_evidence",
  "confidence": "low | medium | high",
  "reason": "string",
  "evidence_refs": [{ "type": "intel_report|verify_report|observation|probe_result|retrospective|goal_event|evolution_event|agent_context", "id": "string", "ref": "string" }],
  "goal_patches": [] | [
    { "op": "add_child", "parent_id": null, "child": { "id", "name", "intent", "good_signal", "bad_signal", "children": [], "role": "outcome|guard" }, "reason": "string" },
    { "op": "update_child", "child_id": "string", "fields": { "intent|good_signal|bad_signal|role": "string" }, "reason": "string" },
    { "op": "remove_child", "child_id": "string", "reason": "string" }
  ],
  "proposed_goal": null | {
    "id": "string",
    "name": "string",
    "intent": "string",
    "good_signal": "string",
    "bad_signal": "string",
    "children": []
  },
  "risk": "string"
}

若建议 refine/split/replace 且仅需改动子目标，使用 goal_patches（proposed_goal 为 null）。若需整树换代，使用 proposed_goal（goal_patches 为 []）。proposed_goal 必须包含 id、name、intent、good_signal、bad_signal、children；即使没有子目标，也必须写 children: []。若包含子目标，每个子目标也必须使用同样结构。

=== 权威文献 agentContextDocs（全文，按加载顺序） ===
${authorityBlock}

=== 情报与机器材料（JSON）===
${contextJson}`;
  }

  return `You are the rule-update auditor for js-evolution-agent. Do not merely decide whether the active goal is still testable. Using Cyber-Taoist first principles, decide whether the current law still produces useful transaction feedback, and recommend goal calibration when failure has produced information.

Step 1: Read every document below under "Authority agentContextDocs" in full (Cyber-Taoist constitution, skill guide, active subject policy, and any other loaded docs). These are your top-level authority: your status, confidence, reason, risk, and any proposed_goal must be compatible with them. Never recommend goals that contradict these texts. When intelligence is insufficient to decide under those constraints, use insufficient_evidence.

Step 2: Under those constraints, use the structured intelligence block below to judge the law/transaction feedback state. First answer: does the current law still produce useful transaction feedback? Has failure produced information that should become a new law? Are guardrails stable enough to continue low-risk learning?

rule_status semantics:
- continue: the current law/goal still produces useful transaction feedback; do not change goals.
- learn: feedback is thin, noisy, or blocked by evidence gaps; next cycle should enter read-only learning, diagnostics, or feedback-loop calibration.
- mutate: outcome metrics keep failing and the failures now contain information, OR **rule feedback death** (an acceptance clause yields a constant zero-information signature across cycles); the old law has been falsified and child clauses should be updated.
- stop: core guardrails such as credentials, boundary, or memory audit failed; pause outcome exploration and recover continuity first.
- insufficient_evidence: evidence is too thin to judge the rule state.

Three-way failure triage (classify first, then choose rule_status):
1. **World not yet at target**: feedback is live (result signature changes with the world) but good_signal unmet → learn or continue; keep diagnosing / waiting; do not rewrite acceptance clauses.
2. **Channel fault**: transient external/config faults (e.g. temporary HTTP 502) → repair the channel, do not mutate the law; learn may describe channel repair.
3. **Rule feedback death**: rule_feedback_stats marks a child goal feedback_state="dead" (constant_signature_streak at threshold and information_gain=0), **or** a non-mechanically-maintained child with starved=true (threshold from config.starved_streak / starved_window_hours, **decoupled** from dead_streak; streak_unit=cycle|evidence; starved_strategy=global_count|wall_clock) → per Constitution Arts. 9/13, conventional transactions no longer yield useful feedback; you MUST return rule_status="mutate" with update_child revising that clause's observation point or exit condition; **do not keep learn-waiting**. reason MUST name the goal_id feedback_state / streak_unit / streak / constant_keys or starved_streak/starved_hours.
   - When mutate_cooldown=true for a goal, a mutate patch was applied recently and the system is waiting for a new signature; **do not repeat mutate on the same observation point**; prefer continue or learn until feedback changes.
   - When mutate_effective=false, a prior mutate did not change the result signature (cosmetic edit); do not pad with similar text patches — rewrite the observable criterion or a reachable exit path.
   - When is_root=true and feedback_state="dead", update_child cannot target the root; use proposed_goal for a whole-tree rewrite (status=replace) with goal_patches=[].

Hold/break layering (required on mutate):
- Hold function, break form: guard children (role=guard or id prefix guard-/monitor-) must not be remove_child; only update_child to replace the observation point with a receipt-proven *actually observable* criterion. This ban applies **only when rule_status=mutate**.
- mutate patch evidence_refs MUST cite the action_receipt that produced the constant signature (use rule_feedback_stats.latest_receipt_id when present).
- update_child intent/good_signal/bad_signal should cite belief ids or receipt refs; do NOT paste per-cycle failure narrative into intent (prevents constitutionalizing failure details).

Mechanized retirement / rebirth (Constitution Art. 13 step 5: successful experience sedimented into law; independent of mutate hold/break):
- Read rule_feedback_stats.mechanical_guards (and goals[].mechanically_maintained / healthy_streak). These goals are already served by evolution.guards.
- **Retirement**: when a mechanical_guards row has eligible_for_retirement=true (or mechanically_maintained=true with healthy_streak ≥ config.dead_streak and feedback_state=live), the observation duty is default-satisfied — remove it from the active tree. Return rule_status="continue", status="refine", and a remove_child goal_patch; reason MUST say mechanized retirement and cite guard_id. This is not mutate, so remove_child is allowed.
- **Rebirth**: when eligible_for_rebirth=true (mechanism failing with no active goal covering serves_goal), add_child a guard goal (role=guard); rule_status may be stop or learn by severity; reason MUST name the failure and guard_id.
- Healthy retired state (goal_in_active_tree=false with recent_status=ok / healthy_streak>0) is the desired steady state — do **not** reopen the goal.
- Unmaintained guard goals (mechanically_maintained=false) still need Decide feeding and participate in starved detection; do not confuse them with mechanized retirement.

Hard constraints:
- Assess only; do not execute changes.
- You MUST ground your judgment in agentContextDocs; intelligence is evidence about the world, not a substitute for doctrinal boundaries.
- Do not recommend broad replace/split without concrete intelligence support; prefer insufficient_evidence with low confidence when facts are thin.
- Prefer narrowing over expanding; proposed_goal must remain compliant with doctrine and subject policy.
- Keep status compatible with the old workflow; rule_status is the first-principles rule judgment. If rule_status is learn or mutate, status should usually be refine (use replace only for whole-tree rewrites).
- Do not treat "the goal correctly triggered human intervention / stopped publishing" as continue/keep. If the trigger came from outcome-law failure, simulation distortion, or real-feedback decoupling, and guardrails are stable, return rule_status="learn" or rule_status="mutate" with goal_patches.
- For rule_status="learn", goal_patches must be read-only learning, diagnostics, feedback-loop calibration, or replay/challenge/rank/rankScore correlation work; explicitly forbid publishing, remote writes, and POST /api/agent/tank/code.
- For rule_status="mutate", goal_patches should turn failure feedback into a new outcome law or revise a dead acceptance observation point (real-feedback gates, challenge/replay correlation gates, bottom-level behavior hypothesis tests, or replace unobservable fields with observable criteria). Do not bypass subject publish approval; do not delete the guard function itself.
- Goal downgrading or narrowing is allowed only as a recovery-phase strategy. It must not permanently replace the original top-level outcome pressure. If the active goal has drifted from outcome goals (win rate, rank, real feedback improvement, strategy capability) into process goals (credential hygiene, auditability, observation only), assess whether those process goals are now completed, stable, or sustainable.
- When recovery subgoals are achieved or repeatedly maintainable, do not keep a low-pressure goal merely because it remains testable. Prefer refine to restore outcome pressure.
- If all child goals are prerequisite, compliance, audit, or observation work and none directly measures subject effectiveness, explicitly mention "goal_pressure_loss" in reason. Unless evidence shows the subject is still in a blocking recovery phase, return status="refine".
- A refined goal may keep safety, credential, and audit work as guardrails, but proposed_goal must include at least one outcome-pressure child goal, such as simulation quality, real match/rank feedback, post-publish performance, or strategy capability improvement.
- If several consecutive cycles are keep while top-level outcome metrics do not improve, do not keep solely because the goal is still testable; assess whether to raise standards, tighten gates, or add an outcome-oriented child goal.
- When assessing safe-runtime, distinguish agent conduct compliance, host preflight blocking, and provider/filesystem hard isolation. boundary_risk from verify_report is evidence about boundary posture, but soft constraints must not be treated as hard isolation.
- If verification.semantic exists, the latest semantic verification has priority over older report, diary, or remembered agent claims. It is not Seen fact; it is interpretation-layer evidence for the latest execution result, and should override stale inference chains instead of amplifying them.
- evidence_refs MUST cite intelligence items you rely on (intel_report / verify_report / observation / probe_result / retrospective / goal_event / evolution_event / action_receipt). When a key norm comes from authority text, also include agent_context with id = doc id and ref = the string "agent_context:" plus the same doc id.
- If evidence_refs would be empty, confidence MUST be low.
- reason MUST briefly name which authority points plus which factual evidence you used (English); when using rule_feedback_stats, name the relevant goal feedback_state.

- Prefer goal_patches for local child changes; do not fill proposed_goal in the same response. Use proposed_goal only for root intent replacement or full tree rewrites.
- goal_patches and proposed_goal are mutually exclusive; when goal_patches is non-empty, proposed_goal must be null.
- Map split to remove_child plus add_child patches; each add_child child must include role: "outcome" or "guard".
- When a child role is misclassified (e.g. an outcome child marked guard, or a guard child marked outcome), correct it with update_child setting fields.role to "outcome" or "guard"; do not remove+add solely to change role.
- The goal tree is flat (one level of children under root; nested children are not supported). add_child parent_id MUST be null (or the root goal id), never another child_id. Guards tied to a specific outcome child should be added as root-level siblings with intent describing the link, or use update_child on that child.
- Order patches: remove_child first, then update_child, then add_child.

Return one JSON object only. No Markdown. No code fences.

JSON schema:
{
  "status": "keep | refine | split | replace | retire | insufficient_evidence",
  "rule_status": "continue | learn | mutate | stop | insufficient_evidence",
  "confidence": "low | medium | high",
  "reason": "string",
  "evidence_refs": [{ "type": "intel_report|verify_report|observation|probe_result|retrospective|goal_event|evolution_event|agent_context", "id": "string", "ref": "string" }],
  "goal_patches": [] | [
    { "op": "add_child", "parent_id": null, "child": { "id", "name", "intent", "good_signal", "bad_signal", "children": [], "role": "outcome|guard" }, "reason": "string" },
    { "op": "update_child", "child_id": "string", "fields": { "intent|good_signal|bad_signal|role": "string" }, "reason": "string" },
    { "op": "remove_child", "child_id": "string", "reason": "string" }
  ],
  "proposed_goal": null | {
    "id": "string",
    "name": "string",
    "intent": "string",
    "good_signal": "string",
    "bad_signal": "string",
    "children": []
  },
  "risk": "string"
}

For refine/split/replace that only touch children, use goal_patches with proposed_goal null. For full tree replacement, use proposed_goal with goal_patches []. proposed_goal must include id, name, intent, good_signal, bad_signal, and children. If there are no child goals, still write children: []. Any child goal must use the same shape.

=== Authority agentContextDocs (full text, loaded order) ===
${authorityBlock}

=== Intelligence and machine artifacts (JSON) ===
${contextJson}`;
}

export function normalizeProposedGoalShape(goal) {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return goal ?? null;
  const hasChildren = Object.prototype.hasOwnProperty.call(goal, 'children');
  return {
    ...goal,
    children: hasChildren
      ? (Array.isArray(goal.children) ? goal.children.map(normalizeProposedGoalShape) : goal.children)
      : [],
  };
}

export function parseGoalAssessment(raw) {
  const parsed = extractJsonFromText(raw);
  const parsedRuleStatus = normalizeRuleStatus(parsed.rule_status)
    ?? (VALID_RULE_STATUSES.has(String(parsed.status ?? '').trim().toLowerCase())
      ? String(parsed.status).trim().toLowerCase()
      : null);
  const status = VALID_STATUSES.has(parsed.status)
    ? parsed.status
    : mapRuleStatusToAssessmentStatus(parsedRuleStatus, 'insufficient_evidence');
  const confidence = VALID_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'low';
  const refs = Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [];
  const goal_patches = normalizeGoalPatches(parsed.goal_patches);
  const proposed_goal = normalizeProposedGoalShape(parsed.proposed_goal);

  return {
    status,
    rule_status: parsedRuleStatus ?? (status === 'keep' ? 'continue' : (status === 'insufficient_evidence' ? 'insufficient_evidence' : null)),
    confidence: refs.length ? confidence : 'low',
    reason: String(parsed.reason || 'No reason provided.'),
    evidence_refs: refs,
    goal_patches,
    proposed_goal,
    risk: String(parsed.risk || ''),
  };
}

export async function assessGoalsWithAi({
  aiClient,
  activeGoals,
  reportRecord,
  reportMarkdown = null,
  verificationReportPath = null,
  store,
  agentContextDocs = [],
  logger = null,
  ruleFeedbackStats = null,
  goalIds = null,
} = {}) {
  const context = buildGoalAssessmentContext({
    activeGoals,
    reportRecord,
    reportMarkdown,
    verificationReportPath,
    store,
    ruleFeedbackStats,
    goalIds,
  });
  const prompt = buildGoalAssessmentPrompt({ context, agentContextDocs });
  const stablePrompt = buildGoalAssessmentPrompt({ context: {}, agentContextDocs });
  const promptCache = buildPromptCacheMetadata({
    profile: 'goal_assess',
    messages: [{ role: 'user', content: prompt }],
    stablePrefix: stablePrompt,
    dynamicPayload: JSON.stringify(context, null, 2),
  });
  const promptCacheInvariant = markPromptCacheInvariant({
    scope: 'goal_assess',
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
      assessment: fallbackGoalAssessment('AI client unavailable.'),
    };
  }

  try {
    const raw = await chatMessages(aiClient, [{ role: 'user', content: prompt }]);
    const assessment = parseGoalAssessment(raw);
    return {
      source: 'ai',
      context,
      prompt,
      prompt_cache: {
        ...promptCache,
        invariant: promptCacheInvariant,
      },
      assessment,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    logger?.warn?.(`[goals] AI assessment failed: ${msg}; using fallback`);
    return {
      source: 'fallback',
      context,
      prompt,
      prompt_cache: {
        ...promptCache,
        invariant: promptCacheInvariant,
      },
      assessment: fallbackGoalAssessment(`AI assessment failed: ${msg}`),
    };
  }
}
