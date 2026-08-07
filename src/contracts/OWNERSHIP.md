# 模块 Ownership 与契约变更流程

- 日期：2026-08-07
- 背景：见 `docs/module-decoupling-plan.md`（模块解耦与多 Agent 并行维护实施计划）

## 1. 模块划分与 Owner

| 模块 | 目录 | Owner | 说明 |
| --- | --- | --- | --- |
| 共享内核 | `src/contracts`、`src/infra`、`src/domain` | agent-kernel | schema、原子写、subject registry/路径、`runtime-paths`、`worker-state-read`、`subject-lock` |
| AI 网关 | `src/ai` | agent-ai | DeepSeek client、LLM 档案、KV 缓存元数据、mock |
| 认知管线 | `src/intelligence`、`src/evolution`、`src/prompts`、`src/engine` | agent-cognition | Phase 1 agent_loop / 报告 / Decide、信念、目标、carryover、诚实闸；`src/engine` 为 vendored，冻结维护 |
| 执行层 | `src/actions` | agent-exec | Phase 2 exec、agent adapter、lane/worktree、审批策略 |
| Daemon 编排 | `src/daemon` | agent-daemon | task queue、worker、step runner、cycle-state、evolve runs、`subject-artifacts` 概览 |
| Channel | `src/channel` | agent-channel | classifier / presence / speech / notify / control、飞书适配器 |
| 观测与门面 | `tools/evolution-viewer`、`src/cli`（含仅剩的 `cli/utils` 纯 CLI 文件）、`src/bridge` | agent-facade | 只读 viewer、CLI 命令薄壳、openclaw bridge |

Owner 名为角色占位（agent-*），实际分配时替换为具体维护者/agent 标识。

## 2. 契约区规则（单点审批）

`src/contracts/` 是**单点审批区**：

1. 本目录下任何 schema / 校验逻辑的变更，必须由 agent-kernel（内核 owner）评审合并；业务模块 PR 不得夹带 contracts 变更。
2. **跨模块数据格式变更流程**：先提交 contracts 变更 PR（内核 owner 审）→ 合并后，生产方与消费方模块各自适配。禁止绕过 contracts 直接在两侧改写数据结构。
3. contracts 变更必须向后兼容（新增可选字段优先）；不兼容变更需要迁移说明与所有受影响模块 owner 的确认。

### 契约级门面（同等待遇）

以下文件虽不在 `src/contracts/` 下，但属于契约级 API 表面，变更同样需要内核 owner 评审：

| 文件 | 消费方 | 说明 |
| --- | --- | --- |
| `src/intelligence/channel-api.mjs` | `src/channel` | channel 唯一允许使用的 intelligence 入口 |
| `src/infra/runtime-paths.mjs` | 所有模块 | subject runtime 路径助手（无 daemon/lock 依赖） |
| `src/infra/worker-state-read.mjs` | `subject-lock`、`daemon-worker-state` | worker-state.json 只读探测（切断 infra↔daemon 环） |

## 3. 运行时数据契约对照

| 运行时文件 | 生产者 → 消费者 | schema |
| --- | --- | --- |
| `pending_decisions.json` | 认知管线（Decide）→ 执行层（exec） | `src/contracts/decision.mjs` |
| `cycle-state/<id>/<step>.json` | 各 step 间 checkpoint 接力 | `src/contracts/step-checkpoint.mjs` |
| action receipts | 执行层 → verify / belief / diary | `src/contracts/action-receipt.mjs` |
| channel inbound/outbox envelope | channel 内部 + listener | `src/contracts/channel-envelope.mjs` |
| daemon task queue | daemon 内部 | `src/contracts/daemon-task.mjs` |
| verify report | verify → belief / goals | `src/contracts/verify-report.mjs` |
| agent run spec | Decide → 执行层 | `src/contracts/agent-run-spec.mjs` |
| belief / goal events | 认知管线内部 + CLI | `src/contracts/belief-goal-events.mjs` |

### 待补清单

| 项 | 现状 | 处置 |
| --- | --- | --- |
| `evolution-events.jsonl` 事件字段 | 无 schema，各模块自由 append | 待内核 owner 补 `src/contracts/evolution-event.mjs`（登记项，不阻塞当前阶段） |

## 4. 跨模块依赖规则

1. 依赖方向必须遵守：`门面 → 业务模块 → ai → 内核`；业务模块之间只允许既有的单向依赖（evolution→intelligence、daemon→channel、channel→intelligence 仅经 `channel-api.mjs`）。
2. 新增跨模块 import 前先确认方向合法；需要反向数据时走运行时数据契约（文件），不走代码 import。
3. 跨模块 e2e 守门测试（`test/cycle-e2e.test.mjs`、`test/e2e-mock-cycle.test.mjs`、`test/contracts.test.mjs`、`test/engine-facade.test.mjs`）归内核 owner；任何模块 PR 必须保持其全绿。
4. 模块内测试随目录归属对应 owner（`channel-*` / `feishu-*` / `daemon-*` / `cycle-*` / `intel-report-*` / `goal-*` / `belief-*` / `agent-loop-*` / `agent-adapter-*` 等命名已对齐）。
