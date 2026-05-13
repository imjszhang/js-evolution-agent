# Agentic Phase 2 与对话式验证闭环调整

> 日期：2026-05-13
> 项目：js-evolution-agent
> 类型：架构设计 / 功能实现 / 问题排查 / 调研分析
> 来源：Cursor Agent 对话

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
4. 将 Phase 2 的本地 action 执行统一改成“agent 先判断，再由本地 finalizer 落盘或执行受控工具”。
5. 思考长时间 Phase 2 运行下，Phase 3 是否应改为 hook / event 触发。

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
Agentic execution：理解 action intent，判断是否应执行
Local finalizer/tool：受控落盘、只读探针、receipt 写入
```

---

## 3. 方案设计

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| Phase 1 上下文 | 完整落盘到 `conversation_context.json` | Phase 3 不能冷启动，应恢复同一轮对话语境 |
| Phase 3 verifier | 保留机械 verifier，新增 semantic verifier | 机械层做 receipt/schema 底线，LLM 层判断证据价值 |
| semantic verifier 上下文 | 从文件读取 Phase 1 conversation，而不是依赖内存 | 支持进程重启、后续 hook 化与长任务恢复 |
| Phase 2 执行 | 本地 action 先调用 agent，再执行 finalizer | 让所有 Phase 2 action 都经过 agentic 判断，同时保留受控写入和审计 |
| 本地 handler | 不删除，降级为 finalizer/tool | record / retrospective / probe 仍需稳定、可审计、可测试 |
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

### 3.3 Phase 2 agentic execution wrapper

本地 action handler 改为异步，并采用统一形态：

```text
handler(action, ctx)
  → runPhase2Agent(action, ctx)
  → 若 agent 不批准 / 需要人工：写 blocked receipt
  → 否则执行 local finalizer
  → result.agentic_execution = agent summary
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
│       └── conversational-intel-pipeline.mjs
└── test/
    ├── actions.test.mjs
    └── conversational-intel-pipeline.test.mjs
```

### 关键模块

| 文件 | 职责 |
| ---- | ---- |
| `src/intelligence/conversation-context.mjs` | Phase 1 对话上下文落盘、读取、恢复对话式 semantic verifier |
| `src/intelligence/conversational-intel-pipeline.mjs` | 在 analyze+decide 后写入 `conversation_context.json` |
| `run.mjs` | Phase 3 调用 mechanical verifier 后，再调用 semantic verifier 并写入报告 |
| `src/actions/handlers.mjs` | 将本地 action handler 改为 agent-reviewed + local finalizer |
| `src/actions/registry.mjs` | 更新 action prompt hints，说明 Phase 2 agent-reviewed 执行契约 |
| `test/conversational-intel-pipeline.test.mjs` | 覆盖 Phase 1 会话落盘与 Phase 3 从文件恢复 |
| `test/actions.test.mjs` | 覆盖本地 handler 先经过 Phase 2 agent 再执行 finalizer |

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

### 4.2 已实现的 Phase 2 agentic wrapper

新增内部函数：

- `summarizeAgenticExecution()`
- `runPhase2Agent()`
- `agentBlockedResult()`

每个本地 handler 都会把 action 原文交给 agent：

```text
phase: exec
contract:
- Interpret the action intent and decide whether the local finalizer/tool should proceed.
- Do not mutate project files unless the action boundary explicitly permits it.
- For tool-backed actions, return execution guidance; the host will perform the controlled final write/read step.
```

然后 local finalizer 完成实际受控动作，并把 agent 执行摘要写入 `result.agentic_execution`。

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

### 5.2 测试命令

针对 conversation pipeline：

```powershell
npm test -- test/conversational-intel-pipeline.test.mjs
```

结果：

```text
Test Files  1 passed
Tests       3 passed
```

针对 action handlers：

```powershell
npm test -- test/actions.test.mjs
```

结果：

```text
Test Files  1 passed
Tests       19 passed
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  4 passed
Tests       90 passed
```

编辑文件 lints：

```text
No linter errors found.
```

### 5.3 当前工作树相关变更

本次主要变更包括：

```text
run.mjs
src/actions/handlers.mjs
src/actions/registry.mjs
src/intelligence/conversation-context.mjs
src/intelligence/conversational-intel-pipeline.mjs
test/actions.test.mjs
test/conversational-intel-pipeline.test.mjs
```

运行进化还产生了 runtime 数据，例如：

```text
runtime/subjects/js-evolution-agent/data/evolution/records/cycle-20260513-161523/
runtime/subjects/js-evolution-agent/data/evolution/records/cycle-20260513-162310/
runtime/subjects/js-evolution-agent/data/evolution/verify_reports/
runtime/subjects/js-evolution-agent/data/intelligence/reports/
```

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

2. Phase 3 增加独立命令：

```powershell
jea verify --cycle <cycle-id>
```

3. Hook/event 监听：

```json
{
  "type": "exec_cycle_completed",
  "cycle_id": "...",
  "exec_result_path": "...",
  "status": "ok"
}
```

4. hook runner 读取事件后触发 verify。

### 6.2 action result 文件化

现在 Phase 3 仍主要吃 `execResult` 内存对象。下一步应改为：

```text
exec writes exec_result.json
verify reads exec_result.json
```

这样即使 Phase 2 进程退出，Phase 3 也能恢复。

### 6.3 更明确的资源定位契约

路径问题仍然存在。后续可考虑引入资源 URI：

```text
source:src/actions/handlers.mjs
runtime:data/evolution/records/...
data:goals/active_goals.json
policy:active
```

这可以减少 LLM 对物理路径的猜测，也让 `run_probe` finalizer 更稳定。

### 6.4 run_probe 的定位

Phase 2 已改为 agent-reviewed，但 `run_probe` 的最终执行仍是本地 read-only finalizer。后续需要进一步决策：

- 若 `run_probe` 只是受控工具，则保持当前设计。
- 若 `run_probe` 应完整由 agent 执行，则应把它升级为 agent-native action，并让本地 probe-runner 只作为 agent 可调用工具或 fallback。

当前折中方案是：

```text
agent understands intent
local finalizer executes controlled probe
semantic verifier judges evidence value
```

这已经解决了“Phase 2 完全没有 agent 参与”的问题，但还没有解决“执行命中率和路径契约”的问题。

### 6.5 verifier 状态合并

机械 verifier 仍会把本地 handler 成功返回判为 `improved`。后续可进一步引入：

```text
mechanical_status
semantic_status
final_status
```

并让上层 goal assess 优先看 `final_status`，避免被 mechanical `improved` 误导。

---

本次工作的核心结论：

> `js-evolution-agent` 正在从“同步脚本式 OADA 流水线”向“持久化、对话式、agentic、可 hook 的演化系统”过渡。Phase 1 和 Phase 3 已开始通过文件恢复同一对话语境；Phase 2 已从本地 handler-first 调整为 agent-reviewed + local finalizer。下一步关键是把 Phase 2 result 文件化，再引入 `exec_cycle_completed` hook，让长时间 agent 执行也能被可靠验证。
