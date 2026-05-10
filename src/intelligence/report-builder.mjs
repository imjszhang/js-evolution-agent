import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EVIDENCE_LIMITS = {
  obsLimit: 5,
  probeLimit: 5,
  retroLimit: 3,
  eventLimit: 5,
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
  return `你是 \`js-evolution-agent\` 主体的情报员。请先研读以下三份文献的全文，然后用其中的视角、术语与方法，为本轮（cycle）写一份"修行札记"性质的 Markdown 报告。

形式完全自由：章节、文体、长度、详略由你决定——只要它对人类操作者可读、对主体的演化有用、忠于 Cyber-Taoist 进化学的立场。

基本约束（仅此而已）：
1. 输出纯 Markdown，不要在最外层用代码围栏包裹。
2. 不要捏造下方"本轮事实"中没有的 id、计数或事件。
3. 用中文写作。

=== 文献 1：Cyber-Taoist 宪章（CONSTITUTION.md，全文） ===
${constitution || '(missing)'}

=== 文献 2：Cyber-Taoist 应用指南（SKILL.md，全文） ===
${skill || '(missing)'}

=== 文献 3：本主体策略（active subject policy，全文） ===
${subject || '(missing)'}

=== 本轮事实（机器汇集，仅供参考，不必逐项罗列） ===
${contextJson}

请开始写你的札记。`;
}

function buildPromptEn({ constitution, skill, subject, contextJson }) {
  return `You are the intel writer for the \`js-evolution-agent\` subject. First, study the three documents below in full, then write a Markdown "practice journal" for this cycle using their lens, vocabulary, and methods.

Form is fully open — sections, voice, length, depth are yours. The only requirements are that it be readable to a human operator, useful to the subject's evolution, and faithful to the Cyber-Taoist evolutionary stance.

Hard constraints (these only):
1. Output pure Markdown; do not wrap the whole document in code fences.
2. Do not invent ids, counts, or events not present in "This cycle's facts" below.
3. Write in English.

=== Document 1: Cyber-Taoist Constitution (CONSTITUTION.md, full text) ===
${constitution || '(missing)'}

=== Document 2: Cyber-Taoist Skill Guide (SKILL.md, full text) ===
${skill || '(missing)'}

=== Document 3: Active Subject Policy (full text) ===
${subject || '(missing)'}

=== This cycle's facts (machine-collected, for reference) ===
${contextJson}

Now write the journal.`;
}

function buildAiContext({ intelResult, runtime, goals, evidence, assessment, generatedAt }) {
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

export function buildPrompt({ language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt }) {
  const constitutionDoc = pickDoc(agentContextDocs, 'cyber-taoist:constitution');
  const skillDoc = pickDoc(agentContextDocs, 'cyber-taoist:skill');
  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || pickDoc(agentContextDocs, 'subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);

  const contextJson = buildAiContext({ intelResult, runtime, goals, evidence, assessment, generatedAt });
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
      `**AI 生成失败，回退为占位札记**${reason ? `（原因：${reason}）` : ''}。下面只列出本轮的机器事实，未做哲学解读。`,
      `**AI generation failed; this is a placeholder journal**${reason ? ` (reason: ${reason})` : ''}. Only mechanical facts are listed below; no philosophical reading was performed.`,
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

async function tryAiRender({ aiClient, language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt, logger }) {
  if (!aiClient || typeof aiClient.chat !== 'function') {
    return { md: null, reason: 'no-ai-client' };
  }
  const prompt = buildPrompt({ language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt });
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
  if (!intelResult?.cycle_id) {
    throw new Error('buildIntelReport requires intelResult.cycle_id');
  }
  const generatedAt = new Date().toISOString();
  const cycleId = intelResult.cycle_id;
  const goals = flattenGoals(safeReadGoals(runtime));
  const evidence = gatherEvidence(store);
  const assessment = assessGoals(goals, evidence);

  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);
  const language = detectLanguage(subjectDoc?.text);

  let md = null;
  let source = 'fallback';
  let fallbackReason = null;
  if (useAi) {
    const { md: aiMd, reason } = await tryAiRender({
      aiClient, language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt, logger,
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
  if (!md) {
    md = renderFallbackMd({ intelResult, runtime, generatedAt, evidence, assessment, language, reason: fallbackReason });
  }

  const reportsDir = join(runtime.runtimeRoot, 'data', 'intelligence', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = join(reportsDir, `${cycleId}.md`);
  writeFileSync(mdPath, md, 'utf-8');

  const indexRecord = {
    cycle_id: cycleId,
    generated_at: generatedAt,
    md_path: mdPath,
    tldr: extractTldr(md),
    action_count: (intelResult.actions || []).length,
    evidence_obs_count: evidence.observations.length,
    evidence_probe_count: evidence.probes.length,
    evidence_retro_count: evidence.retrospectives.length,
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    language,
    source,
  };
  store.recordIntelReport(indexRecord);

  return { mdPath, indexRecord, source };
}
