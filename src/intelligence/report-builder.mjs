import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from './redaction.mjs';

const DEFAULT_EVIDENCE_LIMITS = {
  obsLimit: 5,
  probeLimit: 5,
  retroLimit: 3,
  eventLimit: 5,
};

const DEFAULT_REPORT_CONTEXT_LIMITS = {
  observationDays: 90,
  observationLimit: 500,
  probeLimit: 300,
  retroLimit: 100,
  eventLimit: 500,
  receiptLimit: 500,
  goalEventLimit: 200,
  reportIndexLimit: 50,
  reportMarkdownLimit: 3,
  reportMarkdownCharLimit: 60000,
  standingMemoryCharLimit: 12000,
};

function safeReadGoals(runtime) {
  const goalsPath = join(runtime.runtimeRoot, 'data', 'goals', 'active_goals.json');
  if (!existsSync(goalsPath)) return null;
  try {
    return JSON.parse(readFileSync(goalsPath, 'utf-8'));
  } catch {
    return null;
  }
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

function shortText(value, max = 200) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function clipText(value, max) {
  const text = String(value ?? '');
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}\n...(truncated)`;
}

function safeRead(fn, fallback) {
  try {
    const value = fn();
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function asRecords(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Detect output language from active subject policy text.
 * Counts CJK ratio; default 'zh' so Chinese operators get Chinese output even
 * when policy text is sparse.
 */
export function detectLanguage(subjectPolicyText) {
  if (!subjectPolicyText) return 'zh';
  const total = subjectPolicyText.length;
  if (total < 20) return 'zh';
  const cjk = (subjectPolicyText.match(/[\u4e00-\u9fff]/g) || []).length;
  return (cjk / total) >= 0.2 ? 'zh' : 'en';
}

/**
 * Pull recent records from the intelligence store and shape them into evidence.
 */
export function gatherEvidence(store, opts = {}) {
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, ...opts };
  const empty = { observations: [], probes: [], retrospectives: [], events: [] };
  if (!store) return empty;

  const safe = (fn) => {
    try { return fn() ?? []; } catch { return []; }
  };

  const observations = safe(() => store.readRecentIntel({ days: 7, limit: limits.obsLimit }))
    .map((r) => ({
      id: r.id,
      kind: r.kind ?? 'observation',
      subject: r.subject ?? r.source ?? null,
      summary: shortText(r.content ?? r.summary ?? '', 240),
      tags: r.tags ?? [],
    }))
    .filter((r) => r.id);

  const probes = safe(() => store.readProbeResults({ limit: limits.probeLimit }))
    .map((r) => ({
      id: r.id,
      probe_type: r.probe_type ?? null,
      target: r.target ?? null,
      status: r.status ?? null,
      summary: shortText(r.summary ?? '', 240),
    }))
    .filter((r) => r.id);

  const retrospectives = safe(() => store.readRetrospectives({ limit: limits.retroLimit }))
    .map((r) => ({
      id: r.id,
      outcome: r.outcome ?? null,
      summary: shortText(r.summary ?? '', 240),
    }))
    .filter((r) => r.id);

  const events = safe(() => store.readEvolutionEvents({ limit: limits.eventLimit }))
    .map((r) => ({
      id: r.id,
      type: r.type ?? null,
      status: r.status ?? null,
      cycle_id: r.cycle_id ?? null,
    }))
    .filter((r) => r.id);

  return { observations, probes, retrospectives, events };
}

function readRecentReportMarkdowns(reportRecords, { limit, charLimit } = {}) {
  return asRecords(reportRecords)
    .slice(-limit)
    .map((record) => {
      const mdPath = record?.md_path ?? null;
      if (!mdPath || !existsSync(mdPath)) return null;
      return {
        id: record.id ?? null,
        cycle_id: record.cycle_id ?? null,
        md_path: mdPath,
        generated_at: record.generated_at ?? record.recorded_at ?? null,
        tldr: record.tldr ?? '',
        markdown: clipText(safeRead(() => readFileSync(mdPath, 'utf-8'), ''), charLimit),
      };
    })
    .filter(Boolean);
}

function normalizeStandingMemory(memory, charLimit) {
  if (!memory) {
    return {
      exists: false,
      updated_at: null,
      source_cycle_id: null,
      text: '(no standing memory yet)',
      evidence_refs: [],
    };
  }
  return {
    exists: true,
    updated_at: memory.updated_at ?? null,
    source_cycle_id: memory.source_cycle_id ?? null,
    text: clipText(memory.text ?? '', charLimit),
    evidence_refs: Array.isArray(memory.evidence_refs) ? memory.evidence_refs : [],
  };
}

export function gatherReportContext({
  store,
  runtime,
  intelResult,
  generatedAt,
  queueSummary = null,
  limits: limitOverrides = {},
} = {}) {
  const limits = { ...DEFAULT_REPORT_CONTEXT_LIMITS, ...limitOverrides };
  const activeGoals = safeReadGoals(runtime);
  const reportIndex = store?.readIntelReports
    ? safeRead(() => store.readIntelReports({ limit: limits.reportIndexLimit }), [])
    : [];

  const context = {
    generated_at: generatedAt,
    subject: runtime?.subject ?? null,
    namespace: runtime?.dataNamespace ?? null,
    decision_queue: queueSummary,
    current_cycle: {
      cycle_id: intelResult?.cycle_id ?? null,
      mode: intelResult?.mode ?? null,
      success: intelResult?.success ?? null,
      actions: (intelResult?.actions || []).map((a) => ({
        type: a.type,
        description: a.description,
        serves_goal: a.serves_goal,
        expected_impact: a.expected_impact,
        priority: a.priority,
      })),
      decisions_queued: intelResult?.decisions_queued || [],
    },
    standing_memory: normalizeStandingMemory(
      store?.readStandingMemory ? safeRead(() => store.readStandingMemory(), null) : null,
      limits.standingMemoryCharLimit,
    ),
    active_goals: activeGoals,
    active_goals_flat: flattenGoals(activeGoals),
    goal_events: store?.readGoalEvents
      ? safeRead(() => store.readGoalEvents({ limit: limits.goalEventLimit }), [])
      : [],
    observations: store?.readRecentIntel
      ? safeRead(() => store.readRecentIntel({ days: limits.observationDays, limit: limits.observationLimit }), [])
      : [],
    probe_results: store?.readProbeResults
      ? safeRead(() => store.readProbeResults({ limit: limits.probeLimit }), [])
      : [],
    retrospectives: store?.readRetrospectives
      ? safeRead(() => store.readRetrospectives({ limit: limits.retroLimit }), [])
      : [],
    evolution_events: store?.readEvolutionEvents
      ? safeRead(() => store.readEvolutionEvents({ limit: limits.eventLimit }), [])
      : [],
    action_receipts: store?.readActionReceipts
      ? safeRead(() => store.readActionReceipts({ limit: limits.receiptLimit }), [])
      : [],
    latest_review: store?.readLatestReview ? safeRead(() => store.readLatestReview(), null) : null,
    intel_reports_index: reportIndex,
    recent_report_markdowns: readRecentReportMarkdowns(reportIndex, {
      limit: limits.reportMarkdownLimit,
      charLimit: limits.reportMarkdownCharLimit,
    }),
  };

  context.evidence = {
    observations: asRecords(context.observations).map((r) => ({
      id: r.id,
      kind: r.kind ?? 'observation',
      subject: r.subject ?? r.source ?? null,
      summary: shortText(r.content ?? r.summary ?? '', 240),
      tags: r.tags ?? [],
    })).filter((r) => r.id),
    probes: asRecords(context.probe_results).map((r) => ({
      id: r.id,
      probe_type: r.probe_type ?? null,
      target: r.target ?? null,
      status: r.status ?? null,
      summary: shortText(r.summary ?? '', 240),
    })).filter((r) => r.id),
    retrospectives: asRecords(context.retrospectives).map((r) => ({
      id: r.id,
      outcome: r.outcome ?? null,
      summary: shortText(r.summary ?? '', 240),
    })).filter((r) => r.id),
    events: asRecords(context.evolution_events).map((r) => ({
      id: r.id,
      type: r.type ?? null,
      status: r.status ?? null,
      cycle_id: r.cycle_id ?? null,
    })).filter((r) => r.id),
  };

  context.source_counts = {
    observations: context.observations.length,
    probe_results: context.probe_results.length,
    retrospectives: context.retrospectives.length,
    evolution_events: context.evolution_events.length,
    action_receipts: context.action_receipts.length,
    goal_events: context.goal_events.length,
    intel_reports_index: context.intel_reports_index.length,
    recent_report_markdowns: context.recent_report_markdowns.length,
    latest_review: context.latest_review ? 1 : 0,
    standing_memory: context.standing_memory.exists ? 1 : 0,
    decision_queue: context.decision_queue ? 1 : 0,
  };

  return context;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 4);
}

function signalHits(signal, haystackLowercase) {
  if (!signal) return false;
  const tokens = tokenize(signal);
  if (!tokens.length) return false;
  return tokens.some((t) => haystackLowercase.includes(t));
}

/**
 * Lightweight rule-based assessment. Used as auxiliary input to the AI prompt;
 * the AI is free to override or ignore it.
 */
export function assessGoals(goals, evidence) {
  const obs = evidence?.observations ?? [];
  const retros = evidence?.retrospectives ?? [];
  return goals.map((g) => {
    const hits = { drifting: [], progressing: [] };
    const badSignal = g.bad_signal || '';
    const goodSignal = g.good_signal || '';

    for (const o of obs) {
      const hay = `${o.summary || ''}`.toLowerCase();
      if (signalHits(badSignal, hay)) hits.drifting.push(o.id);
    }
    for (const r of retros) {
      const hay = `${r.summary || ''}`.toLowerCase();
      const ok = (r.outcome ?? '').toLowerCase() === 'ok';
      if (ok && signalHits(goodSignal, hay)) hits.progressing.push(r.id);
    }

    let status = 'needs-assessment';
    const evidenceIds = [];
    if (hits.drifting.length) {
      status = 'drifting';
      evidenceIds.push(...hits.drifting);
    } else if (hits.progressing.length) {
      status = 'progressing';
      evidenceIds.push(...hits.progressing);
    }

    return {
      id: g.id,
      name: g.name,
      intent: g.intent,
      status,
      evidence_ids: evidenceIds,
    };
  });
}

/**
 * Best-effort tldr extraction. Free-form reports may not have a TL;DR section
 * at all; in that case, take the first 2 non-empty content lines after the
 * top heading and clip.
 */
export function extractTldr(md) {
  if (!md) return '';
  const m = md.match(/##\s*TL;?DR[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
  if (m) {
    return m[1].trim().split('\n').filter(Boolean).slice(0, 5).join(' ').slice(0, 400);
  }
  const lines = md.split('\n');
  const collected = [];
  let pastTopHeading = false;
  for (const ln of lines) {
    if (!pastTopHeading) {
      if (ln.startsWith('# ')) pastTopHeading = true;
      continue;
    }
    if (ln.startsWith('>') || ln.startsWith('#')) continue;
    const t = ln.trim();
    if (!t) continue;
    collected.push(t);
    if (collected.length >= 3) break;
  }
  return collected.join(' ').slice(0, 400);
}

function pickDoc(docs, idPrefix) {
  if (!Array.isArray(docs)) return null;
  return docs.find((d) => typeof d?.id === 'string' && d.id.startsWith(idPrefix)) || null;
}

function buildPromptZh({ constitution, skill, subject, contextJson }) {
  return `你是 \`js-evolution-agent\` 主体的情报员。请先研读以下三份文献的全文，然后用其中的视角、术语与方法，为本轮（cycle）写一份 Markdown 「情报报告」。

章节结构与篇幅可适当发挥，但必须同时满足：(1) 对人类操作者可读、对主体的演化有用、忠于 Cyber-Taoist 进化学立场；(2) 全文使用现代汉语书面语（白话），禁止使用文言文、骈俪、「修行札记」式杂文口吻，以及堆砌典故作主标题或过长的玄学隐喻；(3) Cyber-Taoist 专有名词可按文献原样使用，用事实与可追溯 id 陈述，少用比喻替代证据。

阅读顺序与约束：
1. 先读权威文献，它们高于所有情报材料。
2. 再读 standing_memory，它是固定容量的整体态势记忆；它可以帮助你保持连续性，但不能覆盖新的证据。
3. 再读当前目标、目标历史、本轮事实、近期完整情报和历史报告索引。
4. 若新证据推翻或削弱 standing_memory 中的旧判断，请在报告中指出。

输出约束：
1. 输出纯 Markdown，不要在最外层用代码围栏包裹。
2. 不要捏造下方"本轮事实"中没有的 id、计数或事件。
3. 用中文写作。
4. 尽量引用可追溯的 id（如 observation、probe_result、goal_event、action_receipt、intel_report、evolution_event）。
5. 报告应覆盖：本轮事实、长期趋势、证据不足处、风险、下一轮建议，以及 standing_memory 应如何更新的要点。
6. 标题与小节标题用简明主题短语（例如「本轮结论」「证据缺口」），禁止使用文言对联式或隐喻式标题。

=== 文献 1：Cyber-Taoist 宪章（CONSTITUTION.md，全文） ===
${constitution || '(missing)'}

=== 文献 2：Cyber-Taoist 应用指南（SKILL.md，全文） ===
${skill || '(missing)'}

=== 文献 3：本主体策略（active subject policy，全文） ===
${subject || '(missing)'}

=== 本轮事实与情报上下文（机器汇集，仅供参考，不必逐项罗列） ===
${contextJson}

请开始撰写报告。`;
}

