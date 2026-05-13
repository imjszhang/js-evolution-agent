# Agentic Phase 2 与对话式验证闭环调整

> 日期：2026-05-13
> 项目：js-evolution-agent
> 类型：架构设计 / 功能实现 / 问题排查 / 调研分析
> 来源：Cursor Agent 对话
> 最近更新：2026-05-13 17:49:52 +08:00

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

本次工作围绕 `js-evolution-agent` 的完整进化循环展开。最初的问题是：在 `exec` 执行阶段到底使用了哪个 agent，以及 Phase 2 / Phase 3 的执行结果是否可信。

运行与分析后确认：

- Phase 1 已经是对话式 LLM 流程：observe → report → analyze/decide。
- Phase 2 原本由 `ExecutionPipeline` 调度队列，但具体 action 多数由本地 `actionHandlers` 执行。
- 只有 `agent_execute` 会真正调用 `runAgenticAction()`，可走 `llm_only` / `claude_code_sdk` / `cursor_sdk`。
- Phase 3 原本主要是机械 verifier，根据 handler receipt 判断 `verified` / `pending`。

这个设计导致一个明显错位：Phase 1 的 LLM 会用自然语言表达 agentic intent，例如“使用 agent_execute observe 探测路径”，但只要 action `type` 是 `run_probe`，Phase 2 实际仍然只跑本地规则探针，不会调用 agent。用户进一步提出：既然系统目标是 agentic self-evolution，Phase 2 应该默认走 agent 调用逻辑。

因此，本次目标逐步演化为：

1. 分析当前 exec / verify 结果是否真实反映进化。
2. 将 Phase 1 的完整对话上下文落盘，供 Phase 3 恢复。
3. 将 Phase 3 semantic verifier 改为读取 Phase 1 会话文件后延续对话。
4. 将 Phase 2 从“agent 审查 + 本地 finalizer”继续收敛为 agent-first：最终 action result 由 agent 产出，host 只负责受控持久化和兼容 fallback。
5. 用真实 `npm start` 验证 agent-first 路径；确认无问题后关闭默认 legacy fallback。
6. 思考长时间 Phase 2 运行下，Phase 3 是否应改为 hook / event 触发。

---

## 2. 分析过程

### 2.1 初始 exec agent 分析

代码阅读确认：

- `run.mjs` Phase 2 通过 `ExecutionPipeline` 执行：

```js
const exec = new ExecutionPipeline({
  host: cfg.host,
  projectRoot: runtime.runtimeRoot,
  aiClient: cfg.aiClient,
  source: 'queue',
});
```

- `ExecutionPipeline` 不直接代表某个 agent；它只负责 claim decision、调用 `ActionExecutor`、再分发到 `host.actionHandlers[action.type]`。
- `run_probe`、`record_observation`、`write_retrospective` 等动作原本是本地 handler。
- `agent_execute` 才会进入 `src/actions/agent-adapter.mjs` 的 `runAgenticAction()`。

结论：当时的 Phase 2 是“handler-first，少数 action 可委托 agent”，不是“agent-first”。

### 2.2 多轮完整进化执行结果

本次对话中运行了多轮完整进化：

| Cycle | Phase 2 动作 | 主要结果 | 关键问题 |
| ---- | ---- | ---- | ---- |
| `cycle-20260513-131319` | 2 个 `run_probe` | 1 个 succeeded，1 个 inconclusive | 路径 `data/...` 与真实 runtime root 不一致 |
| `cycle-20260513-161523` | `run_probe` + `record_observation` | observation 成功，probe neutral | Phase 3 semantic verifier 正确指出 probe 无证据 |
| `cycle-20260513-162310` | observation、2 个 probe、retrospective | 观测和回顾成功；一个 runtime probe 部分成功；safe-runtime probe 仍 inconclusive | `run_probe` 仍未真正调用 agent，且 target 仍可能使用错误相对根 |

重要发现：

- 机械 verifier 会把 handler `success: true` 判成 `improved`。
- 但 `run_probe` 的 `success: true` 只代表 handler 正常返回，不代表 probe objective 达成。
- 新增 semantic verifier 后，能更准确地区分：
  - `record_observation` / `write_retrospective`：`improved`
  - 无文件读取、无匹配的 `run_probe`：`neutral`
  - 有匹配但未读文件的 runtime probe：部分进展

### 2.3 路径问题与 action 语义错位

多轮结果显示，`run_probe` target 默认按 `sourceRoot` 解析，导致 LLM 写出的 `data/...` 会落到仓库根，而真实主体数据在：

```text
runtime/subjects/js-evolution-agent/data/
```

这引出两个层次的问题：

