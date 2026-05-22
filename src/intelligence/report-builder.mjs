import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTemporalDecisionBrief } from './decision-brief.mjs';
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
    .slice(0, limit)
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

function historicalReportReferences(reportRecords, { limit } = {}) {
  return asRecords(reportRecords)
    .slice(0, limit)
    .map((record) => ({
      id: record.id ?? null,
      cycle_id: record.cycle_id ?? null,
      generated_at: record.generated_at ?? record.recorded_at ?? null,
      md_path: record.md_path ?? null,
      tldr: record.tldr ?? '',
      source_role: 'historical_model_report_reference',
      use_policy: 'Use as historical claim context only; verify against Temporal Decision Brief and structured evidence before treating as current fact.',
    }));
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
  operatorBriefs = [],
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
    operator_intent_briefs: operatorBriefs,
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
    historical_report_references: historicalReportReferences(reportIndex, {
      limit: limits.reportMarkdownLimit,
    }),
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
    operator_intent_briefs: context.operator_intent_briefs.length,
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

function seenSourceId(item) {
  return item?.source?.id ?? item?.id ?? null;
}

function memorySourceType(sourceType) {
  const map = {
    evolution_event: 'evolution_events',
    goal_event: 'goal_events',
    action_receipt: 'action_receipts',
    probe_result: 'probe_results',
    intel_report: 'reports',
    latest_review: 'retrospectives',
    standing_memory: 'standing_memory',
  };
  return map[sourceType] ?? sourceType ?? 'unknown';
}

function sourceAddress({ sourceType, sourceId } = {}) {
  const type = memorySourceType(sourceType);
  return sourceId ? `[${type}:${sourceId}]` : `[${type}:unknown]`;
}

function summarizeSeenItem(item) {
  if (item?.summary) {
    const summary = shortText(item.summary, 260);
    if (item.evidence_level === 'source_statement') return summary;
    return summary;
  }
  if (item?.fields && typeof item.fields === 'object') {
    return shortText(JSON.stringify(item.fields), 260);
  }
  return shortText(JSON.stringify(item ?? {}), 260);
}

function rememberedPrefix(item) {
  if (item?.kind === 'agent_claim') return 'agent_claim';
  if (item?.kind === 'historical_claim') return 'historical_claim';
  return item?.kind || 'remembered';
}

function rememberedPolicy(item) {
  if (item?.kind === 'agent_claim') return 'agent_claim_lead_not_fact';
  if (item?.kind === 'historical_claim') return 'historical_context_not_fact';
  return 'remembered_context_not_fact';
}

function rememberedDedupeKey(item, sourceId) {
  const sourceType = item?.source?.source_type ?? 'unknown';
  if (sourceType === 'goal_event') {
    const summary = String(item?.summary ?? '');
    const goalMatch = summary.match(/\b(?:assessment|refine|defer|keep|replace|completed|goal_event)\s+([^:]+):/i);
    return [
      sourceType,
      goalMatch?.[1]?.trim() ?? '',
      goalMatch?.[0]?.split(/\s+/)[0]?.toLowerCase() ?? '',
      shortText(item?.summary ?? '', 120),
    ].join(':');
  }
  return `${sourceType}:${sourceId}`;
}

function normalizeRememberedItems(items) {
  const counts = new Map();
  const seenKeys = new Set();
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    const sourceType = item?.source?.source_type ?? null;
    if (sourceType === 'standing_memory') continue;
    const sourceId = seenSourceId(item);
    if (!sourceId) continue;
    const key = rememberedDedupeKey(item, sourceId);
    if (seenKeys.has(key)) continue;
    const policy = rememberedPolicy(item);
    const policyCount = counts.get(policy) ?? 0;
    if (policy === 'agent_claim_lead_not_fact' && policyCount >= 24) continue;
    if (policy === 'historical_context_not_fact' && policyCount >= 8) continue;
    seenKeys.add(key);
    counts.set(policy, policyCount + 1);
    normalized.push({
      source_id: sourceId,
      source_type: sourceType,
      source_address: sourceAddress({
        sourceType,
        sourceId,
      }),
      recorded_at: item?.source?.recorded_at ?? null,
      kind: item?.kind ?? null,
      evidence_level: item?.evidence_level ?? null,
      summary: shortText(item?.summary ?? '', 260),
      remembered_policy: policy,
      prefix: rememberedPrefix(item),
    });
  }
  return normalized;
}

