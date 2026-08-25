# Daemon 编排（daemon）

本文件是 `src/daemon` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。


## Daemon 工作流

Daemon 用于 **belief-driven、事件驱动的 reactor 演化**。推荐用 `jea daemon start` 启动 worker：idle 循环扫描 eligible evidence / wake backlog，heartbeat 只做维护与消费显式 reaction request。无 evidence/wake 时安静即健康，**不凭 tick 创建工作**。

运行开关是 `evolution.state`：`active` 自动消费 wake；`paused` 不启新的 Cognitive / Exec / Rule，verify / settlement / Memory 仍可收尾。`evolution.mode`（`continuous` / `on_demand`）已弃用，不再改变调度。`jea daemon cycle request` 是 `jea daemon reaction request` 的兼容命令名；`jea intel brief put` 也会 wake cognition。

历史 cycle-state JSON **保留可读**，不再作为 live driver，也不用于推断 reactor task 已完成。术语分层见 [docs/evolution-terminology.md](../../docs/evolution-terminology.md)。

状态解析优先级：`<JEA_HOME>/subjects/registry.json` 中 `subjects.<name>.evolution.state` > `evolution.automation` > 默认 `active`。`evolution.mode` 只作兼容读。

**热加载**：daemon worker 运行中修改 `<JEA_HOME>/subjects/registry.json` 的 `evolution.state` **无需 restart**（下一轮 worker loop 重新读盘，通常数秒内 idle 生效；`daemon events` 可见 `evolution_state_changed`）。

`jea run` 是 reactor 同步等待入口，与 daemon 共用 cognitive / exec / verify / rule / memory tasks。旧 driver task 不再是 live 操作入口。

### 任务与 worker

- `jea daemon start [--mock] [--tick-ms N] [--domain evolution|cycle|channel|all] [--heartbeat-ms N] [--lease-ms N]`：前台 worker；默认 `tick-ms=300000`（5min）。`--domain cycle` 是 evolution domain 的兼容名。**Windows 长期后台**勿用 Cursor/IDE 后台 shell（会话结束会中止子进程）；用 `npm run daemon:start:detached`（或 `scripts/daemon-start-detached-win.ps1 -Subject NAME [-StopFirst] [-Force]`），日志在 `<JEA_HOME>/logs/daemon-<subject>.*.log`。
- `jea daemon evolution-state show [--json]`：查看当前 subject 的 `active|paused` 与来源。
- `jea daemon evolution-state set active|paused [--json]`：写入 `evolution.state` 并同步 `evolution.automation`，emit `evolution_state_changed`。
- `jea daemon evolution-mode show|set`：已弃用；只写 `evolution.mode`，不改变调度。
- `jea daemon reaction request [--reason TEXT] [--note TEXT]`：入队显式 reaction / cognitive wake。`jea daemon cycle request` 是兼容别名。
- `jea daemon work --once [--mock]`：领取并执行一个 reactor task 后退出。
- `jea daemon process-once [--mock] [--json]`：扫描 evolution wake backlog 并执行一次有界 cognitive 恢复；`paused` 时不启新 Cognitive。不启动持续演化，不改写 Channel worker。
- reactor task 类型：`cognitive_reaction`、`exec_queue`、`verify_batch`、`rule_reaction`、`memory_compaction`。这些任务进程内执行，恢复真相是 batch checkpoint / exec intent / exec result / settlement checkpoint，不是 cycle-state。
- `jea daemon enqueue --type cognitive_reaction|exec_queue|verify_batch|rule_reaction|memory_compaction`：手动入队 reactor 任务。
- `jea daemon stop` / `jea daemon stop --all`：请求 worker 优雅停止。

0.3.0 bounded scheduler (`src/daemon/reactor-scheduler.mjs`) 从 Activation Ledger 选活：实时 lane 优先于 replay；同一 `execution_id` / `belief_id` / `producer_batch_id` 组内保持因果序；replay 每轮最多认领一条并 yield 以便下一轮重检实时工作。Replay 受 `JEA_CATCHUP_MAX_BATCHES` / `JEA_CATCHUP_MAX_WALL_MS` / `JEA_CATCHUP_TOKEN_RESERVE` / `JEA_CATCHUP_SPEND_ALLOWANCE_USD` 约束，消耗记在 `reactor/scheduler-plan.json`，重启不重置。主体 LLM 预算耗尽或 `cycle_admission=parked` 时把 Cognitive/Rule 相关 activation **park once**（`deferred` + `hold_reason.class=budget`），不重复入队等价失败任务。调度器状态由 `deriveReactorSchedulerState` 从 task/claim/checkpoint/budget 事实派生；heartbeat / `worker_alive` 不会变成 `running` 或 `catching_up`。`evolution.state=paused` 仍不启新的 Cognitive / Exec / Rule（含 backlog 扫描与显式 request）；verify / Memory 收尾不受影响。有界 catch-up / lane park 消费同一 `inspectLlmBudget` / `cycle_admission` 契约，不要另起一套预算账本。

