import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildTemporalDecisionBrief } from '../decision-brief.mjs';
import { normalizeCurrentBeliefs } from '../beliefs.mjs';
import {
  markOperatorFactsInjected,
  migrateLegacyOperatorFacts,
  readPendingOperatorFacts,
  summarizeOperatorFactsForContext,
} from '../operator-facts.mjs';
import {
  readPendingOperatorQuestions,
  summarizeOperatorQuestionsForContext,
} from '../operator-questions.mjs';
import {
  resolveIntelReportRecordPath,
  resolveIntelReportWritePath,
} from '../report-paths.mjs';
import { redactSecrets } from '../redaction.mjs';
import { chatMessages } from '../../ai/messages.mjs';

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
  beliefEventLimit: 100,
  reportIndexLimit: 50,
  reportMarkdownLimit: 3,
  reportMarkdownCharLimit: 60000,
  standingMemoryCharLimit: 12000,
};

const STANDING_MEMORY_CANONICAL_PATH = 'data/intelligence/memory/standing_memory.json';

const STANDING_MEMORY_EVIDENCE_DEPTH_TARGET = 35;

const STANDING_MEMORY_LIMITS = {
  maxEvidenceItems: 50,
  maxCurrentStateItems: 5,
  maxRememberedLeads: 5,
  maxDoNotTreatAsSeenItems: 10,
};

const STANDING_MEMORY_SECTIONS = [
  'Current State',
  'Evidence',
  'Remembered',
  'Do Not Treat As Seen',
];

const STANDING_MEMORY_REMEMBERED_HINT = {
  en: '- Historical reports, beliefs, and diaries are continuity hints only. Reopen source records before treating them as Seen.',
  zh: '- 历史报告、信念与日记仅作连续性线索；重开源记录前不得当作 Seen 事实。',
};

const EVIDENCE_SECTION_POLLUTION_PATTERNS = [
  /\bagent_claim:/i,
  /remote\.matchCount/i,
  /remote_matchCount\s*=/i,
];

/** Patterns that make standing_memory narrative (free text) fail external clean audits. */
const FREE_TEXT_POLLUTION_PATTERNS = [
  /\.\.\.\(truncated\)/i,
  /…/,
  /\bfallba…/i,
  /\bagent_claim:/i,
  /\bfree_text_clean\b/i,
  /\bremote\.matchCount/i,
  /remote_matchCount\s*=/i,
];

const DO_NOT_TREAT_MAX_LINE_CHARS = 220;
/** Shared budget for Do Not Treat As Seen section (compose, sanitize, audit). */
export const DO_NOT_TREAT_SECTION_MAX_CHARS = 1200;

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

/** Hard-clip without ellipsis markers (avoids DNTAS audit false positives). */
function hardClipText(value, max = 200) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  // Prefer word/punctuation boundary when within the last 40 chars.
  const window = s.slice(0, max);
  const boundary = Math.max(
    window.lastIndexOf(' '),
    window.lastIndexOf('，'),
    window.lastIndexOf('。'),
    window.lastIndexOf(';'),
    window.lastIndexOf(','),
  );
  if (boundary >= max - 40 && boundary > 0) return window.slice(0, boundary).trimEnd();
  return window.trimEnd();
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

function readRecentReportMarkdowns(reportRecords, { runtimeRoot = null, limit, charLimit } = {}) {
  return asRecords(reportRecords)
    .slice(0, limit)
    .map((record) => {
      const mdPath = runtimeRoot
        ? resolveIntelReportRecordPath(runtimeRoot, record)
        : record?.md_path ?? null;
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
      resource_kind: 'standing_memory',
      resource_scope: 'subject_runtime',
      canonical_path: STANDING_MEMORY_CANONICAL_PATH,
      source_role: 'working_memory_index',
      path_policy: 'Only canonical_path is authoritative. ./standing_memory.json at the runtime root is not an alias.',
      updated_at: null,
      source_cycle_id: null,
      text: '(no standing memory yet)',
      evidence_refs: [],
    };
  }
  return {
    exists: true,
    resource_kind: 'standing_memory',
    resource_scope: 'subject_runtime',
    canonical_path: STANDING_MEMORY_CANONICAL_PATH,
    source_role: 'working_memory_index',
    path_policy: 'Only canonical_path is authoritative. ./standing_memory.json at the runtime root is not an alias.',
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
    current_beliefs: normalizeCurrentBeliefs(
      store?.readCurrentBeliefs ? safeRead(() => store.readCurrentBeliefs(), null) : null,
    ),
    belief_events: store?.readBeliefEvents
      ? safeRead(() => store.readBeliefEvents({ limit: limits.beliefEventLimit }), [])
      : [],
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
      runtimeRoot: runtime?.runtimeRoot ?? null,
      limit: limits.reportMarkdownLimit,
      charLimit: limits.reportMarkdownCharLimit,
    }),
    pending_operator_facts: [],
    injected_operator_fact_ids: [],
    operator_fact_migration: null,
    pending_operator_questions: [],
  };

  // Migrate legacy observation-store operator facts into pending/ (idempotent).
  if (runtime?.runtimeRoot) {
    const migration = migrateLegacyOperatorFacts(runtime.runtimeRoot, context.observations, { store });
    context.operator_fact_migration = {
      migrated: migration.migrated.length,
      skipped: migration.skipped.length,
      ids: migration.migrated.map((m) => m.id),
    };

    const pendingRead = readPendingOperatorFacts(runtime.runtimeRoot, { limit: 50 });
    const cycleId = intelResult?.cycle_id ?? null;
    // Mark as injected this cycle so Phase 3.5 digests only these seeds.
    // Facts already injected by a prior cycle stay pending until digested;
    // re-marking with the current cycle would incorrectly claim them as this cycle's.
    const toInject = pendingRead.facts.filter((f) => !f.injected_by_cycle);
    if (toInject.length && cycleId) {
      markOperatorFactsInjected(runtime.runtimeRoot, toInject, { cycleId });
    }
    // Re-read so injected_by_cycle is current.
    const refreshed = readPendingOperatorFacts(runtime.runtimeRoot, { limit: 50 });
    context.pending_operator_facts = summarizeOperatorFactsForContext(refreshed.facts);
    // All pending facts Seen this cycle; digestion covers any with injected_by_cycle
    // (including prior-cycle leftovers whose belief_update was skipped/failed).
    context.injected_operator_fact_ids = refreshed.facts
      .filter((f) => f.injected_by_cycle)
      .map((f) => f.id)
      .filter(Boolean);

    const questionsRead = readPendingOperatorQuestions(runtime.runtimeRoot, { limit: 20 });
    context.pending_operator_questions = summarizeOperatorQuestionsForContext(questionsRead.questions);
  }

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
    pending_operator_facts: context.pending_operator_facts.length,
    pending_operator_questions: context.pending_operator_questions.length,
    goal_events: context.goal_events.length,
    intel_reports_index: context.intel_reports_index.length,
    recent_report_markdowns: context.recent_report_markdowns.length,
    latest_review: context.latest_review ? 1 : 0,
    standing_memory: context.standing_memory.exists ? 1 : 0,
    current_beliefs: context.current_beliefs.exists ? context.current_beliefs.beliefs.length : 0,
    belief_events: context.belief_events.length,
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
 * Truncate at a sentence boundary when possible; otherwise hard-cut with ellipsis.
 * Never treat numbered-list markers (`1. `, `2. `) as English sentence ends.
 */
export function truncateAtSentence(text, maxChars = 400, minBoundary = 200) {
  const s = String(text ?? '').trim();
  if (s.length <= maxChars) return s;
  const window = s.slice(0, maxChars);
  let lastBoundary = -1;
  for (let i = 0; i < window.length; i += 1) {
    const ch = window[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '…' || ch === '!' || ch === '?') {
      lastBoundary = i + 1;
      continue;
    }
    if (ch !== '.') continue;
    const prev = i > 0 ? window[i - 1] : '';
    // Skip "1." / "2." list markers and digit-terminated versions like "v1.0 ".
    if (/\d/.test(prev)) continue;
    const after = window.slice(i + 1);
    if (!after) {
      lastBoundary = i + 1;
      continue;
    }
    if (!/^\s/.test(after)) continue;
    const rest = after.trimStart();
    // Accept ". " only when end-of-window or next token starts with uppercase (English sentence).
    if (!rest || /^[A-Z]/.test(rest)) {
      lastBoundary = i + 1;
    }
  }
  if (lastBoundary >= minBoundary) {
    return window.slice(0, lastBoundary).trim();
  }
  // Hard cut: drop a trailing numbered-list fragment before ellipsis.
  let hard = window.trimEnd().replace(/\s+\d+\.\s*$/, '').trimEnd();
  return `${hard}…`;
}

