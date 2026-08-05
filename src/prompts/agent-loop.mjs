import { MACHINE_CONTEXT_IDS } from '../intelligence/machine-context-refs.mjs';
import { formatCarryover } from '../evolution/carryover.mjs';

export { formatCarryover };

function clip(value, max = 120000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text;
}

function formatAgentDocs(agentContextDocs = []) {
  if (!Array.isArray(agentContextDocs) || !agentContextDocs.length) return '(none)';
  return agentContextDocs.map((doc) => [
    `## ${doc.id || 'document'}`,
    doc.source ? `Source: ${doc.source}` : '',
    clip(doc.text, 200000),
  ].filter(Boolean).join('\n\n')).join('\n\n---\n\n');
}

function briefJson(reportContext) {
  return clip(JSON.stringify(reportContext?.temporal_decision_brief || {}, null, 2), 200000);
}

/**
 * System prompt for the readonly investigation phase only.
 */
export function buildAgentLoopSystemPromptParts({
  agentContextDocs = [],
  toolCatalogText = '',
  language = 'zh',
} = {}) {
  const isEn = language === 'en';
  const stablePrefix = isEn
    ? `You are the investigation mind of js-evolution-agent in agent_loop mode (readonly evidence gathering only).

Rules:
- Authoritative documents outrank all intelligence material.
- Every turn you MUST call a tool.
- Use readonly tools only to close evidence gaps that mechanical Seen / Temporal Decision Brief do not already cover.
- If the mechanical Seen + brief + carryover are already enough, call finish_investigation immediately with enough_for_report=true (zero queries is allowed and preferred).
- When finishing, prefer verified_facts: each item is { ref, statement } where ref is an exact handle from tool results (item.ref / cite_as) or a machine_context key (${MACHINE_CONTEXT_IDS.join(', ')}). Never invent refs. findings_summary is prose lead material only; the host splices Seen from mechanical Seen + verified_facts.
- Do NOT queue decisions and do NOT write the full Intel report in this phase. The host will draft the Phase 1.5 report and run Analyze+Decide afterward.
- Never invent filesystem writes or claim that an action already ran.
- After a budget checkpoint, stop new queries and call finish_investigation.

Authoritative documents:

${formatAgentDocs(agentContextDocs)}

Available tools:

${toolCatalogText || '(see tool schemas)'}
`
    : `你是 js-evolution-agent 的查证者，当前运行在 agent_loop 的只读查证阶段。

规则：
- 权威文档优先于一切情报材料。
- 每一轮必须调用工具。
- 只用只读工具补齐机械 Seen / Temporal Decision Brief 尚未覆盖的证据缺口。
- 若机械 Seen + brief + carryover 已经足够，立刻调用 finish_investigation（enough_for_report=true）；允许且鼓励 0 次查询直接结束。
- 收尾时优先提交 verified_facts：每项为 { ref, statement }，ref 必须来自工具结果标注的句柄（item.ref / cite_as）或 machine_context 枚举（${MACHINE_CONTEXT_IDS.join('、')}），禁止编造。findings_summary 只是散文线索；宿主会用机械 Seen + verified_facts 组装最终 Seen。
- 本阶段不要入队决策，也不要撰写完整 Intel 报告；宿主会随后定稿 Phase 1.5 报告并执行 Analyze+Decide。
- 禁止伪造写盘，也禁止宣称动作已经执行完成。
- 收到 budget checkpoint 后停止新查询，调用 finish_investigation。

权威文档：

${formatAgentDocs(agentContextDocs)}

可用工具：

${toolCatalogText || '(见 tool schemas)'}
`;

  return {
    stablePrefix,
    dynamicPayload: '',
    content: stablePrefix,
  };
}

