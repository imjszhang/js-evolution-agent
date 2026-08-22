# 执行层（actions / causal exec）

本文件是 `src/actions` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。


## Exec reactor（精简版 swarm 双通道）

相关 env：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JEA_EXEC_AGENT_BUDGET` | `8` | 一次 exec batch 消费的 `agent_run` 上限；机械动作（非 agent_run）无上限；剩余 pending 后续继续 |
| `JEA_EXEC_LIMIT` | （deprecated） | 旧名；若设置且未设 `JEA_EXEC_AGENT_BUDGET`，映射为 agent 预算并警告。Decide **不再**按此截断入队 |
| `JEA_EXEC_AGENT_RATE` | （未设） | 墙钟窗口内 `agent_run` 执行数上限；未设时只受单 batch 预算约束。与 `JEA_EXEC_AGENT_BUDGET` **双闸并存**（取更严）。账本落 `data/evolution/agent-rate-ledger.json`，进程重启不重置。旧按轮部署可用历史吞吐折算窗口速率 |
| `JEA_EXEC_AGENT_RATE_WINDOW_MS` | `3600000` | 速率滑动窗口长度（毫秒）；仅在设置了 `JEA_EXEC_AGENT_RATE` 时生效 |
| `JEA_AGENT_MAX_CONCURRENCY` | `2` | agent_run 波内并行宽度上限（`read_only` 可并行；写类 profile 独占波宽 1）；设 `1` 关闭并行 |
| `JEA_AGENT_MAX_ATTEMPTS` | `2` | agent_run 失败自动重试次数；耗尽转 `blocked`，由下轮 Decide `queue_ops` 处置 |
| `JEA_AGENT_PROVIDER` | `llm_only`（代码默认；部署可覆盖） | Agent provider；除现有 provider 外支持 `acp:*`，首个 framework 为 `acp:claude-code` |
| `JEA_ACP_TIMEOUT_MS` | `1800000` | ACP initialize/session/prompt 单次超时；超时先发 cancel，关闭时清理子进程 |
| `JEA_ACP_KILL_GRACE_MS` | `5000` | ACP 子进程关闭时 SIGTERM 到 SIGKILL 的宽限期 |
| `JEA_PENDING_TTL_CYCLES` | `5` | pending 连续经历多少轮 exec 仍未认领后过期（`cycles_seen > N`） |
| `JEA_BLOCKED_TTL_CYCLES` | `10` | blocked 连续经历多少轮 exec 后过期（`cycles_seen > N`） |
| `JEA_QUEUE_DISABLE_CYCLE_TTL` | 未设置（TTL 启用） | 显式设为 `1`/`true`/`yes`/`on` 才关闭 cycle TTL；墙钟后备仍生效 |
| `JEA_QUEUE_WALLCLOCK_TTL_DAYS` | `30` | 队列墙钟后备上限（防 cycle 计数异常时决策永生）；正常 on_demand idle 不应触发 |
| `JEA_QUEUE_AUTO_ARCHIVE` | 开启 | `0`/`false` 关闭；exec queue maintenance 自动归档 completed/expired/retired/**failed**（legacy）决策 |

Decide 输出的 `actions` **全量入队**（fingerprint 去重）；不再按条数截断进 deferred。Decide JSON 可选 `queue_ops: [{op:"requeue"|"retire", id, reason}]` 处置跨轮 `blocked`/`pending`。动态载荷注入 `## Decision Backlog`（pending/blocked 摘要）。

`runExecStep` 内部：

```text
queue maintenance（pending/blocked cycles_seen+1 → cycle/墙钟后备 expire）
→ mechanical guards
→ 通道 A：非 agent_run 全量串行直跑（无预算）
→ 通道 B：agent_run 波次调度
   remaining = min(batch 预算剩余, 墙钟速率账本剩余)  # 未设 RATE 时仅 batch 预算
   width = min(cap, demand, backpressureCap, remaining)
   read_only 可并行；workspace_write / remote_write_review 等独占波宽 1
   claim 后立即写入 agent-rate-ledger（失败重试也计入）
   失败：attempts+1 < max → pending（下轮自动重试）；≥ max → blocked
→ 为每个副作用先写 durable exec intent；完成后写 exec result / receipt 并唤醒独立 verify
```

每条 live 记录传播 `producer_batch_id`、`reaction_id`、`decision_id`、`execution_id`、`belief_id`。0.1.0 缺少可选字段的记录仍可执行兼容读取，但投影/审计必须标为 unknown，不能推断或伪造。

队列状态机（`pending_decisions.json` v2）：