function isMarkdownListLine(line) {
  return /^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line);
}

function firstProseParagraphFromBody(body) {
  const prose = [];
  for (const line of String(body || '').split('\n')) {
    const t = line.trim();
    if (!t) {
      if (prose.length) break;
      continue;
    }
    if (t.startsWith('#') || isMarkdownListLine(t)) break;
    prose.push(t);
  }
  return prose.join(' ').trim();
}

function bulletSummaryFromBody(body, limit = 3) {
  const bullets = [];
  for (const line of String(body || '').split('\n')) {
    const t = line.trim();
    if (!isMarkdownListLine(t)) continue;
    bullets.push(t.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim());
    if (bullets.length >= limit) break;
  }
  return bullets.filter(Boolean).join('；');
}

/**
 * Best-effort tldr extraction for intel reports. Free-form reports may not have
 * a TL;DR section; in that case, take the first content lines (after optional top heading).
 */
export function extractTldr(md) {
  if (!md) return '';
  const m = md.match(/##\s*TL;?DR[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
  if (m) {
    return truncateAtSentence(m[1].trim().split('\n').filter(Boolean).slice(0, 5).join(' '), 400);
  }
  // Bold lead-in used by some agent_loop reports: **TL;DR**：...
  const bold = md.match(/^\s*\*\*TL;?DR\*\*\s*[:：]?\s*([^\n]+)/im);
  if (bold) {
    return truncateAtSentence(bold[1].trim(), 400);
  }
  const lines = md.split('\n');
  const collected = [];
  let pastTopHeading = false;
  let sawTopHeading = false;
  for (const ln of lines) {
    if (!pastTopHeading) {
      if (ln.startsWith('# ')) {
        pastTopHeading = true;
        sawTopHeading = true;
        continue;
      }
      // No H1: start collecting from the first non-empty prose line.
      if (!sawTopHeading && ln.trim()) {
        pastTopHeading = true;
      } else {
        continue;
      }
    }
    if (ln.startsWith('>') || ln.startsWith('#')) continue;
    const t = ln.trim();
    if (!t) {
      if (collected.length) break;
      continue;
    }
    if (/^\d+\.\s+/.test(t) || /^[-*]\s+/.test(t)) {
      if (collected.length) break;
      continue;
    }
    collected.push(t);
    if (collected.length >= 3) break;
  }
  return truncateAtSentence(collected.join(' '), 400);
}

/**
 * Diary-oriented tldr: prefer ## TL;DR, then "真正推进了什么" bullets,
 * then first prose paragraph of "这一轮发生了什么" (stop before lists).
 */
export function extractDiaryTldr(md) {
  if (!md) return '';

  const tldrBody = extractMarkdownSection(md, 'TL;DR') || extractMarkdownSection(md, 'TLDR');
  if (tldrBody) {
    const proseLines = tldrBody
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !isMarkdownListLine(line) && !line.startsWith('#'));
    const text = proseLines.length
      ? proseLines.slice(0, 5).join(' ')
      : tldrBody.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join(' ');
    return truncateAtSentence(text, 400);
  }

  const moved = extractMarkdownSection(md, '真正推进了什么')
    || extractMarkdownSection(md, 'What actually moved');
  if (moved) {
    const fromBullets = bulletSummaryFromBody(moved, 3);
    if (fromBullets) return truncateAtSentence(fromBullets, 400);
    const prose = firstProseParagraphFromBody(moved);
    if (prose) return truncateAtSentence(prose, 400);
  }

  const happened = extractMarkdownSection(md, '这一轮发生了什么')
    || extractMarkdownSection(md, 'What happened this cycle');
  if (happened) {
    const prose = firstProseParagraphFromBody(happened);
    if (prose) return truncateAtSentence(prose, 400);
  }

  const collected = [];
  let pastTopHeading = false;
  for (const ln of md.split('\n')) {
    if (!pastTopHeading) {
      if (ln.startsWith('# ')) pastTopHeading = true;
      continue;
    }
    if (ln.startsWith('>') || ln.startsWith('#')) continue;
    const t = ln.trim();
    if (!t) {
      if (collected.length) break;
      continue;
    }
    if (isMarkdownListLine(t)) break;
    collected.push(t);
    if (collected.length >= 3) break;
  }
  return truncateAtSentence(collected.join(' '), 400);
}

function pickDoc(docs, idPrefix) {
  if (!Array.isArray(docs)) return null;
  return docs.find((d) => typeof d?.id === 'string' && d.id.startsWith(idPrefix)) || null;
}

