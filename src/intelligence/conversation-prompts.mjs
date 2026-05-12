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

export function buildConversationSystemPrompt({ agentContextDocs = [], actionRegistry = null } = {}) {
  const actions = actionRegistry && typeof actionRegistry.toPromptSection === 'function'
    ? actionRegistry.toPromptSection()
    : '(no registered actions)';

  return `You are the continuous intelligence-and-decision mind of js-evolution-agent.

Use one coherent viewpoint across this conversation:
- First, write a human-readable intelligence report from the observed evidence (for Chinese: call it 「情报报告」).
- Writing style when using Chinese: modern standard written Chinese (白话书面语)，清晰直白；禁止使用文言文、骈俪与半文半白句式；禁止使用典故作主标题或过长的玄学、武侠、宗教隐喻；Cyber-Taoist 专有术语可按文献原样引用，但整体叙述须像技术与运行复盘，而非杂文或随笔。
- When writing English, use straightforward technical-or-ops prose; avoid purple prose headings or journaling flourishes unless quoting authoritative docs verbatim.
- Then, in the next turn, convert supported judgements into strict Analyze+Decide JSON.
- Treat earlier assistant report text as your analysis product, not as new external fact.
- Decisions must remain evidence-aware, goal-aligned, and bounded by the host's registered action handlers.

Authoritative documents:

${formatAgentDocs(agentContextDocs)}

Registered action types:

${actions}`;
}

export function buildReportUserPrompt({
  cycleId,
  goalsText = '',
  rules = '',
  humanGuidance = '',
  intelligenceContext = '',
  observationReport = '',
  reportContext = null,
} = {}) {
  return `请为本轮 cycle \`${cycleId}\` 生成一份人类可读的情报报告（不要使用「修行札记」体裁或文言、半文言文风）。

阶段：pre_analyze_decide_report。只评价下方已提供的观察、历史情报和机器上下文；不要评价本阶段尚未产生的后续产物。

要求：
- 输出纯 Markdown，不要使用最外层代码围栏。
- 文风：现代汉语书面语（白话），条目化、可直接给工程师阅读；禁止使用文言文、堆砌典故作主标题、「子在川上」类譬喻文风；Cyber-Taoist 术语可照文献引用，勿用玄学修辞替代事实陈述。
- 不要捏造机器上下文中没有的 id、计数或事件。
- 覆盖本轮观察、长期趋势、证据不足、风险、下一轮建议。
- 尽量引用可追溯 id。

## Goals

${goalsText || '(none)'}

## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

## Intelligence Summary

${intelligenceContext || '(none)'}

## Observation Report

${observationReport || '(none)'}

## Machine Context

\`\`\`json
${clip(JSON.stringify(reportContext || {}, null, 2), 500000)}
\`\`\``;
}

export function buildDecideUserPrompt({
  goalsText = '',
  rules = '',
  humanGuidance = '',
  intelligenceContext = '',
  observationReport = '',
  reportContext = null,
  actionRegistry = null,
} = {}) {
  const actions = actionRegistry && typeof actionRegistry.toPromptSection === 'function'
    ? actionRegistry.toPromptSection()
    : '(no registered actions)';

  return `# Strategic Analysis & Decision

基于以上完整对话，尤其是你刚刚生成的情报报告，请输出本轮 Analyze+Decide 的严格 JSON。

重要约束：
- 只能输出 JSON 对象，不要 Markdown，不要代码围栏。
- 报告中的判断可以作为分析线索，但 action 必须能追溯到机器上下文、观察报告、目标或历史证据。
- 优先使用下方已注册 action types；如果确需非标准 type，必须在 params.execution_plan 写清楚步骤。
- 每个 action 必须有 serves_goal，并尽量使用目标树中的 goal id。
- 不要为了覆盖而制造行动；证据不足时可以把 decision 设为 "defer" 或让 actions 为空数组。

## Available Action Types

${actions}

## Goals

${goalsText || '(none)'}

## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

## Intelligence Summary

${intelligenceContext || '(none)'}

## Observation Report

${observationReport || '(none)'}

## Machine Context

\`\`\`json
${clip(JSON.stringify(reportContext || {}, null, 2), 500000)}
\`\`\`

Respond with exactly this JSON shape:
{
  "analysis": {
    "key_patterns": ["..."],
    "root_causes": {
      "high_performers_why": "...",
      "low_performers_why": "...",
      "failures_why": "..."
    },
    "opportunities": [
      { "opportunity": "...", "potential_impact": "high/medium/low", "effort": "high/medium/low" }
    ],
    "goal_assessment": {
      "<goal_id>": {
        "status": "...",
        "trend": "improving/stable/declining",
        "observed_signals": ["..."],
        "gap": "..."
      }
    }
  },
  "decision": "execute",
  "rationale": "...",
  "actions": [
    {
      "type": "action_type_name",
      "description": "...",
      "serves_goal": "<goal_id>",
      "goal_rationale": "...",
      "priority": "high/medium/low",
      "update_issue": null,
      "params": {},
      "expected_impact": "...",
      "risk": "..."
    }
  ],
  "goal_coverage": {
    "covered": ["<goal_id>"],
    "not_covered": { "<goal_id>": "reason" }
  },
  "deferred": [
    { "action": "...", "reason": "...", "revisit_after": "..." }
  ],
  "risk_mitigation": ["..."],
  "goal_suggestions": [
    { "suggestion": "...", "reason": "..." }
  ],
  "confidence_score": 0.8
}`;
}
