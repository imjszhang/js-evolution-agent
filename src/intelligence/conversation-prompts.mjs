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
- First, study the authoritative documents in full, then write a human-readable intelligence report from the observed evidence (for Chinese: call it 「情报报告」) using their lens, vocabulary, and methods.
- The authoritative documents outrank all intelligence material. Use standing_memory for continuity, but never let it override new evidence.
- Writing style when using Chinese: modern standard written Chinese (白话书面语)，清晰直白；禁止使用文言文、骈俪与半文半白句式；禁止使用典故作主标题或过长的玄学、武侠、宗教隐喻；Cyber-Taoist 专有术语可按文献原样引用，但整体叙述须像技术与运行复盘，而非杂文或随笔。
- When writing English, use straightforward technical-or-ops prose that is faithful to Cyber-Taoist evolutionary thinking; avoid purple prose headings or journaling flourishes unless quoting authoritative docs verbatim.
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
  language = 'zh',
  goalsText = '',
  rules = '',
  humanGuidance = '',
  operatorBriefs = '',
  intelligenceContext = '',
  observationReport = '',
  reportContext = null,
} = {}) {
  if (language === 'en') {
    return `Write a human-readable Markdown intelligence report for cycle \`${cycleId}\`.

Stage: pre_analyze_decide_report. Evaluate only the observations, historical intelligence, and machine context provided below; do not evaluate later products that do not exist at this stage.

Reading order and constraints:
1. First, read the authoritative documents already provided in the system message. They outrank all intelligence material.
2. Then read standing_memory. It is fixed-capacity global situation memory; use it for continuity, but do not let it override new evidence.
3. Then read active goals, goal history, current cycle facts, recent intelligence, and report history.
4. Then read Operator Intent Briefs. They are one-cycle operator intent, not verified evidence or standing memory.
5. If new evidence weakens or overturns standing_memory, say so in the report.

Output constraints:
- Output pure Markdown; do not wrap the whole document in code fences.
- Use straightforward technical-or-ops prose: readable to a human operator, useful to the subject's evolution, and faithful to Cyber-Taoist evolutionary thinking.
- Cyber-Taoist terms may be used as written in the documents, but state claims with facts and traceable ids instead of metaphor.
- Do not invent ids, counts, or events not present in the machine context.
- Treat Operator Intent Briefs as requests to verify or focus attention. Do not state their claims as facts until supported by machine evidence.
- Cover current cycle facts, long-term trends, evidence gaps, risks, next-cycle recommendations, and how standing_memory should be updated.
- Include an explicit Cyber-Taoist analysis section. It must interpret the evidence through the authoritative documents, including the current evolutionary phase, law/transaction/niche signals, and fractal keep/break/probe boundaries when the provided evidence supports them.
- Prefer traceable ids where relevant, such as observation, probe_result, goal_event, action_receipt, intel_report, or evolution_event.
- Use concise, literal section headings such as "Cycle conclusion" or "Evidence gaps"; avoid ornate, mystical, or literary headings.

## Goals

${goalsText || '(none)'}

## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

## Operator Intent Briefs

One-cycle operator intent. Use it to prioritize evidence gathering and decision focus, but do not treat it as established fact:

${operatorBriefs || '(none)'}

## Intelligence Summary

${intelligenceContext || '(none)'}

## Observation Report

${observationReport || '(none)'}

## Machine Context

\`\`\`json
${clip(JSON.stringify(reportContext || {}, null, 2), 500000)}
\`\`\``;
  }

  return `请为本轮 cycle \`${cycleId}\` 生成一份人类可读的情报报告（不要使用「修行札记」体裁或文言、半文言文风）。

阶段：pre_analyze_decide_report。只评价下方已提供的观察、历史情报和机器上下文；不要评价本阶段尚未产生的后续产物。

阅读顺序与约束：
1. 先读 system message 中已提供的权威文献，它们高于所有情报材料。
2. 再读 standing_memory；它是固定容量的整体态势记忆，可以帮助保持连续性，但不能覆盖新的证据。
3. 再读当前目标、目标历史、本轮事实、近期完整情报和历史报告索引。
4. 再读 Operator Intent Briefs。它们是单轮人工意图，不是已验证证据，也不是 standing_memory。
5. 若新证据推翻或削弱 standing_memory 中的旧判断，请在报告中指出。

要求：
- 输出纯 Markdown，不要使用最外层代码围栏。
- 文风：现代汉语书面语（白话），条目化、可直接给工程师阅读；对人类操作者可读、对主体的演化有用，并忠于 Cyber-Taoist 进化学立场。
- 禁止使用文言文、骈俪、堆砌典故作主标题、「子在川上」类譬喻文风，或过长的玄学、武侠、宗教隐喻。
- Cyber-Taoist 专有名词可照文献原样引用，但必须用事实与可追溯 id 陈述，勿用玄学修辞替代证据。
- 不要捏造机器上下文中没有的 id、计数或事件。
- 将 Operator Intent Briefs 视为核实请求或注意力偏好；除非已有机器证据支持，不得把其中 claim 表述为事实。
- 覆盖本轮观察、长期趋势、证据不足、风险、下一轮建议，以及 standing_memory 应如何更新的要点。
- 对缺失路径、ENOENT、blocked 探针等证据，必须引用 execution_root/resource_scope/resource_kind；除非该 root 是资源权威 root，不得升级为「模块缺失」「机制未实现」「写入冻结」。
- 必须包含明确的 Cyber-Taoist 分析章节。该章节需依据权威文献解释当前证据，至少覆盖当前进化阶段、法则/交易/生态位信号，以及在证据支持时的分形守/破/探针边界。
- 尽量引用可追溯 id（如 observation、probe_result、goal_event、action_receipt、intel_report、evolution_event）。
- 标题与小节标题用简明主题短语（例如「本轮结论」「证据缺口」），禁止使用文言对联式或隐喻式标题。

## Goals

${goalsText || '(none)'}

## Rules

${rules || '(none)'}

## Operator Guidance

${humanGuidance || '(none)'}

## Operator Intent Briefs

单轮人工意图。可用于调整证据搜集与决策优先级，但不得当作已成立事实：

${operatorBriefs || '(none)'}

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
  operatorBriefs = '',
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
- 优先使用具体 action types；不要用 \`agent_execute\` 表达观察、探针、复盘或核心 review 等已有语义。
- \`agent_execute\` 只允许作为兜底动作：当没有任何具体 action type 能表达任务时才使用，并且必须提供 params.objective、params.mode、params.boundary、params.acceptance、params.escape_hatch_reason。
- 当 \`agent_execute\` 或 \`run_probe\` 涉及本地文件或目录时，优先提供 params.resource_kind / params.resource_scope，再提供 params.cwd（语义等同 executionRoot）。cwd 必须与资源归属一致；文件路径应相对该资源 root 描述，不要混用多个项目根的绝对路径。执行层会从资源语义解析权威 executionRoot，并阻断 root_mismatch。
- 常见资源归属：主体日记/records/daemon/goals/intelligence 使用 resource_scope=subject_runtime；AgenTank candidates/scores/simulations/data/config/actions.json/src/strategy 使用 resource_scope=agentank_evolver；JEA 源码/policies/journal 使用 resource_scope=source_root。
- 对 ENOENT、目录不存在、blocked 等缺失证据，只能表述为「在 executionRoot=X 下 path=Y 不存在」；除非该 root 是该 resource_kind 的权威 root，否则不得升级为「模块缺失」「机制未实现」「写入冻结」。
- Operator Intent Briefs 是单轮人工意图，不是事实证据。可以据此优先调度核实动作；若不采纳 brief，应在 deferred 中说明原因。
- \`write_retrospective\` 只用于记录已经掌握的结构化复盘结论（summary/outcome/lessons/next_actions）；不要把它当作文件调查动作，不要设置 cwd。若需要读取文件或补证据，先调度 \`run_probe\`。
- 涉及读写边界、安全探针、越界路径或敏感目标的 action，必须把 params.boundary 写成软操作约束而非沙箱承诺，并说明是否需要审批、如何审计、如何清理。
- 如果确需非标准 type，必须在 params.execution_plan 写清楚步骤。
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

## Operator Intent Briefs

One-cycle operator intent. It may prioritize verification actions, but its claims must be verified before being treated as facts:

${operatorBriefs || '(none)'}

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
    "cyber_taoist_analysis": {
      "evolutionary_phase": "...",
      "law_transaction_niche_signals": ["..."],
      "fractal_keep_break_probe_boundaries": ["..."],
      "standing_memory_delta": "..."
    },
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
