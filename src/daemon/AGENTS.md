# Daemon 编排（daemon）

本文件是 `src/daemon` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。


## Daemon 工作流

Daemon 用于 **事件驱动的 reactor 演化**。推荐用 `jea daemon start` 启动 worker：默认 **持续进化模式**（`continuous`）下每 **5 分钟** heartbeat tick 会消费 cycle 启动请求并扫描 wake backlog。**reactor 默认不再因 tick 自动开新轮**（安静即健康）；开轮入口是 `jea run`、`jea daemon cycle request`、`jea intel brief put` 等。`JEA_TICK_OPEN_CYCLE=1` 仍可恢复 tick 自动开轮。

**按需进化模式**（`on_demand`）：tick **不会**自动入队开轮请求，仅 reconcile + 消费已有请求（`jea daemon cycle request`、`jea intel brief put` 等）。worker idle 时也会尝试消费 pending 请求，不必等 5 分钟。无 open cycle、无 pending request 时 long idle 为 **healthy**（不算 stalled）。reactor 在 continuous 下同样如此：无证据 / 无请求时不报 `evolution_stalled`。

历史 cycle-state JSON **保留可读**，不再作为 live driver。**reactor 默认不再**用 tick reconcile 把「cycle-state 已 terminal 但 task 仍 running」假完成为 completed（仅显式 `JEA_STEP_ARTIFACT_RECONCILE=1`）。

演化模式解析优先级：`<JEA_HOME>/subjects/registry.json` 中 `subjects.<name>.evolution.mode` > `jea daemon start --evolution-mode` > env `JEA_EVOLUTION_MODE` > 默认 `continuous`。

**热加载**：daemon worker 运行中修改 `<JEA_HOME>/subjects/registry.json` 的 `evolution.mode` **无需 restart**（下一轮 worker loop 重新读盘，通常数秒内 idle 生效；`daemon events` 可见 `evolution_mode_changed`）。修改 `.env` 的 `JEA_EVOLUTION_MODE` 或启动时的 `--evolution-mode` **需** `daemon stop` 后重新 `start` 才生效。

`jea run` 是 reactor 同步链。`run_cycle` / 列车 step 任务已删除；`jea daemon enqueue --type run_cycle` 会报错。后台长期运行请用 reactor task。

### 任务与 worker

- `jea daemon start [--mock] [--tick-ms N] [--evolution-mode continuous|on_demand] [--heartbeat-ms N] [--lease-ms N]`：前台 worker；默认 `tick-ms=300000`（5min）。**Windows 长期后台**勿用 Cursor/IDE 后台 shell（会话结束会中止子进程）；用 `npm run daemon:start:detached`（或 `scripts/daemon-start-detached-win.ps1 -Subject NAME [-StopFirst] [-Force]`），日志在 `<JEA_HOME>/logs/daemon-<subject>.*.log`。
- `jea daemon evolution-mode show [--json]`：查看当前 subject 演化模式与来源。
- `jea daemon evolution-mode set continuous|on_demand [--json]`：写入 `<JEA_HOME>/subjects/registry.json` 并 emit `evolution_mode_changed`（viewer SSE / worker 热加载）。
- `jea daemon cycle request [--reason TEXT] [--note TEXT]`：入队 cycle 启动请求（写入 `data/evolution/cycle-start-requests.json`），由 worker 在前提满足时开轮。
- `jea daemon work --once [--mock]`：领取并执行一个 reactor task 后退出。
- `jea daemon process-once [--mock] [--json]`：扫描 Cycle wake backlog 并执行一次有界 cognitive 恢复；不启动持续演化，不改写 Channel worker。
- reactor task 类型：`cognitive_reaction`、`exec_queue`、`verify_batch`、`rule_reaction`、`memory_compaction`。这些任务进程内执行，恢复真相是 batch checkpoint / exec intent / exec result，不是 cycle-state。
- `jea daemon enqueue --type cognitive_reaction|exec_queue|verify_batch|rule_reaction|memory_compaction`：手动入队 reactor 任务。`run_cycle` / 列车 step 会报错。
- `jea daemon stop` / `jea daemon stop --all`：请求 worker 优雅停止。

