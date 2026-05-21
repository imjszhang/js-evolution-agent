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
- Decisions must remain evidence-aware and goal-aligned. Prefer one autonomous agent_run with a concrete run_spec over subject-specific action menus.

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
2. Then read the Temporal Decision Brief. It is the current evidence-state summary and must be used before historical narrative.
3. Then read standing_memory. It is fixed-capacity global situation memory; use it for continuity, but treat it as a cache, not an authority.
4. Then read active goals, goal history, current cycle facts, recent intelligence, and report history.
4. Then read Operator Intent Briefs. They are one-cycle operator intent, not verified evidence or standing memory.
5. If new evidence weakens or overturns standing_memory or historical reports, say so in the report.
6. When sources conflict, use this precedence: raw/direct file evidence > structured machine records > active verified claims > historical model summaries > operator intent.

Output constraints:
- Output pure Markdown; do not wrap the whole document in code fences.
- Use straightforward technical-or-ops prose: readable to a human operator, useful to the subject's evolution, and faithful to Cyber-Taoist evolutionary thinking.
- Cyber-Taoist terms may be used as written in the documents, but state claims with facts and traceable ids instead of metaphor.
- Do not invent ids, counts, or events not present in the machine context.
- Treat Operator Intent Briefs as requests to verify or focus attention. Do not state their claims as facts until supported by machine evidence.
- Treat historical reports as historical claims, not current facts. Do not promote refuted, stale, or unverified claims into current facts.
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

## Temporal Decision Brief

Read this before the full Machine Context. It summarizes current evidence state, source freshness, and historical claims that should not be promoted without verification:

\`\`\`json
${briefJson(reportContext)}
\`\`\`

## Model Observation Claims

The following Observation Report is model-generated. Use it as leads only. If it conflicts with the Temporal Decision Brief, schema guards, or structured evidence, prefer the latter and call out the conflict:

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
2. 再读 Temporal Decision Brief；它是当前证据状态摘要，必须先于历史叙事使用。
3. 再读 standing_memory；它是固定容量的整体态势缓存，可以帮助保持连续性，但不是权威事实源。
4. 再读当前目标、目标历史、本轮事实、近期完整情报和历史报告索引。
5. 再读 Operator Intent Briefs。它们是单轮人工意图，不是已验证证据，也不是 standing_memory。
6. 若新证据推翻或削弱 standing_memory 或历史报告中的旧判断，请在报告中指出。
7. 多源冲突时按以下优先级裁决：原始/直接文件证据 > 结构化机器记录 > 当前已验证 claim > 历史模型总结 > 人工意图。

要求：
- 输出纯 Markdown，不要使用最外层代码围栏。
- 文风：现代汉语书面语（白话），条目化、可直接给工程师阅读；对人类操作者可读、对主体的演化有用，并忠于 Cyber-Taoist 进化学立场。
- 禁止使用文言文、骈俪、堆砌典故作主标题、「子在川上」类譬喻文风，或过长的玄学、武侠、宗教隐喻。
- Cyber-Taoist 专有名词可照文献原样引用，但必须用事实与可追溯 id 陈述，勿用玄学修辞替代证据。
- 不要捏造机器上下文中没有的 id、计数或事件。
- 将 Operator Intent Briefs 视为核实请求或注意力偏好；除非已有机器证据支持，不得把其中 claim 表述为事实。
- 将历史报告视为 historical claim，而不是当前事实源；不得把 refuted、stale、unverified 的 claim 写成当前事实。
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

## Temporal Decision Brief

先读这一节，再读完整 Machine Context。它汇总当前证据状态、来源新旧顺序，以及不能直接升级为事实的历史 claim：

\`\`\`json
${briefJson(reportContext)}
\`\`\`

## Model Observation Claims

以下 Observation Report 是模型生成的观察 claim，只能作为线索。若它与 Temporal Decision Brief、schema guard 或结构化证据冲突，必须以后者为准，并指出冲突：

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
- 报告中的判断可以作为分析线索，但 run 必须能追溯到机器上下文、观察报告、目标或历史证据。
- 必须优先使用 Temporal Decision Brief 中的 current_facts、source_ordering 和 claim 状态；历史报告和 standing_memory 是历史 claim/缓存，不是权威事实源。
- 若 brief 标记某个 claim 为 refuted_or_weakened 或 unverified，不得基于它调度执行动作，除非动作本身是为了重新验证它。
- 多源冲突时按以下优先级裁决：原始/直接文件证据 > 结构化机器记录 > 当前已验证 claim > 历史模型总结 > 人工意图。
- 默认输出 \`type: "agent_run"\`，并在 \`params.run_spec\` 中描述一次自主 agent 运行。不要再把主体业务步骤拆成 \`sync/generate/simulate/evaluate/publish\` 之类的 action 菜单。
- \`params.run_spec.primary_cwd_kind\` 是一等字段。常见值：主体日记/records/daemon/goals/intelligence 使用 \`subject_runtime\`；JEA 源码/policies/journal 使用 \`source_root\`；主体外部项目使用 subject policy 中声明的自定义 scope。
- 每次 run 只能有一个 primary cwd。需要参考其他 root 时，使用 \`additional_directory_kinds\` 或把摘要写入 context；不要让一次 run 无差别跨多个项目根写入。
- \`permission_profile\` 必须是 \`read_only\`、\`workspace_write\` 或 \`remote_write_review\` 之一。只读调查用 \`read_only\`；本地候选/模拟/沙盒改动用 \`workspace_write\`；真实远端变更或发布准备用 \`remote_write_review\`。
- 若必须使用旧 action type，只能用于兼容已有队列或明确的宿主记录语义，并在 rationale 说明为什么 \`agent_run\` 不合适。
- \`agent_execute\` 只允许作为旧兼容兜底动作；新决策不要优先使用它。
- 当 run 涉及本地文件或目录时，文件路径应相对 primary cwd 描述，不要混用多个项目根的绝对路径。执行层会从 run_spec 解析 cwd 并阻断 root_mismatch。
- 常见资源归属：主体日记/records/daemon/goals/intelligence 使用 primary_cwd_kind=subject_runtime；JEA 源码/policies/journal 使用 primary_cwd_kind=source_root；外部项目文件使用 subject policy 中声明的自定义 primary_cwd_kind。
- 对 ENOENT、目录不存在、blocked 等缺失证据，只能表述为「在 executionRoot=X 下 path=Y 不存在」；除非该 root 是该 resource_kind 的权威 root，否则不得升级为「模块缺失」「机制未实现」「写入冻结」。
- Operator Intent Briefs 是单轮人工意图，不是事实证据。可以据此优先调度核实动作；若不采纳 brief，应在 deferred 中说明原因。
- \`write_retrospective\` 只用于记录已经掌握的结构化复盘结论（summary/outcome/lessons/next_actions）；需要读取文件或补证据时，优先调度 \`agent_run\`。
- 涉及权限、安全探针、越界路径或敏感目标的 run，必须通过 \`permission_profile\`、primary cwd、additional directories 和 expected_output 约束，不要只靠自然语言承诺。
- 每个 action 必须有 serves_goal，并尽量使用目标树中的 goal id；对 \`agent_run\`，serves_goal 描述本次 run 要推进的目标。
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

## Temporal Decision Brief

\`\`\`json
${briefJson(reportContext)}
\`\`\`

## Model Observation Claims

The following observation is model-generated lead material, not an authority. If it conflicts with the Temporal Decision Brief or schema guards, use it only as an unverified claim:

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
      "type": "agent_run",
      "description": "...",
      "serves_goal": "<goal_id>",
      "goal_rationale": "...",
      "priority": "high/medium/low",
      "update_issue": null,
      "params": {
        "run_spec": {
          "primary_cwd_kind": "subject_runtime | source_root | <subject_policy_external_scope>",
          "additional_directory_kinds": [],
          "permission_profile": "read_only | workspace_write | remote_write_review",
          "provider": "claude_code_sdk | cursor_sdk",
          "intent": "...",
          "context": {
            "why_now": "...",
            "relevant_evidence": ["..."],
            "constraints": ["..."]
          },
          "expected_output": [
            "strict JSON receipt",
            "summary of what was done",
            "evidence read or produced",
            "files/resources touched",
            "verification result",
            "next recommendation"
          ]
        }
      },
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