function buildPromptEn({ constitution, skill, subject, contextJson }) {
  return `You are the intel writer for the \`js-evolution-agent\` subject. First, study the three documents below in full, then write a Markdown intelligence report for this cycle using their lens, vocabulary, and methods.

Sectioning and depth are yours, but voice must stay modern, plain, and technical-ops flavored: readable to a human operator, useful to evolution, faithful to Cyber-Taoist evolutionary thinking. Avoid archaic/literary register, ornate metaphors as section titles, or "meditation journal" tone unless you are quoting the constitution verbatim.

Reading order and constraints:
1. Read the authority documents first. They outrank all intelligence material.
2. Then read standing_memory. It is the fixed-capacity global situation memory; use it for continuity, but do not let it override new evidence.
3. Then read the active goals, goal history, current cycle facts, recent intelligence, and report history.
4. If new evidence weakens or overturns standing_memory, say so in the report.

Output constraints:
1. Output pure Markdown; do not wrap the whole document in code fences.
2. Do not invent ids, counts, or events not present in the machine-collected context below.
3. Write in English.
4. Prefer traceable ids where relevant (observation, probe_result, goal_event, action_receipt, intel_report, evolution_event).
5. Cover current cycle facts, long-term trends, evidence gaps, risks, next-cycle recommendations, and how standing_memory should be updated.
6. Use concise, literal section headings (for example “Cycle conclusion”, “Evidence gaps”); avoid purple prose titles.

=== Document 1: Cyber-Taoist Constitution (CONSTITUTION.md, full text) ===
${constitution || '(missing)'}

=== Document 2: Cyber-Taoist Skill Guide (SKILL.md, full text) ===
${skill || '(missing)'}

=== Document 3: Active Subject Policy (full text) ===
${subject || '(missing)'}

=== Current Cycle Facts and Intelligence Context (machine-collected, for reference) ===
${contextJson}

Now write the report.`;
}