### Step 状态与 checkpoint

每轮 cycle 的状态与 step 产物位于：

```text
<JEA_HOME>/subjects/<data_namespace>/data/evolution/cycle-state/
├── <cycleId>.json              # step 状态机（pending/running/done/skipped/failed）
└── <cycleId>/
    ├── intel.json              # step checkpoint（可序列化输出）
    ├── exec.json
    └── ...
```

下游 step 子进程从 checkpoint 重建上游产物（如 verify 读取 `exec.json` 的 `executed` 列表）。`jea daemon status --json` 的 `cycles` / `tasks.step_tasks` 字段可观测 step 进度：

| 字段 | 含义 |
| --- | --- |
| `cycles.open_count` | 未关闭 cycle 数量 |
| `cycles.stuck_steps[]` | cycle-state 为 `running` 但无有效 step task 租约（含 `cycle_id`、`step`、`reason`、`age_ms`） |
| `cycles.drift_steps[]` | cycle-state 已 `done`/`skipped` 但同 step 的 daemon task 仍为 `running`（含 `artifact_complete`） |
| `cycles.progress_stalled` | open cycle 在预期 tick 窗口内无 step 进展 |
| `cycles.oldest_open_cycle_age_ms` | 最久未关闭 cycle 的打开时长（毫秒） |
| `cycles.recent[].running_steps` / `stuck_steps` | 各 open cycle 摘要 |
| `tasks.step_tasks` | 带 `cycle_id` 的 daemon task 列表 |

卡住 step 阈值与 worker heartbeat stale 共用（默认 60s，可用 `--heartbeat-stale-ms` 调整）。

reactor 生产健康看 `daemon status --json` 的 `reactor` 字段（eligible backlog、pending verify、open/uncertain intents、rule/memory due、lease）。**不要**用旧 `stuck_steps` / `progress_stalled` 判断 reactor 是否健康。`uncertain` exec intent 表示副作用已开始但无 receipt：决策会被 `blocked`，需人工对照目标仓库/外部效果后处置；**禁止**自动重放未知副作用。

S9 后上述行为已固化，不再有 gate 回退。隔离验收：`npm run reactor:canary`。生产 subject 操作前先 `jea data backup`。

### 韧性（队列写入与 worker 存活）

- 任务队列锁文件：`data/evolution/tasks/pending_tasks.lock`（与 `pending_tasks.json` 分离，避免 Windows 上锁与 rename 冲突）。
- 队列写入对 `EPERM`/`EBUSY` 自动重试；**写失败不会终止 worker**（记 `queue_write_failed` 事件，空闲循环继续）。
- `jea daemon status` / `doctor` 健康态除 heartbeat 外会校验 **PID 是否存活**：
  - `worker_zombie`：状态文件为 running 但进程已死 → `ok=false`，应 `jea daemon start`。
  - `evolution_stalled`：仅当 tick 自动开轮启用（列车 pipeline 或 `JEA_TICK_OPEN_CYCLE=1`）时：continuous 下无 open cycle/无 pending，且超过 `tick_ms` 未开新轮 → `ok=false`。reactor 默认安静即健康。
  - `cycle_progress_stalled`：有 open cycle 但在约 `2×tick_ms` 内无 step 进展，或存在 step state drift → `ok=false`（on_demand 无 open cycle 时不触发）。
- Worker 崩溃会尽力写入 `worker_crashed` 事件并将 `worker-state` 标为 `stopped`。
- `daemon start` 若检测到 zombie（fresh 心跳 + 死 PID），会先清理旧状态再启动新 worker。

### 观测与诊断