function buildMemoryAdmission(reportContext) {
  const brief = reportContext?.temporal_decision_brief ?? {};
  const seen = Array.isArray(brief.seen) ? brief.seen : [];
  const memorySeen = seen.filter((item) => {
    if (item?.evidence_level === 'agent_narrative') return false;
    if (item?.source?.source_type !== 'action_receipt') return true;
    const status = String(item?.fields?.status ?? '').toLowerCase();
    return status === 'completed' || status === 'succeeded';
  });
  const rememberedCandidates = [
    ...(brief.remembered ?? []),
    ...seen.filter((item) => (
      item?.source?.source_type === 'goal_event'
      && item?.evidence_level === 'source_statement'
    )),
  ];
  return {
    rule: 'Only memory_admission.seen may appear in the final Seen section. Completed action_receipt structured status is Seen; receipt summaries, messages, and agent claims are not Seen.',
    seen: memorySeen.map((item) => ({
      source_id: seenSourceId(item),
      source_type: item?.source?.source_type ?? null,
      source_address: sourceAddress({
        sourceType: item?.source?.source_type,
        sourceId: seenSourceId(item),
      }),
      recorded_at: item?.source?.recorded_at ?? null,
      kind: item?.kind ?? null,
      evidence_level: item?.evidence_level ?? null,
      summary: summarizeSeenItem(item),
      seen_policy: item?.evidence_level === 'source_statement'
        ? 'source_statement_only'
        : 'direct_field_or_status',
    })).filter((item) => item.source_id),
    remembered: normalizeRememberedItems(rememberedCandidates).slice(0, 40),
    do_not_treat_as_seen: (brief.do_not_treat_as_seen ?? []).slice(0, 30),
  };
}

function buildSeenSection(reportContext) {
  const admitted = buildMemoryAdmission(reportContext).seen;
  if (!admitted.length) return '- (none)';
  return admitted
    .map((item) => `- ${item.source_address}: ${item.summary}`)
    .join('\n');
}

function buildRememberedSection(reportContext) {
  const admitted = buildMemoryAdmission(reportContext).remembered;
  if (!admitted.length) return '- (none)';
  return admitted
    .map((item) => `- ${item.source_address} ${item.prefix}: ${item.summary}`)
    .join('\n');
}

function buildTypedEvidenceRefs(reportContext) {
  return buildMemoryAdmission(reportContext).seen
    ?.map((fact) => ({
      source_type: memorySourceType(fact.source_type),
      source_id: fact.source_id,
      source_address: fact.source_address,
    }))
    .filter((ref) => ref.source_id)
    .slice(0, 50) ?? [];
}

function replaceMarkdownSection(markdown, heading, replacementBody) {
  const text = String(markdown || '').trim();
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(
    `(^|\\n)##\\s+${escaped}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`,
    'i',
  );
  const replacement = `\n## ${heading}\n\n${replacementBody.trim()}\n`;
  if (sectionPattern.test(text)) {
    return text.replace(sectionPattern, replacement).trim();
  }
  return `## ${heading}\n\n${replacementBody.trim()}\n\n${text}`.trim();
}

export function enforceStandingMemorySeenGate(text, reportContext) {
  return replaceMarkdownSection(text, 'Seen', buildSeenSection(reportContext));
}

export function enforceStandingMemoryRememberedGate(text, reportContext) {
  return replaceMarkdownSection(text, 'Remembered', buildRememberedSection(reportContext));
}

