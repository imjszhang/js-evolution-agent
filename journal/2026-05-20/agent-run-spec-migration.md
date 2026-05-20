# Agent Run Spec：把进化执行从 action 菜单迁移到受权限约束的 agent run

> 日期：2026-05-20
> 项目：js-evolution-agent
> 类型：架构设计 / 功能实现 / 升级迁移
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

这次工作的起点不是一个 bug，而是一个系统抽象问题。

`agentank-tank` 主体里配置了多种自定义 action：同步上下文、生成候选、模拟候选、评估候选、发布候选、请求挑战、触发事件。它们看起来像能力列表，但从进化系统的第一性原理看，很多只是同一条演化流水线里的业务步骤。

真正的问题是：当 exec 阶段已经由 Claude Code / Cursor Agent 这类代码 agent 执行时，宿主还需要把每一个业务动作都建成 action type 吗？

答案逐步收敛为：不需要。

如果 agent 本身具备自主执行能力，宿主更应该决定“在哪里运行、给什么权限、要达成什么意图、最后交付什么回执”，而不是提前拆成 `sync/generate/simulate/evaluate/publish` 这类菜单项。

因此，这次迁移的核心目标是：

```text
从 action.type 驱动执行
转向 AgentRunSpec 驱动执行
```

阶段 1 不再主要生成“下一步动作名称”，而是生成一次 agent run 的运行规格。

---

## 2. 分析过程

本轮先梳理了当前系统的三条主线。

### 2.1 决策仍以 action.type 入队

当前 `analyze_decide` 由 [`src/intelligence/conversational-intel-pipeline.mjs`](../../src/intelligence/conversational-intel-pipeline.mjs) 生成 `analysis.actions`，再通过 [`src/intelligence/decision-queue.mjs`](../../src/intelligence/decision-queue.mjs) 写入：

```text
runtime/subjects/<subject>/data/evolution/pending_decisions.json
```

队列结构仍然是：

```json
{
  "action": {
    "type": "...",
    "params": {}
  }
}
```

这意味着短期不能直接删除 `actions[]` 容器，否则会影响 engine 的队列消费路径。

### 2.2 exec 阶段按 handler 路由

执行阶段由 engine 的 `ExecutionPipeline` claim 队列，再通过 `ActionExecutor` 按 `action.type` 查找 `host.actionHandlers[type]`。

宿主侧 handler 在 [`src/actions/handlers.mjs`](../../src/actions/handlers.mjs)，agent provider 统一入口在 [`src/actions/agent-adapter.mjs`](../../src/actions/agent-adapter.mjs)。

这说明迁移要兼容两层：

- 队列层仍然需要 `action.type`。
- 执行层可以新增一个统一 `agent_run` handler，把真正的执行语义下沉到 `params.run_spec`。

### 2.3 目录模型已经有雏形

项目已经存在 `resource_scope -> authoritative root -> root_mismatch` 的模型：

- [`src/actions/resource-registry.mjs`](../../src/actions/resource-registry.mjs)
- [`src/actions/execution-root.mjs`](../../src/actions/execution-root.mjs)

`agentank-tank` 的 policy 也明确区分了三个根：

| root kind | 语义 |
| --- | --- |
| `subject_runtime` | 主体运行态数据、diary、records、goals、receipts |
| `agentank_evolver` | AgenTank 候选、模拟、策略源码、CLI |
| `source_root` | `js-evolution-agent` 宿主系统源码 |

这正好可以升级为 `AgentRunSpec.primary_cwd_kind`。

### 2.4 Claude Code SDK 与 Cursor SDK 的差异

调研 Claude Code SDK 文档后确认：

- Claude Code SDK 支持一个主 `cwd`。
- 也支持 `additionalDirectories`。
- 还支持 `permissionMode`、`allowedTools`、`disallowedTools`。

Cursor SDK local runtime 支持 `local.cwd`，但没有同构的 `additionalDirectories` 硬挂载能力。因此设计上不能假装两者完全等价：

| 能力 | Claude Code SDK | Cursor SDK |
| --- | --- | --- |
| 主运行目录 | `cwd` | `local.cwd` |
| 额外目录 | `additionalDirectories` | 记录为 spec/context metadata |
| 工具权限 | `permissionMode` / `allowedTools` / `disallowedTools` | 当前适配层不具备同构硬权限 |

这成为最终方案的一个边界：`AgentRunSpec` 是统一抽象，但 provider 的硬能力不同。

---

## 3. 方案设计

最终没有引入复杂的 Grant / Boundary 对象，而是采用更贴近 Claude Code / Cursor Agent 调用模型的 `AgentRunSpec`。

最小字段是：

```text
primary_cwd
additional_directories
permission_profile
provider
intent
context
expected_output
```

阶段 1 仍然输出 `actions[]`，但推荐输出一个统一 action：

```json
{
  "type": "agent_run",
  "params": {
    "run_spec": {
      "primary_cwd_kind": "agentank_evolver",
      "additional_directory_kinds": ["subject_runtime"],
      "permission_profile": "workspace_write",
      "provider": "claude_code_sdk",
      "intent": "生成并验证一个本地 tank 候选，不发布",
      "context": {},
      "expected_output": [
        "strict JSON receipt",
        "candidate hash",
        "simulation result",
        "next recommendation"
      ]
    }
  }
}
```

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 顶层 action | 新增 `agent_run` | 保持队列兼容，同时把执行语义迁移到 run spec |
| 主目录模型 | 一个 `primary_cwd` | 更贴近真实代码 agent 的运行方式，避免一次 run 在多个项目根之间混写 |
| 额外目录 | `additional_directories` / `additional_directory_kinds` | Claude Code SDK 可硬挂载；其他 provider 至少可记录为上下文 |
| 权限模型 | `permission_profile` 展开为 provider options | 不再靠自然语言 boundary 模拟权限 |
| 自定义 action | 降级为工具能力 | 主体业务步骤不再进入全局 action 词表 |
| 验证对象 | run receipt | 检查回执、目录、证据和权限 metadata，而不是只看 action type |

