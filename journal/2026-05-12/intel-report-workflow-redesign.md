# Intel Report 工作流重设计与实现记录

> 日期：2026-05-12
> 项目：js-evolution-agent
> 类型：架构设计 / 功能实现 / 调研分析
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)

---

## 1. 背景与动机

本次工作从一个运行流程问题开始：分析 `run.mjs` 在调用 LLM 时，是否会把 `runtime/subjects/js-evolution-agent/data/intelligence/goal_events/goal-events.jsonl` 全量作为上下文导入。

初步结论是：当前仓库内可确认的 LLM 调用并不会把 `goal-events.jsonl` 整份塞入上下文。`buildIntelReport` 阶段不读取 `goal_events`；目标审计阶段会读取最近 goal events，但默认只取有限条数。

随后进一步检查 `buildIntelReport` 从情报库读取材料的逻辑，发现它主要通过 `gatherEvidence(store)` 读取小窗口摘要：

- `intel_observations`：最近 7 天，最多 5 条。
- `probe_results`：最多 5 条。
- `retrospectives`：最多 3 条。
- `evolution_events`：最多 5 条。

它没有读取 `goal_events`、`action_receipts`、`intel_reports`、`latest_review`、`probe_threads` 等历史与闭环材料。因此，当前 report 更像轻量本轮速记，不足以支撑长期趋势判断、目标历史理解和执行结果闭环分析。

用户补充说明当前使用的 LLM 支持约 1,000,000 总上下文，因此希望重新设计 report 生成流程。讨论中提出一个关键建议：在 prompt 结构里加入一个固定容量区域，作为整体情况的概要记忆。这个建议被采纳为新设计核心，即 `standing_memory`。

---

## 2. 分析过程

分析范围集中在以下文件：

| 文件 | 发现 |
| ---- | ---- |
| `run.mjs` | Phase 1.5 调用 `buildIntelReport`，发生在执行管线之前。 |
| `src/intelligence/report-builder.mjs` | `buildIntelReport` 使用 `gatherEvidence` 构造报告上下文，原逻辑读取范围很窄。 |
| `src/intelligence/store.mjs` | Store 已有部分写入能力，如 `recordActionReceipt`、`recordGoalEvent`、`recordIntelReport`，但缺少对应报告阶段需要的读接口。 |
| `src/intelligence/specs.mjs` | 已有多个 intelligence source，但没有固定容量整体概要记忆源。 |
| `test/intelligence.test.mjs` | 已覆盖原有 `gatherEvidence`、`buildPrompt`、`buildIntelReport` 行为，需要扩展。 |

关键判断：

1. 大上下文不意味着应该无脑全量平铺。更稳妥的方式是分层组织：权威文献、概要记忆、本轮事实、近期完整情报、历史索引。
2. `standing_memory` 应该是固定容量、跨轮滚动维护的整体态势摘要，而不是无限追加日志。
3. 报告生成应消费旧 `standing_memory`，但不能被旧记忆绑架；新证据可以修正、降级或推翻旧判断。
4. 由于当前 `run.mjs` 的 report 在 exec pipeline 前生成，本轮执行结果不应强行纳入 Phase 1.5。第一版先利用历史 `action_receipts` 补足执行闭环。

---

## 3. 方案设计

最终方案是把 `buildIntelReport` 从“少量近期摘要 + 本轮事实”升级为“权威文献 + 固定容量概要记忆 + 丰富情报证据 + 本轮事实”的综合报告生成。

上下文分区：

- 权威文献：`agentContextDocs` 全文，仍然是最高约束。
- 固定容量概要记忆：`standing_memory`，记录跨轮整体态势。
- 当前目标与目标历史：`active_goals` + `goal_events`。
- 本轮事实：`intelResult` 的 cycle、actions、decisions queued。
- 丰富情报证据：扩大后的 observations、probe results、retrospectives、evolution events、action receipts、latest review。
- 历史报告记忆：`intel_reports` index 和最近若干 report Markdown 全文。
- 生成任务：要求报告引用证据 id，并指出 standing memory 应如何更新。

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| 整体记忆形式 | 新增 `standing_memory` 单文档情报源 | 固定容量、易读写、可跨轮持续维护。 |
| 存储策略 | `single_json` | `js-intel-store` 已支持，避免引入新存储策略。 |
| report context | 新增 `gatherReportContext`，保留 `gatherEvidence` | 扩展能力同时兼容旧测试和旧调用。 |
| prompt 结构 | 明确阅读顺序：权威文献 -> standing memory -> 证据 | 降低大上下文下模型失焦风险。 |
| memory 更新 | report 写入后尝试更新，失败不阻断 | 保持 report 主流程可用性。 |
| 执行闭环 | 纳入历史 `action_receipts`，暂不改 `run.mjs` 阶段顺序 | 避免扩大本次改动边界。 |