1. 执行命中率问题：target path 没有明确 resource root。
2. 架构语义问题：Phase 1 以为自己在给 agent 下任务，Phase 2 实际只跑规则探针。

用户明确指出：当前所有 Phase 2 都应该走调用 agent 的逻辑。分析后确认这应是长期方向，但不应删除 `ExecutionPipeline` 和本地工具；更合理的分层是：

```text
ExecutionPipeline：队列 claim、状态流转、审计边界
Agentic execution：执行 action intent，产出 evidence / writes / verification_hints
Host persistence/tools：校验并持久化 agent 返回的 writes；必要时提供显式 fallback
```

### 2.4 第三轮真实执行后的结论更新

在 agent-first 改造后，执行 `cycle-20260513-174002` 得到新的证据：

| Action | Provider | Fallback | 结果 |
| ---- | ---- | ---- | ---- |
| `record_observation` | `claude_code_sdk` | `false` | agent 返回 `writes.observations`，host 持久化 1 条 observation |
| `run_probe` | `claude_code_sdk` | `false` | agent 直接产出有效 evidence，确认 `data/intelligence/memory/` 存在但为空 |

这说明 Phase 2 已不再只是“agent 审查后交给硬编码 finalizer”。本轮 verify 中两条动作的 mechanical metric 都是 `agent_action_result`，semantic verifier 也判为 `improved/high`。随后进一步收敛：legacy finalizer 默认关闭，只有显式 `allow_legacy_fallback` 或 `diagnostic_fallback` 才允许使用。

---

## 3. 方案设计

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| Phase 1 上下文 | 完整落盘到 `conversation_context.json` | Phase 3 不能冷启动，应恢复同一轮对话语境 |
| Phase 3 verifier | 保留机械 verifier，新增 semantic verifier | 机械层做 receipt/schema 底线，LLM 层判断证据价值 |
| semantic verifier 上下文 | 从文件读取 Phase 1 conversation，而不是依赖内存 | 支持进程重启、后续 hook 化与长任务恢复 |
| Phase 2 执行 | agent-first：agent 产出最终 action result | 避免 agent 已理解意图但最终结果仍被原始 action 字段和硬编码规则决定 |
| 本地 handler | 降级为 host persistence / tool / 显式 fallback | record / retrospective / probe 仍需稳定、可审计、可测试，但不再默认抢占最终裁判权 |
| legacy fallback | 默认关闭，仅显式开启 | 防止 `run_probe` 空 evidence 时被旧 finalizer 误判为成功 |
| 长任务设计 | 先文件化，再 hook 化 | 阶段间不能依赖内存对象，否则无法支持长时间执行 |

### 3.1 Phase 1 对话上下文落盘

新增 `src/intelligence/conversation-context.mjs`，负责：

- 写入 `conversation_context.json`
- 读取 `conversation_context.json`
- 基于已落盘的 Phase 1 对话恢复 messages
- 追加 Phase 3 verification prompt
- 调用 LLM 进行 semantic verification

落盘内容包括：

```text
observation.prompt
observation.response
report_turn.messages
report_turn.response
analyze_decide_turn.messages
analyze_decide_turn.response
analyze_decide_turn.parsed
restored_conversation
```

文件路径：

```text
runtime/subjects/<subject>/data/evolution/records/<cycle>/conversation_context.json
```

### 3.2 Phase 3 对话式 semantic verifier

Phase 3 当前流程改为：

```text
verifyActions(execResult)                 # mechanical verification
load conversation_context.json
append Reflective Phase 3 Verification prompt
call LLM
attach verification.semantic to report
```

semantic verifier 不重新执行 action，也不解决执行命中率问题，只判断：

- action 原始目标是什么
- result / evidence 是否支持目标
- 对 goal 是 improved / partial / neutral / regressed / blocked
- 证据缺口是什么
- 下一轮应验证什么

### 3.3 Phase 2 agent-first execution

第一阶段曾采用 agentic wrapper：

本地 action handler 改为异步，并采用统一形态：

```text
handler(action, ctx)
  → runPhase2Agent(action, ctx)
  → 若 agent 不批准 / 需要人工：写 blocked receipt
  → 否则执行 local finalizer
  → result.agentic_execution = agent summary
  → recordActionReceipt()
```

这个阶段解决了“Phase 2 完全没有 agent 参与”的问题，但仍然保留了旧错位：agent 只是 gate，最终结果仍由本地 finalizer 决定。

最终收敛后的形态为：