export function buildAgentLoopInitialUserPromptParts({
  cycleId,
  currentTime = '',
  language = 'zh',
  goalsText = '',
  rules = '',
  humanGuidance = '',
  operatorBriefs = '',
  intelligenceContext = '',
  reportContext = null,
  mechanicalSeen = '',
  carryover = [],
} = {}) {
  const isEn = language === 'en';
  // Stability-descending order for DeepSeek KV prefix cache:
  // Rules / Guidance / Goals change rarely; Cycle + Current Time and later evidence change every run.
  // Keep Current Time after Cycle (not in system stablePrefix) so Rules→Goals can still prefix-hit.
  const dynamicPayload = `## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

## Goals

${goalsText || '(none)'}

## Cycle

${cycleId || '(unknown)'}

## Current Time

${currentTime || '(unknown)'}

## Operator Intent Briefs

${isEn
    ? 'One-cycle operator intent. Prioritize accordingly, but do not treat as established fact:'
    : '单轮人工意图。可用于排优先级，但不得当作已成立事实：'}

${operatorBriefs || '(none)'}

## Intelligence Summary

${intelligenceContext || '(none)'}

## Mechanical Seen (host-rendered; prefer over re-querying the same facts)

${mechanicalSeen || '(none)'}

## Temporal Decision Brief

${briefJson(reportContext)}

## Carryover from previous cycle

${formatCarryover(carryover, language)}

## Task

${isEn
    ? 'Identify evidence gaps against mechanical Seen / brief / carryover. Query only what is missing, then call finish_investigation with findings_summary. Prefer finishing early over exhaustive browsing.'
    : '对照机械 Seen / brief / carryover 标出证据缺口；只查缺失项，然后调用 finish_investigation 并提交 findings_summary。宁可早结束，不要穷尽浏览。'}
`;

  const stablePrefix = isEn
    ? 'Begin the readonly investigation for this cycle using the dynamic payload below.'
    : '根据以下动态载荷开始本周期只读查证。';

  return {
    stablePrefix,
    dynamicPayload,
    content: `${stablePrefix}\n\n${dynamicPayload}`,
  };
}

export function formatToolCatalogForPrompt(toolsProduct) {
  const tools = toolsProduct?.tools || [];
  return tools
    .filter((tool) => tool.name !== 'finish_cycle')
    .map((tool) => `- \`${tool.name}\` (${tool.kind}): ${String(tool.description || '').split('\n')[0]}`)
    .join('\n');
}

/**
 * Compress investigation outputs into a bounded digest for the single-shot report call.
 */
export function buildInvestigationDigest({
  investigation = null,
  queryLog = [],
  maxChars = 16000,
} = {}) {
  const verified = Array.isArray(investigation?.verified_facts) ? investigation.verified_facts : [];
  const rejected = Array.isArray(investigation?.rejected_facts) ? investigation.rejected_facts : [];
  const lines = [
    '## Investigation Digest',
    '',
    `enough_for_report: ${investigation?.enough_for_report !== false}`,
    `forced: ${Boolean(investigation?.forced)}`,
    investigation?.forced_reason ? `forced_reason: ${investigation.forced_reason}` : null,
    '',
    '### Findings summary',
    String(investigation?.findings_summary || '(none)').slice(0, 8000),
    '',
    '### Verified facts',
    ...(verified.length
      ? verified.map((f) => `- ${f.ref}: ${f.statement}`)
      : ['- (none)']),
    '',
    '### Rejected facts',
    ...(rejected.length
      ? rejected.map((f) => `- ${f.ref || '(missing)'} (${f.reason || 'rejected'}): ${f.statement || ''}`)
      : ['- (none)']),
    '',
    '### Gaps closed',
    ...(Array.isArray(investigation?.gaps_closed) && investigation.gaps_closed.length
      ? investigation.gaps_closed.map((g) => `- ${g}`)
      : ['- (none)']),
    '',
    '### Open gaps',
    ...(Array.isArray(investigation?.open_gaps) && investigation.open_gaps.length
      ? investigation.open_gaps.map((g) => `- ${g}`)
      : ['- (none)']),
    '',
    '### Readonly query log (truncated)',
  ].filter((line) => line != null);

  const queries = Array.isArray(queryLog) ? queryLog : [];
  if (!queries.length) {
    lines.push('- (no readonly queries)');
  } else {
    for (const q of queries.slice(0, 30)) {
      lines.push(`- ${q.name} ok=${q.ok}: ${String(q.preview || '').slice(0, 500)}`);
    }
  }

  return clip(lines.join('\n'), maxChars);
}

/** Observation substitute for classic report prompts: mechanical Seen + investigation digest. */
export function buildAgentLoopObservationReport({
  mechanicalSeen = '',
  investigationDigest = '',
} = {}) {
  return [
    '## Host mechanical Seen',
    '',
    mechanicalSeen || '(none)',
    '',
    investigationDigest || '## Investigation Digest\n\n(none)',
  ].join('\n');
}

/**
 * Thin agent_loop report prompt: host owns Final Seen; model writes judgement sections.
 * Stable prefix keeps `# 情报报告任务` / `# Intelligence Report Task` for mock canned matchers.
 */