```text
pending → in_progress → completed
                      → fail（attempts < max）→ pending
                      → fail（attempts ≥ max）→ blocked
blocked → queue_ops requeue → pending（attempts / cycles_seen 清零）
blocked|pending → queue_ops retire → retired
pending cycles_seen > JEA_PENDING_TTL_CYCLES（默认 5）→ expired（expire_reason=cycles）
blocked cycles_seen > JEA_BLOCKED_TTL_CYCLES（默认 10）→ expired
墙钟后备 JEA_QUEUE_WALLCLOCK_TTL_DAYS（默认 30d）→ expired（expire_reason=wallclock）
```

机械守护（`evolution.guards`，不占 agent_run 预算）：

在 `<JEA_HOME>/subjects/registry.json` 的 `subjects.<name>.evolution.guards` 配置固定节奏动作（如凭据 sync、记忆审计）。exec queue 在消费决策前运行到期 guard。旧 `data/evolution/agent_loop_guard_state.json` 仅作兼容存储名；action 落盘带 `origin: mechanical_guard` + `guard_id`，首见/移除时发对应事件。

**法则化退役/重生**（宪章第十三条第 5 步）：当 guard 的 `serves_goal` 已被机械确定性维持且连续健康 ≥ `JEA_RULE_FEEDBACK_DEAD_STREAK` 轮时，对应 active goal 使命已完成——assess 应 `rule_status=continue` + `status=refine` + `remove_child`（mechanized retirement；不触碰 mutate 轮的 guard 删除保护）。若机制连续失败且无 active goal 覆盖，assess 应 `add_child` 重开守护目标（rebirth）。健康且已退役是期望稳态。

```json
{
  "id": "credential-sync",
  "enabled": true,
  "every_cycles": 1,
  "action": {
    "type": "agentank_sync_context",
    "description": "Mechanical guard: sync context",
    "priority": "high",
    "params": {}
  }
}
```

**Legacy carryover / diary**：`agent_loop_carryover.json` 与旧 cycle diary 只读兼容，不再是 live 跨批协调机制。跨批连续性来自 evidence stream、claim/checkpoint、settlement 和 Memory Reactor。不要写旧 carryover 或手改 `standing_memory.json`。

**Exec journal（同批信息流）**：exec 串行执行多个 action 时，宿主维护共享笔记，避免兄弟 `agent_run` 互相看不见。

- 来源：mechanical guards 与 decision queue 每完成一个 action，宿主从 receipt 机械提炼一行（优先 `handoff_note`，否则 `summary`/`message`）；daemon 重跑时从同 cycle 的 `action_receipts` 回放重建。
- 注入：后续 `agent_run` / `agent_execute` prompt 在 `## Recent intelligence` 之前插入 `## Earlier actions this cycle`（最多约 12 行；空时固定占位 `None (you are the first action this cycle).`），并附行为指令（前提被推翻时先核实、勿重复劳动）。
- `handoff_note`：agent receipt 可选单行字段（≤300 字符），专门留给本轮后续兄弟 action。
- 排序：Decide 的 `actions` 应按期望执行顺序输出（调查/探针在前，依赖结论的行动在后）；同批 `claimNext` 在相同 `created_at` 下按 decision id seq **升序**保证该顺序。
- 落盘：live exec result/checkpoint 含 `journal`；历史 `exec.json` / diary 的 `phase2.exec_journal` 字段仅作兼容投影。

Live 产物路径（subject runtime）：

```text
data/evolution/pending_decisions.json
data/evolution/reactor/exec-intents.json
data/evolution/reactor/exec-results/
data/evolution/reactor/settlements.json
data/intelligence/                 # action_receipts / verify_reports sources
```

审批语义：Decide JSON 可带 `approval_granted`；真正执行仍走 handler 内 `preflightAgentRun` / `JEA_APPROVAL_MODE`。本地冒烟：

```powershell
npm run jea -- run --mock --subject js-evolution-agent
```

Crash 语义：intent 在副作用前落盘。`executing` 后没有 receipt 的 intent 会变为 `uncertain`，decision 被 blocked，必须人工核对目标仓库/远端结果；禁止自动重放不确定副作用。

## 人工审批与操作者意图

系统**没有**独立的 `jea approve` 命令。人工审批通过两层机制配合：

| 机制 | 入口 | 作用 | 是否硬开关 |
| --- | --- | --- | --- |
| Operator Intent Brief | `jea intel brief put` | 影响下一次 cognitive Decide 如何排优先级 | 否（软输入，引导 LLM） |
| `approval_granted` | Decide 产出的 action 字段 | exec preflight：与 `requires_approval` 联用时，无批准则 blocked | 是 |

典型远端发布流程（如 `agentank-tank`）：

