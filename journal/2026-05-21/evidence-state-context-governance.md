# 证据状态治理：别让旧结论继续指挥进化

> 日期：2026-05-21  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现 / 问题排查  
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)
7. [附：本轮对话问题—思考—方案—执行对照](#附本轮对话问题思考方案执行对照)

---

## 1. 背景与动机

这次问题的起点很小：进化工作流在构建上下文时，会不会把多篇历史内容混在一起，却没有讲清楚时间？

继续追问后，真正的问题浮出来了。

进化系统不是一次性问答。它会连续生成情报报告、执行动作、写日记、更新 `standing_memory`，下一轮再把这些材料喂回模型。只要其中某个旧判断被错误压缩进长期记忆，或者某篇历史报告里的断言没有被新证据覆盖，它就可能在后续轮次里继续传播。

最新的 `agentank-tank` 日记已经出现了这种迹象：旧报告曾反复引用 `worker-state.json` 中并不存在的同步字段，也曾把“日记写入停滞”“standing_memory 可逐条清理”等判断当成事实。后续探针发现，这些结论有的无法从文件结构复现，有的已经被证伪。

第一阶段修复后，又执行了 20 轮进化。结果很有价值：系统确实更容易发现旧幻觉，但并没有完全阻断新幻觉。最新观察报告仍然把 `worker-state.json.remote.*`、`pipeline.*`、`queue.*` 这类不存在字段写成当前事实，后续报告和 `standing_memory` 又会吸收这些 claim。

这说明第一阶段的方向是对的，但防线太靠后。

真正的问题不是“prompt 里有没有一句以最新为准”。

真正的问题是：进化系统缺少一个明确的证据状态层，去告诉模型哪些是当前事实、哪些只是历史观点、哪些已经被证伪、哪些还需要验证。

---

## 2. 分析过程

这次先看了 Phase 1 的上下文链路：

| 环节 | 文件 | 发现 |
| --- | --- | --- |
| Phase 1 管道 | [`src/intelligence/conversational-intel-pipeline.mjs`](../../src/intelligence/conversational-intel-pipeline.mjs) | report 和 decide 共用一套上下文，但此前没有独立的证据状态摘要 |
| 报告上下文 | [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | `gatherReportContext()` 会收集 `standing_memory`、历史报告、receipts、events、probes 等多源材料 |
| 提示词 | [`src/intelligence/conversation-prompts.mjs`](../../src/intelligence/conversation-prompts.mjs) | 已要求 standing_memory 不能覆盖新证据，但没有完整的冲突裁决协议 |
| 存储 | [`src/intelligence/store.mjs`](../../src/intelligence/store.mjs) | 结构化记录有时间字段，但 claim 的生命周期还没有独立数据源 |
| 日记 | [`src/intelligence/evolution-diary-builder.mjs`](../../src/intelligence/evolution-diary-builder.mjs) | 日记也会消费 recent memory，长期应复用同一套证据状态语义 |

第一性原理下，系统要解决的不是“把更多上下文塞给模型”，而是让持续演化主体基于最新可信反馈，做出下一步最小有效行动。

因此要先回答三个问题：

- 什么是事实？
- 什么事实仍然有效？
- 这些事实如何约束下一步行动？

历史 Markdown、`standing_memory`、复盘日记都很有价值，但它们本质上是模型或人类整理过的观点。它们可以解释系统处境，却不能天然拥有事实权威。

20 轮验证后，又补充了第二个结论：

**污染源比 report/decide 更早。**

`observe` 阶段先于 `Temporal Decision Brief` 运行。如果 observe 报告已经把不存在字段写成事实，后面的 TDB 虽然能提醒模型降权历史材料，却已经是在污染进入上下文之后补救。更糟的是，第一版 TDB 把 receipt/probe 的自然语言 `summary` 放进 `current_facts`，等于把 agent 叙述套上了“结构化事实”的外壳。

---

## 3. 方案设计

最终方案是新增一层 `Temporal Decision Brief`。

它不是新的报告，也不是新的决策者，而是 report/decide 之前的证据状态摘要。它把当前上下文重新分层：

- `current_facts`：来自 receipts、probe results、evolution events、goal events 的结构化事实。
- `historical_claims`：来自历史报告、`standing_memory`、latest review 的历史模型结论。
- `refuted_or_weakened_claims`：文本或新证据显示已经被削弱、证伪的结论。
- `unverified_claims`：缺少原始证据支撑、仍需验证的结论。
- `decision_constraints`：目标、队列、operator brief 等行动边界。
- `source_ordering`：各类来源的新旧时间和证据等级。

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 核心抽象 | `Temporal Decision Brief` | 先用系统结构告诉模型“当前证据状态”，而不是只靠 prompt 自觉 |
| 证据优先级 | 原始/直接证据 > 结构化机器记录 > 已验证 claim > 历史模型总结 > 人工意图 | 避免旧报告和长期记忆压过新证据 |
| 历史报告 | 降级为 historical claim | 保留历史脉络，但不再默认当作当前事实 |
| standing_memory | 定义为 active claim cache | 它是缓存，不是权威事实源 |
| Claim Ledger | 先预留数据源和 API | 第一版不做复杂 claim 抽取，但字段设计要能迁移到长期生命周期管理 |

数据流变成：

```mermaid
flowchart TD
  records["Receipts, Probes, Events, Reports"] --> reportContext["gatherReportContext"]
  reportContext --> brief["Temporal Decision Brief"]
  brief --> reportPrompt["Intel Report Prompt"]
  brief --> decidePrompt["Analyze Decide Prompt"]
  reportPrompt --> report["Human Report"]
  decidePrompt --> decision["Structured Decision"]
  report --> memoryUpdate["Standing Memory Update"]
  brief --> memoryUpdate
  memoryUpdate --> standingMemory["Active Memory Cache"]
```

### 第二阶段：Observe 前移证据治理

20 轮运行后的结论是：仅有 `Temporal Decision Brief` 不够。治理必须前移到 observe，并且 TDB 自身要把“机器结构化状态”和“agent 自然语言 claim”拆开。

第二阶段方案增加了三条防线：

| 防线 | 作用 |
| --- | --- |
| `Observation Evidence Guard` | 在 observe prompt 中提前声明已知 schema guard 和 forbidden claim，要求字段声明必须带 `source_path` / `json_pointer` |
| `Model Observation Claims` | 将 Observation Report 降级为模型观察 claim，放在 TDB 之后，避免它先入为主 |
| TDB 证据分级硬化 | 把 `summary` 放入 `agent_claims`，不再作为 `current_facts` |

新的目标不是让模型“更谨慎一点”，而是让它很难把旧幻觉重新包装成当前事实。

### 第三阶段：把治理语言压缩成 Seen / Inferred / Remembered

第二阶段之后，系统的证据污染明显减少，但另一个问题开始显现：治理术语变多了。

`Temporal Decision Brief` 里有 `direct_evidence`、`structured_status`、`agent_claims`、`historical_claims`、`refuted_or_weakened_claims`、`unverified_claims`。`Observation Evidence Guard` 又有自己的 schema guard 和 forbidden claim 语言。`standing_memory` 更新协议也在讲 active claim、verified claim、agent claim。

这些词都对，但系统开始变得像在维护一套复杂的“事实法院”。

用户指出一个关键约束：不是所有事实都能靠代码证明。继续扩大 claim ledger 或 forbidden 列表，可能会把系统带向过度工程化。于是第三阶段回到第一性原理：

真正要避免的不是“所有 claim 都必须被证明”。

真正要避免的是把“不知道”写成“知道”。

因此第三阶段把证据治理统一成四栏：

| 栏位 | 含义 | 使用规则 |
| --- | --- | --- |
| `seen` | 本轮或近期由文件、API、结构化记录直接看到的东西 | 可以当事实使用 |
| `inferred` | 基于 `seen` 推断出的当前判断 | 必须引用 `seen`，并说明反证条件 |
| `remembered` | 历史报告、日记、`standing_memory`、agent summary 中说过的内容 | 只能当线索或背景 |
| `do_not_treat_as_seen` | 已证伪、禁止复活、或不能当直接事实的说法 | 不得作为事实或行动前提 |

这不是推翻前两阶段，而是给它们换一套更容易被模型和人类共同遵守的语言。

### 第四阶段：把 Seen 从提示词规则变成写入门禁

三栏模型上线后，又执行了 3 轮 `agentank-tank` 进化。结果很清楚：

- `Observation Evidence Guard` 已经进入 observe prompt。
- `standing_memory` 已经按 Seen / Inferred / Remembered / Do Not Treat As Seen 四段输出。
- 系统开始主动识别污染，并把污染范围量化到 17 条条目。

但核心漏洞还在。

模型已经会说“这不是 Seen”，但 `standing_memory` 更新器仍会把完整 `reportContext` 交给模型。模型可以从 `action_receipts`、日记、报告正文、partial receipt 的 summary 中重新摘取内容，再写回 `Seen`。

这里的第一性原理更简单：

> 记忆只能把亲眼见过的东西写进 Seen。  
> “别人说看见了”不是 Seen。

因此第四阶段不再加新的治理术语，也不继续扩展 forbidden 列表，而是在 `standing_memory` 写入路径上加硬门禁：`Seen` 只能来自 TDB 的 `seen`，并且要再过滤掉 partial / failed receipt 这类不适合进入长期事实层的状态。

### 第五阶段：自然语言可以是 Seen，但只能作为来源摘录

第四阶段之后又跑了 3 轮，新的问题浮出来了：如果把 Seen 继续理解成“机器字段才干净”，系统会变得过窄。

进化主体不是纯监控系统。很多关键事实本来就是自然语言：

- 探针到底调查了什么。
- 日记如何复盘一次执行。
- goal event 为什么判断目标需要 refine。
- receipt 为什么 partial。
- 人类意图和外部约束是什么。

如果把这些自然语言全部踢出 Seen，系统会只剩下 `status=ok`、`cycle_id=...` 这类骨架字段，却失去行动语义。

所以第五阶段把原则修正为：

> Seen 不是“事实为真”。  
> Seen 是“我直接读到了这个来源”。  
> Inferred 才是“所以我相信什么”。

因此自然语言可以进入 Seen，但必须写成来源摘录：

```text
source goal-event-64e87b99 claims: 当前目标包含已证伪假设
source evolution_event records: 本轮日记记录了 standing_memory 清理尝试
```

它不能写成：

```text
当前目标包含已证伪假设
standing_memory 清理已完成
```

这样既保留自然语言的表达力，又避免把“来源说了”误写成“事实成立”。

### 第六阶段：给 Seen 一个可重开的地址

第五阶段之后又跑了 3 轮，`source claims/records` 已经生效。自然语言不再直接写成事实结论，而是保留为来源摘录。

但新的问题也暴露出来了。

系统会在 `standing_memory` 中写：

```text
receipt-39273435
probe-result-337e44d3
goal-event-890f2c10
evt-e250de88
```

这些 id 看起来都像证据引用。但后续探针不知道它们应该去哪查，于是把 `receipt-*` 当作文件名在磁盘上搜索。搜索不到文件后，就得出“receipt 是幻影引用”的结论。

这可能是误判。

`receipt-*` 不一定对应单独的 `receipt-*.json` 文件。它可能存在于 action receipts 数据源中。`probe-result-*` 也不一定是同名文件，可能存在于 probe results store 中。

所以第六阶段回到更小的第一性原理：

> Seen 不只要有 id。  
> Seen 必须告诉下一轮“去哪儿重新打开它”。

也就是给每条 Seen 加一个可重开地址：

```text
[evolution_events:evt-xxx]
[goal_events:goal-event-xxx]
[action_receipts:receipt-xxx]
[probe_results:probe-result-xxx]
```

这样后续验证者不会再把所有 id 都当成文件名，而是按 `source_type` 去对应数据源查。

---

## 4. 实现要点

### 关键模块

| 文件 | 职责 |
| --- | --- |
| [`src/intelligence/decision-brief.mjs`](../../src/intelligence/decision-brief.mjs) | 新增 `buildTemporalDecisionBrief()`，按来源、时间和证据等级生成结构化 brief |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 在 `prepareIntelReport()` 中生成 brief；修正近期报告取样；收紧 standing memory 更新协议 |
| [`src/intelligence/conversation-prompts.mjs`](../../src/intelligence/conversation-prompts.mjs) | 在 report/decide prompt 中加入 `Temporal Decision Brief`，明确冲突裁决顺序 |
| [`src/intelligence/observation-guard.mjs`](../../src/intelligence/observation-guard.mjs) | 新增 `Observation Evidence Guard`，为 observe 阶段提供 schema guard、forbidden claim 和字段引用要求 |
| [`src/intelligence/conversational-intel-pipeline.mjs`](../../src/intelligence/conversational-intel-pipeline.mjs) | 将 guard 注入 `AIDrivenObserver` 的 rules，避免修改上游 `node_modules` |
| [`src/intelligence/specs.mjs`](../../src/intelligence/specs.mjs) | 新增 `claim_ledger` 数据源定义 |
| [`src/intelligence/store.mjs`](../../src/intelligence/store.mjs) | 新增 `recordClaimLedgerEntry()` 与 `readClaimLedger()` |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 更新数据源清单，新增 guard 和 TDB 分级测试 |
| [`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) | 验证 observe prompt 包含 guard，report prompt 中 TDB 位于 Observation Report 之前 |

### 关键变化

`readRecentReportMarkdowns()` 从 `.slice(-limit)` 改为 `.slice(0, limit)`。这是因为现有 store 的 `readLatestIntelReport()` 语义已经假设 `readIntelReports({ limit: 1 })[0]` 是最新报告；如果这里继续取尾部，就可能把“较旧的近期报告”误当作最近报告全文。

报告上下文新增 `historical_report_references`。它保留 `cycle_id`、`generated_at`、`md_path`、`tldr`，并明确 `use_policy`：这些报告只能作为历史 claim，需要先和 brief 及结构化证据核对。

prompt 层新增明确裁决规则：

```text
原始/直接文件证据 > 结构化机器记录 > 当前已验证 claim > 历史模型总结 > 人工意图
```

standing memory 更新也变成基于 brief 的 active 记忆维护：只保留仍被当前事实或结构化证据支持的结论；被削弱、证伪、替代的旧判断要降级、删除或明确标记；关键数值和状态判断应尽量引用 evidence refs 或 source cycle。

第二阶段又做了三项关键收紧：

1. **observe 前置 guard**  
   `Observation Evidence Guard` 明确要求：JSON 字段 claim 必须带 `source_path` 和 `json_pointer`。例如 `worker-state.json.remote.*`、`pipeline.*`、`queue.*`、`secrets.*`、`cycle3.*` 都属于 forbidden unless independently verified。

2. **Observation Report 降权**  
   report/decide prompt 中，`Temporal Decision Brief` 被放到 `Model Observation Claims` 之前。Observation Report 明确只是线索，不是权威事实源。

3. **TDB 拆分证据等级**  
   第一版 `current_facts` 会收纳 receipt/probe 的 summary。第二版改为：

   - `direct_evidence`
   - `structured_status`
   - `agent_claims`
   - `historical_claims`
   - `forbidden_or_refuted_claims`

   其中自然语言 summary 进入 `agent_claims`，不再默认是事实。

### 第三阶段简化实现

第三阶段没有删除旧字段，也没有继续扩展大型 claim ledger。它做的是兼容式收敛：旧结构继续存在，新上下文优先使用 Seen / Inferred / Remembered 语言。

| 文件 | 第三阶段变化 |
| --- | --- |
| [`src/intelligence/decision-brief.mjs`](../../src/intelligence/decision-brief.mjs) | 在 TDB 中新增 `seen`、`inferred`、`remembered`、`do_not_treat_as_seen` 兼容视图；`seen` 来自 `direct_evidence` 和 `structured_status`，`remembered` 来自 agent/historical/unverified claims |
| [`src/intelligence/conversation-prompts.mjs`](../../src/intelligence/conversation-prompts.mjs) | report/decide prompt 改为先读 `seen`，再读 `inferred`，最后读 `remembered`；Observation Report 明确归入 remembered/lead material |
| [`src/intelligence/observation-guard.mjs`](../../src/intelligence/observation-guard.mjs) | 保留 worker-state forbidden fields 等硬 guard，但文案收敛为 Seen / Inferred / Remembered 分类规则 |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | `standing_memory` 更新协议改为固定四节：Seen、Inferred、Remembered、Do Not Treat As Seen |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 验证 TDB 三栏视图存在，并确认 receipt summary 进入 remembered 而不是 seen |
| [`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) | 验证 observe/report/memory prompt 都包含三栏语言 |

数据流也变得更直观：

```mermaid
flowchart TD
  records["Files, Receipts, Events"] --> tdb["Temporal Decision Brief"]
  tdb --> seen["Seen"]
  tdb --> remembered["Remembered"]
  tdb --> blocked["Do Not Treat As Seen"]
  seen --> inferred["Inferred by Report and Decide"]
  inferred --> memory["Standing Memory"]
  remembered --> memory
  blocked --> memory
```

### 第四阶段写入门禁

第四阶段只改一个关键位置：[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) 的 `standing_memory` 更新流程。

以前 memory prompt 会收到完整机器上下文：

- `goal_events`
- `observations`
- `probe_results`
- `evolution_events`
- `action_receipts`
- `latest_review`
- `intel_reports_index`
- `historical_report_references`

这给了模型太多“重新解释”的空间。即使 prompt 说 `Seen` 只能来自 TDB，模型仍可能把 receipt summary 或 diary prose 当成 Seen 写回。

新的流程改成两层门禁：

| 层级 | 作用 |
| --- | --- |
| `memory_admission` | 给 memory prompt 的机器上下文只暴露准入后的 `seen`、`remembered`、`do_not_treat_as_seen`，不再暴露完整 receipts/reports/diaries |
| `enforceStandingMemorySeenGate()` | AI 输出后，用代码重写 `## Seen` 小节，确保最终写入的 Seen 只来自准入后的 TDB `seen` |

同时增加一条很窄的过滤：

- `partial` / `failed` 的 `action_receipt` 不进入 memory `Seen`。
- `agent_narrative` 不进入 memory `Seen`。
- 成功完成的 receipt 只能把结构化状态作为 Seen，不能把 summary 当 Seen。

这一步的重点不是“证明所有 claim”，而是把长期记忆中最危险的入口关掉：模型叙述、partial receipt、历史报告都不能再自己爬回 Seen。

### 第五阶段来源摘录语义

第五阶段没有新增大型 schema，也没有禁止自然语言。它只在两个位置加了最小语义边界。

| 文件 | 第五阶段变化 |
| --- | --- |
| [`src/intelligence/decision-brief.mjs`](../../src/intelligence/decision-brief.mjs) | `goal_event.reason/summary` 进入 Seen 时改写为 `source claims: ...`；`evolution_event.summary/tldr` 进入 Seen 时改写为 `source records: ...`；无自然语言 statement 时仍保留结构化状态式 Seen |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | `memory_admission.seen` 保留 `source claims/records` 文案；memory prompt 要求不得把这些来源摘录改写成事实结论；`enforceStandingMemorySeenGate()` 继续重写 `## Seen` 小节，确保最终写入保持来源摘录格式 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 增加回归测试，验证 `goal_event.reason` 在 TDB 和 standing memory 中都以 `source claims: ...` 出现 |

这里的关键变化不是字段数量，而是语义：

- `Seen`: 我读到了这个来源说了什么。
- `Inferred`: 我基于这些来源判断什么更可信。
- `Remembered`: 旧来源曾经这样说过。

### 第六阶段可重开地址

第六阶段继续保持轻量，只改 `standing_memory` 的 Seen 输出格式和 prompt 规则。

| 文件 | 第六阶段变化 |
| --- | --- |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 增加 source type 映射，把内部来源类型格式化为 `[source_type:id]`；`buildSeenSection()` 输出可重开地址；memory prompt 明确要求后续验证按括号里的 source type 查找，不要把 id 当文件名 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 更新回归测试，验证 `Seen` 输出 `[evolution_events:evt-safe]` 和 `[goal_events:goal-event-claim]` |

映射规则很小：

| 内部来源 | memory Seen 地址 |
| --- | --- |
| `evolution_event` | `[evolution_events:evt-...]` |
| `goal_event` | `[goal_events:goal-event-...]` |
| `action_receipt` | `[action_receipts:receipt-...]` |
| `probe_result` | `[probe_results:probe-result-...]` |

这不是大型 resolver，也不是 Claim Ledger。它只是把“这个 id 属于哪个数据源”写在记忆里。

### 第七阶段执行契约治理

第七阶段不是继续扩展证据分类，而是处理“系统已经看见问题，却无法执行落地”的断点。最新 3 轮验证后，问题从证据语义转向执行契约：

- `goals_assess` 连续高置信建议 refine，但 `goals_calibrate` 因 `invalid_proposed_goal` 跳过，目标 v9 一直写不进去。
- `standing_memory` 的 `Seen` 已有 `[source_type:id]`，但顶层 `evidence_refs` 仍是裸 id，机器消费者仍可能把 `receipt-*` 当文件名。
- `partial` receipt 即使 `success=true` 仍可能进入 Seen，与“未完成执行不能当事实”的原则冲突。
- 远端同步 action 声明 `permission_profile=read_only`，但任务又要求落盘脱敏摘要，权限声明和副作用不一致。

用第一性原理收敛后，只保留三个执行不变量：

| 不变量 | 含义 | 第七阶段实现 |
| --- | --- | --- |
| 契约一致 | 上游 AI 产物必须能被下游代码直接消费 | `proposed_goal` prompt 明确完整 goal shape；进入校验前只补缺失的 `children: []`，核心字段仍由强校验拒绝 |
| 证据可重开 | 进入 Seen 的证据必须能按 source type 和 id 重新打开 | `standing_memory` 新增 `typed_evidence_refs`；`action_receipt` 只有 `completed/succeeded` 才能进入 Seen |
| 副作用诚实 | 声明只读就不能要求写文件 | 决策 prompt 明确 `read_only` 不得落盘；`validateAgentRunSpec()` 对 read_only 写入/落盘/持久化意图给 warning |

涉及文件：

| 文件 | 第七阶段变化 |
| --- | --- |
| [`src/intelligence/goal-assessor.mjs`](../../src/intelligence/goal-assessor.mjs) | prompt 明确 `proposed_goal` 必须包含 `id/name/intent/good_signal/bad_signal/children`；新增 `normalizeProposedGoalShape()`，只补缺失的 `children: []` |
| [`src/cli/commands/goals.mjs`](../../src/cli/commands/goals.mjs) | `autoCalibrateGoals()` 在 `validateGoalShape()` 前使用归一化后的 proposed goal，打破缺 `children` 导致的 dead-letter refine |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | `buildMemoryAdmission()` 不再用 `success === true` 放行 partial receipt；写入 `typed_evidence_refs` |
| [`src/intelligence/conversation-prompts.mjs`](../../src/intelligence/conversation-prompts.mjs) | 决策约束说明 `read_only` 只能返回 receipt/evidence，不得要求写入、落盘、保存或持久化文件 |
| [`src/actions/agent-run-spec.mjs`](../../src/actions/agent-run-spec.mjs) | `validateAgentRunSpec()` 对 read_only 中出现写入/落盘/持久化意图的 run_spec 追加 warning |
| [`test/cli.test.mjs`](../../test/cli.test.mjs) | 覆盖缺 `children` 的高置信 `proposed_goal` 能归一化并写入 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 覆盖 `typed_evidence_refs` 与 `partial + success=true` 不进入 Seen |
| [`test/actions.test.mjs`](../../test/actions.test.mjs) | 覆盖 `read_only` + 写入意图产生 warning，而 `workspace_write` 不产生该 warning |

### 第八阶段执行边界修复

第八阶段继续围绕“系统看见问题后能否稳定执行”，但问题更具体：上一轮修复后，系统已经能写入 v9 目标、生成 `typed_evidence_refs`，也能阻止 partial receipt 进入 `Seen`。最新 3 轮又暴露出两个边界问题。

| 问题 | 现象 | 根因 |
| --- | --- | --- |
| receipt 语义被混判 | 审计把 `Seen` 中 9 条 `[action_receipts:...]` 判为违反 `Do Not Treat As Seen` | 代码允许 completed receipt 的结构化状态进入 Seen，但 prompt / DNTAS 文案容易被理解成“所有 receipt id 都禁止进入 Seen” |
| Analyze+Decide JSON 失败会杀死 cycle | `cycle-20260522-164013` 因 `Cannot extract JSON from AI response` 停在 `intel_report` 之后 | Analyze+Decide 阶段直接解析严格 JSON；一旦模型输出被截断或包裹文本无法解析，就进入外层失败路径 |

第八阶段的原则是只修执行边界，不再增加证据分类：

1. **receipt 分两层**  
   `action_receipt` 的结构化机器字段，例如 `status`、`success`、`provider`、`writes_applied`，可以作为 Seen；receipt 的 `summary/message/error`、审计结论、建议、推断仍只能作为 remembered/inferred，不能进 Seen。

2. **JSON 失败变成可审计 defer**  
   Analyze+Decide JSON 解析失败时，不把整轮 cycle 变成不可执行失败，也不凭空制造 action，而是保存 raw response 和解析错误，生成 `decision: defer`、`actions: []`、`error_code: invalid_ai_json` 的安全结果。

涉及文件：

| 文件 | 第八阶段变化 |
| --- | --- |
| [`src/ai/messages.mjs`](../../src/ai/messages.mjs) | 新增共用 `extractJsonFromText()`，支持 JSON 代码围栏、前后说明文本和首尾大括号截取；失败时保留前 500 字符错误信息 |
| [`src/intelligence/goal-assessor.mjs`](../../src/intelligence/goal-assessor.mjs) | 复用共用 JSON 提取器，避免 goal assessment 和 conversation pipeline 使用两套解析逻辑 |
| [`src/intelligence/conversational-intel-pipeline.mjs`](../../src/intelligence/conversational-intel-pipeline.mjs) | Analyze+Decide 解析失败时局部降级为 defer，并继续持久化 conversation context，不入队 action |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | `memory_admission.rule` 和 standing memory prompt 明确 completed receipt structured status 可 Seen，receipt summary/message/agent claim 不可 Seen |
| [`src/intelligence/conversation-context.mjs`](../../src/intelligence/conversation-context.mjs) | 语义验证 prompt 明确区分 `[action_receipts:...]` 结构化状态和 receipt agent claim，避免把所有 receipt id 泛化为违规 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 覆盖 receipt summary 不进入 Seen、goal assessment 能解析包裹 JSON |
| [`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) | 覆盖 Analyze+Decide 包裹 JSON 可解析、无效 JSON 安全降级且不入队 action |

### 第九阶段持久记忆门禁

第八阶段之后又跑了 3 轮，执行边界问题基本收敛：Analyze+Decide JSON 失败不再杀死 cycle，receipt 结构化状态和 agent claim 也能被审计区分。新的问题转移到 `standing_memory` 的持久性。

表面上，系统已经能通过 `workspace_write` 清理 `standing_memory.json`。但下一轮 `updateStandingMemoryWithAi()` 会基于旧 memory、report 和 `memory_admission.remembered` 全量重写。只要写入入口仍允许模型自由生成 `## Remembered`，人工清理过的短 id、孤立 receipt claim、重复 goal_event 或旧 remembered claim 就可能再次复活。

第九阶段的原则是：不要把清理放在事后手工编辑，而要放在每轮生成时的写入入口。

| 原则 | 含义 |
| --- | --- |
| `Seen` 继续硬门禁 | 最终 `## Seen` 仍只来自 `memory_admission.seen` |
| `Remembered` 也轻量门禁 | 最终 `## Remembered` 由过滤后的 `memory_admission.remembered` 生成 |
| 旧 memory 只作线索 | `Previous Standing Memory` 不能直接决定最终 `Seen/Remembered` |
| 不迁移数据库 | 不删除历史 JSONL，也不把 memory 改成完整 entry-array 结构 |

涉及文件：

| 文件 | 第九阶段变化 |
| --- | --- |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 扩展 `memory_admission.remembered`，标准化 `source_type/source_id/source_address/summary/remembered_policy`，过滤无可重开 source id 和旧 `standing_memory` 条目 |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 新增 `buildRememberedSection()`、`enforceStandingMemoryRememberedGate()` 和 `enforceStandingMemoryGates()`，在写入时同时重写 `Seen` 与 `Remembered` |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 对 receipt/probe/event 的 `agent_claim` 保留 `agent_claim:` 前缀；对重复 `goal_event` assessment 按目标、类型和摘要去重，优先保留最新记录 |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 更新 standing memory prompt，明确旧 memory 只是 continuity hint，直接编辑 `standing_memory.json` 不是持久修复 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 覆盖污染 Remembered 不复活、receipt summary 只以完整 `[action_receipts:...] agent_claim:` 进入 Remembered、重复 goal_event 只保留单条规范化记录 |

### 第十阶段执行事实三层契约

第九阶段之后又跑了 3 轮，`Seen` 和 `Remembered` 的写入门禁基本生效：`Seen` 能稳定保持 `[source_type:id]`，`Remembered` 也不再复活孤立短 id，而是以 `[action_receipts:...] agent_claim:` 形式保留线索。

但新的执行消费问题浮出来了：系统把三件事混在同一个 `status/partial` 里。

| 层次 | 旧问题 | 第十阶段含义 |
| --- | --- | --- |
| 执行层 | agent 实际完成了探针，但因为最终 JSON receipt 格式不合格被标成 partial | `execution_status` 表示任务是否真的完成、是否有 evidence/output、是否越权 |
| 格式层 | nested `{ receipt: {...} }` 或缺顶层 `summary` 会让机器消费者以为执行失败 | `schema_status` / `schema_missing` 单独表示 receipt 是否满足宿主 schema |
| 解释层 | verify/report/diary 会把模型总结当成事实，或者把 Remembered agent claim 当成结构缺口 | semantic verification 是最新解释层证据；`Remembered` 不需要进入 `typed_evidence_refs` |

第一性原理是：**下一轮应该相信最新可重开的执行事实，而不是相信上一轮模型怎么描述它。**

涉及文件：

| 文件 | 第十阶段变化 |
| --- | --- |
| [`src/actions/agent-adapter.mjs`](../../src/actions/agent-adapter.mjs) | `normalizeAgentResult()` / `validateAgentReceipt()` 前置支持 nested `{ receipt: {...} }` 提升；输出 `schema_status` 和 `schema_missing`；schema invalid 不再直接改写 agent 原始执行状态 |
| [`src/actions/handlers.mjs`](../../src/actions/handlers.mjs) | `agent_run` result 拆分 `execution_status`、`schema_status`、`acceptance_status`、`goal_progress_status`；有执行 evidence 但 schema invalid 时可保留 `goal_progress_status=progressed` |
| [`src/actions/handlers.mjs`](../../src/actions/handlers.mjs) | `actionVerifiers.agent_run.verify()` 暴露三层状态，把 `schema_invalid` 作为格式问题，而不是执行失败 |
| [`src/intelligence/decision-brief.mjs`](../../src/intelligence/decision-brief.mjs) | `actionReceiptStatuses()` 纳入 `execution_status`、`schema_status`、`acceptance_status`、`goal_progress_status`，供下一轮 TDB 结构化消费 |
| [`src/intelligence/conversation-context.mjs`](../../src/intelligence/conversation-context.mjs) | Phase 3 semantic verify prompt 明确区分执行事实、receipt schema、模型解释；同时说明 `typed_evidence_refs` 只用于 `Seen`，不要求 `Remembered agent_claim` 进入其中 |
| [`src/intelligence/goal-assessor.mjs`](../../src/intelligence/goal-assessor.mjs) | goal assessment context 标记 `verification.semantic` 的优先级高于旧 report/diary/remembered claim，但仍不把它升级成 Seen |
| [`src/intelligence/evolution-diary-builder.mjs`](../../src/intelligence/evolution-diary-builder.mjs) | diary context 增加 semantic verification 摘要和优先级提示，让日记用最新执行解释修正旧推断 |
| [`test/actions.test.mjs`](../../test/actions.test.mjs) | 覆盖 nested receipt 自动归一化、schema invalid 不抹掉 `execution_status=completed`、verifier 能区分格式问题与执行失败 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 覆盖 TDB `Seen` 包含三层 receipt 状态字段，且 receipt summary 仍只作为 Remembered agent claim |
| [`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) | 覆盖 semantic verify prompt 明确三层状态和 Remembered/typed_evidence_refs 边界 |

### 第十一阶段 Remembered 内容门禁

第十阶段之后又跑了 3 轮，执行事实三层契约基本生效：系统能区分执行完成、receipt schema 不合格和模型解释层判断；operator fact 也已进入情报系统，`skillType=freeze` 被补充为 tank 技能而不是账号冻结。

新的问题集中在 `standing_memory` 的 `Remembered` 内容层：第九阶段已经保证 Remembered 有完整 `[source_type:id]` 地址，也不再复活短 id；但只要上游 receipt summary、conversation context 或旧报告继续携带已证伪说法，`Remembered` 仍会以“有地址的线索”形式保存污染内容。格式正确不等于内容应该被长期记住。

第十一阶段的原则是：**已证伪 claim 不应该作为 Remembered lead 继续进入长期记忆。**

| 原则 | 含义 |
| --- | --- |
| 不手工清 memory | 不依赖 `workspace_write` 直接编辑 `standing_memory.json` |
| 在 admission 源头过滤 | 在 `normalizeRememberedItems()` 准入时过滤已证伪内容 |
| 先做小规则 | 只覆盖已经反复复活、可稳定描述的污染 claim |
| 不影响普通线索 | 普通 receipt summary 仍可作为 `[action_receipts:...] agent_claim:` 保留 |

涉及文件：

| 文件 | 第十一阶段变化 |
| --- | --- |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 新增 `REFUTED_REMEMBERED_PATTERNS` 和 `isRefutedRememberedClaim()`，在 `normalizeRememberedItems()` 内过滤已证伪 Remembered claim |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | 初始过滤 `remote_matchCount=847/4127`、虚构 pipeline 分数、login deadlock、worker zombie，以及把 `skillType=freeze` 误解为账号/发布通道冻结的说法 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 覆盖完整 source-addressed receipt claim 中的已证伪内容不会进入 `## Remembered`，同时正常 remembered lead 仍保留 |

### 第十二阶段 standing_memory 权威路径契约

第十一阶段之后又跑了 3 轮，内容门禁基本生效：`remote_matchCount=4127`、虚构 pipeline 分数、`freeze=账号冻结` 等旧污染没有进入最终 `standing_memory` 主文件；`skillType=freeze` 也稳定被理解为 tank 技能类型。更重要的是，目标校准终于落地，`active_goals.json` 从 `win-more-agentank-refined-v9` 更新到 `win-more-agentank-refined-v10`。

新的问题不是内容污染，而是**同名不同物**：多个探针都在说 `standing_memory.json`，但它们指向的不是同一个资源。

| 路径 | 角色 | 是否权威 |
| --- | --- | --- |
| `data/intelligence/memory/standing_memory.json` | intelligence store 的 active standing memory | 是 |
| `data/evolution/records/<cycle>/standing_memory.json` | cycle phase record / 快照 | 否 |
| `./standing_memory.json` | runtime root 下的不存在别名 | 否 |

第十二阶段的原则是：**不移动文件，修路径契约。** `standing_memory` 仍属于 subject runtime 下的 intelligence data，权威路径固定为 `data/intelligence/memory/standing_memory.json`。根目录 `./standing_memory.json` 的 ENOENT 只能说明非权威别名不存在，不能证伪 canonical memory。

涉及文件：

| 文件 | 第十二阶段变化 |
| --- | --- |
| [`src/actions/resource-registry.mjs`](../../src/actions/resource-registry.mjs) | 新增 `resource_kind=standing_memory`，匹配 canonical path `data/intelligence/memory/standing_memory.json`；资源推断改为同一 target 取最具体规则，避免被 `data/intelligence/**` 泛规则吞掉 |
| [`src/actions/agent-adapter.mjs`](../../src/actions/agent-adapter.mjs) | workspace prompt 和 Claude system prompt 增加 `standing_memory_canonical_path`，明确 `./standing_memory.json` 缺失只是 missing alias，不是 canonical memory 不存在 |
| [`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) | `normalizeStandingMemory()` 输出 `resource_kind/resource_scope/canonical_path/source_role/path_policy`，让 report context 自带路径语义 |
| [`src/intelligence/observation-guard.mjs`](../../src/intelligence/observation-guard.mjs) | 明确 `data/intelligence/memory/standing_memory.json` 是 canonical path，同时仍是 model-summary cache；根路径 ENOENT 不可当成 memory 不存在 |
| [`test/actions.test.mjs`](../../test/actions.test.mjs) | 覆盖 canonical memory 资源识别，以及 Claude prompt 包含 canonical path 契约 |
| [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) | 覆盖 report context 中 standing_memory path metadata |

---

## 5. 验证与测试

本轮做了两层验证。

第一层是编辑后的静态诊断：

```bash
ReadLints
```

结果：相关改动文件无 linter 错误。

第二层是项目测试：

```bash
npm test
```

第一次运行暴露了两个合理失败：

- `claim_ledger` 是新增数据源，测试里的 expected source list 需要更新。
- pre-decision report prompt 的测试要求不要出现 `decisions_queued`。新 brief 初版把完整 `current_cycle` 带进了 prompt，因此需要把 brief 的 `current_cycle` 改成预决策安全摘要，只保留 `cycle_id`、`mode`、`stage`、`note`。

修正后重新运行：

```bash
npm test
```

结果：4 个测试文件、185 个测试全部通过。

第二阶段补充测试后再次运行：

```bash
npm test
```

结果：4 个测试文件、187 个测试全部通过。

新增覆盖点包括：

- observe prompt 必须包含 `Observation Evidence Guard`、`worker-state.json.remote.*` 和 `json_pointer`。
- report prompt 中 `Temporal Decision Brief` 必须出现在 `Model Observation Claims` 之前。
- receipt summary 中即使写了 `worker-state.json.remote.matchCount is 4127`，也只能进入 `agent_claims`，不能进入 `current_facts`。

第三阶段简化实现后再次运行：

```bash
npm test
```

结果：4 个测试文件、187 个测试全部通过。

新增覆盖点包括：

- TDB 包含 `seen`、`remembered`、`do_not_treat_as_seen`。
- receipt/probe summary 这类自然语言 claim 不进入 `seen`，只进入 `remembered`。
- observe prompt 包含 `Seen / Inferred / Remembered`。
- report prompt 和 standing memory prompt 都使用 Seen / Inferred / Remembered 语言。

随后运行静态诊断：

```bash
ReadLints
```

结果：相关改动文件无 linter 错误。

第四阶段写入门禁补充了一个回归测试：

```bash
npm test -- test/intelligence.test.mjs
```

测试故意让 AI 生成污染的 standing memory：

```text
## Seen

- receipt-polluted: worker-state.json.remote.matchCount is 4127
```

最终断言写入后的 `Seen` 小节被代码门禁重写，只包含 TDB 准入后的 source id，不包含 `remote.matchCount`，并且 `evidence_refs` 不再记录 partial receipt。

结果：`test/intelligence.test.mjs` 37 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、188 个测试全部通过。

再运行静态诊断：

```bash
ReadLints
```

结果：[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs) 和 [`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) 无 linter 错误。

第五阶段来源摘录语义补充了两个回归测试：

```bash
npm test -- test/intelligence.test.mjs
```

新增覆盖点：

- `goal_event.reason` 进入 TDB `seen` 时，必须写成 `source claims: ...`，并标记为 `source_statement`。
- 如果 AI 在 standing memory 中把自然语言 Seen 写成事实结论，写入门禁会把它恢复成 `source claims: ...`。

结果：`test/intelligence.test.mjs` 39 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、190 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/intelligence/decision-brief.mjs`](../../src/intelligence/decision-brief.mjs)、[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) 无 linter 错误。

第六阶段可重开地址更新了回归测试：

```bash
npm test -- test/intelligence.test.mjs
```

新增覆盖点：

- `Seen` 不再只写裸 `evt-safe`，而是写 `[evolution_events:evt-safe]`。
- 自然语言 Seen 仍保持 `source claims`，但地址写成 `[goal_events:goal-event-claim]`。

结果：`test/intelligence.test.mjs` 39 个测试全部通过。

完整测试：

```bash
npm test
```

结果：4 个测试文件、190 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) 无 linter 错误。

第七阶段执行契约治理补充了三类回归：

```bash
npm test -- test/intelligence.test.mjs test/cli.test.mjs test/actions.test.mjs
```

新增覆盖点：

- 缺 `children` 的高置信 `proposed_goal` 会在写入前补 `children: []`，从而通过目标校准；缺核心字段仍然被拒绝。
- `standing_memory` 写入 `typed_evidence_refs`，与 `Seen` 中的 `[source_type:id]` 地址一致。
- `partial + success=true` 的 action receipt 不进入 `Seen`，只有明确 `completed/succeeded` 的 receipt 可以进入。
- `permission_profile=read_only` 但描述中要求写入、落盘或持久化时，`validateAgentRunSpec()` 返回 warning；`workspace_write` 不触发这个 warning。

结果：3 个测试文件、184 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、193 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/intelligence/goal-assessor.mjs`](../../src/intelligence/goal-assessor.mjs)、[`src/cli/commands/goals.mjs`](../../src/cli/commands/goals.mjs)、[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`src/intelligence/conversation-prompts.mjs`](../../src/intelligence/conversation-prompts.mjs)、[`src/actions/agent-run-spec.mjs`](../../src/actions/agent-run-spec.mjs)、[`test/cli.test.mjs`](../../test/cli.test.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs)、[`test/actions.test.mjs`](../../test/actions.test.mjs) 无 linter 错误。

第八阶段执行边界修复补充了两类回归：

```bash
npm test -- test/intelligence.test.mjs test/conversational-intel-pipeline.test.mjs
```

新增覆盖点：

- completed receipt 的结构化状态仍可进入 `Seen`，但 receipt summary 不进入 `Seen`。
- partial receipt 即使有 `success=true` 或 summary，也不会进入 `standing_memory` 的 `Seen`。
- goal assessment 能解析带前后文本和 JSON 代码围栏的响应。
- Analyze+Decide 能解析带前后文本和 JSON 代码围栏的响应。
- Analyze+Decide JSON 被截断或无法解析时，pipeline 安全降级为 `decision: defer`、`actions: []`、`error_code: invalid_ai_json`，不入队 action，也不让整轮 cycle 失败。

结果：2 个测试文件、52 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、196 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/ai/messages.mjs`](../../src/ai/messages.mjs)、[`src/intelligence/goal-assessor.mjs`](../../src/intelligence/goal-assessor.mjs)、[`src/intelligence/conversational-intel-pipeline.mjs`](../../src/intelligence/conversational-intel-pipeline.mjs)、[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`src/intelligence/conversation-context.mjs`](../../src/intelligence/conversation-context.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs)、[`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) 无 linter 错误。

第九阶段持久记忆门禁补充了 Remembered 写入入口回归：

```bash
npm test -- test/intelligence.test.mjs
```

新增覆盖点：

- AI 输出污染的 `Remembered` 会被代码门禁替换，不会保留短 id、孤立 receipt claim 或旧 memory 中的污染文本。
- completed receipt 的结构化状态仍保留在 `Seen`，receipt summary 只以完整 `[action_receipts:...] agent_claim:` 形式进入 `Remembered`。
- 重复 goal_event assessment remembered 项只保留最新或单条规范化记录。

结果：1 个测试文件、43 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、198 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) 无 linter 错误。

第十阶段执行事实三层契约补充了三类回归：

```bash
npm test -- test/actions.test.mjs
```

新增覆盖点：

- nested `{ receipt: {...} }` 会在校验前提升为顶层 receipt。
- 执行已经完成但 schema 缺字段时，`execution_status=completed`、`schema_status=invalid`，不再把执行事实伪装成 `partial`。
- `actionVerifiers.agent_run.verify()` 能区分 `schema_invalid` 和真正执行失败。

结果：1 个测试文件、56 个测试全部通过。

随后运行 intelligence 与 pipeline 聚焦测试：

```bash
npm test -- test/intelligence.test.mjs test/conversational-intel-pipeline.test.mjs
```

新增覆盖点：

- TDB / standing memory 的 `Seen` 包含结构化 receipt 三层状态字段，但不包含 receipt summary。
- verify prompt 明确 `Remembered` 的 `[action_receipts:...] agent_claim:` 不要求进入 `typed_evidence_refs`。
- 最新 semantic verification 可作为下一轮上下文中覆盖旧推断的解释层证据。

结果：2 个测试文件、55 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、201 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/actions/agent-adapter.mjs`](../../src/actions/agent-adapter.mjs)、[`src/actions/handlers.mjs`](../../src/actions/handlers.mjs)、[`src/intelligence/decision-brief.mjs`](../../src/intelligence/decision-brief.mjs)、[`src/intelligence/conversation-context.mjs`](../../src/intelligence/conversation-context.mjs)、[`src/intelligence/goal-assessor.mjs`](../../src/intelligence/goal-assessor.mjs)、[`src/intelligence/evolution-diary-builder.mjs`](../../src/intelligence/evolution-diary-builder.mjs)、[`test/actions.test.mjs`](../../test/actions.test.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs)、[`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) 无 linter 错误。