export function buildAgentLoopReportUserPromptParts({
  cycleId,
  currentTime = '',
  language = 'zh',
  goalsText = '',
  rules = '',
  humanGuidance = '',
  operatorBriefs = '',
  hostSeenBody = '',
  investigationDigest = '',
  reportContext = null,
} = {}) {
  const isEn = language === 'en';
  const stablePrefix = isEn
    ? `# Intelligence Report Task

Write a human-readable Markdown intelligence report for the current cycle (agent_loop host-assembled Seen).

Rules:
- Output pure Markdown; do not wrap the whole document in code fences.
- Required level-2 headings (English preferred): ## Seen, ## Inferred, ## Cyber-Taoist analysis, ## 下一轮建议 (or Next cycle suggestions).
- Prefer a short ## TL;DR heading near the top (1–2 sentences). Do not write TL;DR as a numbered/bullet list.
- ## Seen is a host-owned placeholder: write one short bullet acknowledging Final Seen below; the host will replace the entire Seen section verbatim with Final Seen. Do not invent Seen facts.
- Write ## Inferred, ## Cyber-Taoist analysis, and next-cycle suggestions based on Final Seen + Investigation Digest + Temporal Decision Brief.
- Inferred judgements may cite only typed refs that appear in Final Seen. Use halfwidth ASCII brackets and colons: [type:id]. Never invent ids.
- Operator Intent Briefs are one-cycle intent, not facts. Discuss them under Inferred; never promote brief claim text into Seen.
- Under ## 下一轮建议 / Next cycle suggestions, each top-level numbered/bullet item must be one complete independent suggestion. Field lists for a single action (intent / context / expected_output / permission_profile / etc.) belong as nested bullets under that one item — never as separate top-level suggestions.
- Use straightforward technical prose; keep Cyber-Taoist analysis faithful to authoritative documents without ornate metaphor.`
    : `# 情报报告任务

请为当前 cycle 生成一份人类可读的情报报告（agent_loop：Seen 由宿主组装）。

规则：
- 输出纯 Markdown，不要使用最外层代码围栏。
- 必须包含这些二级标题（优先英文）：## Seen、## Inferred、## Cyber-Taoist analysis、## 下一轮建议。
- 文首建议用二级标题 ## TL;DR（1–2 句）；不要用编号或 bullet 列表写 TL;DR。
- ## Seen 是宿主占位：写一条短 bullet 确认已读下方 Final Seen 即可；宿主会用 Final Seen 整段替换 Seen。不要自行编造 Seen 事实。
- 基于 Final Seen + Investigation Digest + Temporal Decision Brief 撰写 ## Inferred、## Cyber-Taoist analysis 与下一轮建议。
- Inferred 只能引用 Final Seen 中已出现的 typed ref；括号与冒号必须半角 ASCII：\`[type:id]\`。禁止编造 id。
- Operator Intent Briefs 是单轮意图，不是事实；放在 Inferred 讨论，不得把 brief claim 原文写入 Seen。
- 「下一轮建议」每个顶层编号/bullet 必须是一条完整独立建议；单个 action 的字段清单（intent/context/expected_output/permission_profile 等）须放在同一条的嵌套子弹内，不得拆成多条顶层项。
- 文风为现代汉语书面语，Cyber-Taoist 分析忠于权威文献，避免文言与玄学修辞。`;

  // Stability-descending order for DeepSeek KV prefix cache.
  // Current Time sits with Cycle (per-run), never in the report-task stablePrefix above.
  const dynamicPayload = `## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

## Goals

${goalsText || '(none)'}

## Cycle

${cycleId || '(unknown)'}

## Current Time

${currentTime || '(unknown)'}

## Operator Intent Briefs

${isEn
    ? 'One-cycle operator intent. Prioritize accordingly, but do not treat as established fact:'
    : '单轮人工意图。可用于排优先级，但不得当作已成立事实：'}

${operatorBriefs || '(none)'}

## Final Seen

${isEn
    ? 'Host will splice this body into ## Seen verbatim. Use it as the citation palette for Inferred.'
    : '宿主将把以下正文逐字写入 ## Seen。Inferred 只能引用这里出现的 typed ref。'}

${hostSeenBody || '- (none)'}

${investigationDigest || '## Investigation Digest\n\n(none)'}

## Temporal Decision Brief

\`\`\`json
${briefJson(reportContext)}
\`\`\`
`;

  return {
    stablePrefix,
    dynamicPayload,
    content: `${stablePrefix}\n\n## Dynamic Cycle Payload\n\n${dynamicPayload}`,
  };
}