export function enforceStandingMemoryGates(text, reportContext) {
  return enforceStandingMemoryRememberedGate(
    enforceStandingMemorySeenGate(text, reportContext),
    reportContext,
  );
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
    memory_admission: buildMemoryAdmission(reportContext),
    current_cycle: reportContext.current_cycle,
    source_counts: reportContext.source_counts,
    active_goals: reportContext.active_goals,
    extra_context: extraContext,
  }, null, 2), 500000);

  if (language === 'en') {
    return `You maintain the fixed-capacity standing memory for js-evolution-agent.

Update the memory so the next cycle can understand the global situation quickly.

Rules:
- Return only the new standing memory text. No code fences.
- Keep it under ${maxChars} characters.
- Use exactly these sections: Seen, Inferred, Remembered, Do Not Treat As Seen.
- Previous Standing Memory is only a continuity hint. Do not copy its Seen or Remembered items unless they also appear in Machine Context memory_admission.
- Seen and Remembered will be rewritten by code from Machine Context memory_admission. Treat direct edits to standing_memory.json as temporary unless they are represented in admission/gates.
- Seen may only use Machine Context memory_admission.seen. Completed action_receipt structured status may appear as Seen, but receipt summaries, messages, audit conclusions, partial receipts, and agent claims must not appear in Seen.
- Write every Seen item with its bracketed reopen address, for example [evolution_events:evt-...], [goal_events:goal-event-...], [action_receipts:receipt-...], or [probe_results:probe-result-...].
- When verifying a Seen item later, use the bracketed source type to locate the record. Do not treat the id as a filename.
- If a Seen item says "source claims" or "source records", keep that wording. It means the source was read, not that the statement is automatically true.
- Inferred must cite Seen source ids and include what would overturn the judgement.
- Remembered may only use Machine Context memory_admission.remembered. It is background only; do not phrase it as current fact, do not use short ids, and do not revive old Previous Standing Memory text.
- Do Not Treat As Seen preserves refuted, stale, forbidden, or repeatedly misleading claims. Do not write a blanket rule that all receipt ids are forbidden; distinguish structured receipt status from receipt agent claims.
- Important numeric or status claims should cite source ids when available.
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
- 固定使用四个小节：Seen、Inferred、Remembered、Do Not Treat As Seen。
- 旧 Standing Memory 只能作为连续性线索。除非内容也出现在机器上下文 memory_admission 中，否则不要复制旧的 Seen 或 Remembered。
- Seen 和 Remembered 会被代码根据 Machine Context memory_admission 重写。直接编辑 standing_memory.json 只是临时修复；持久修复必须进入 admission/gate。
- Seen 只能使用机器上下文 memory_admission.seen。已完成 action_receipt 的结构化状态可以作为 Seen；receipt summary、message、审计结论、partial receipt 或 agent claim 不得放入 Seen。
- 每条 Seen 都必须写出方括号可重开地址，例如 [evolution_events:evt-...]、[goal_events:goal-event-...]、[action_receipts:receipt-...]、[probe_results:probe-result-...]。
- 后续验证 Seen 时必须按方括号里的 source type 去对应数据源查找，不要把 id 当成文件名。
- 如果 Seen 项写着 “source claims” 或 “source records”，必须保留这个说法。它表示读到了该来源，不表示该说法自动为真。
- Inferred 必须引用 Seen 的 source id，并写明什么证据会推翻该判断。
- Remembered 只能使用机器上下文 memory_admission.remembered。它只能作为背景，不得写成当前事实，不得使用短 id，也不得复活旧 Standing Memory 文本。
- Do Not Treat As Seen 保留已证伪、过期、禁止复活或反复误导的说法。不要写成“所有 receipt id 都禁止”；必须区分 receipt 结构化状态和 receipt agent claim。
- 关键数值或状态判断应尽量引用 source id。
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
    const text = clipText(
      enforceStandingMemoryGates(stripCodeFence(raw), reportContext),
      maxChars,
    ).trim();
    if (!text) return { status: 'failed', reason: 'empty-output' };
    const written = store.recordStandingMemory({
      source_cycle_id: cycleId,
      generated_at: generatedAt,
      char_limit: maxChars,
      token_budget_hint: `fixed prompt region, max ${maxChars} characters`,
      text,
      evidence_refs: buildTypedEvidenceRefs(reportContext)
        .map((ref) => ref.source_id),
      typed_evidence_refs: buildTypedEvidenceRefs(reportContext),
      memory_policy: {
        standing_memory_role: 'seen_inferred_remembered_cache',
        evidence_precedence: reportContext.temporal_decision_brief?.evidence_policy?.precedence ?? [],
        sections: ['Seen', 'Inferred', 'Remembered', 'Do Not Treat As Seen'],
        source_cycle_id: cycleId,
      },
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
  operatorBriefs = [],
}) {
  if (!intelResult?.cycle_id) {
    throw new Error('prepareIntelReport requires intelResult.cycle_id');
  }
  const reportContext = gatherReportContext({
    store,
    runtime,
    intelResult,
    generatedAt,
    queueSummary,
    operatorBriefs,
  });
  const goals = reportContext.active_goals_flat;
  const evidence = reportContext.evidence;
  const assessment = assessGoals(goals, evidence);
  const temporalDecisionBrief = buildTemporalDecisionBrief(reportContext);
  reportContext.temporal_decision_brief = temporalDecisionBrief;

  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);
  const language = detectLanguage(subjectDoc?.text);

  return {
    generatedAt,
    reportContext,
    goals,
    evidence,
    assessment,
    temporalDecisionBrief,
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
  operatorBriefs = [],
} = {}) {
  const prepared = reportContext && evidence && assessment && language
    ? {
      generatedAt: generatedAt || new Date().toISOString(),
      reportContext,
      goals,
      evidence,
      assessment,
      temporalDecisionBrief: reportContext.temporal_decision_brief ?? buildTemporalDecisionBrief(reportContext),
      language,
    }
    : prepareIntelReport({
      intelResult,
      runtime,
      store,
      agentContextDocs,
      generatedAt: generatedAt || new Date().toISOString(),
      queueSummary,
      operatorBriefs,
    });

  const cycleId = intelResult.cycle_id;
  const finalGeneratedAt = prepared.generatedAt;
  const finalReportContext = prepared.reportContext;
  if (!finalReportContext.temporal_decision_brief) {
    finalReportContext.temporal_decision_brief = prepared.temporalDecisionBrief ?? buildTemporalDecisionBrief(finalReportContext);
  }
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