第十一阶段 Remembered 内容门禁补充了内容级过滤回归：

```bash
npm test -- test/intelligence.test.mjs
```

新增覆盖点：

- 完整 `[action_receipts:...] agent_claim:` 中如果包含已证伪 `remote_matchCount=4127` 或虚构 pipeline confidence，不会进入 `standing_memory` 的 `## Remembered`。
- 把 `skillType=freeze` 解释为账号冻结或发布通道锁定的说法会被过滤。
- 正常 remembered lead 不受影响，仍能作为带 source address 的线索保留。

结果：1 个测试文件、45 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、202 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) 无 linter 错误。

第十二阶段 standing_memory 权威路径契约补充了路径语义回归：

```bash
npm test -- test/actions.test.mjs test/intelligence.test.mjs
```

新增覆盖点：

- `data/intelligence/memory/standing_memory.json` 会被识别为 `resource_kind=standing_memory`、`resource_scope=subject_runtime`，而不是被泛化为普通 `intelligence_data`。
- Claude Code SDK 的 system prompt 会携带 `standing_memory_canonical_path`，并明确 `./standing_memory.json` 缺失只是非权威别名缺失。
- report context 中的 `standing_memory` 带有 `canonical_path/source_role/path_policy`，供后续 report、verify 和 diary 消费。