```text
handler(action, ctx)
  → runPhase2Agent(action, ctx)
  → agent 返回 status / evidence / writes / verification_hints
  → host 校验并持久化 writes
  → 若 agent 未返回必要 artifact：blocked receipt
  → 仅当 action 显式 allow_legacy_fallback 或 diagnostic_fallback 时，才调用旧 finalizer
  → recordActionReceipt()
```

受影响的 action：

- `record_observation`
- `propose_probe`
- `run_probe`
- `write_retrospective`
- `request_core_review`

`agent_execute` 本身仍直接调用 `runAgenticAction()`。

---

## 4. 实现要点

### 项目结构

```text
js-evolution-agent/
├── run.mjs
├── src/
│   ├── actions/
│   │   ├── agent-adapter.mjs
│   │   ├── handlers.mjs
│   │   └── registry.mjs
│   └── intelligence/
│       ├── conversation-context.mjs
│       ├── conversational-intel-pipeline.mjs
│       ├── goal-assessor.mjs
│       └── store.mjs
└── test/
    ├── actions.test.mjs
    └── conversational-intel-pipeline.test.mjs
```

### 关键模块

| 文件 | 职责 |
| ---- | ---- |
| `src/intelligence/conversation-context.mjs` | Phase 1 对话上下文落盘、读取、恢复对话式 semantic verifier |
| `src/intelligence/conversational-intel-pipeline.mjs` | 在 analyze+decide 后写入 `conversation_context.json` |
| `src/intelligence/goal-assessor.mjs` | 将 verification.semantic 摘要纳入目标评估上下文 |
| `src/intelligence/store.mjs` | action receipt 增加 intel/exec/decision/action 关联字段 |
| `run.mjs` | Phase 3 调用 mechanical verifier 后，再调用 semantic verifier 并写入报告 |
| `src/actions/agent-adapter.mjs` | 统一 agent output contract，规范 `evidence` / `writes` |
| `src/actions/handlers.mjs` | 将本地 action handler 改为 agent-first + host persistence + 显式 fallback |
| `src/actions/registry.mjs` | 更新 action prompt hints，说明 Phase 2 agent-first 执行契约 |
| `test/conversational-intel-pipeline.test.mjs` | 覆盖 Phase 1 会话落盘与 Phase 3 从文件恢复 |
| `test/actions.test.mjs` | 覆盖 agent writes、approval block、fallback 收敛与空 evidence 误判 |

### 4.1 已实现的 conversation context

`persistPhase1ConversationContext()` 在 Phase 1 analyze+decide 后写入：

```text
data/evolution/records/<cycle>/conversation_context.json
```

`verifyWithRestoredConversation()` 读取该文件后追加 Phase 3 prompt，并返回：

```json
{
  "enabled": true,
  "source": "phase1_conversation_context",
  "context_path": "...",
  "status": "ok",
  "result": {
    "semantic_verified": [],
    "overall_summary": "...",
    "next_cycle_focus": []
  }
}
```

如果文件缺失或 LLM 调用失败，不中断整个 run，只记录 `unavailable` 或 `failed`。

### 4.2 已实现的 Phase 2 agent-first contract

Agent 输出契约已扩展为：

```json
{
  "status": "completed | partial | blocked | requires_human_review",
  "summary": "short result",
  "action_type": "run_probe",
  "action_id": "...",
  "served_goal": "bootstrap",
  "evidence": {
    "files_read": [],
    "matches": [],
    "observations": [],
    "probe_results": [],
    "notes": []
  },
  "writes": {
    "observations": [],
    "probe_results": [],
    "probe_events": [],
    "evolution_events": [],
    "retrospectives": [],
    "core_reviews": []
  },
  "verification_hints": [],
  "next_actions": []
}
```

关键内部函数包括：

- `summarizeAgenticExecution()`
- `runPhase2Agent()`
- `agentBlockedResult()`
- `agentActionResult()`
- `persistObservationWrites()`
- `persistProbeResultWrites()`
- `persistProbeProposalWrites()`
- `persistRetrospectiveWrites()`
- `persistCoreReviewWrites()`

每个本地 handler 都会把 action 原文交给 agent：

```text
phase: exec
contract:
- Execute the action intent and return the final auditable action result.
- Do not mutate project files unless the action boundary explicitly permits it.
- For host-backed writes, return explicit writes.* records; the host will validate and persist only those records.
- For investigations, return explicit evidence.* records. Do not rely on a hard-coded local finalizer to decide the final outcome.
```

host 不再默认执行 local finalizer。若 agent 未返回目标 artifact，例如 `run_probe` 没有 `evidence` 或 `writes.probe_results`，handler 会写入 blocked receipt：

```text
agent-first execution returned no evidence or writes.probe_results;
legacy finalizer is disabled unless allow_legacy_fallback is set
```