Rule backlog 使用独立的安全预算：每批默认最多 32 个事件、4 MiB hydrated payload、4 分钟墙钟，连续瞬态失败最多 3 次；catch-up 默认 4 批或 10 分钟。对应 `JEA_RULE_MAX_EVENTS`、`JEA_RULE_MAX_PAYLOAD_BYTES`、`JEA_RULE_MAX_WALL_MS`、`JEA_RULE_MAX_CONSECUTIVE_FAILURES`、`JEA_RULE_CATCHUP_MAX_BATCHES`、`JEA_RULE_CATCHUP_MAX_WALL_MS`。确定性容量失败会有界拆分；不可拆分的单条 evidence 写入 `reactor/archive/rule-quarantine.jsonl` 后才推进 Rule cursor。主体 LLM token/spend 预算耗尽属于 operator budget block，不归因于 evidence，不拆分、不隔离且不推进 cursor。`rule_catch_up_budget`、`rule_poison_batch_circuit_open`、`rule_llm_budget_exhausted`、`rule_journal_capacity_exceeded` 会稳定暴露到 daemon projection/readiness，且不暂停 Channel worker。恢复用 `jea llm budget status|raise|period-open`（见 [src/ai/AGENTS.md](../ai/AGENTS.md)），不要手改 `llm-budget-ledger.json`。

### Reactor 恢复真相

Live 恢复依赖：

```text
<JEA_HOME>/subjects/<data_namespace>/data/evolution/reactor/
├── claims.json                 # evidence batch claim/ack；终态 archive → requeue → prune
├── checkpoints/               # batch effect checkpoint
├── exec-intents.json           # 副作用前 durable intent
├── exec-results.json           # verify 独立认领
└── settlements.json            # 幂等协调 sidecar（可由 authority events 重建）
```

failed/released/expired claim 的 requeue 使用按 `evidence_key` 分片的 locator lookup，不全量物化 evidence journal。若 archive 已成功而 requeue 失败，terminal hot record 保留；重启后幂等完成 requeue，再 prune。权威 evidence 与 Rule cursor 都不会被该恢复步骤回滚或删除。

`daemon status --json` 的 `reactor` 字段显示 eligible evidence、pending verify、open/uncertain intents、rule/memory due 与 lease。`uncertain` exec intent 表示副作用已开始但无 receipt：决策会被 `blocked`，需人工对照目标仓库/外部效果后处置；**禁止**自动重放未知副作用。历史 `cycles` / step 字段仅供 0.1.0 记录投影。

### Runtime maintenance

heartbeat 默认每 24 小时运行一次保守维护：

- `JEA_RUNTIME_MAINTENANCE=0` 关闭；`JEA_RUNTIME_MAINTENANCE_INTERVAL_MS` 调整周期。
- `JEA_SIDECAR_RETENTION_DAYS`（默认 30）和 `JEA_SIDECAR_HOT_MAX`（默认 1000）是通用边界；claim、daemon task、checkpoint、exec result、wake、channel task/event 可用 `.env.example` 所列变量单独覆盖。
- terminal records 先归档再从 hot state 压缩。active claims/leases、uncertain intents 与主 append-only evidence 永不由这条维护路径删除。
- 状态写入 `data/evolution/reactor/maintenance.json`；单个 store 失败记为 `partial`，其余 store 继续，下一轮重试失败项。
- evidence journal 的 heartbeat 维护只读取 manifest/`journal-state.json` 与文件大小并投影 `ok|maintenance_due|blocked`，绝不在 live worker 下扫描或重写 journal。默认 rotate/block 阈值为 256/768 MiB；到期后停 Cycle 与 Channel，运行 `jea data evidence-journal rebuild --dry-run --json`，确认后加 `--yes`。

S9 后上述行为已固化，不再有 gate 回退。隔离验收：`npm run reactor:canary`。生产 subject 操作前先 `jea data backup`。

### 韧性（队列写入与 worker 存活）

- 任务队列锁文件：`data/evolution/tasks/pending_tasks.lock`（与 `pending_tasks.json` 分离，避免 Windows 上锁与 rename 冲突）。
- 队列写入对 `EPERM`/`EBUSY` 自动重试；**写失败不会终止 worker**（记 `queue_write_failed` 事件，空闲循环继续）。
- `jea daemon status` / `doctor` 健康态除 heartbeat 外会校验 **PID 是否存活**：
  - `worker_zombie`：状态文件为 running 但进程已死 → `ok=false`，应 `jea daemon start`。
  - 历史 `evolution_stalled` / `cycle_progress_stalled` 仅是 0.1.0 cycle-state 兼容投影；live reactor 健康使用 eligible backlog、lease、pending verify、uncertain intents 与 rule/memory due。