结果：2 个测试文件、102 个测试全部通过。

随后运行完整测试：

```bash
npm test
```

结果：4 个测试文件、203 个测试全部通过。

静态诊断：

```bash
ReadLints
```

结果：[`src/actions/resource-registry.mjs`](../../src/actions/resource-registry.mjs)、[`src/actions/agent-adapter.mjs`](../../src/actions/agent-adapter.mjs)、[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)、[`src/intelligence/observation-guard.mjs`](../../src/intelligence/observation-guard.mjs)、[`test/actions.test.mjs`](../../test/actions.test.mjs)、[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs) 无 linter 错误。

---

## 6. 后续演化

第一版已经把“以最新证据为准”从一句 prompt 提醒，推进成了可复用的上下文结构。但它仍然是轻量版。

后续可以继续做三件事：

1. **把 Claim Ledger 真正写起来**  
   现在已经有 `claim_ledger` 数据源和 store API，但还没有自动抽取和更新 claim 生命周期。下一步可以把关键报告结论持久化为 `active/refuted/unverified/superseded` 状态。

2. **让日记生成复用 Temporal Decision Brief**  
   当前日记构建仍有自己的 `recent_memory` 读取逻辑。后续可以让 `evolution-diary-builder` 也消费 brief，避免日记复盘再次把旧 claim 写成事实。

