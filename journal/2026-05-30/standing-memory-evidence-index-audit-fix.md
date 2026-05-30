# Standing Memory 又冻住了：不是 disabled，是 Evidence 索引与 audit 门禁打架

> 日期：2026-05-30  
> 项目：js-evolution-agent  
> 类型：问题排查 / 功能实现  
> 来源：Cursor Agent 对话（ai-researcher daemon 连续 11 轮 standing_memory audit 失败；Phase 3b 累积影响分析）

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

ai-researcher 主体在 daemon step 模式下连续演化时，`standing_memory` 自 bootstrap 后 **11 轮 Phase 3b 全部写入失败**，`data/intelligence/memory/standing_memory.json` 冻结在 2026-05-30 09:54 的空态（Current State 为 `(none)`，Evidence 仅 2 条初始化记录）。

与此同时，真实进展已在积累：action receipts 23+、observations 8+、validated beliefs、多轮 evolution diary。Decide 与 evolution diary 反复读到 index 里的 `standing_memory_update_error: disabled`，误判为「引擎层配置问题」，形成 meta 循环 defer。

05-29 已为 Current State / Remembered 加了 free-text 门禁（见 [`standing-memory-free-text-gates.md`](../2026-05-29/standing-memory-free-text-gates.md)）。本轮要回答的不是「audit 要不要更严」，而是：**Evidence 段本应是机器索引，为什么会被叙事门禁整段打回？**

---

## 2. 分析过程

### 2.1 「disabled」与「failed」是两层不同的事

| 阶段 | 行为 | 记录字段 |
| --- | --- | --- |
| intel_report 持久化 | 刻意跳过更新（避免与 Phase 3b 重复） | `standing_memory_update_status: skipped`, `reason: disabled` |
| Phase 3b standing_memory | **会执行**，但 audit 失败 | `status: failed`, `audit-failed:free_text:evidence:unicode_ellipsis,free_text:evidence:pollution` |

index 里的 `disabled` 只反映 intel_report 步骤；**不能代表 Phase 3b 是否在跑**。diary / Decide 把两者混写，是后续 meta 环的一部分。

### 2.2 根因链（本地复现）

```mermaid
flowchart LR
  TDB_seen[TDB seen 含 diary/assess 长叙事]
  summarize[summarizeSeenItem 用 shortText 加 …]
  compose[compose Evidence 段]
  audit[auditStandingMemoryFreeText 扫 Evidence]
  TDB_seen --> summarize --> compose --> audit
  audit --> fail[写入失败 / 记忆冻结]
```

对 ai-researcher 当前 runtime 调用 `prepareIntelReport` → `buildMemoryAdmission` → `composeStandingMemoryMarkdown` → `auditStandingMemoryMarkdown`：

- 修前：`audit.ok === false`，issues 含 `free_text:evidence:unicode_ellipsis` 与 `free_text:evidence:pollution`
- 典型失败行：Evidence 段由代码生成，却含 evolution_diary 长摘要经 `shortText(..., 180)` 截断后的 **`…`**，以及正文里的 `agent_claim` 字样

### 2.3 第一性原理：standing_memory 真正需要什么

跨周期系统从 `standing_memory` 只需两类东西（与 05-28 设计一致）：

1. **可重开的事实索引**：`[source_type:id]` → 回源读正文，不复制 narrative  
2. **少量当前判断**：Current State（≤5 条），每条挂 Evidence 地址  

**Evidence 里出现 diary 正文、goal assess 理由、`…` 截断，说明职责边界被打破**——不是 audit「太严」，是 admission + 格式化把 TDB 叙事塞进了索引层。

### 2.4 与 05-29 的关系

05-29 给 **LLM 叙事层**（Current State）加了 free-text 门禁，并把 Evidence 的 `agent_claim:` 等纳入结构 audit。但未解决：

- `buildMemoryAdmission` 仍把 evolution_diary / goal assess 的 `source_statement` 长摘要写入 Evidence  
- `shortText()` 在 Evidence 路径产出 Unicode `…`，与 free-text 门禁冲突  
- fallback 仍用同一 admission 重 compose，**11 轮零写入**

Journal 2026-05-29 §6 已预见「Evidence 摘要的 `…` 与探针冲突」——本轮是对齐写入侧与门禁 scope 的落地。

---

## 3. 方案设计

核心原则：**Evidence 只允许「地址 + 结构化字段标签」；需要读正文才能理解的内容，只保留地址，正文回源。**

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 主修复层 | Admission + 索引格式化（Layer 1） | 从第一性职责入手；比 blanket 豁免 audit 或改 daemon 配置更根本 |
| goal assess 叙事 | 排除 `goal_event` + `source_statement` 进 Evidence | 已在 Remembered；Evidence 不应复制 assess 理由 |
| Evidence 摘要函数 | 新增 `summarizeEvidenceIndexItem`，禁用 `shortText()` | 消除 Unicode `…`；`source_statement` 解析为 `type=… status=…` 等 |
| free-text audit scope | 不再扫 Evidence 叙事；只守 Current State | Evidence 由代码生成 + 结构 `EVIDENCE_SECTION_POLLUTION_PATTERNS` 守护 |
| fallback | `buildMinimalSafeAdmission` + 重 compose | 主路径 audit 失败时保证 liveness，避免再次冻结 |
| TDB broad seen | **不改** [`decision-brief.mjs`](../../src/intelligence/decision-brief.mjs) | standing_memory 专用收紧只在 `buildMemoryAdmission` |

