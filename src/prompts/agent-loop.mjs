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

function formatAlreadyExecuted(alreadyExecuted = []) {
  if (!Array.isArray(alreadyExecuted) || !alreadyExecuted.length) return '(none)';
  return alreadyExecuted.map((item, idx) => {
    if (typeof item === 'string') return `${idx + 1}. ${item}`;
    return `${idx + 1}. ${item.type || 'action'}: ${item.description || item.summary || JSON.stringify(item).slice(0, 200)}`;
  }).join('\n');
}

export function buildAgentLoopSystemPromptParts({
  agentContextDocs = [],
  toolCatalogText = '',
  language = 'zh',
} = {}) {
  const isEn = language === 'en';
  const stablePrefix = isEn
    ? `You are the controlled self-evolution decision mind of js-evolution-agent running in agent_loop mode.

Rules:
- Authoritative documents outrank all intelligence material.
- Every turn you MUST call a tool. Prefer readonly tools before actions.
- Side-effect actions go through registered action tools only; never invent filesystem writes.
- Respect action budgets. Do not retry the same action fingerprint in this cycle.
- When done, call finish_cycle with status and a full report_markdown.
- report_markdown must include sections: Seen, Inferred, Cyber-Taoist analysis, Next cycle suggestions.
- Writing style: straightforward technical/ops prose. Cyber-Taoist terms may be quoted from docs.

Authoritative documents:

${formatAgentDocs(agentContextDocs)}

Available tools:

${toolCatalogText || '(see tool schemas)'}
`
    : `你是 js-evolution-agent 的受控自演化决策者，当前运行在 agent_loop 模式。

规则：
- 权威文档优先于一切情报材料。
- 每一轮必须调用工具；先用只读工具查证，再决定是否执行动作工具。
- 副作用只能通过已注册 action 工具产生，禁止伪造写盘。
- 遵守动作预算；本周期内不要重复相同 fingerprint 的动作。
- 结束时必须调用 finish_cycle，并提供完整 report_markdown。
- report_markdown 必须包含：Seen、Inferred、Cyber-Taoist 分析、下一轮建议。
- 中文使用白话书面语，清晰直白；Cyber-Taoist 专有术语可按文献原样引用。

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
  alreadyExecuted = [],
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

## Temporal Decision Brief

${briefJson(reportContext)}

## Already executed this cycle (do not repeat)

${formatAlreadyExecuted(alreadyExecuted)}

## Task

${isEn
    ? 'Investigate with readonly tools as needed, execute at most the action budget of high-value actions, then finish_cycle with a complete report_markdown.'
    : '按需使用只读工具查证，在动作预算内执行高价值动作，然后调用 finish_cycle 并提交完整 report_markdown。'}
`;

  const stablePrefix = isEn
    ? 'Begin the agent_loop for this cycle using the dynamic payload below.'
    : '根据以下动态载荷开始本周期 agent_loop。';

  return {
    stablePrefix,
    dynamicPayload,
    content: `${stablePrefix}\n\n${dynamicPayload}`,
  };
}

export function formatToolCatalogForPrompt(toolsProduct) {
  const tools = toolsProduct?.tools || [];
  return tools.map((tool) => `- \`${tool.name}\` (${tool.kind}): ${String(tool.description || '').split('\n')[0]}`).join('\n');
}