3. **增加真实回归样本**  
   可以用 `agentank-tank` 最近记录构造测试样本，验证“日记写入停滞”“worker-state 存在 sync 字段”“standing_memory 可逐条清理”等旧结论会被 brief 标记为 refuted 或 unverified。

第二阶段之后，后续重点也随之变化：

1. **让 guard 从静态规则走向 schema snapshot**  
   现在 `Observation Evidence Guard` 是针对高频幻觉的静态规则。下一步可以在 observe 前读取真实 `worker-state.json` schema，自动生成 allowed/forbidden 字段。

2. **给 report 结果做 claim audit**  
   standing_memory 仍然主要依赖 prompt 自律。更稳的方案是 report 生成后先做 claim audit，命中 forbidden pattern 的段落不能进入 active memory。

3. **让 Claim Ledger 记录“幻觉复活”**  
   不仅记录 claim 当前状态，还要记录 `last_seen_cycle`。如果同一个 forbidden claim 多轮复活，系统应该升级为管道缺陷，而不是每轮重新发现。

第三阶段之后，后续重点再次收敛：

1. **观察三栏语言是否真的降低记忆污染**  
   接下来可以继续跑多轮 `agentank-tank` 进化，重点检查 `standing_memory` 是否仍会把 remembered 线索写成 seen 事实。