### 被否定的备选

| 备选 | 为何不选 |
| --- | --- |
| Evidence 段 audit 全豁免 | 掩盖 admission 错误；未来真污染无检测 |
| 全局改 `shortText` 去掉 `…` | 影响 report/prompt 多处；未解决 narrative 进 Evidence |
| 仅加 `report_builder.json` rolling_update | refs 数量问题，非本轮根因 |
| operator_fact / 手改 standing_memory | 运维兜底，非引擎修复；违反 OADA |
| 修改 intel_report 的 `updateStandingMemory: false` | 设计如此：Phase 3b 负责更新 |

### 三层改动

```text
Layer 1  summarizeEvidenceIndexItem + buildMemoryAdmission 过滤 + backfill 路径
Layer 2  auditStandingMemoryFreeText 移除 Evidence 叙事检查
Layer 3  buildMinimalSafeAdmission + updateStandingMemoryWithAi fallback
```

---

## 4. 实现要点

主文件：[`src/intelligence/report-builder.mjs`](../../src/intelligence/report-builder.mjs)

| 符号 | 职责 |
| --- | --- |
| `summarizeEvidenceIndexItem` | Evidence 专用索引摘要；`parseSourceStatementIndexSummary` 按 `source_type` 解析，避免 `evolution_diary ok` 误判为 `belief_id` |
| `buildMemoryAdmission` | 排除 goal assess 叙事；`summary` 改走索引格式化 |
| `summarizeBackfillRecord` | rolling backfill 同行走路径，不再 `shortText(..., 260)` |
| `auditStandingMemoryFreeText` | 仅审 Current State / Remembered orphan / Do Not Treat；Evidence 不交叙事门禁 |
| `buildMinimalSafeAdmission` | 过滤并重写为结构化摘要 |
| `updateStandingMemoryWithAi` | 主 audit 失败 → minimal admission + `fallback_reason: primary_audit_failed` |

测试：[`test/intelligence.test.mjs`](../../test/intelligence.test.mjs)

- 更新 goal assessment / free-text audit 断言  
- 新增长 diary + goal assess 回归、minimal safe admission 用例  

未改：[`conversational-intel-pipeline.mjs`](../../src/intelligence/conversational-intel-pipeline.mjs) intel_report 阶段 `updateStandingMemory: false`（设计保留）。

---

## 5. 验证与测试

```powershell
cd d:\github\my\js-evolution-agent
npm test -- test/intelligence.test.mjs
npm test -- test/conversational-intel-pipeline.test.mjs
npm test
```

结果（2026-05-30 实现当日）：

| 命令 | 结果 |
| --- | --- |
| `test/intelligence.test.mjs` + conversational | **82 passed** |
| 全量 `npm test` | **395 passed** |

本地 ai-researcher runtime 复现脚本（`prepareIntelReport` → admission → compose → audit）：

| 指标 | 修前 | 修后 |
| --- | --- | --- |
| `audit.ok` | `false` | **`true`** |
| `admission.seen` 条数 | 29（8 条污染 Evidence） | 22（结构化索引） |

未在本篇执行的运行时 smoke（daemon 需加载新代码后下一轮 Phase 3b）：

- `runtime/subjects/ai-researcher/data/evolution/records/<cycleId>/standing_memory.json` → `outputs.status: updated`  
- `data/intelligence/memory/standing_memory.json` → `updated_at` 晚于 bootstrap，`Evidence` 含 receipt 结构化行、无 `…`

---

## 6. 后续演化

| 项 | 建议 |
| --- | --- |
| daemon smoke | 重启或等 worker 加载新代码后，确认 ai-researcher 下一轮 Phase 3b `standing_memory_update.status === updated` |
| meta 环 | `standingMemoryClaim` 只传 cycle_id/hash，不传整段 `text`（[`decision-brief.mjs`](../../src/intelligence/decision-brief.mjs) L413-424） |
| rolling_update | ai-researcher 可选配 `data/config/report_builder.json`；Layer 1 修好后非必须 |
| 探针口径 | 外部 `free_text_clean` 与 `memory_policy.audit_ok` + free-text issues 对齐，避免双标准 |
| fallback 集成测 | 可选补 seed 旧 memory + locked refs 触发 `used_fallback: true` 的端到端用例 |

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | ai-researcher daemon 连续 11 轮 standing_memory audit 失败；跨轮工作记忆冻结，Decide/diary 误判「disabled」，context 成本随 evolution_events 线性膨胀 |
| 思考 | 非配置 disabled，而是 Evidence 代码生成路径与 05-29 free-text 门禁冲突；`shortText` 的 `…` + diary/assess 叙事进入 admission |
| 方案 | 第一性原则：Evidence = 机器索引 only；三层修复（索引格式化 / audit scope 分离 / safe fallback）；不改 TDB |
| 执行 | 改 `report-builder.mjs` + `test/intelligence.test.mjs`；395 tests passed；ai-researcher runtime `audit.ok` 由 false → true |
