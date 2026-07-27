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

function formatCarryover(carryover = [], language = 'zh') {
  const isEn = language === 'en';
  const note = isEn
    ? 'Unfinished items left by the previous agent_loop. Prefer them when still valid, but verify preconditions with readonly tools first.'
    : '上轮 agent_loop 留下的待续事项。可优先处理，但必须先用只读工具核实其前提仍然成立。';
  if (!Array.isArray(carryover) || !carryover.length) {
    return `${note}\n\n(none)`;
  }
  const list = carryover.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
  return `${note}\n\n${list}`;
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
  const dynamicPayload = `## Cycle

${cycleId || '(unknown)'}

## Goals

${goalsText || '(none)'}

## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

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