2. **让日记也采用同一套三栏语言**  
   当前 report/decide/observe/memory 已经统一，日记生成仍可以进一步消费 TDB 的 `seen`、`inferred`、`remembered`，避免复盘文本重新混淆证据状态。

3. **少加规则，多看失败样本**  
   第三阶段的原则是不再轻易扩展 forbidden 列表。只有当某类错误反复复活，并且能被稳定描述时，才把它沉淀为硬 guard。

第四阶段之后，下一步更具体：

1. **跑几轮验证污染是否复发**  
   重点检查新生成的 `standing_memory`：`Seen` 是否只来自 `memory_admission.seen`，partial receipt 和 agent narrative 是否还会回流。

2. **清理现有 standing_memory 中的旧污染**  
   写入门禁只能防止新污染进入，不能自动修复已经存在的旧文本。后续可以执行一次明确的 memory 清理，把已识别的污染 receipt 从 `Seen` 移到 `Remembered`，并保留必要的 `Do Not Treat As Seen`。

3. **再处理目标和队列**  
   目标中的 `std<40 / 429=0` 这类不可验证指标、以及 pending decisions 的可归档积压，仍然需要处理。但顺序应该在 memory 写入门禁稳定之后。

第五阶段之后，后续验证要换一个问题问：

1. **Seen 是否保持“来源摘录”语义**  
   重点看新 memory 中是否还会把 `source claims/records` 改写成直接结论。

