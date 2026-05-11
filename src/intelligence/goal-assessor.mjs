import { readFileSync } from 'node:fs';
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
- evidence_refs：须引用支持你结论的情报条目（intel_report / observation / probe_result / retrospective / goal_event / evolution_event）。若某项判断主要依据某一权威文献中的原则，也请用 type 为 agent_context、id 为该文档 id、ref 为该文档 id 前加前缀 agent_context: 一并列出，使理由可追溯。
- 没有可用的 evidence_refs（含 agent_context）时 confidence 必须为 low。
- reason 必须用中文简述：结合了哪些文献要点 + 哪些情报事实。
- 只返回一个 JSON 对象，不要 Markdown，不要代码块。

JSON schema:
{
  "status": "keep | refine | split | replace | retire | insufficient_evidence",
  "confidence": "low | medium | high",
  "reason": "string",
  "evidence_refs": [{ "type": "intel_report|observation|probe_result|retrospective|goal_event|evolution_event|agent_context", "id": "string", "ref": "string" }],
  "proposed_goal": null,
  "risk": "string"
}

若建议 refine/split/replace，可将 proposed_goal 填为符合文献的主体目标 JSON 草案；否则使用 null。

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
- evidence_refs MUST cite intelligence items you rely on (intel_report / observation / probe_result / retrospective / goal_event / evolution_event). When a key norm comes from authority text, also include agent_context with id = doc id and ref = the string "agent_context:" plus the same doc id.
- If evidence_refs would be empty, confidence MUST be low.
- reason MUST briefly name which authority points plus which factual evidence you used (English).

Return one JSON object only. No Markdown. No code fences.

JSON schema:
{
  "status": "keep | refine | split | replace | retire | insufficient_evidence",
  "confidence": "low | medium | high",
  "reason": "string",
  "evidence_refs": [{ "type": "intel_report|observation|probe_result|retrospective|goal_event|evolution_event|agent_context", "id": "string", "ref": "string" }],
  "proposed_goal": null,
  "risk": "string"
}

If you recommend refine/split/replace, proposed_goal may be a draft goal JSON consistent with doctrine. Otherwise null.

=== Authority agentContextDocs (full text, loaded order) ===
${authorityBlock}

=== Intelligence and machine artifacts (JSON) ===
${contextJson}`;
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonObject(text) {
  const stripped = stripCodeFence(text);
  if (!stripped) throw new Error('empty AI output');
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI output is not JSON');
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

export function parseGoalAssessment(raw) {
  const parsed = extractJsonObject(raw);
  const status = VALID_STATUSES.has(parsed.status) ? parsed.status : 'insufficient_evidence';
  const confidence = VALID_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'low';
  const refs = Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [];

  return {
    status,
    confidence: refs.length ? confidence : 'low',
    reason: String(parsed.reason || 'No reason provided.'),
    evidence_refs: refs,
    proposed_goal: parsed.proposed_goal ?? null,
    risk: String(parsed.risk || ''),
  };
}

export async function assessGoalsWithAi({
  aiClient,
  activeGoals,
  reportRecord,
  reportMarkdown = null,
  store,
  agentContextDocs = [],
  logger = null,
} = {}) {
  const context = buildGoalAssessmentContext({
    activeGoals,
    reportRecord,
    reportMarkdown,
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