1. 某轮 `agent_run` 在 lane worktree 内完成候选生成、模拟、门禁，仅准备 release artifacts（Decide 可约束「不触发远端发布」）。
2. verify / operator projection 标记 `requires_approval` 或 `acceptance_status: requires_human_review`。
3. 操作者 `jea intel brief put` 表达同意（或校准基线、修正口径等意图）。
4. 下一轮 Decide 调度带 `approval_granted: true` 的 `agent_run`（`permission_profile: remote_write_review`）；外部工具层（如 agentank-evolver 的 `AGENTANK_ALLOW_PUBLISH`）仍可能拦截。
5. 发布后 getTank 探针验证 rank；若 `|rank_delta|≥50`，可能再次要求人工确认新基线（再提交 brief）。

其他需人工介入的场景：

- **核心层变更**：`core_apply` 默认受 `JEA_CORE_APPLY_POLICY=review` 约束；`request_core_review` 只落审批请求，不执行变更。
- **主体边界**：`<JEA_HOME>/subjects/<data_namespace>/SUBJECT.md` 的 Off-Limits Without Human Approval 定义各 subject 的审批规则（凭据、远端发布、越界写入等）；AGENTS.md 不重复主体语义，用 `jea subject check` 校验 policy 结构。

自动化代理在未获操作者明确确认时，不要替其提交发布/基线校准类 brief，也不要在 action 上伪造 `approval_granted`。

### 环境变量审批策略（JEA_APPROVAL_MODE）

`.env` 可配置审批策略，默认 `manual`（保持现状）：

| 值 | 含义 |
| --- | --- |
| `manual` | 所有需要 `approval_granted` 的 `agent_run` 必须显式批准 |
| `auto_guarded` | 仅自动批准低风险动作：只读 `agent_run`（`permission_profile=read_only`）、`record_observation`、`run_evidence_audit`、`propose_probe`、`write_retrospective` |
| `auto_all` | 仅当 registry `subjects.<name>.approval.allow_auto_all=true` 或 `approval.sandbox=true` 时自动批准所有需审批动作；否则 fail-closed。允许后含远端发布、`workspace_write` / `remote_write_review`，外部工具 `approvalFlag` 可追加 `--force`。`JEA_CORE_APPLY_POLICY=disabled` 仍硬拦截 |

`auto_guarded` **不会**自动：

- 远端发布（`remote_write_review` / publish intent）
- 更新 rank baseline
- 解除人工介入阻塞（动作语义含 `unblock` / `human intervention` / `人工介入` 等）
- `core_apply`（仍由 `JEA_CORE_APPLY_POLICY` 独立控制）
- 外部工具 `--force`（如 `AGENTANK_ALLOW_PUBLISH` 路径）

**敏感词闸分层**（仅影响 `auto_guarded` 的 `sensitive_signal_detected`）：

| 层 | 来源 | 生效面 |
| --- | --- | --- |
| 动作语义词 | 核心固定（`publish` / `release` / `remote_write` / `baseline_update` / `unblock` / `core_apply` / `approval_granted` 等） | 所有分支（含 read_only / record） |
| 通用安全词 | 核心固定（`.env` / `secret` / `credential leak`） | **仅非 read_only 的 `agent_run`**（防 safety_class 灰色通道走私）；read_only 与 record 豁免 |
| Subject 专有词 | `subjects.<name>.approval.sensitive_keywords`（registry 可选） | 所有分支；命中即拒（操作者显式意志） |

匹配面只扫动作语义字段（`type` / `description` / `params.intent|objective` / `run_spec.intent|objective` / `context.why_now|desired_decision_effect`），**不**扫 `content` / `summary` / `relevant_evidence` / `do_not_repeat`。Subject 专有词（如某 endpoint）不得写进核心层。

`auto_all` **适合完全沙盒或本地实验**。生产主体必须显式配置 `approval.allow_auto_all=true`；仅设置环境变量不会放行。

建议用法：本地长期演化时设 `JEA_APPROVAL_MODE=auto_guarded`，让凭据合规探针、记忆审计探针、只读 replay 分析、记录型 action 无需每轮人工 brief；远端发布仍通过 `jea intel brief put` 或 Decide 显式 `approval_granted: true`。需要完全无人值守时再设 `auto_all`。

自动批准会在 action receipt 中留下 `auto_approval` 审计字段（`mode`、`reason`、`guardrails`）。

## Expected verification、审计与动作

`agent_run` 的 `run_spec.expected_output[]` 是必须验证的声明。verify 只把结构化 receipt/result、机械 verifier 与语义 verifier 的 observation 与声明对照，状态为 `matched|contradicted|uncertain|not_observed`。`execution_success=true` 只说明执行过程成功，不能替代 expectation match；agent narrative 不算 observation。`contradicted` 会产生 rule settlement signal。

