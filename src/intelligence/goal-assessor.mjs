import { readFileSync } from 'node:fs';
import { extractJsonFromText } from '../ai/messages.mjs';
import { assessGoals, detectLanguage, gatherEvidence } from './report-builder.mjs';

const VALID_STATUSES = new Set(['keep', 'refine', 'split', 'replace', 'retire', 'insufficient_evidence']);
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

function summarizeVerificationReport(reportPath) {
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
    confidence: 'low',
    reason,
    evidence_refs: [],
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
} = {}) {
  const goals = flattenGoals(activeGoals);
  const evidence = gatherEvidence(store);
  const machineAssessment = assessGoals(goals, evidence);
  const recentGoalEvents = store?.readGoalEvents?.({ limit: goalEventsLimit }) ?? [];
  const markdown = reportMarkdown ?? readReportMarkdown(reportRecord);

  return {
    active_goals: activeGoals,
    flat_goals: goals,
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
    verification: summarizeVerificationReport(verificationReportPath),
    evidence,
    recent_goal_events: recentGoalEvents,
    machine_assessment: machineAssessment,
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
    return `你是 js-evolution-agent 的目标审计员。你的任务是判断当前目标是否仍是可验证假设，并给出目标校准建议。

第一步：请先完整阅读下方「权威文献 agentContextDocs」中的每一份文档全文（Cyber-Taoist 宪章、应用指南与本主体策略等）。**这是你判定的顶层依据：**你的 status、confidence、reason、risk 以及若有 proposed_goal，必须与这些文献相容；不得以情报材料为由提出与文献相冲突的目标。若情报不足以在文献约束下做决定，必须使用 insufficient_evidence。

第二步：在文献约束之内，再结合下方「情报与机器材料」评估目标是否可被当前证据验证或是否需要收敛。

硬约束：
- 只做判定，不执行修改。
- 必须以 agentContextDocs 为最高层级约束来判断目标是否合理、可验证、是否偏离主体边界。
- 没有来自情报侧的可用证据（观察、回顾、报告、事件等）支撑具体结论时：不得轻易建议 replace/split；若仅能依据文献得出「尚需等待证据」，则用 insufficient_evidence，且 confidence 为 low。
- 能收敛，不扩展；目标越可验证越好；proposed_goal 必须仍符合文献与主体策略。
- 评估 safe-runtime 时必须区分「agent 行为合规」「宿主预检阻断」和「provider/文件系统硬隔离」；verify_report 中的 boundary_risk 可作为边界风险证据，但不得把软约束误判为硬隔离。
- 若 verification.semantic 存在，最新 semantic verification 优先于旧 report、diary 或 remembered agent claim。它仍不是 Seen 事实；它是最近执行结果的解释层证据，应用来覆盖旧推断而不是放大旧推断。
- evidence_refs：须引用支持你结论的情报条目（intel_report / verify_report / observation / probe_result / retrospective / goal_event / evolution_event）。若某项判断主要依据某一权威文献中的原则，也请用 type 为 agent_context、id 为该文档 id、ref 为该文档 id 前加前缀 agent_context: 一并列出，使理由可追溯。
- 没有可用的 evidence_refs（含 agent_context）时 confidence 必须为 low。
- reason 必须用中文简述：结合了哪些文献要点 + 哪些情报事实。
- 只返回一个 JSON 对象，不要 Markdown，不要代码块。

JSON schema:
{
  "status": "keep | refine | split | replace | retire | insufficient_evidence",
  "confidence": "low | medium | high",
  "reason": "string",
  "evidence_refs": [{ "type": "intel_report|verify_report|observation|probe_result|retrospective|goal_event|evolution_event|agent_context", "id": "string", "ref": "string" }],
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

若建议 refine/split/replace，可将 proposed_goal 填为符合文献的主体目标 JSON 草案；否则使用 null。proposed_goal 必须包含 id、name、intent、good_signal、bad_signal、children；即使没有子目标，也必须写 children: []。若包含子目标，每个子目标也必须使用同样结构。

=== 权威文献 agentContextDocs（全文，按加载顺序） ===
${authorityBlock}

=== 情报与机器材料（JSON）===
${contextJson}`;
  }

  return `You are the goal auditor for js-evolution-agent. Decide whether the active goal remains a testable hypothesis and whether it should be calibrated.

Step 1: Read every document below under "Authority agentContextDocs" in full (Cyber-Taoist constitution, skill guide, active subject policy, and any other loaded docs). These are your top-level authority: your status, confidence, reason, risk, and any proposed_goal must be compatible with them. Never recommend goals that contradict these texts. When intelligence is insufficient to decide under those constraints, use insufficient_evidence.

Step 2: Under those constraints, use the structured intelligence block below to judge verifiability and whether goals should narrow.

Hard constraints:
- Assess only; do not execute changes.
- You MUST ground your judgment in agentContextDocs; intelligence is evidence about the world, not a substitute for doctrinal boundaries.
- Do not recommend broad replace/split without concrete intelligence support; prefer insufficient_evidence with low confidence when facts are thin.
- Prefer narrowing over expanding; proposed_goal must remain compliant with doctrine and subject policy.
- When assessing safe-runtime, distinguish agent conduct compliance, host preflight blocking, and provider/filesystem hard isolation. boundary_risk from verify_report is evidence about boundary posture, but soft constraints must not be treated as hard isolation.
- If verification.semantic exists, the latest semantic verification has priority over older report, diary, or remembered agent claims. It is not Seen fact; it is interpretation-layer evidence for the latest execution result, and should override stale inference chains instead of amplifying them.
- evidence_refs MUST cite intelligence items you rely on (intel_report / verify_report / observation / probe_result / retrospective / goal_event / evolution_event). When a key norm comes from authority text, also include agent_context with id = doc id and ref = the string "agent_context:" plus the same doc id.
- If evidence_refs would be empty, confidence MUST be low.
- reason MUST briefly name which authority points plus which factual evidence you used (English).

Return one JSON object only. No Markdown. No code fences.

JSON schema:
{
  "status": "keep | refine | split | replace | retire | insufficient_evidence",
  "confidence": "low | medium | high",
  "reason": "string",
  "evidence_refs": [{ "type": "intel_report|verify_report|observation|probe_result|retrospective|goal_event|evolution_event|agent_context", "id": "string", "ref": "string" }],
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

If you recommend refine/split/replace, proposed_goal may be a draft goal JSON consistent with doctrine. Otherwise null. proposed_goal must include id, name, intent, good_signal, bad_signal, and children. If there are no child goals, still write children: []. Any child goal must use the same shape.

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
  const status = VALID_STATUSES.has(parsed.status) ? parsed.status : 'insufficient_evidence';
  const confidence = VALID_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'low';
  const refs = Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [];

  return {
    status,
    confidence: refs.length ? confidence : 'low',
    reason: String(parsed.reason || 'No reason provided.'),
    evidence_refs: refs,
    proposed_goal: normalizeProposedGoalShape(parsed.proposed_goal),
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
} = {}) {
  const context = buildGoalAssessmentContext({
    activeGoals,
    reportRecord,
    reportMarkdown,
    verificationReportPath,
    store,
  });
  const prompt = buildGoalAssessmentPrompt({ context, agentContextDocs });

  if (!aiClient || typeof aiClient.chat !== 'function') {
    return {
      source: 'fallback',
      context,
      prompt,
      assessment: fallbackGoalAssessment('AI client unavailable.'),
    };
  }

  try {
    const raw = await aiClient.chat(prompt);
    const assessment = parseGoalAssessment(raw);
    return { source: 'ai', context, prompt, assessment };
  } catch (e) {
    const msg = e?.message || String(e);
    logger?.warn?.(`[goals] AI assessment failed: ${msg}; using fallback`);
    return {
      source: 'fallback',
      context,
      prompt,
      assessment: fallbackGoalAssessment(`AI assessment failed: ${msg}`),
    };
  }
}