function buildPromptZh({ constitution, guide, subject, contextJson }) {
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
7. 没有 boundary 的缺失观察不得升级成全局不存在；没有 layer 的 action 结果不得升级成执行结论。

=== 文献 1：Cyber-Taoist 宪章（CONSTITUTION.md，全文） ===
${constitution || '(missing)'}

=== 文献 2：Cyber-Taoist 应用指南（GUIDE.md，全文） ===
${guide || '(missing)'}

=== 文献 3：本主体策略（active subject policy，全文） ===
${subject || '(missing)'}

=== 本轮事实与情报上下文（机器汇集，仅供参考，不必逐项罗列） ===
${contextJson}

请开始撰写报告。`;
}

function buildPromptEn({ constitution, guide, subject, contextJson }) {
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
7. Do not upgrade missing observations without boundary into global non-existence, and do not upgrade action results without layer metadata into execution conclusions.

=== Document 1: Cyber-Taoist Constitution (CONSTITUTION.md, full text) ===
${constitution || '(missing)'}

=== Document 2: Cyber-Taoist Application Guide (GUIDE.md, full text) ===
${guide || '(missing)'}

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
  const guideDoc = pickDoc(agentContextDocs, 'cyber-taoist:guide');
  const subjectDoc = pickDoc(agentContextDocs, 'js-evolution-agent:subject:')
    || pickDoc(agentContextDocs, 'subject:')
    || (Array.isArray(agentContextDocs) ? agentContextDocs.find((d) => d?.id?.includes(':subject:')) : null);

  const contextJson = buildAiContext({ intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext });
  const args = {
    constitution: constitutionDoc?.text,
    guide: guideDoc?.text,
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
  if (!aiClient || (typeof aiClient.chat !== 'function' && typeof aiClient.chatMessages !== 'function')) {
    return { md: null, reason: 'no-ai-client' };
  }
  const prompt = buildPrompt({ language, agentContextDocs, intelResult, runtime, goals, evidence, assessment, generatedAt, reportContext });
  try {
    const md = await chatMessages(aiClient, [{ role: 'user', content: prompt }]);
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

export function memorySourceType(sourceType) {
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

function hasStandingMemoryPollution(text) {
  const raw = String(text || '');
  return [
    ...FREE_TEXT_POLLUTION_PATTERNS,
    ...EVIDENCE_SECTION_POLLUTION_PATTERNS,
  ].some((pattern) => pattern.test(raw));
}

function summarizeEvidenceFields(fields = {}) {
  if (!fields || typeof fields !== 'object') return '';
  const keys = [
    'action_type',
    'type',
    'status',
    'success',
    'provider',
    'cycle_id',
    'confidence',
    'execution_status',
    'schema_status',
    'acceptance_status',
    'goal_progress_status',
    'writes_count',
  ];
  const compact = {};
  for (const key of keys) {
    if (fields[key] != null) compact[key] = fields[key];
  }
  return Object.keys(compact).length ? JSON.stringify(compact) : '';
}

function structuredEvidenceSummary(item) {
  const parts = [
    item?.kind ? `kind=${item.kind}` : null,
    item?.evidence_level ? `level=${item.evidence_level}` : null,
    item?.seen_policy ? `policy=${item.seen_policy}` : null,
    summarizeEvidenceFields(item?.fields),
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'structured evidence';
}

function summarizeSeenItem(item) {
  const rawSummary = String(item?.summary ?? '').trim();
  const fieldSummary = summarizeEvidenceFields(item?.fields);
  if (fieldSummary) return fieldSummary;
  if (rawSummary && !hasStandingMemoryPollution(rawSummary)) {
    return shortText(rawSummary, 180);
  }
  if (item?.summary) {
    return structuredEvidenceSummary(item);
  }
  if (item?.fields && typeof item.fields === 'object') {
    return structuredEvidenceSummary(item);
  }
  const raw = shortText(JSON.stringify(item ?? {}), 180);
  return hasStandingMemoryPollution(raw) ? structuredEvidenceSummary(item) : raw;
}

/** ASCII-only clip for machine index lines; never emits Unicode ellipsis. */
function clipAsciiIndex(value, max = 180) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function parseSourceStatementIndexSummary(summary, sourceType = null) {
  const text = String(summary || '').trim();
  const normalizedSource = memorySourceType(sourceType);
  const goalMatch = text.match(/^source claims:\s*(\S+)\s+(\S+)\s*:/i);
  if (goalMatch) {
    return `type=${goalMatch[1]} goal_id=${goalMatch[2]}`;
  }
  const recordsMatch = text.match(/^source records:\s*(\S+)\s+(\S+)\s*:/i);
  if (recordsMatch) {
    const first = recordsMatch[1];
    const second = recordsMatch[2];
    if (normalizedSource === 'belief_events' || /^belief-/i.test(second)) {
      return `change=${first} belief_id=${second}`;
    }
    if (normalizedSource === 'evolution_events') {
      return `type=${first} status=${second}`;
    }
    if (/^(assessment|refine|defer|keep|replace|completed|goal_event)$/i.test(first)) {
      return `type=${first} goal_id=${second}`;
    }
    return `type=${first} status=${second}`;
  }
  return null;
}

/**
 * Standing-memory Evidence index line: structured labels only, no narrative or Unicode ellipsis.
 */
export function summarizeEvidenceIndexItem(item) {
  const fieldSummary = summarizeEvidenceFields(item?.fields);
  if (fieldSummary) return fieldSummary;

  if (item?.kind === 'structured_status' || item?.evidence_level === 'structured_machine_record') {
    return structuredEvidenceSummary(item);
  }

  if (item?.evidence_level === 'source_statement') {
    const sourceType = item?.source?.source_type ?? item?.source_type ?? null;
    const parsed = parseSourceStatementIndexSummary(item?.summary, sourceType);
    if (parsed) return parsed;
    return structuredEvidenceSummary(item);
  }

  const rawSummary = String(item?.summary ?? '').trim();
  if (rawSummary && !hasStandingMemoryPollution(rawSummary) && rawSummary.length <= 180) {
    return rawSummary;
  }
  if (rawSummary) {
    const sourceType = item?.source?.source_type ?? item?.source_type ?? null;
    const parsed = parseSourceStatementIndexSummary(rawSummary, sourceType);
    if (parsed) return parsed;
  }

  return structuredEvidenceSummary(item);
}

function isMinimalSafeEvidenceItem(item) {
  if (summarizeEvidenceFields(item?.fields)) {
    const fieldSummary = summarizeEvidenceFields(item.fields);
    if (/\[[a-z_]+:[^\]]*$/im.test(fieldSummary) || hasStandingMemoryPollution(fieldSummary)) {
      return false;
    }
    return true;
  }
  if (item?.kind === 'structured_status') return true;
  if (item?.evidence_level === 'structured_machine_record') return true;
  const summary = summarizeEvidenceIndexItem(item);
  return Boolean(summary)
    && !/…/.test(summary)
    && !hasStandingMemoryPollution(summary)
    && !/\[[a-z_]+:[^\]]*$/im.test(summary);
}

export function buildMinimalSafeAdmission(admission) {
  const toIndexItem = (item) => ({
    ...item,
    source: item.source ?? { source_type: item.source_type, id: item.source_id },
    fields: item.fields ?? null,
  });
  return {
    ...admission,
    seen: (admission?.seen ?? [])
      .filter((item) => isMinimalSafeEvidenceItem(toIndexItem(item)))
      .map((item) => ({
        ...item,
        summary: summarizeEvidenceIndexItem(toIndexItem(item)),
      })),
  };
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

const REFUTED_REMEMBERED_PATTERNS = [
  /remote_matchCount\s*=\s*(?:847|4127)/i,
  /cycle3_pipeline_confidence\s*=\s*0\.72/i,
  /pipeline_score\s*=\s*0\.87/i,
  /sync_success_rate\s*=\s*0\.95/i,
  /login\s+deadlock/i,
  /worker\s+(?:is\s+)?(?:app-level\s+)?zombie/i,
  /skillType\s*=\s*freeze[\s\S]{0,120}(?:account|publish|publishing|channel|frozen|locked|unfreeze|冻结|账号|账户|发布通道|发布|解冻)/i,
  /(?:account|publish|publishing|channel|frozen|locked|unfreeze|冻结|账号|账户|发布通道|发布|解冻)[\s\S]{0,120}skillType\s*=\s*freeze/i,
  /(?:ENOENT|not\s+found|missing|does\s+not\s+exist|不存在|缺失)[\s\S]{0,160}(?:\.\/)?standing_memory\.json[\s\S]{0,160}(?:canonical|global|authoritative|memory\s+does\s+not\s+exist|不存在)/i,
  /(?:\.\/)?standing_memory\.json[\s\S]{0,160}(?:ENOENT|not\s+found|missing|does\s+not\s+exist|不存在|缺失)[\s\S]{0,160}(?:canonical|global|authoritative|memory\s+does\s+not\s+exist|不存在)/i,
];

function isRefutedRememberedClaim(item) {
  const summary = String(item?.summary ?? '');
  if (!summary.trim()) return false;
  return REFUTED_REMEMBERED_PATTERNS.some((pattern) => pattern.test(summary));
}

function isPathScopeMismatchRememberedClaim(item) {
  const summary = String(item?.summary ?? '');
  if (!summary.trim()) return false;
  const mentionsStandingMemory = /(?:^|[^\w/])(?:\.\/)?standing_memory\.json\b/i.test(summary);
  const mentionsCanonical = summary.includes(STANDING_MEMORY_CANONICAL_PATH);
  const mentionsMissing = /ENOENT|not\s+found|missing|does\s+not\s+exist|不存在|缺失/i.test(summary);
  return mentionsStandingMemory && !mentionsCanonical && mentionsMissing;
}

function normalizeRememberedItems(items) {
  const counts = new Map();
  const seenKeys = new Set();
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    const sourceType = item?.source?.source_type ?? null;
    if (sourceType === 'standing_memory') continue;
    if (isRefutedRememberedClaim(item)) continue;
    if (isPathScopeMismatchRememberedClaim(item)) continue;
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

export function buildMemoryAdmission(reportContext) {
  const brief = reportContext?.temporal_decision_brief ?? {};
  const seen = Array.isArray(brief.seen) ? brief.seen : [];
  const memorySeen = seen.filter((item) => {
    if (item?.evidence_level === 'agent_narrative') return false;
    if (
      item?.source?.source_type === 'goal_event'
      && item?.evidence_level === 'source_statement'
    ) {
      return false;
    }
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
    rule: 'Only memory_admission.seen may appear in the final Evidence section. Completed action_receipt structured status is Evidence; receipt summaries, messages, and agent claims are not Evidence. Evidence summaries are structured index labels only; source_statement narratives are not copied.',
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
      fields: item?.fields ?? null,
      summary: summarizeEvidenceIndexItem(item),
      seen_policy: item?.evidence_level === 'source_statement'
        ? 'source_statement_only'
        : 'direct_field_or_status',
    })).filter((item) => item.source_id),
    remembered: normalizeRememberedItems(rememberedCandidates)
      .slice(0, STANDING_MEMORY_LIMITS.maxRememberedLeads),
    do_not_treat_as_seen: (brief.do_not_treat_as_seen ?? [])
      .slice(0, STANDING_MEMORY_LIMITS.maxDoNotTreatAsSeenItems),
  };
}

function extractMarkdownSection(markdown, heading) {
  const text = String(markdown || '').trim();
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(
    `##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
    'i',
  );
  const match = text.match(sectionPattern);
  return match ? match[1].trim() : '';
}