只有显式提供 `allow_legacy_fallback` 或 `diagnostic_fallback` 时，旧 `runReadOnlyProbe()` / legacy 写入路径才会执行，并在 receipt 中标记 `fallback_used: true`。

### 4.3 验证与目标评估增强

mechanical verifier 现在对 agent-first action 使用 `agent_action_result` 指标，记录：

- `provider`
- `requires_approval`
- `fallback_used`
- `evidence_count`
- `writes_count`
- `verification_hints`

`conversation-context` 的 semantic verify prompt 也明确要求检查：

```text
result.evidence
result.writes
result.provider
result.requires_approval
result.fallback_used
result.agentic_execution
```

`goal-assessor` 的 verification summary 现在会纳入 `verification.semantic.result.overall_summary` 和 `next_cycle_focus`，避免 Phase 4 只看到机械 verified/pending 而看不到语义判断。

---

## 5. 执行与验证结果

### 5.1 运行过的完整进化

本次对话中执行了多轮 `npm start`：

```powershell
npm start
```

关键结果：

| Cycle | 结果 |
| ---- | ---- |
| `cycle-20260513-131319` | Phase 2 执行 2 个 `run_probe`，一个成功、一个 inconclusive；暴露路径根问题 |
| `cycle-20260513-161523` | Phase 3 semantic verifier 正常工作，`run_probe` 被判 neutral，`record_observation` 被判 improved |
| `cycle-20260513-162310` | 观测和回顾成功，runtime probe 有部分进展，safe-runtime probe 仍无证据；目标评估仍为 insufficient_evidence |
| `cycle-20260513-170414` | reset/init 后首轮真实进化：3 条决策，1 条 observation 成功，1 条 probe 达到 Claude 6 轮上限，1 条 probe 因 missing target blocked；目标评估 `insufficient_evidence/low` |
| `cycle-20260513-171455` | 第二轮：`record_observation`、`run_probe`、`propose_probe` 均完成；probe 仍 inconclusive；目标评估提升为 `keep/medium` |
| `cycle-20260513-174002` | agent-first 改造后真实验证：2 条动作均为 `agent_action_result`，`fallback_used=false`；`run_probe` 成功确认 `data/intelligence/memory/` 存在但为空；目标评估 `keep/high` |

`cycle-20260513-174002` 的关键 verify 结果：

```text
record_observation:
  metric: agent_action_result
  provider: claude_code_sdk
  fallback_used: false
  evidence_count: 16
  writes_count: 1
  status: improved

run_probe:
  metric: agent_action_result
  provider: claude_code_sdk
  fallback_used: false
  evidence_count: 11
  writes_count: 1
  status: improved
```

semantic verifier 对本轮的 overall summary：

```text
Both executed actions completed successfully with strong evidence.
The run_probe action delivered the first successful probe across 3 cycles,
confirming memory/ empty and providing actionable evidence for standing_memory initialization.
No fallback was used, no approval was required.
```

### 5.2 测试命令

针对 conversation pipeline：

```powershell
npm test -- --run test/conversational-intel-pipeline.test.mjs
```

结果：

```text
Test Files  1 passed
Tests       3 passed
```

针对 action handlers：

```powershell
npm test -- --run test/actions.test.mjs
```

结果：

```text
Test Files  1 passed
Tests       24 passed
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  4 passed
Tests       95 passed
```

编辑文件 lints：

```text
No linter errors found.
```

### 5.3 当前工作树相关变更

本次主要变更包括：

```text
run.mjs
src/actions/agent-adapter.mjs
src/actions/handlers.mjs
src/actions/registry.mjs
src/intelligence/conversation-context.mjs
src/intelligence/conversational-intel-pipeline.mjs
src/intelligence/goal-assessor.mjs
src/intelligence/store.mjs
test/actions.test.mjs
test/conversational-intel-pipeline.test.mjs
```

运行进化还产生了 runtime 数据，例如：

```text
runtime/subjects/js-evolution-agent/data/evolution/records/cycle-20260513-161523/
runtime/subjects/js-evolution-agent/data/evolution/records/cycle-20260513-162310/
runtime/subjects/js-evolution-agent/data/evolution/records/cycle-20260513-174002/
runtime/subjects/js-evolution-agent/data/evolution/verify_reports/
runtime/subjects/js-evolution-agent/data/intelligence/reports/
```

### 5.4 fallback 收敛验证

收敛后，legacy finalizer 默认关闭：

```text
agent returns no evidence/writes
→ handler writes blocked receipt
→ no runReadOnlyProbe / legacy write path
```

只有显式设置以下字段之一才允许兼容路径：