---

## 4. 实现要点

### 项目结构

```text
js-evolution-agent/
├── src/
│   └── intelligence/
│       ├── specs.mjs
│       ├── store.mjs
│       └── report-builder.mjs
├── test/
│   └── intelligence.test.mjs
└── journal/
    └── 2026-05-12/
        └── intel-report-workflow-redesign.md
```

### 关键模块

| 文件 | 职责 |
| ---- | ---- |
| `src/intelligence/specs.mjs` | 新增 `standing_memory` 数据源。 |
| `src/intelligence/store.mjs` | 增加 `readActionReceipts`、`readProbeThreads`、`readStandingMemory`、`recordStandingMemory`。 |
| `src/intelligence/report-builder.mjs` | 新增 `gatherReportContext`，扩展 prompt，增加 standing memory 更新步骤。 |
| `test/intelligence.test.mjs` | 覆盖新增情报源、report context、prompt、memory update、fallback 和 index 元数据。 |

### 具体实现

新增 `standing_memory` spec：

```js
new DataSourceSpec({
  name: 'standing_memory',
  description: 'Fixed-capacity rolling summary of the subject state for report generation.',
  storageType: 'single_json',
  subdir: 'memory',
  filename: 'standing-memory.json',
})
```

新增更完整的 report context 默认窗口：

```js
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
```

`gatherReportContext` 现在汇集：

- `standing_memory`
- `active_goals`
- `active_goals_flat`
- `goal_events`
- `observations`
- `probe_results`
- `retrospectives`
- `evolution_events`
- `action_receipts`
- `latest_review`
- `intel_reports_index`
- `recent_report_markdowns`
- `source_counts`
- 兼容旧逻辑的 `evidence`

Prompt 重写后新增要求：

- 先读权威文献。
- 再读 `standing_memory`。
- 再读目标、历史、本轮事实和情报材料。
- 不得让旧记忆覆盖新证据。
- 报告要覆盖本轮事实、长期趋势、证据不足、风险、下一轮建议，以及 standing memory 应如何更新。

Standing memory 更新逻辑：

- `buildIntelReport` 先生成并写入 report Markdown。
- 然后调用 memory update prompt 生成新版概要记忆。
- 写入 `store.recordStandingMemory`。
- 如果 LLM 不可用或更新失败，记录状态但不阻断 report 生成。

`indexRecord` 增加审计元数据：

- `context_source_counts`
- `standing_memory_used`
- `standing_memory_updated`
- `standing_memory_update_status`
- `standing_memory_update_error`
- `recent_report_count`
- `action_receipt_count`
- `goal_event_count`

---

## 5. 验证与测试

完成后执行了 IDE 诊断检查：

```text
No linter errors found.
```

随后运行测试：

```powershell
npm test
```

结果：

```text
Test Files  3 passed (3)
Tests       75 passed (75)
```

新增或扩展的测试覆盖：

- `INTELLIGENCE_SPECS` 包含 `standing_memory`。
- `IntelligenceStore` 能记录和读取 action receipts、standing memory。
- `gatherReportContext` 会包含 `goal_events`、`action_receipts`、`intel_reports`、`latest_review`、最近 report Markdown 和 source counts。
- `buildPrompt` 在传入 report context 时包含 `standing_memory` 固定容量区域。
- AI report 仍可原样写出，不强制 schema。
- standing memory 更新成功时会写入 store。
- standing memory 更新失败不会阻断 report 写入。
- `indexRecord` 记录新增的情报计数和 memory update 状态。

---

## 6. 后续演化

近期可以继续演化的方向：

- 观察实际运行后 `standing_memory` 的质量，必要时把 memory update prompt 改为结构化 JSON 输出，再渲染为 Markdown 文本。
- 如果未来需要 report 覆盖本轮执行结果，可以评估把 report 生成移动到 Phase 3 后，或生成两份报告：pre-exec intel report 与 post-exec review report。
- `probe_threads` 当前只增加了读接口，尚未在 report context 中默认展开。后续可按引用展开相关 probe thread，避免噪声。
- 可以增加 `context_source_counts` 的 CLI 展示，帮助操作者快速确认每轮 report 实际消费了多少情报。
- 当情报规模进一步增大时，可加入引用展开策略：近期全文 + 长期索引 + 被 evidence refs 命中的历史原文。

---

记录时间：2026-05-12 10:32:33 +08:00。