2. **Inferred 是否承担判断职责**  
   如果系统认为“目标需要 refine”或“清理未完成”，这些判断应该出现在 Inferred，并引用对应 Seen，而不是直接塞进 Seen。

3. **observe 阶段仍需后续处理，但不是当前优先级**  
   observe 仍可能把目录树推断写得像直接读取文件。当前先确保 TDB 和 standing memory 不把这种说法升级为长期事实。

第六阶段之后，下一轮要验证的是：

1. **后续探针是否还把 receipt id 当文件名搜索**  
   如果 memory 写成 `[action_receipts:receipt-xxx]`，探针应该去 action receipts 数据源查，而不是搜索 `receipt-xxx.json`。

2. **Seen 是否都带可重开地址**  
   新生成的 `standing_memory` 中，Seen 条目应统一是 `[source_type:id] ...` 形式。

3. **基于 source type 的验证是否能减少误判**  
   如果 `receipt-*` 能在 action receipts 数据源中找到，就不应再被称为“幻影文件引用”。

第七阶段之后，后续重点变为执行消费：

1. **确认 v9 是否能真正写入 active goals**  
   下一轮应检查 `goals_calibrate` 是否从 `invalid_proposed_goal` 变为 `applied`，以及 `active_goals.json` 是否从 v8 更新到 v9。