```text
allow_legacy_fallback: true
diagnostic_fallback: true
```

测试覆盖新增：

- agent observation writes 优先于 legacy action params。
- agent `requires_approval` 时不落盘。
- agent probe evidence 可直接生成 probe result。
- 默认不再使用 legacy probe finalizer。
- 空 evidence 的 agent investigation 不再被 mechanical verifier 判为 `improved`。

---

## 6. 后续演化

### 6.1 Phase 2 长任务与 hook 化

当前 handler 已经是异步，但 `run.mjs` 仍是顺序等待：

```text
await exec.run()
→ verify
→ goals assess
```

这适合短任务，不适合未来的长时间 agent 执行，例如：

- Cursor / Claude SDK 长任务
- 沙箱 patch
- 大量文件探测
- 长时间测试
- 外部 CI 等待
- 跨进程或并发 action

建议演进为：

```text
Phase 2 writes exec_result.json
→ emits exec_cycle_completed event
→ hook runner triggers Phase 3 verify
```

更具体地说，先文件化，再 hook 化：

1. Phase 2 将 `execResult` 完整写入：

```text
records/<cycle>/exec_result.json
records/<cycle>/action_results/<decision-id>.json
```

1. Phase 3 增加独立命令：

```powershell
jea verify --cycle <cycle-id>
```

1. Hook/event 监听：

```json
{
  "type": "exec_cycle_completed",
  "cycle_id": "...",
  "exec_result_path": "...",
  "status": "ok"
}
```

1. hook runner 读取事件后触发 verify。

### 6.2 action result 文件化

现在 Phase 3 仍主要吃 `execResult` 内存对象。下一步应改为：

```text
exec writes exec_result.json
verify reads exec_result.json
```

这样即使 Phase 2 进程退出，Phase 3 也能恢复。

### 6.3 更明确的资源定位契约

agent-first 改造降低了硬编码路径对最终结果的影响，但资源定位仍应继续收敛。后续可考虑引入资源 URI：

```text
source:src/actions/handlers.mjs
runtime:data/evolution/records/...
data:goals/active_goals.json
policy:active
```

这可以减少 LLM 对物理路径的猜测，也让 agent 产出的 `evidence` 和 `writes` 更可验证。

### 6.4 run_probe 的定位

Phase 2 已从 agent-reviewed 收敛为 agent-first。当前 `run_probe` 的定位是：

- `run_probe` 是 agent-executed investigation action。
- agent 返回 `evidence` 或 `writes.probe_results` 才算可持久化结果。
- 本地 `runReadOnlyProbe()` 只作为显式 `allow_legacy_fallback` / `diagnostic_fallback` 路径存在。

当前方案是：

```text
agent executes intent
host persists agent evidence/writes
semantic verifier judges evidence value
legacy probe-runner only on explicit fallback
```

这解决了“Phase 2 看似 agentic、实际由硬编码 finalizer 决定结果”的问题。剩余问题从“执行权归属”转为“agent 工具能力、资源 URI、evidence schema 是否足够稳定”。

### 6.5 verifier 状态合并

机械 verifier 已能通过 `agent_action_result` 记录 `evidence_count` / `writes_count` / `fallback_used`。后续仍可进一步引入：

```text
mechanical_status
semantic_status
final_status
```

并让上层 goal assess 优先看 semantic `final_status`，避免只凭 mechanical `success` 做目标判断。

### 6.6 standing_memory 初始化

最新真实探针确认：

```text
data/intelligence/memory/ exists
files: 0
hidden files: 0
```

同时 action_receipts、evolution_events、goal_events、probe_results 等 intelligence 子目录已产生数据。这说明存储层不是整体失效，而是 standing_memory 尚未触发初始化。下一步可排队一个明确的 agent-first action：

```text
objective: initialize minimal standing_memory
boundary: only write through IntelligenceStore.recordStandingMemory or equivalent host persistence path
acceptance: memory/ 下出现可读的初始 memory 记录，且 verify 能引用该 evidence
```

---

本次工作的核心结论：

> `js-evolution-agent` 正在从“同步脚本式 OADA 流水线”向“持久化、对话式、agentic、可 hook 的演化系统”过渡。Phase 1 和 Phase 3 已开始通过文件恢复同一对话语境；Phase 2 已从本地 handler-first 进一步收敛为 agent-first，最终 action result 由 agent 的 `evidence` / `writes` 驱动，host 只负责受控持久化与显式 fallback。下一步关键是把 Phase 2 result 文件化、初始化 standing_memory，再引入 `exec_cycle_completed` hook，让长时间 agent 执行也能被可靠验证。