---

## 4. 实现要点

### 4.1 项目结构

```text
js-evolution-agent/
├── src/
│   ├── actions/
│   │   ├── agent-run-spec.mjs
│   │   ├── agent-adapter.mjs
│   │   ├── handlers.mjs
│   │   └── registry.mjs
│   └── intelligence/
│       └── conversation-prompts.mjs
└── test/
    ├── actions.test.mjs
    ├── cli.test.mjs
    └── conversational-intel-pipeline.test.mjs
```

### 4.2 关键模块

| 文件 | 职责 |
| --- | --- |
| [`src/actions/agent-run-spec.mjs`](../../src/actions/agent-run-spec.mjs) | 规范化 `run_spec`，解析 `primary_cwd_kind`，展开 `permission_profile`，兼容旧 action 字段 |
| [`src/actions/agent-adapter.mjs`](../../src/actions/agent-adapter.mjs) | 将 run spec 接入 Claude/Cursor provider；Claude 映射到 `cwd`、`additionalDirectories` 和权限 options |
| [`src/actions/handlers.mjs`](../../src/actions/handlers.mjs) | 新增 `agent_run` handler，记录 run receipt，并增加专用 verifier |
| [`src/actions/registry.mjs`](../../src/actions/registry.mjs) | 注册 `agent_run`，不再把 subject configured actions 注入推荐 action registry |
| [`src/intelligence/conversation-prompts.mjs`](../../src/intelligence/conversation-prompts.mjs) | 调整 Analyze+Decide prompt，优先要求输出 `agent_run` + `params.run_spec` |
| [`test/actions.test.mjs`](../../test/actions.test.mjs) | 覆盖 `agent_run` handler 与 receipt verifier |
| [`test/cli.test.mjs`](../../test/cli.test.mjs) | 覆盖 run spec 到 Claude/Cursor options 的映射 |
| [`test/conversational-intel-pipeline.test.mjs`](../../test/conversational-intel-pipeline.test.mjs) | 覆盖新 prompt schema 关键词 |

### 4.3 权限 profile

新增的 profile 是迁移期的最小集合：

| profile | 语义 | 默认工具 |
| --- | --- | --- |
| `read_only` | 只读调查和综合 | `Read`、`Grep`、`Glob` |
| `workspace_write` | 本地候选、模拟、沙盒修改 | `Read`、`Edit`、`Write`、`Bash`、`Grep`、`Glob` |
| `remote_write_review` | 远端变更或发布前准备 | 编辑工具可用，但默认 permission mode 更保守 |

这里没有把 `publish` 做成 action。发布只是一次更高风险的 run，需要更强的权限 profile、证据和人工审批策略。

---

## 5. 验证与测试

运行全量测试：

```bash
npm test
```

结果：

```text
Test Files  4 passed (4)
Tests       178 passed (178)
```

同时对修改文件执行 IDE lint 诊断：

```text
No linter errors found.
```

本次验证覆盖了：

- `agent_run` handler 能通过统一 agent receipt 路径执行。
- `AgentRunSpec` 能把 `primary_cwd_kind=agentank_evolver` 解析为外部项目根。
- Claude Code SDK options 包含 `additionalDirectories`。
- Cursor SDK 使用同一 spec 的 `primary_cwd`，并保留 additional directories metadata。
- Analyze+Decide prompt 已要求输出 `agent_run`、`primary_cwd_kind` 和 `permission_profile`。

---

## 6. 后续演化

这次迁移完成的是第一阶段：新模型可用，旧路径兼容。

后续可以继续推进：

1. **让真实 cycle 观察 LLM 是否稳定输出 `agent_run`。**  
   如果仍频繁输出旧 action，需要继续收紧 prompt 或加入队列入库前的规范化转换。

2. **把 subject-local tool capability 显式注入 agent context。**  
   现在已经不把自定义 action 注入 action registry，但还可以把 `external_tools.agentank_evolver` 作为工具能力说明提供给 agent。

3. **为 Cursor provider 明确能力边界。**  
   Cursor 当前能硬传 `local.cwd`，但不能等价支持 Claude 的 `additionalDirectories`。后续应决定是摘要注入，还是为 Cursor 单独实现多目录上下文收集。

4. **逐步减少 legacy fallback。**  
   如果 exec 阶段未来彻底由代码 agent 执行，host 不应在缺少 receipt 时替 agent 编造业务结果。缺证据就应标记为 `partial` 或 `blocked`。

5. **清理旧自定义 action 配置语义。**  
   `runtime/subjects/<subject>/data/config/actions.json` 里的 `actions[]` 可以逐步从 action type 配置转向 tool capability 配置。

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | `agentank-tank` 的自定义 action 太多，且所有主体都维护自定义 action 会让系统像插件菜单，而不是通用进化框架。 |
| 思考 | 如果 exec 阶段使用 Claude Code / Cursor Agent，自主执行者已经存在，宿主不必预拆业务动作；真正需要控制的是运行目录、权限、意图、上下文和回执。 |
| 方案 | 保留队列兼容，新增 `agent_run`，用 `params.run_spec` 表达一次 agent run。一个主 cwd，必要时附加目录，权限由 provider runtime 承担。 |
| 执行 | 新增 `agent-run-spec.mjs`，改造 `agent-adapter.mjs`、`handlers.mjs`、`registry.mjs`、`conversation-prompts.mjs`，补充测试并通过 `npm test`。 |