function buildAiContext({ intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext = null }) {
  if (reportContext) {
    return JSON.stringify({
      ...reportContext,
      precomputed_assessment: assessment,
    }, null, 2);
  }
  return JSON.stringify({
    cycle_id: intelResult.cycle_id,
    generated_at: generatedAt,
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    mode: intelResult.mode,
    success: intelResult.success,
    actions: (intelResult.actions || []).map((a) => ({
      type: a.type,
      description: a.description,
      serves_goal: a.serves_goal,
      expected_impact: a.expected_impact,
      priority: a.priority,
    })),
    decisions_queued: intelResult.decisions_queued || [],
    active_goals: goals,
    evidence,
    precomputed_assessment: assessment,
  }, null, 2);
}

export function buildPrompt({ language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext = null }) {
  const constitutionDoc = pickDoc(agentContextDocs, 'cyber-taoist:constitution');
  const skillDoc = pickDoc(agentContextDocs, 'cyber-taoist:skill');
  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || pickDoc(agentContextDocs, 'subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);

  const contextJson = buildAiContext({ intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext });
  const args = {
    constitution: constitutionDoc?.text,
    skill: skillDoc?.text,
    subject: subjectDoc?.text,
    contextJson,
  };
  return language === 'en' ? buildPromptEn(args) : buildPromptZh(args);
}

function renderFallbackMd({ intelResult, runtime, generatedAt, evidence, assessment, language, reason }) {
  const cycleId = intelResult.cycle_id;
  const isZh = language !== 'en';
  const t = (zh, en) => (isZh ? zh : en);

  const lines = [
    `# Intel Report — ${cycleId}`,
    `> Generated: ${generatedAt}  Subject: ${runtime.subject}  Namespace: ${runtime.dataNamespace}`,
    '',
    `> ${t(
      `**AI 生成失败，回退为占位报告**${reason ? `（原因：${reason}）` : ''}。下面只列出本轮的机器事实，未做模型诠释。`,
      `**AI generation failed; this is a placeholder report**${reason ? ` (reason: ${reason})` : ''}. Only mechanical facts are listed below; no model interpretation was performed.`,
    )}`,
    '',
    `## ${t('本轮事实', 'Cycle Facts')}`,
    `- cycle: ${cycleId}`,
    `- ${t('动作数', 'actions')}: ${(intelResult.actions || []).length}`,
    `- ${t('入队决策数', 'decisions queued')}: ${(intelResult.decisions_queued || []).length}`,
    `- ${t('观察证据', 'observations')}: ${evidence.observations.length}`,
    `- ${t('探针证据', 'probes')}: ${evidence.probes.length}`,
    `- ${t('回顾证据', 'retrospectives')}: ${evidence.retrospectives.length}`,
    '',
  ];

  if (evidence.observations.length) {
    lines.push(`## ${t('近期观察', 'Recent Observations')}`);
    for (const o of evidence.observations) lines.push(`- [${o.id}] ${o.summary || ''}`);
    lines.push('');
  }
  if (assessment.length) {
    lines.push(`## ${t('目标快照（机器评估）', 'Goal Snapshot (machine assessment)')}`);
    for (const a of assessment) {
      lines.push(`- \`${a.id}\` (${a.name || ''}): ${a.status}${a.evidence_ids.length ? ` — ${a.evidence_ids.join(', ')}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function tryAiRender({ aiClient, language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext, logger }) {
  if (!aiClient || typeof aiClient.chat !== 'function') {
    return { md: null, reason: 'no-ai-client' };
  }
  const prompt = buildPrompt({ language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext });
  try {
    const md = await aiClient.chat(prompt);
    if (typeof md !== 'string' || !md.trim()) {
      return { md: null, reason: 'empty-output' };
    }
    return { md: md.trim() + '\n', reason: null };
  } catch (e) {
    const msg = e?.message || String(e);
    logger?.warn?.(`[report] AI generation failed: ${msg}; using fallback placeholder`);
    return { md: null, reason: msg };
  }
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function buildStandingMemoryUpdatePrompt({
  language,
  oldMemory,
  reportMarkdown,
  reportContext,
  maxChars,
  extraContext = null,
}) {
  const contextJson = clipText(JSON.stringify({
    current_cycle: reportContext.current_cycle,
    source_counts: reportContext.source_counts,
    active_goals: reportContext.active_goals,
    goal_events: reportContext.goal_events,
    observations: reportContext.observations,
    probe_results: reportContext.probe_results,
    retrospectives: reportContext.retrospectives,
    evolution_events: reportContext.evolution_events,
    action_receipts: reportContext.action_receipts,
    latest_review: reportContext.latest_review,
    intel_reports_index: reportContext.intel_reports_index,
    extra_context: extraContext,
  }, null, 2), 500000);

  if (language === 'en') {
    return `You maintain the fixed-capacity standing memory for js-evolution-agent.

Update the memory so the next cycle can understand the global situation quickly.

Rules:
- Return only the new standing memory text. No code fences.
- Keep it under ${maxChars} characters.
- Preserve stable conclusions that are still supported.
- Downgrade or remove stale claims when the new report or evidence weakens them.
- Track active goal rationale, durable trends, risks, unresolved hypotheses, and useful evidence refs.
- Missing-path, ENOENT, or blocked probe evidence must stay qualified by execution_root/resource_scope/resource_kind. Do not turn "path missing under root X" into "module missing" unless X is the authoritative root for that resource.

=== Previous Standing Memory ===
${oldMemory?.text || '(none)'}

=== New Cycle Report ===
${reportMarkdown}

=== Machine Context ===
${contextJson}`;
  }

  return `你维护 js-evolution-agent 的固定容量 standing memory。

请把它更新为下一轮可快速理解整体态势的概要记忆。

规则：
- 只返回新版 standing memory 正文，不要代码围栏。
- 总长度必须控制在 ${maxChars} 字符以内。
- 保留仍被证据支持的稳定结论。
- 如果新报告或新证据削弱了旧判断，请降级或删除旧判断。
- 记录当前目标理由、长期趋势、风险、未验证假设，以及有用的 evidence refs。
- 缺失路径、ENOENT 或 blocked 探针证据必须保留 execution_root/resource_scope/resource_kind 边界；除非该 root 是该资源的权威 root，不得把「root X 下 path 不存在」升级为「模块缺失」「机制未实现」「写入冻结」。

=== 旧 Standing Memory ===
${oldMemory?.text || '(none)'}

=== 新周期报告 ===
${reportMarkdown}

=== 机器上下文 ===
${contextJson}`;
}

export async function updateStandingMemoryWithAi({
  aiClient,
  store,
  language,
  reportContext,
  reportMarkdown,
  cycleId,
  generatedAt,
  logger,
  maxChars = DEFAULT_REPORT_CONTEXT_LIMITS.standingMemoryCharLimit,
  extraContext = null,
} = {}) {
  if (!store || typeof store.recordStandingMemory !== 'function') {
    return { status: 'skipped', reason: 'store-unavailable' };
  }
  if (!aiClient || typeof aiClient.chat !== 'function') {
    return { status: 'skipped', reason: 'no-ai-client' };
  }

  const prompt = buildStandingMemoryUpdatePrompt({
    language,
    oldMemory: reportContext.standing_memory,
    reportMarkdown,
    reportContext,
    maxChars,
    extraContext,
  });

  try {
    const raw = await aiClient.chat(prompt);
    const text = clipText(stripCodeFence(raw), maxChars).trim();
    if (!text) return { status: 'failed', reason: 'empty-output' };
    const written = store.recordStandingMemory({
      source_cycle_id: cycleId,
      generated_at: generatedAt,
      char_limit: maxChars,
      token_budget_hint: `fixed prompt region, max ${maxChars} characters`,
      text,
      evidence_refs: [],
    });
    return { status: written > 0 ? 'updated' : 'failed', reason: written > 0 ? null : 'write-failed' };
  } catch (e) {
    const msg = e?.message || String(e);
    logger?.warn?.(`[report] standing memory update failed: ${msg}`);
    return { status: 'failed', reason: msg };
  }
}

export function prepareIntelReport({
  intelResult,
  runtime,
  store,
  agentContextDocs = [],
  generatedAt = new Date().toISOString(),
  queueSummary = null,
}) {
  if (!intelResult?.cycle_id) {
    throw new Error('prepareIntelReport requires intelResult.cycle_id');
  }
  const reportContext = gatherReportContext({ store, runtime, intelResult, generatedAt, queueSummary });
  const goals = reportContext.active_goals_flat;
  const evidence = reportContext.evidence;
  const assessment = assessGoals(goals, evidence);

  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);
  const language = detectLanguage(subjectDoc?.text);

  return {
    generatedAt,
    reportContext,
    goals,
    evidence,
    assessment,
    language,
  };
}

export async function persistIntelReport({
  intelResult,
  runtime,
  store,
  agentContextDocs = [],
  aiClient = null,
  logger = null,
  md = null,
  source = 'ai',
  fallbackReason = null,
  generatedAt = null,
  reportContext = null,
  goals = null,
  evidence = null,
  assessment = null,
  language = null,
  updateStandingMemory = true,
  queueSummary = null,
} = {}) {
  const prepared = reportContext && evidence && assessment && language
    ? { generatedAt: generatedAt || new Date().toISOString(), reportContext, goals, evidence, assessment, language }
    : prepareIntelReport({ intelResult, runtime, store, agentContextDocs, generatedAt: generatedAt || new Date().toISOString(), queueSummary });

  const cycleId = intelResult.cycle_id;
  const finalGeneratedAt = prepared.generatedAt;
  const finalReportContext = prepared.reportContext;
  const finalEvidence = prepared.evidence;
  const finalAssessment = prepared.assessment;
  const finalLanguage = prepared.language;
  let finalMd = md;
  let finalSource = source || 'ai';

  if (!finalMd) {
    finalSource = 'fallback';
    finalMd = renderFallbackMd({
      intelResult,
      runtime,
      generatedAt: finalGeneratedAt,
      evidence: finalEvidence,
      assessment: finalAssessment,
      language: finalLanguage,
      reason: fallbackReason,
    });
  }

  finalMd = redactSecrets(finalMd);

  const reportsDir = join(runtime.runtimeRoot, 'data', 'intelligence', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = join(reportsDir, `${cycleId}.md`);
  writeFileSync(mdPath, finalMd, 'utf-8');

  const memoryUpdate = updateStandingMemory
    ? await updateStandingMemoryWithAi({
      aiClient,
      store,
      language: finalLanguage,
      reportContext: finalReportContext,
      reportMarkdown: finalMd,
      cycleId,
      generatedAt: finalGeneratedAt,
      logger,
      maxChars: DEFAULT_REPORT_CONTEXT_LIMITS.standingMemoryCharLimit,
    })
    : { status: 'skipped', reason: 'disabled' };

  const indexRecord = {
    cycle_id: cycleId,
    generated_at: finalGeneratedAt,
    md_path: mdPath,
    tldr: extractTldr(finalMd),
    action_count: (intelResult.actions || []).length,
    evidence_obs_count: finalEvidence.observations.length,
    evidence_probe_count: finalEvidence.probes.length,
    evidence_retro_count: finalEvidence.retrospectives.length,
    context_source_counts: finalReportContext.source_counts,
    standing_memory_used: finalReportContext.standing_memory.exists,
    standing_memory_updated: memoryUpdate.status === 'updated',
    standing_memory_update_status: memoryUpdate.status,
    standing_memory_update_error: memoryUpdate.reason,
    recent_report_count: finalReportContext.recent_report_markdowns.length,
    action_receipt_count: finalReportContext.action_receipts.length,
    goal_event_count: finalReportContext.goal_events.length,
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    language: finalLanguage,
    source: finalSource,
  };
  store.recordIntelReport(indexRecord);

  return { mdPath, indexRecord, source: finalSource, memoryUpdate, markdown: finalMd };
}

/**
 * Build a free-form, human-readable intel report for the given cycle.
 *
 * No output schema is enforced; the AI is given the full Cyber-Taoist documents
 * plus the active subject policy as context and writes whatever it judges most
 * useful for the operator.
 *
 * @param {object} args
 * @param {object} args.intelResult
 * @param {object} args.runtime
 * @param {object} args.store
 * @param {Array<{id:string,text:string,source:string}>} [args.agentContextDocs]
 * @param {object} [args.aiClient]
 * @param {object} [args.logger]
 * @param {boolean} [args.useAi=true]
 * @returns {Promise<{ mdPath: string, indexRecord: object, source: 'ai'|'fallback' }>}
 */
export async function buildIntelReport({
  intelResult,
  runtime,
  store,
  agentContextDocs = [],
  aiClient = null,
  logger = null,
  useAi = true,
}) {
  const prepared = prepareIntelReport({ intelResult, runtime, store, agentContextDocs });

  let md = null;
  let source = 'fallback';
  let fallbackReason = null;
  if (useAi) {
    const { md: aiMd, reason } = await tryAiRender({
      aiClient,
      language: prepared.language,
      agentContextDocs,
      intelResult,
      runtime,
      goals: prepared.goals,
      evidence: prepared.evidence,
      assessment: prepared.assessment,
      generatedAt: prepared.generatedAt,
      reportContext: prepared.reportContext,
      logger,
    });
    if (aiMd) {
      md = aiMd;
      source = 'ai';
    } else {
      fallbackReason = reason;
    }
  } else {
    fallbackReason = 'use-ai-disabled';
  }

  return persistIntelReport({
    intelResult,
    runtime,
    store,
    agentContextDocs,
    aiClient: useAi ? aiClient : null,
    logger,
    md,
    source,
    fallbackReason,
    ...prepared,
  });
}