- Worker 崩溃会尽力写入 `worker_crashed` 事件并将 `worker-state` 标为 `stopped`。
- `daemon start` 若检测到 zombie（fresh 心跳 + 死 PID），会先清理旧状态再启动新 worker。
- Desktop spawn 的 Cycle/Channel 额外受 supervisor lease 约束：默认 TTL 30 秒、每 5 秒续租；Desktop crash/kill 后 worker 在租约过期时走现有 graceful stop。系统从休眠恢复时有一个 TTL 的续租宽限。仅私有 Desktop child env 启用该约束，外部 `jea daemon start` 无 supervisor lease，仍按 attached worker 处理。
- `<data>/evolution/daemon/desktop-supervisor[-cycle|-channel].json` 的 schema v2 是租约记录；schema v1 继续只作兼容诊断。新 Desktop 实例不会续租或接管旧 `owner_token`。worker-state 只镜像 required/status/expiry，不保存 token；Client API、readiness、事件和诊断不得暴露 token。

### Subject 投影缓存

`readDaemonProjection` 按 subject 复用同一 revision。Desktop / Web 热路径可设 `deferRebuild: true`：Evidence/Reactor 输入变化且已有上一份成功快照时，主进程立即返回该快照，并在 `daemon-projection-worker.mjs` 线程里重算；心跳与 Channel 轻量字段仍同步刷新。CLI、Vitest 与带 `store` 的读取保持同步，避免写后读到陈旧投影。worker 文件缺失时回退同步重建。

### 观测与诊断

- `jea daemon status [--all | --subjects a,b] [--json]`：查看 worker、队列、健康状态、锁和最近事件。
- `jea daemon doctor [--all | --subjects a,b] [--json]`：诊断 daemon 健康状态；若存在 `running` 但无有效租约的 step，输出 `stuck_cycle_step` 诊断（warning/error，含 `stuck_steps` 明细）。
- `jea daemon events [--all | --subjects a,b] [--limit N] [--json]`：查看近期 daemon/task 生命周期事件。
- `jea daemon inbox [--all | --subjects a,b] [--json]`：汇总最新 report、verify report、standing memory、reactor/Channel 健康注意项；历史 diary/cycle counters 只作兼容读取。

任务列表与处置：

- `jea daemon tasks list [--all | --subjects a,b] [--status STATUS] [--json]`：列出任务。
- `jea daemon tasks inspect <task_id>`：查看单个任务详情。
- `jea daemon tasks retry <task_id>`：重试任务。
- `jea daemon tasks cancel <task_id>`：取消任务。
- `jea daemon tasks acknowledge <task_id>`：确认已检查过的失败任务（别名 `ack`）。

`jea daemon start` 默认在同一前台进程内启动平级的 evolution domain 与 channel domain；两者使用独立队列、worker-state 与锁边界，因此 channel 收发不会被长 cognitive/agent task 阻塞。CLI 的 `--domain cycle` 是 evolution domain 的兼容参数名；`--domain channel` 只启动 channel，`--domain all` 启动两者。多主体并行仍应由外部终端或编排器分别启动。

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

Channel worker-state 写入已使用与 task queue 相同的原子重试写入；loop 内心跳写失败会记 `channel_worker_state_write_failed` 并降级继续，不会直接终止 evolution domain。停止路径由 child 销账，supervisor 只在子进程退出后对残留 running role 做 safe fallback。

## 批量演化

- `jea evolve --rounds N`：连续运行多轮演化，带重试和运行状态记录。
- `jea evolve status [ID]`：查看最近或指定演化运行状态。
- `jea evolve resume ID`：恢复被中断的演化运行。

相关环境变量：

- `JEA_VIEWER_BUILD_LIMIT`：`jea intel viewer serve` / `build` 的轮次上限，默认 `50`。
- `JEA_SKIP_GOALS_ASSESS=1`：跳过目标评估。
- `JEA_SKIP_BELIEF_UPDATE=1`：跳过 post-verify 信念更新。
- `JEA_FORCE_MOCK=1`：强制使用 Mock AI。

执行预算 / 队列 TTL（`JEA_EXEC_*`、`JEA_AGENT_*`、`JEA_PENDING_TTL_*`、`JEA_QUEUE_*`）见 [src/actions/AGENTS.md](../actions/AGENTS.md)。