function splitBulletItems(body) {
  const lines = String(body || '').split('\n');
  const bullets = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      if (current.length) bullets.push(current.join('\n').trim());
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) bullets.push(current.join('\n').trim());
  return bullets.filter(Boolean);
}

function limitBulletItems(body, maxItems) {
  const bullets = splitBulletItems(body);
  if (!bullets.length) return '- (none)';
  const kept = bullets.slice(0, maxItems);
  const omitted = bullets.length - kept.length;
  let result = kept.join('\n');
  if (omitted > 0) {
    result += `\n- (omitted ${omitted} items due to section budget)`;
  }
  return result;
}

function extractBracketAddresses(text) {
  const matches = String(text || '').match(/\[[a-z_]+:[^\]]+\]/gi) ?? [];
  return [...new Set(matches)];
}

function extractRawCurrentStateBody(aiText) {
  let body = extractMarkdownSection(aiText, 'Current State');
  if (!body) body = extractMarkdownSection(aiText, 'Inferred');
  if (!body) {
    const legacySeen = extractMarkdownSection(aiText, 'Seen');
    if (legacySeen && !legacySeen.includes('[')) body = legacySeen;
  }
  return body;
}

function bulletHasFreeTextPollution(text) {
  return FREE_TEXT_POLLUTION_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

/**
 * Keep only Current State bullets that cite allowed evidence addresses and pass free-text gates.
 */
export function sanitizeCurrentStateBody(body, allowedAddresses = []) {
  const allowed = new Set(Array.isArray(allowedAddresses) ? allowedAddresses : []);
  const bullets = splitBulletItems(body);
  const kept = bullets.filter((bullet) => {
    if (bulletHasFreeTextPollution(bullet)) return false;
    const addresses = extractBracketAddresses(bullet);
    if (!addresses.length) return false;
    return addresses.some((addr) => allowed.has(addr));
  });
  if (!kept.length) return '- (none)';
  return limitBulletItems(kept.join('\n'), STANDING_MEMORY_LIMITS.maxCurrentStateItems);
}

function extractCurrentStateBody(aiText, allowedAddresses = null) {
  const body = extractRawCurrentStateBody(aiText);
  if (allowedAddresses == null) {
    return limitBulletItems(body, STANDING_MEMORY_LIMITS.maxCurrentStateItems);
  }
  return sanitizeCurrentStateBody(body, allowedAddresses);
}

function buildEvidenceSectionBody(admission, { maxItems = STANDING_MEMORY_LIMITS.maxEvidenceItems } = {}) {
  const admitted = admission.seen.slice(0, maxItems);
  const omitted = admission.seen.length - admitted.length;
  if (!admitted.length) return '- (none)';
  let body = admitted
    .map((item) => `- ${item.source_address}: ${item.summary}`)
    .join('\n');
  if (omitted > 0) {
    body += `\n- (omitted ${omitted} evidence items due to section budget)`;
  }
  return body;
}

function buildEvidenceSection(reportContext) {
  return buildEvidenceSectionBody(buildMemoryAdmission(reportContext));
}

/** @deprecated Use buildEvidenceSection; kept for callers expecting Seen gate naming. */
export function buildSeenSection(reportContext) {
  return buildEvidenceSection(reportContext);
}

function buildRememberedSectionBody(admission, language = 'zh') {
  const hint = STANDING_MEMORY_REMEMBERED_HINT[language === 'en' ? 'en' : 'zh'];
  const leads = admission.remembered
    .slice(0, STANDING_MEMORY_LIMITS.maxRememberedLeads)
    .map((item) => `- ${item.source_address} (${item.remembered_policy})`);
  if (!leads.length) return hint;
  return [hint, ...leads].join('\n');
}

function buildRememberedSection(reportContext, language = 'zh') {
  return buildRememberedSectionBody(buildMemoryAdmission(reportContext), language);
}

function summarizeDoNotTreatItem(item) {
  const sourceId = item?.source?.id ?? item?.id ?? null;
  const sourceType = item?.source?.source_type ?? null;
  if (sourceType === 'standing_memory') {
    return `${sourceAddress({ sourceType, sourceId })}: prior-cycle working-memory narrative; reopen source before treating as fact`;
  }
  const summary = hardClipText(item?.summary ?? '', DO_NOT_TREAT_MAX_LINE_CHARS);
  if (sourceId && sourceType) {
    return `${sourceAddress({ sourceType, sourceId })}: ${summary}`;
  }
  return summary || '- (item)';
}

function buildDoNotTreatAsSeenSectionBody(admission) {
  const items = admission.do_not_treat_as_seen.slice(0, STANDING_MEMORY_LIMITS.maxDoNotTreatAsSeenItems);
  if (!items.length) return '- (none)';
  const kept = [];
  let size = 0;
  for (const item of items) {
    const line = `- ${summarizeDoNotTreatItem(item)}`;
    const nextSize = size + line.length + (kept.length ? 1 : 0);
    if (nextSize > DO_NOT_TREAT_SECTION_MAX_CHARS) break;
    kept.push(line);
    size = nextSize;
  }
  return kept.length ? kept.join('\n') : '- (none)';
}

function buildDoNotTreatAsSeenSection(reportContext) {
  return buildDoNotTreatAsSeenSectionBody(buildMemoryAdmission(reportContext));
}

export function buildTypedEvidenceRefsFromAdmission(admission) {
  return admission.seen
    .slice(0, STANDING_MEMORY_LIMITS.maxEvidenceItems)
    .map((fact) => ({
      source_type: memorySourceType(fact.source_type),
      source_id: fact.source_id,
      source_address: fact.source_address,
    }))
    .filter((ref) => ref.source_id);
}

function buildTypedEvidenceRefs(reportContext) {
  return buildTypedEvidenceRefsFromAdmission(buildMemoryAdmission(reportContext));
}

const BACKFILL_SOURCE_MAP = {
  action_receipts: { field: 'action_receipts', sourceType: 'action_receipts' },
  belief_events: { field: 'belief_events', sourceType: 'belief_event' },
  goal_events: { field: 'goal_events', sourceType: 'goal_events' },
  evolution_events: { field: 'evolution_events', sourceType: 'evolution_events' },
};

function typedEvidenceRefKey(ref) {
  return `${memorySourceType(ref?.source_type)}:${ref?.source_id ?? ''}`;
}

export function readReportBuilderConfig(runtimeRoot) {
  if (!runtimeRoot) return null;
  const configPath = join(runtimeRoot, 'data', 'config', 'report_builder.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

function recordTimestamp(record) {
  return record?.recorded_at ?? record?.generated_at ?? record?.timestamp ?? record?.created_at ?? '';
}

function summarizeBackfillRecord(sourceType, record) {
  if (sourceType === 'action_receipts') {
    return summarizeEvidenceIndexItem({
      kind: 'structured_status',
      evidence_level: 'structured_machine_record',
      fields: {
        action_type: record?.action_type ?? record?.type ?? record?.action?.type ?? null,
        status: record?.status ?? record?.result?.status ?? null,
        success: record?.success ?? record?.result?.success ?? null,
      },
      source: { source_type: 'action_receipt' },
    });
  }
  if (sourceType === 'belief_events') {
    return summarizeEvidenceIndexItem({
      evidence_level: 'source_statement',
      summary: `source records: ${record?.change ?? 'update'} ${record?.belief_id ?? ''}: ${record?.reason ?? ''}`,
      source: { source_type: 'belief_event' },
    });
  }
  if (sourceType === 'goal_events') {
    return summarizeEvidenceIndexItem({
      evidence_level: 'source_statement',
      summary: `source claims: ${record?.type ?? 'goal_event'} ${record?.goal_id ?? ''}: ${record?.reason ?? ''}`,
      source: { source_type: 'goal_event' },
    });
  }
  if (sourceType === 'evolution_events') {
    const eventStatus = `${record?.type ?? 'event'} ${record?.status ?? ''}`.trim();
    const statement = record?.summary ?? record?.tldr ?? '';
    return summarizeEvidenceIndexItem({
      evidence_level: 'source_statement',
      summary: statement
        ? `source records: ${eventStatus}: ${statement}`
        : `source records: ${eventStatus}:`,
      source: { source_type: 'evolution_event' },
    });
  }
  return summarizeEvidenceIndexItem({
    evidence_level: 'structured_machine_record',
    summary: clipAsciiIndex(JSON.stringify(record ?? {}), 180),
  });
}

function lookupRecordSummary(reportContext, ref) {
  const sourceType = memorySourceType(ref.source_type);
  const collections = {
    evolution_events: reportContext?.evolution_events,
    goal_events: reportContext?.goal_events,
    action_receipts: reportContext?.action_receipts,
    belief_events: reportContext?.belief_events,
  };
  const records = asRecords(collections[sourceType]);
  const record = records.find((item) => (item?.id ?? item?.receipt_id) === ref.source_id);
  if (!record) return summarizeBackfillRecord(sourceType, { summary: `backfill preserved: ${ref.source_address}` });
  return summarizeBackfillRecord(sourceType, record);
}

function collectBackfillCandidates(reportContext, sourceNames, excludeKeys) {
  const candidates = [];
  for (const sourceName of sourceNames) {
    const mapping = BACKFILL_SOURCE_MAP[sourceName];
    if (!mapping) continue;
    const records = [...asRecords(reportContext?.[mapping.field])].sort((a, b) => (
      String(recordTimestamp(b)).localeCompare(String(recordTimestamp(a)))
    ));
    for (const record of records) {
      const sourceId = record?.id ?? record?.receipt_id ?? null;
      if (!sourceId) continue;
      const key = typedEvidenceRefKey({ source_type: mapping.sourceType, source_id: sourceId });
      if (excludeKeys.has(key)) continue;
      candidates.push({
        source_type: mapping.sourceType,
        source_id: sourceId,
        source_address: sourceAddress({ sourceType: mapping.sourceType, sourceId }),
        record,
      });
      excludeKeys.add(key);
    }
  }
  return candidates;
}

function buildAdmissionSeenItem(ref, reportContext, admissionSeenByKey) {
  const key = typedEvidenceRefKey(ref);
  const existing = admissionSeenByKey.get(key);
  if (existing) return existing;
  return {
    source_id: ref.source_id,
    source_type: ref.source_type,
    source_address: ref.source_address,
    recorded_at: null,
    kind: ref._backfill ? 'backfill' : null,
    evidence_level: ref._backfill ? 'backfill_preserved' : null,
    summary: lookupRecordSummary(reportContext, ref),
    seen_policy: ref._backfill ? 'backfill_preserved' : 'direct_field_or_status',
  };
}

export function buildExtendedMemoryAdmission(admission, typedEvidenceRefs, reportContext) {
  const admissionSeenByKey = new Map(
    admission.seen.map((item) => [
      typedEvidenceRefKey({ source_type: item.source_type, source_id: item.source_id }),
      item,
    ]),
  );
  return {
    ...admission,
    seen: typedEvidenceRefs.map((ref) => buildAdmissionSeenItem(ref, reportContext, admissionSeenByKey)),
  };
}

export function applyRollingTypedEvidenceRefs({
  cycleRefs = [],
  oldMemory = null,
  reportContext = null,
  currentStateBody = '',
  config = {},
} = {}) {
  const minRefs = config.min_typed_evidence_refs ?? STANDING_MEMORY_EVIDENCE_DEPTH_TARGET;
  const maxRefs = config.max_typed_evidence_refs ?? STANDING_MEMORY_LIMITS.maxEvidenceItems;
  const backfillSources = Array.isArray(config.on_roll_backfill_from) ? config.on_roll_backfill_from : [];
  const referencedInState = new Set(extractBracketAddresses(currentStateBody));
  const rememberedAddresses = new Set(
    config.preserve_remembered_leads
      ? [
        ...extractBracketAddresses(extractMarkdownSection(oldMemory?.text ?? '', 'Remembered')),
        ...(reportContext ? buildMemoryAdmission(reportContext).remembered.map((item) => item.source_address) : []),
      ]
      : [],
  );

  const oldRefs = Array.isArray(oldMemory?.typed_evidence_refs) ? oldMemory.typed_evidence_refs : [];
  const oldOrder = oldRefs.map((ref) => typedEvidenceRefKey(ref));
  const merged = new Map();

  for (const ref of cycleRefs) {
    merged.set(typedEvidenceRefKey(ref), { ...ref });
  }

  // Locked (incl. prior backfill) refs only pad depth; once organic cycle refs
  // already meet minRefs, do not keep them forever pinning preservation.
  for (const ref of oldRefs) {
    if (merged.size >= minRefs) break;
    const key = typedEvidenceRefKey(ref);
    if (ref._locked === true && !merged.has(key)) {
      merged.set(key, { ...ref });
    }
  }

  if (config.preserve_referenced_in_current_state) {
    for (const ref of oldRefs) {
      const key = typedEvidenceRefKey(ref);
      if (referencedInState.has(ref.source_address) && !merged.has(key)) {
        merged.set(key, { ...ref });
      }
    }
  }

  if (config.preserve_remembered_leads) {
    for (const ref of oldRefs) {
      const key = typedEvidenceRefKey(ref);
      if (rememberedAddresses.has(ref.source_address) && !merged.has(key)) {
        merged.set(key, { ...ref });
      }
    }
  }

  if (config.backfill_when_below_min && merged.size < minRefs) {
    const excludeKeys = new Set([...merged.keys()]);
    const candidates = collectBackfillCandidates(reportContext, backfillSources, excludeKeys);
    for (const candidate of candidates) {
      if (merged.size >= minRefs) break;
      merged.set(typedEvidenceRefKey(candidate), {
        source_type: candidate.source_type,
        source_id: candidate.source_id,
        source_address: candidate.source_address,
        _locked: true,
        _backfill: true,
      });
    }
  }

  const evictable = () => [...merged.entries()].filter(([key, ref]) => {
    if (ref._locked === true) return false;
    if (config.preserve_referenced_in_current_state && referencedInState.has(ref.source_address)) return false;
    if (config.preserve_remembered_leads && rememberedAddresses.has(ref.source_address)) return false;
    return true;
  });

  while (merged.size > maxRefs && config.eviction_policy === 'drop_oldest_unlinked') {
    const candidates = evictable();
    if (!candidates.length) break;
    const oldestKey = candidates.sort((a, b) => {
      const ai = oldOrder.indexOf(a[0]);
      const bi = oldOrder.indexOf(b[0]);
      const aRank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bRank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      return aRank - bRank;
    })[0]?.[0];
    if (!oldestKey) break;
    merged.delete(oldestKey);
  }

  const orderedKeys = [
    ...cycleRefs.map((ref) => typedEvidenceRefKey(ref)),
    ...oldOrder.filter((key) => merged.has(key) && !cycleRefs.some((ref) => typedEvidenceRefKey(ref) === key)),
    ...[...merged.keys()].filter((key) => !oldOrder.includes(key) && !cycleRefs.some((ref) => typedEvidenceRefKey(ref) === key)),
  ];
  const seenKeys = new Set();
  const result = [];
  for (const key of orderedKeys) {
    if (seenKeys.has(key) || !merged.has(key)) continue;
    seenKeys.add(key);
    result.push(merged.get(key));
  }
  for (const [key, ref] of merged.entries()) {
    if (!seenKeys.has(key)) result.push(ref);
  }
  return result.slice(0, maxRefs);
}

export function composeStandingMemoryMarkdown({
  currentStateBody,
  reportContext,
  language = 'zh',
  admission = null,
} = {}) {
  const resolvedAdmission = admission ?? buildMemoryAdmission(reportContext);
  const sections = [
    ['Current State', limitBulletItems(currentStateBody, STANDING_MEMORY_LIMITS.maxCurrentStateItems)],
    ['Evidence', buildEvidenceSectionBody(resolvedAdmission)],
    ['Remembered', buildRememberedSectionBody(resolvedAdmission, language)],
    ['Do Not Treat As Seen', buildDoNotTreatAsSeenSectionBody(resolvedAdmission)],
  ];
  return sections.map(([heading, body]) => `## ${heading}\n\n${body.trim()}`).join('\n\n').trim();
}

/**
 * Cosmetic cleanup before standing-memory audit:
 * - replace unicode ellipsis glyphs with ASCII "..."
 * - trim oversized Do Not Treat As Seen section at bullet boundaries
 * Does not touch substantive pollution / unlinked / agent_claim gates.
 */
export function sanitizeStandingMemoryCosmeticIssues(text) {
  let body = String(text || '').replace(/\u2026/g, '...');
  const heading = 'Do Not Treat As Seen';
  const sectionBody = extractMarkdownSection(body, heading);
  if (sectionBody && sectionBody.length > DO_NOT_TREAT_SECTION_MAX_CHARS) {
    const bullets = splitBulletItems(sectionBody);
    const kept = [];
    let size = 0;
    for (const bullet of bullets) {
      const nextSize = size + bullet.length + (kept.length ? 1 : 0);
      if (nextSize > DO_NOT_TREAT_SECTION_MAX_CHARS) break;
      kept.push(bullet);
      size = nextSize;
    }
    const trimmedBody = kept.length ? kept.join('\n') : '- (none)';
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(
      `(##\\s+${escaped}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s+|$)`,
      'i',
    );
    body = body.replace(sectionPattern, `$1${trimmedBody}\n`);
  }
  return body.trim();
}

export function auditStandingMemoryFreeText({
  text,
  typedEvidenceRefs = [],
  admission = null,
} = {}) {
  const issues = [];
  const body = String(text || '');
  const refAddresses = new Set(
    typedEvidenceRefs.map((ref) => ref.source_address).filter(Boolean),
  );
  const admittedRemembered = new Set(
    (admission?.remembered ?? []).map((item) => item.source_address).filter(Boolean),
  );

  const currentStateText = extractMarkdownSection(body, 'Current State');
  const evidenceText = extractMarkdownSection(body, 'Evidence');
  const rememberedText = extractMarkdownSection(body, 'Remembered');
  const doNotTreatText = extractMarkdownSection(body, 'Do Not Treat As Seen');

  for (const [sectionName, sectionText] of [
    ['current_state', currentStateText],
    ['remembered', rememberedText],
    ['do_not_treat', doNotTreatText],
  ]) {
    if (/\.\.\.\(truncated\)/i.test(sectionText)) {
      issues.push(`${sectionName}:truncated_marker`);
    }
    if (/…/.test(sectionText)) issues.push(`${sectionName}:unicode_ellipsis`);
    if (/\bfallba…/i.test(sectionText)) issues.push(`${sectionName}:partial_truncation`);
    if (sectionName === 'current_state' && /\bagent_claim:/i.test(sectionText)) {
      issues.push(`${sectionName}:agent_claim_prefix`);
    }
    if (sectionName === 'current_state' && hasStandingMemoryPollution(sectionText)) {
      issues.push(`${sectionName}:pollution`);
    }
    const openBracket = (sectionText.match(/\[[a-z_]+:[^\]]*$/im) ?? []).length;
    if (openBracket > 0) issues.push(`${sectionName}:incomplete_source_address`);
  }

  {
    const openBracket = (evidenceText.match(/\[[a-z_]+:[^\]]*$/im) ?? []).length;
    if (openBracket > 0) issues.push('evidence:incomplete_source_address');
  }

  if (/##\s+Current State/i.test(doNotTreatText)) {
    issues.push('do_not_treat:standing_memory_body_embedded');
  }
  if (doNotTreatText.length > DO_NOT_TREAT_SECTION_MAX_CHARS) {
    issues.push('do_not_treat:section_too_long');
  }

  for (const bullet of splitBulletItems(currentStateText)) {
    if (bullet === '- (none)' || /\(omitted \d+ items/.test(bullet)) continue;
    if (bulletHasFreeTextPollution(bullet)) issues.push('current_state:pollution');
    const addresses = extractBracketAddresses(bullet);
    if (!addresses.some((addr) => refAddresses.has(addr))) {
      issues.push('current_state:unlinked_bullet');
    }
  }

  for (const addr of extractBracketAddresses(rememberedText)) {
    if (!refAddresses.has(addr) && !admittedRemembered.has(addr)) {
      issues.push(`remembered:orphan_address:${addr}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

export function auditStandingMemoryMarkdown({
  text,
  typedEvidenceRefs = [],
  admission = null,
} = {}) {
  const issues = [];
  const body = String(text || '');

  if (/\.\.\.\(truncated\)/i.test(body)) issues.push('truncated_marker');

  for (const heading of STANDING_MEMORY_SECTIONS) {
    if (!new RegExp(`##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)) {
      issues.push(`missing_section:${heading}`);
    }
  }

  const evidenceText = extractMarkdownSection(body, 'Evidence');
  const evidenceAddresses = extractBracketAddresses(evidenceText);
  const refAddresses = typedEvidenceRefs.map((ref) => ref.source_address).filter(Boolean);

  if (evidenceAddresses.length !== refAddresses.length) {
    issues.push('evidence_count_mismatch');
  }
  for (const addr of refAddresses) {
    if (!evidenceAddresses.includes(addr)) issues.push(`ref_missing_in_evidence:${addr}`);
  }

  const openBracket = (evidenceText.match(/\[[a-z_]+:[^\]]*$/im) ?? []).length;
  if (openBracket > 0) issues.push('incomplete_source_address');

  for (const pattern of EVIDENCE_SECTION_POLLUTION_PATTERNS) {
    if (pattern.test(evidenceText)) issues.push(`evidence_pollution:${pattern}`);
  }

  const freeTextAudit = auditStandingMemoryFreeText({ text, typedEvidenceRefs, admission });
  if (!freeTextAudit.ok) {
    for (const issue of freeTextAudit.issues) issues.push(`free_text:${issue}`);
  }

  return { ok: issues.length === 0, issues };
}

export function buildFallbackStandingMemoryMarkdown({ reportContext, language = 'zh' } = {}) {
  return composeStandingMemoryMarkdown({
    currentStateBody: '- (none)',
    reportContext,
    language,
  });
}

export function hasLockedEvidenceRefs(refs = []) {
  return (Array.isArray(refs) ? refs : []).some((ref) => ref._locked === true);
}

/** When locked refs exist, keep narrative sections from a prior clean memory and refresh Evidence only. */
export function mergePreservedNarrativeWithUpdatedEvidence({
  oldText,
  typedEvidenceRefs = [],
  admission = null,
  language = 'zh',
  allowedAddresses = null,
} = {}) {
  const rawCurrentState = extractMarkdownSection(oldText, 'Current State');
  const currentStateBody = allowedAddresses != null
    ? sanitizeCurrentStateBody(rawCurrentState, allowedAddresses)
    : limitBulletItems(rawCurrentState, STANDING_MEMORY_LIMITS.maxCurrentStateItems);
  const rememberedBody = extractMarkdownSection(oldText, 'Remembered');
  const doNotTreatBody = extractMarkdownSection(oldText, 'Do Not Treat As Seen');
  const evidenceBody = admission
    ? buildEvidenceSectionBody(admission)
    : typedEvidenceRefs.map((ref) => `- ${ref.source_address}`).join('\n') || '- (none)';
  const sections = [
    ['Current State', currentStateBody || '- (none)'],
    ['Evidence', evidenceBody],
    ['Remembered', rememberedBody || STANDING_MEMORY_REMEMBERED_HINT[language === 'en' ? 'en' : 'zh']],
    ['Do Not Treat As Seen', doNotTreatBody || '- (none)'],
  ];
  return sections.map(([heading, body]) => `## ${heading}\n\n${body.trim()}`).join('\n\n').trim();
}

/**
 * Rescue prior clean narrative sections when the primary (new) candidate fails
 * audit. Locked/backfill refs never trigger preservation by themselves — they
 * only pad Evidence depth. Prefer the caller's full primary `audit`; fall back
 * to free-text audit when audit is omitted. Merges old narrative-referenced
 * refs into the rolling set so preserved Current State stays linked.
 */
export function applyLockedNarrativePreservation({
  text,
  audit,
  oldMemory,
  typedEvidenceRefs,
  extendedAdmission,
  language,
  reportContext = null,
} = {}) {
  const passthrough = {
    text,
    audit,
    typed_evidence_refs: typedEvidenceRefs,
    admission: extendedAdmission,
    narrative_preserved: false,
  };
  if (!oldMemory?.text) return passthrough;

  const oldFreeTextAudit = auditStandingMemoryFreeText({
    text: oldMemory.text,
    typedEvidenceRefs: oldMemory.typed_evidence_refs ?? [],
  });
  if (!oldFreeTextAudit.ok) return passthrough;

  // Rescue-only: preserve when primary fails. Prefer caller's full audit.
  const primaryOk = audit && typeof audit === 'object' && 'ok' in audit
    ? audit.ok === true
    : auditStandingMemoryFreeText({
      text,
      typedEvidenceRefs,
      admission: extendedAdmission,
    }).ok;
  if (primaryOk) return passthrough;

  const oldNarrativeText = [
    extractMarkdownSection(oldMemory.text, 'Current State'),
    extractMarkdownSection(oldMemory.text, 'Remembered'),
  ].join('\n');
  const referencedAddresses = new Set(extractBracketAddresses(oldNarrativeText));
  const oldRefs = Array.isArray(oldMemory.typed_evidence_refs) ? oldMemory.typed_evidence_refs : [];
  const preservedMap = new Map(
    (Array.isArray(typedEvidenceRefs) ? typedEvidenceRefs : []).map((ref) => [
      typedEvidenceRefKey(ref),
      { ...ref },
    ]),
  );
  for (const ref of oldRefs) {
    if (!referencedAddresses.has(ref.source_address)) continue;
    const key = typedEvidenceRefKey(ref);
    if (!preservedMap.has(key)) {
      preservedMap.set(key, { ...ref });
    }
  }
  const preservedRefs = [...preservedMap.values()];
  const baseAdmission = extendedAdmission
    ?? (reportContext ? buildMemoryAdmission(reportContext) : { seen: [], remembered: [], do_not_treat_as_seen: [] });
  const preservedAdmission = buildExtendedMemoryAdmission(baseAdmission, preservedRefs, reportContext);
  const allowedAddresses = preservedRefs.map((ref) => ref.source_address).filter(Boolean);
  let preservedText = mergePreservedNarrativeWithUpdatedEvidence({
    oldText: oldMemory.text,
    typedEvidenceRefs: preservedRefs,
    admission: preservedAdmission,
    language,
    allowedAddresses,
  });
  preservedText = sanitizeStandingMemoryCosmeticIssues(preservedText);
  const preservedAudit = auditStandingMemoryMarkdown({
    text: preservedText,
    typedEvidenceRefs: preservedRefs,
    admission: preservedAdmission,
  });
  return {
    text: preservedText,
    audit: preservedAudit,
    typed_evidence_refs: preservedRefs,
    admission: preservedAdmission,
    narrative_preserved: true,
  };
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

export function enforceStandingMemoryEvidenceGate(text, reportContext) {
  return replaceMarkdownSection(text, 'Evidence', buildEvidenceSection(reportContext));
}

/**
 * Host-owned Seen splice for agent_loop reports.
 * Replaces the first matching Seen/Evidence/本轮看到 section body; inserts ## Seen if none exist.
 */
export function enforceIntelReportSeenGate(markdown, seenBody) {
  const body = String(seenBody || '').trim() || '- (none)';
  const text = String(markdown || '');
  for (const heading of ['Seen', 'Evidence', '本轮看到']) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sectionPattern = new RegExp(
      `(^|\\n)##\\s+${escaped}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`,
      'i',
    );
    if (sectionPattern.test(text)) {
      return replaceMarkdownSection(text, heading, body);
    }
  }
  return `## Seen\n\n${body}\n\n${text}`.trim();
}

/** @deprecated Use enforceStandingMemoryEvidenceGate */
export function enforceStandingMemorySeenGate(text, reportContext) {
  let updated = replaceMarkdownSection(text, 'Evidence', buildEvidenceSection(reportContext));
  if (/##\s+Seen\b/i.test(updated)) {
    updated = replaceMarkdownSection(updated, 'Seen', buildEvidenceSection(reportContext));
  }
  return updated;
}

export function enforceStandingMemoryRememberedGate(text, reportContext, language = 'zh') {
  return replaceMarkdownSection(text, 'Remembered', buildRememberedSection(reportContext, language));
}

export function enforceStandingMemoryGates(text, reportContext, language = 'zh') {
  const currentState = extractCurrentStateBody(text);
  return composeStandingMemoryMarkdown({
    currentStateBody: currentState,
    reportContext,
    language,
  });
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
    return `You maintain the short Markdown standing memory index for js-evolution-agent.

This is not an intelligence report. Write only the Current State section.

Rules:
- Return only Markdown for "## Current State". No code fences. No other sections.
- Keep Current State under ${maxChars} characters and at most ${STANDING_MEMORY_LIMITS.maxCurrentStateItems} bullet items.
- Each bullet must cite at least one Evidence source address from Machine Context memory_admission.seen, for example [evolution_events:evt-...] or [action_receipts:receipt-...].
- Current State is judgement only. Do not restate receipt summaries, agent claims, or historical report prose.
- Evidence, Remembered, and Do Not Treat As Seen will be rewritten by code after your output.
- Do not copy old Standing Memory bullets unless still supported by current admission.
- Carry forward long-lived constraints and metric directions from old Current State when they remain true and are still supported by current admission; do not keep judgements overturned by this cycle's facts.
- State what would overturn each judgement.

=== Previous Standing Memory ===
${oldMemory?.text || '(none)'}

=== New Cycle Report ===
${reportMarkdown}

=== Machine Context ===
${contextJson}`;
  }

  return `你维护 js-evolution-agent 的短 Markdown standing memory 索引。

这不是情报报告。你只写 Current State 小节。

规则：
- 只返回 "## Current State" 的 Markdown 正文，不要代码围栏，不要写其他小节。
- Current State 控制在 ${maxChars} 字符以内，最多 ${STANDING_MEMORY_LIMITS.maxCurrentStateItems} 条 bullet。
- 每条 bullet 必须引用机器上下文 memory_admission.seen 中的至少一个 Evidence 地址，例如 [evolution_events:evt-...] 或 [action_receipts:receipt-...]。
- Current State 只写判断，不要复述 receipt summary、agent claim 或历史报告正文。
- Evidence、Remembered、Do Not Treat As Seen 会由代码在你输出后重写。
- 不要复制旧 Standing Memory 中未被当前 admission 支持的 bullet。
- 旧 Current State 中仍成立、且被当前 admission 支持的长期约束/指标方向应带入新版本；被本轮事实推翻的旧判断不得保留。
- 每条判断应写明什么证据会推翻它。

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
  runtimeRoot = null,
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
    const admission = buildMemoryAdmission(reportContext);
    const cycleRefs = buildTypedEvidenceRefsFromAdmission(admission);
    const oldMemory = safeRead(() => store.readStandingMemory(), null);
    const rollingConfig = readReportBuilderConfig(runtimeRoot)?.rolling_update ?? null;
    const raw = await chatMessages(aiClient, [{ role: 'user', content: prompt }]);
    const aiBody = stripCodeFence(raw);
    const rawCurrentStateBody = extractCurrentStateBody(aiBody);
    let typedEvidenceRefs = rollingConfig
      ? applyRollingTypedEvidenceRefs({
        cycleRefs,
        oldMemory,
        reportContext,
        currentStateBody: rawCurrentStateBody,
        config: rollingConfig,
      })
      : cycleRefs;
    const allowedAddresses = typedEvidenceRefs.map((ref) => ref.source_address).filter(Boolean);
    const currentStateBody = sanitizeCurrentStateBody(rawCurrentStateBody, allowedAddresses);
    const extendedAdmission = rollingConfig
      ? buildExtendedMemoryAdmission(admission, typedEvidenceRefs, reportContext)
      : admission;
    let text = composeStandingMemoryMarkdown({
      currentStateBody,
      reportContext,
      language,
      admission: extendedAdmission,
    });
    text = sanitizeStandingMemoryCosmeticIssues(text);
    let audit = auditStandingMemoryMarkdown({
      text,
      typedEvidenceRefs,
      admission: extendedAdmission,
    });
    const primaryText = text;
    const primaryAudit = audit;
    const primaryRefs = typedEvidenceRefs;
    const primaryAdmission = extendedAdmission;
    const primaryIssues = Array.isArray(primaryAudit.issues) ? [...primaryAudit.issues] : [];

    let usedFallback = false;
    let fallbackReason = null;
    let fallbackIssues = [];
    let preservedIssues = [];
    let narrativePreserved = false;
    let finalCandidate = 'primary';

    const applyMinimalFallback = (reason) => {
      const minimalAdmission = buildMinimalSafeAdmission(primaryAdmission);
      const minimalRefs = buildTypedEvidenceRefsFromAdmission(minimalAdmission);
      text = composeStandingMemoryMarkdown({
        currentStateBody: '- (none)',
        reportContext,
        language,
        admission: minimalAdmission,
      });
      text = sanitizeStandingMemoryCosmeticIssues(text);
      audit = auditStandingMemoryMarkdown({
        text,
        typedEvidenceRefs: minimalRefs,
        admission: minimalAdmission,
      });
      typedEvidenceRefs = minimalRefs;
      usedFallback = true;
      fallbackReason = reason;
      narrativePreserved = false;
      finalCandidate = 'minimal_fallback';
      if (!audit.ok) {
        fallbackIssues = Array.isArray(audit.issues) ? [...audit.issues] : [];
      }
    };

    // Ladder: primary (if clean) → preserved rescue → minimal_fallback.
    // Locked refs never veto a clean primary.
    if (primaryAudit.ok) {
      text = primaryText;
      audit = primaryAudit;
      typedEvidenceRefs = primaryRefs;
      narrativePreserved = false;
      finalCandidate = 'primary';
    } else {
      const preservation = applyLockedNarrativePreservation({
        text: primaryText,
        audit: primaryAudit,
        oldMemory,
        typedEvidenceRefs: primaryRefs,
        extendedAdmission: primaryAdmission,
        language,
        reportContext,
      });
      if (preservation.narrative_preserved === true) {
        preservedIssues = Array.isArray(preservation.audit?.issues)
          ? [...preservation.audit.issues]
          : [];
        if (preservation.audit?.ok) {
          text = preservation.text;
          audit = preservation.audit;
          typedEvidenceRefs = preservation.typed_evidence_refs;
          narrativePreserved = true;
          finalCandidate = 'preserved';
        } else {
          applyMinimalFallback('primary_and_preserved_audit_failed');
        }
      } else {
        applyMinimalFallback('primary_audit_failed');
      }
    }

    // Invariant: fallback never claims narrative was preserved.
    if (usedFallback) narrativePreserved = false;

    if (!text.trim()) {
      const failed = {
        status: 'failed',
        reason: 'empty-output',
        primary_issues: primaryIssues,
        preserved_issues: preservedIssues,
        fallback_issues: fallbackIssues,
        used_fallback: usedFallback,
        narrative_preserved: narrativePreserved,
        final_candidate: finalCandidate,
      };
      emitStandingMemoryUpdateEvent(store, { cycleId, result: failed });
      return failed;
    }
    if (!audit.ok) {
      const reasonParts = [];
      if (primaryIssues.length) reasonParts.push(`primary:${primaryIssues.join(',')}`);
      if (preservedIssues.length) reasonParts.push(`preserved:${preservedIssues.join(',')}`);
      if (fallbackIssues.length) reasonParts.push(`fallback:${fallbackIssues.join(',')}`);
      if (!reasonParts.length) reasonParts.push(`audit-failed:${audit.issues.join(',')}`);
      const failed = {
        status: 'failed',
        reason: reasonParts.join('; '),
        audit,
        primary_issues: primaryIssues,
        preserved_issues: preservedIssues,
        fallback_issues: fallbackIssues,
        used_fallback: usedFallback,
        narrative_preserved: narrativePreserved,
        final_candidate: finalCandidate,
      };
      emitStandingMemoryUpdateEvent(store, { cycleId, result: failed });
      return failed;
    }

    const lockedRefsCount = typedEvidenceRefs.filter((ref) => ref._locked === true).length;
    const backfillRefsCount = typedEvidenceRefs.filter((ref) => ref._backfill === true).length;
    const written = store.recordStandingMemory({
      source_cycle_id: cycleId,
      generated_at: generatedAt,
      char_limit: maxChars,
      token_budget_hint: `short working-memory index, max ${maxChars} characters`,
      text,
      evidence_refs: typedEvidenceRefs.map((ref) => ref.source_id),
      typed_evidence_refs: typedEvidenceRefs,
      memory_policy: {
        standing_memory_role: 'working_memory_index',
        evidence_precedence: reportContext.temporal_decision_brief?.evidence_policy?.precedence ?? [],
        sections: STANDING_MEMORY_SECTIONS,
        evidence_depth_target: STANDING_MEMORY_EVIDENCE_DEPTH_TARGET,
        evidence_depth: typedEvidenceRefs.length,
        evidence_depth_ok: typedEvidenceRefs.length >= STANDING_MEMORY_EVIDENCE_DEPTH_TARGET,
        source_cycle_id: cycleId,
        audit_ok: audit.ok,
        used_fallback: usedFallback,
        fallback_reason: fallbackReason,
        rolling_update_applied: Boolean(rollingConfig),
        locked_refs_count: lockedRefsCount,
        backfill_refs_count: backfillRefsCount,
        narrative_preserved: narrativePreserved,
        final_candidate: finalCandidate,
        primary_issues: primaryIssues,
        preserved_issues: preservedIssues,
      },
    });
    const result = {
      status: written > 0 ? 'updated' : 'failed',
      reason: written > 0 ? null : 'write-failed',
      audit,
      primary_issues: primaryIssues,
      preserved_issues: preservedIssues,
      fallback_issues: fallbackIssues,
      used_fallback: usedFallback,
      narrative_preserved: narrativePreserved,
      final_candidate: finalCandidate,
      evidence_depth: typedEvidenceRefs.length,
      locked_refs_count: lockedRefsCount,
      backfill_refs_count: backfillRefsCount,
    };
    emitStandingMemoryUpdateEvent(store, { cycleId, result });
    return result;
  } catch (e) {
    const msg = e?.message || String(e);
    logger?.warn?.(`[report] standing memory update failed: ${msg}`);
    const failed = { status: 'failed', reason: msg };
    emitStandingMemoryUpdateEvent(store, { cycleId, result: failed });
    return failed;
  }
}

function emitStandingMemoryUpdateEvent(store, { cycleId = null, result = null } = {}) {
  if (!store || typeof store.recordEvolutionEvent !== 'function' || !result) return;
  try {
    store.recordEvolutionEvent({
      type: 'standing_memory_update',
      status: result.status || 'unknown',
      cycle_id: cycleId || null,
      reason: result.reason ?? null,
      used_fallback: result.used_fallback === true,
      narrative_preserved: result.narrative_preserved === true,
      final_candidate: result.final_candidate ?? null,
      primary_issues: Array.isArray(result.primary_issues) ? result.primary_issues.slice(0, 20) : [],
      preserved_issues: Array.isArray(result.preserved_issues) ? result.preserved_issues.slice(0, 20) : [],
      fallback_issues: Array.isArray(result.fallback_issues) ? result.fallback_issues.slice(0, 20) : [],
      evidence_depth: result.evidence_depth ?? null,
    });
  } catch {
    // best-effort; do not fail the update path on event write
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
  transformMd = null,
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

  if (typeof transformMd === 'function') {
    finalMd = transformMd(finalMd, { source: finalSource });
  }

  finalMd = redactSecrets(finalMd);

  const mdPath = resolveIntelReportWritePath(runtime.runtimeRoot, cycleId, { generatedAt: finalGeneratedAt });
  mkdirSync(dirname(mdPath), { recursive: true });
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
      runtimeRoot: runtime.runtimeRoot,
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
    belief_count: finalReportContext.current_beliefs?.beliefs?.length ?? 0,
    belief_event_count: finalReportContext.belief_events.length,
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
