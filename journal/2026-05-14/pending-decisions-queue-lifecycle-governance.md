# pending_decisions 队列生命周期治理

> 日期：2026-05-14
> 项目：js-evolution-agent
> 类型：架构设计 / 功能实现 / 问题排查 / 调研分析
> 来源：Cursor Agent 对话
> 最近更新：2026-05-14 09:12:36 +08:00

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [执行与验证结果](#5-执行与验证结果)
6. [后续演化](#6-后续演化)

---

## 1. 背景与动机

本次工作从 `runtime/subjects/js-evolution-agent/data/intelligence/reports/cycle-20260514-083727.md` 中的问题分析开始。报告指出 `pending_decisions.json` 持续增长：从早期 15 项增长到 25 项，其中大部分已经完成但仍留在主文件里。

这个现象表面上是文件变大，实质上是执行队列语义不清：

- `pending_decisions.json` 同时承担了热路径执行队列和历史记录的职责。
- Phase 1 每轮 Analyze+Decide 会继续追加 actions。
- Phase 2 使用 `ExecutionPipeline({ source: 'queue' })` 消费队列，但每轮有固定执行上限。
- 已完成或过期的条目没有退出热路径，导致后续周期反复承受读写和扫描成本。

因此，本次目标不是简单压缩文件，而是把 `pending_decisions` 改造成有生命周期治理的执行队列，使系统形成稳定闭环：

```text
决策产生速度 <= 执行速度 + 归档速度
```

---

## 2. 分析过程

### 2.1 运行链路确认

代码阅读确认当前完整循环大致为：

```text
Phase 1: ConversationalIntelligencePipeline
  observe -> report -> analyze/decide -> add decisions

Phase 2: ExecutionPipeline
  source=queue -> run({ limit: 5 }) -> execute actions

Phase 3: verifyActions + semantic verification
  只验证本轮已执行动作

Phase 4: goals assess
  依据报告、验证结果和事件判断目标状态
```

关键文件：

- `run.mjs` 串联 Phase 1 到 Phase 4，Phase 2 固定从 queue 消费并带有 `limit: 5`。
- `src/intelligence/conversational-intel-pipeline.mjs` 在 Analyze+Decide 后调用队列入队。
- `src/intelligence/decision-queue.mjs` 原本只做整文件读取、追加、整体写回。
- `src/cli/commands/audit.mjs` 原本能审计健康度，但不能治理归档。
- `src/cli/commands/actions.mjs` 负责读取 active subject namespace 下的队列。

### 2.2 影响阶段判断

`pending_decisions` 增长主要影响以下阶段：

1. Phase 1 入队末尾：每次追加都要读完整 JSON、追加、再整体写回；队列越大，I/O 和锁持有时间越高。
2. Phase 2 执行前：执行管线需要从 queue 读取候选项；如果热队列混入大量历史状态，会增加扫描成本，也会让真实 pending 淹没在旧条目中。
3. Phase 3 验证：验证本身不直接按总队列长度增长，但 backlog 会让动作延迟执行，验证证据链也随之滞后。
4. Phase 4 目标评估：目标状态依赖已执行和已验证结果；若执行滞后，目标评估会出现完成信号后置。

### 2.3 根因归纳

本次讨论中把问题归纳为三类：

- 生命周期缺失：`completed`、`expired` 等冷状态没有离开 `pending_decisions.json`。
- 入队缺少去重：等价 action 可跨周期反复进入热队列。
- 决策缺少背压感知：Phase 1 在队列已膨胀时仍可能继续制造新动作。

---

## 3. 方案设计

最终方案选择“宿主侧治理优先”，不直接修改 `js-evolution-engine` 内部消费逻辑。

核心设计：

1. 明确热队列语义

   `pending_decisions.json` 只应长期保留 `pending` 与必要的 `in_progress`。`completed` 和确定过期的条目进入冷归档，不从热路径消失证据，只是不再污染执行队列。

2. 增加生命周期 API

   在 `LocalDecisionQueue` 内部增加摘要、去重指纹和归档能力，继续保持原有 `addDecisions()` 的兼容返回值，避免影响既有调用方。

3. 入队前去重

   基于 action 的稳定 fingerprint 判断等价任务。已有相同 `pending` / `in_progress` 时，新 action 被跳过，并记录跳过原因。

4. 注入队列摘要而非完整队列

   在 report context 中增加 `decision_queue` 小摘要，包括总数、热队列数、可归档数、状态计数、最老 pending 和背压标记。这样下一轮 Analyze+Decide 能看见 backlog，但不会把完整队列塞进 prompt。

5. 增加 CLI 治理入口

   在 `jea audit queue` 下增加归档模式：

   ```text
   jea audit queue --archive
   jea audit queue --archive --yes
   ```

   默认 dry-run，只预览将归档的 `completed` / `expired`。只有显式 `--yes` 才实际移动到 `archived_decisions.json`。

### 关键决策

- 保留 `failed` 在热/审计视野中，不默认归档，避免吞掉需要复盘或重试的失败。
- 不提高 `exec.run({ limit: 5 })` 作为第一阶段修复手段，先清理热队列语义。
- 不删除历史记录，而是写入冷归档文件，保证可追溯性。
- 不修改 plan 文件本身，只按计划落实代码与测试。

---

## 4. 实现要点

### 4.1 队列模块扩展

修改 `src/intelligence/decision-queue.mjs`：

- 新增 `decisionFingerprint(action)`，使用稳定 JSON 序列化生成等价指纹。
- 新增 `summarize()`，返回队列规模、状态计数、可归档数、热队列数、最老 pending 和背压信息。
- 新增 `addDecisionsDetailed()`，返回 `{ ids, skipped }`，支持重复热任务跳过。
- 保留 `addDecisions()`，继续返回 ID 数组，保持兼容。
- 新增 `archiveDecisions()`，支持 dry-run 与实际归档。

### 4.2 情报管线接入

修改 `src/intelligence/conversational-intel-pipeline.mjs`：

- `result` 增加 `decisions_skipped`。
- 入队优先调用 `addDecisionsDetailed()`。
- 日志中记录实际入队数和跳过数。
- 在报告准备阶段读取 queue summary，传入 report context。

### 4.3 报告上下文接入

修改 `src/intelligence/report-builder.mjs`：

- `gatherReportContext()` 支持 `queueSummary`。
- report context 增加 `decision_queue`。
- `source_counts` 增加 `decision_queue` 计数标记。
- `prepareIntelReport()` 与 `persistIntelReport()` 透传 queue summary。

### 4.4 CLI 归档入口

修改 `src/cli/commands/audit.mjs` 和 `src/cli/jea.mjs`：

- `jea audit queue --archive`：预览可归档条目。
- `jea audit queue --archive --yes`：实际归档。
- `--statuses completed,expired` 可指定状态集合。
- 输出 subject、namespace、runtime，避免误操作跨 subject。

### 4.5 测试覆盖

新增和扩展测试：

- `test/cli.test.mjs`
  - 本地队列去重。
  - backpressure 摘要。
  - dry-run 不修改文件。
  - 实际归档移动到 `archived_decisions.json`。
  - active subject namespace 隔离。

- `test/conversational-intel-pipeline.test.mjs`
  - report prompt 中包含 `decision_queue`。
  - 已有热队列重复 action 时，本轮不重复入队。
  - `decisions_skipped` 正确记录跳过项。

---

## 5. 执行与验证结果

本次实际修改文件：

```text
src/cli/commands/audit.mjs
src/cli/jea.mjs
src/intelligence/conversational-intel-pipeline.mjs
src/intelligence/decision-queue.mjs
src/intelligence/report-builder.mjs
test/cli.test.mjs
test/conversational-intel-pipeline.test.mjs
```

验证过程：

1. 使用 `ReadLints` 检查上述编辑文件，无 linter 诊断错误。
2. 第一次尝试 `npm test -- --runInBand`，Vitest 不支持该参数，命令在参数解析阶段失败，未进入测试执行。
3. 改用仓库原生命令：

   ```text
   npm test
   ```

4. 测试结果：

   ```text
   Test Files  4 passed (4)
   Tests       99 passed (99)
   ```

结果说明：

- 队列治理逻辑有单元测试覆盖。
- 情报管线仍可完整生成报告、决策和队列写入。
- active subject namespace 隔离仍然成立。
- CLI 归档默认 dry-run，实际归档需要显式 `--yes`。

---

## 6. 后续演化

本次治理解决的是“热队列无界增长”的第一阶段问题。后续可以继续演化：

1. 更细粒度的优先级调度

   当前没有直接修改 `ExecutionPipeline` 内部消费顺序。后续可考虑按 `priority`、安全相关性、最老 pending 年龄排序。

2. 自动归档触发策略

   当前提供 CLI 手动归档入口。后续可在每轮 Phase 0 或 Phase 4 后自动执行保守归档，但需要先观察手动归档效果。

3. 队列吞吐指标

   可记录每轮新增、跳过、执行、归档数量，形成趋势指标，帮助判断是否仍存在生产速度大于消费速度的问题。

4. failed 重试策略

   `failed` 当前不默认归档。后续需要明确哪些失败可重试、哪些失败应转人工复盘、哪些失败可过期。

5. 执行 limit 策略

   如果热队列清理后仍持续积压，再评估是否调整 `run.mjs` 中 Phase 2 的 `limit`，或让安全/治理类 action 获得更高调度优先级。