- `jea audit queue`：检查决策队列健康状态、未知动作和陈旧 in-progress 项。
- `jea audit queue --archive`：预览归档 completed/expired 队列项。
- `jea audit queue --archive --yes`：执行归档。
- `jea audit evidence [--subject NAME] [--json] [--strict] [--ingest] [--no-narrative]`：机械审计证据引用（信念 `evidence_refs`、standing memory typed refs、operator_fact `supersedes` 链、近期 report/diary 叙事引用）。`--strict` 时 warnings 也非零退出；`--ingest` 写入一条 `source: evidence_audit` observation（摘要，不含完整 findings）；`--no-narrative` 跳过 report/diary 扫描。`verify_report:` 引用必须用磁盘文件名（`exec-…` 或 `cycle-…`），裸 `cycle-…` 也会解析为 verify report。
- `jea audit closure [--subject NAME] [--json]`：只读闭环审计，检查 belief binding / expected-output 声明覆盖、causal correlation、batch-scoped refs、duplicate settlement candidates、Memory freshness 与分离的 evidence/task backlog；历史缺失字段计入 `legacy_unknown`。
- `jea actions list`：列出已注册 action types。
- `jea actions check`：检查待处理决策中的未知 action types。

Exec action 选择口径：

- 主执行：优先 `agent_run`（调查、改代码、模拟、发布准备等“做事”任务）。
- 记录型：`record_observation`、`run_evidence_audit`（机械证据审计）、`propose_probe`、`write_retrospective`、`request_core_review` 只落已有结论/提案/审批请求/审计摘要，不用于读文件或调查。
- 系统/兼容：`lane_status`、`lane_observe`、`lane_verify`、`github_open_lane_pr` 是机械 lane 能力；`run_probe`、`agent_execute` 是旧兼容动作；`core_apply` 仅用于 core 层审批变更。subject policy 不应维护 subject-specific action 菜单，业务能力通过 `<JEA_HOME>/subjects/registry.json` 的 lane/resources 或 configured external actions 表达。

### ACP 无头 provider

`provider: acp:claude-code` 通过 `@agentclientprotocol/sdk` 1.x fluent client API 和 stdio 启动 `claude-agent-acp`。运行时执行 `initialize → session/new → prompt`，验证提示复用同一 session（最多三轮），结束时在 agent 声明支持的情况下调用 `session/close`，随后关闭连接并按 SIGTERM → SIGKILL 清理子进程。现有 provider 和默认值不变。

无头权限路由以 `permission_profile` 为准：

- `read_only`：只允许已知本地读取类请求，拒绝 edit/delete/move/execute。
- `workspace_write`：读取请求可通过；写请求必须提供可判定路径，且所有路径位于 execution root 或声明的 additional directories 内。
- `remote_write_review`、远端访问、未知工具/路径/权限 profile：默认拒绝；需要交互确认的远端写不在本 issue 的无头能力内。

所有权限决定和 ACP session update 都进入 agent-run observer；消息、思考、工具开始/结束、权限决定和结束状态可在 agent-run JSONL 中审计。ACP binary/framework 不可用返回 `deferred`，decision 保持 pending 且不消耗失败重试。`jea doctor` 检查 binary/version、环境凭据和 initialize/session 握手；可设置 `JEA_ACP_DOCTOR_HANDSHAKE=0` 跳过握手。

真实 Claude ACP smoke 默认跳过；显式设置 `JEA_LIVE_ACP_CLAUDE_CODE=1` 后运行 `test/acp-provider.test.mjs`。该 smoke 需要 ACP agent 可用且已通过环境凭据或本地登录认证。

兼容性与迁移评估：

- `runProviderComparison()`（`scripts/acp-provider-compare.mjs`）按 provider 身份对照 legacy 与 `acp:*`；verification 次数缺失时保守保留 legacy。默认只允许 `read_only` 对比；写类对比必须提供每 provider 独立 execution root，否则失败。报告只给建议，不修改 `JEA_AGENT_PROVIDER`。
- POSIX 真实 spawn 使用独立进程组，关闭时 `SIGTERM → grace → SIGKILL` 整组清理。Windows 本地 binary 优先解析 `node_modules/.bin/claude-agent-acp.cmd`，spawn/doctor 共用 `shell` 标记；关闭时使用 `taskkill /T`，超时后 `/F`。
- Desktop ACP timeline 最多保留 400 个事件，连续 assistant chunk 合并后最多保留 200,000 字符；权限卡、审批与 agent-run 审计语义不变。
- PR CI 在 Linux、Windows、macOS 执行 Desktop test/typecheck/build/smoke；真实 ACP 与 DeepSeek 调用仍保持 opt-in。