2. **让消费者优先使用 `typed_evidence_refs`**  
   目前旧 `evidence_refs` 仍为兼容保留。后续代码和探针应优先读取 `typed_evidence_refs`，逐步减少裸 id 的使用。

3. **把权限 warning 升级为决策反馈**  
   当前 `read_only` 写入意图是 warning。后续可以把它反馈到决策队列或验证报告，让模型自动改成“只读 evidence”或拆出 `workspace_write` action。

第八阶段之后，后续验证重点是：

1. **确认 receipt 不再被误判为整体违规**  
   新一轮审计应区分 `[action_receipts:...]` 的结构化状态和 receipt summary/agent claim。前者不应再被统计为 `Do Not Treat As Seen` 违规。

2. **观察 invalid AI JSON 是否变成可恢复事件**  
   如果 Analyze+Decide 再次输出截断 JSON，cycle 应记录 `invalid_ai_json` 并 defer，不应让 worker task 失败。

3. **再考虑同会话重试和 max_tokens**  
   当前先做安全降级。若截断 JSON 仍高频出现，可以进一步加“同会话只修 JSON”的重试，以及为 decide/verify 设置更明确的 token 上限。

第九阶段之后，后续验证重点是：

1. **确认 Remembered 污染不会跨轮复活**  
   新一轮应重点检查 `standing_memory` 中是否仍出现孤立 `receipt-xxxx` 短 id、旧 memory 污染文本或重复 goal_event remembered claim。