- `jea daemon status [--all | --subjects a,b] [--json]`：查看 worker、队列、健康状态、锁和最近事件。
- `jea daemon doctor [--all | --subjects a,b] [--json]`：诊断 daemon 健康状态；若存在 `running` 但无有效租约的 step，输出 `stuck_cycle_step` 诊断（warning/error，含 `stuck_steps` 明细）。
- `jea daemon events [--all | --subjects a,b] [--limit N] [--json]`：查看近期 daemon/task 生命周期事件。
- `jea daemon inbox [--all | --subjects a,b] [--json]`：汇总最新 intel report、evolution diary、verify report、standing memory 和健康注意项；`attention.open_cycles` / `attention.stuck_steps` 汇总 open cycle 与卡住 step 数量。

任务列表与处置：

- `jea daemon tasks list [--all | --subjects a,b] [--status STATUS] [--json]`：列出任务。
- `jea daemon tasks inspect <task_id>`：查看单个任务详情。
- `jea daemon tasks retry <task_id>`：重试任务。
- `jea daemon tasks cancel <task_id>`：取消任务。
- `jea daemon tasks acknowledge <task_id>`：确认已检查过的失败任务（别名 `ack`）。

`jea daemon start` 默认在同一前台进程内启动平级的 cycle domain 与 channel domain；两者使用独立队列、worker-state 与锁边界，因此 channel 收发不会被长 cycle step 阻塞。可用 `jea daemon start --domain cycle|channel|all` 只启动某个 domain；`jea daemon work --once --domain channel` 只领取 channel task。多主体并行仍应由外部终端或编排器分别启动。

**长期运行建议（故障隔离）**：`domain=all` 时 cycle 与 channel 共享同一 Node 进程；channel 侧未捕获异常可能拖垮 cycle worker。生产或无人值守环境推荐分两个终端/进程启动：

```powershell
jea daemon start --subject NAME --domain cycle
jea daemon start --subject NAME --domain channel
```

`jea daemon start --domain channel` **默认**在同一进程内启动六个 channel role worker（`notify`、`control`、`agent`、`presence`、`speech`、`classifier`），共享同一任务队列但按任务类型隔离领取，避免 LLM 分类、异步 agent 调查、话术生成阻塞 outbox flush。高级用法：

```powershell
jea daemon start --subject NAME --domain channel --channel-role presence
jea daemon start --subject NAME --domain channel --channel-roles notify,classifier
jea daemon start --subject NAME --domain channel --channel-role all
```

`worker-state.json` 的 `workers` map 记录各 role 的 `worker_id` / `pid` / `heartbeat_at`；`jea channel status --json` 可见 `workers.roles[]` 与 `classifier` 配置。

Channel worker-state 写入已使用与 task queue 相同的原子重试写入；loop 内心跳写失败会记 `channel_worker_state_write_failed` 并降级继续，不会直接终止 cycle domain。停止路径由 child 销账，supervisor 只在子进程退出后对残留 running role 做 safe fallback。

## 批量演化

- `jea evolve --rounds N`：连续运行多轮演化，带重试和运行状态记录。
- `jea evolve status [ID]`：查看最近或指定演化运行状态。
- `jea evolve resume ID`：恢复被中断的演化运行。

相关环境变量：

- `JEA_VIEWER_BUILD_LIMIT`：`jea intel viewer serve` / `build` 的轮次上限，默认 `50`。
- `JEA_SKIP_GOALS_ASSESS=1`：跳过目标评估。
- `JEA_SKIP_BELIEF_UPDATE=1`：跳过 post-verify 信念更新。
- `JEA_FORCE_MOCK=1`：强制使用 Mock AI。

Phase 2 执行预算 / 队列 TTL（`JEA_EXEC_*`、`JEA_AGENT_*`、`JEA_PENDING_TTL_*`、`JEA_QUEUE_*`）见 [src/actions/AGENTS.md](../actions/AGENTS.md)。