2. **观察 Do Not Treat As Seen 是否仍需门禁**  
   当前 `Do Not Treat As Seen` 仍由模型维护。只有当 blanket receipt 禁令或旧污染全文继续复活时，才考虑把它也收敛为轻量 admission/gate。

3. **把持久修复转向 admission 源头**  
   后续不应再依赖 `workspace_write` 直接编辑 `standing_memory.json` 作为长期解法。真正持久的修复应进入 `memory_admission`、TDB 或对应原始记录的生成逻辑。

第十阶段之后，后续验证重点是：

1. **观察 schema invalid 是否不再污染执行判断**  
   后续 verify report 应把“执行有证据但 receipt schema 不合格”写成格式层问题，而不是把 action 简化为执行失败或无进展。

2. **确认 Remembered 不再被报成 typed_evidence_refs 缺口**  
   `[action_receipts:...] agent_claim:` 是背景线索，只要有完整可重开地址，就不应被当成 Seen 结构缺失。

3. **检查 semantic verification 是否能覆盖旧推断链**  
   如果新一轮直接证据证伪了 worker 僵死、memory 污染等旧判断，goal assessment 和 diary 应优先采用最新 semantic verification，而不是继续复制旧 report 叙事。

第十一阶段之后，后续验证重点是：

1. **确认内容污染不再以“有地址线索”复活**  
   新一轮应检查 `standing_memory` 的 `## Remembered`，确认 `remote_matchCount=4127`、虚构 pipeline 分数、worker zombie、`freeze=账号冻结` 等已证伪 claim 不再出现。

2. **观察规则是否过窄或过宽**  
   当前过滤器是小规则，不是通用真伪判断器。若新的固定污染 claim 反复复活，再加入 pattern；若正常 tank 技能线索被误伤，则缩小 `freeze` 相关匹配范围。

3. **把内容门禁逐步接到 Claim Ledger**  
   当前规则是代码常量。长期更稳的形态是从 `operator_fact`、`Do Not Treat As Seen` 或 `claim_ledger` 中生成 refuted claim 集合，而不是继续人工维护固定 pattern。

第十二阶段之后，后续验证重点是：

1. **确认探针不再把 root ENOENT 当作 memory 不存在**  
   下一轮如果探针读取 `./standing_memory.json` 失败，应报告为非权威别名缺失；只有读取 `data/intelligence/memory/standing_memory.json` 的结果才能判断 active memory 是否存在。

2. **区分 active memory 与 cycle record 快照**  
   `data/evolution/records/<cycle>/standing_memory.json` 只能用于审计某轮 phase 产物，不能反过来覆盖 active memory 的存在性或内容判断。

3. **检查 v10 目标是否消费新契约**  
   `verify-auditable-memory` 子目标应围绕 canonical path 的可审计性展开，而不是重新触发“清理不存在的 Remembered 区”叙事。

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 进化工作流调用多篇历史内容时，没有充分注明时间，也没有明确要求按最新结论裁决，导致旧结论可能继续污染后续轮次 |
| 思考 | 第一性原理下，持续演化系统不能依赖语言连续性维持记忆，而要依赖证据状态维持记忆；20 轮后进一步确认污染源在 observe 阶段更早出现；继续加治理术语又会让系统过度复杂；3 轮三栏验证后确认 prompt 语言不足以阻止污染回流；后续又确认自然语言不能被排除，问题是不能把“来源说了”写成“事实成立”；再后续发现裸 id 会让探针误把数据源记录当文件名搜索；最新 3 轮则显示系统已能发现问题，但目标、memory、权限三个执行契约不能稳定消费发现；再后一轮暴露的是执行边界问题：receipt 结构化状态与 agent claim 被混判，Analyze+Decide JSON 失败会杀死 cycle；第九阶段则确认直接编辑 `standing_memory.json` 不能持久，因为下一轮全量重写会复活旧 Remembered 污染；第十阶段进一步确认系统把执行是否完成、receipt 格式是否合格、模型如何解释执行结果混成了一个 `partial`；第十一阶段则确认格式正确的 Remembered 仍可能携带已证伪内容，必须在 admission 源头过滤；第十二阶段确认问题转为同名不同物，root ENOENT、cycle 快照和 canonical memory 被混成一个资源 |
| 方案 | 第一阶段新增 `Temporal Decision Brief`；第二阶段新增 `Observation Evidence Guard`，并把 Observation Report 降级为模型 claim；第三阶段统一为 Seen / Inferred / Remembered / Do Not Treat As Seen；第四阶段把 memory Seen 改成代码层写入门禁；第五阶段把自然语言 Seen 统一为 `source claims/records` 来源摘录；第六阶段给 Seen 加 `[source_type:id]` 可重开地址；第七阶段收敛为契约一致、证据可重开、副作用诚实三个执行不变量；第八阶段统一 receipt 结构化状态/agent claim 边界，并把 invalid AI JSON 转成可审计 defer；第九阶段把 Remembered 也改为由 `memory_admission.remembered` 驱动的轻量代码门禁；第十阶段把 agent_run 结果拆成执行层、格式层、解释层三层契约；第十一阶段为 Remembered 增加 refuted claim 内容门禁；第十二阶段固定 standing_memory canonical path 契约 |
| 执行 | 新增 `decision-brief` 和 `observation-guard`，接入 observe/report/decide/memory 链路，降权历史 Markdown 和 receipt summary，收紧 standing memory，并预留 `claim_ledger`；随后在 TDB、prompt、observe guard、standing memory 中统一三栏语言；在 `report-builder` 中加入 `memory_admission` 与 `enforceStandingMemorySeenGate()`；让 `goal_event`/`evolution_event` 自然语言进入 Seen 时保持来源摘录语义；把 Seen 输出改为 `[evolution_events:...]`、`[goal_events:...]`、`[action_receipts:...]`、`[probe_results:...]`；补齐 `proposed_goal.children` 归一化、`typed_evidence_refs`、partial receipt 门禁和 read_only 写入 warning；最后增加共用 JSON 提取器、Analyze+Decide invalid JSON defer 降级，并更新 receipt policy / verify prompt；随后扩展 `memory_admission.remembered`、新增 Remembered gate，并在写入时统一应用 `enforceStandingMemoryGates()`；之后增加 nested receipt 归一化、拆分 `execution_status/schema_status/acceptance_status`，并让 TDB、verify、goal assessment、diary 消费三层状态；随后新增 `isRefutedRememberedClaim()`，过滤已证伪 remembered claim；本轮新增 `resource_kind=standing_memory`、canonical path prompt、report context path metadata 和 observation guard 路径契约 |
| 验证 | `ReadLints` 无错误；第一阶段 `npm test` 185 项通过，第二阶段和第三阶段 `npm test` 187 项通过，第四阶段 `npm test` 188 项通过，第五、第六阶段 `npm test` 190 项通过，第七阶段 `npm test` 193 项通过，第八阶段 `npm test` 196 项通过，第九阶段 `npm test` 198 项通过，第十阶段 `npm test` 201 项通过，第十一阶段 `npm test` 202 项通过，第十二阶段 `npm test` 203 项通过 |
