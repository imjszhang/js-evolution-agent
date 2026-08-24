# Channel 通道（channel）

本文件是 `src/channel` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。

Channel 是 daemon 下与 evolution reactors 平级的通信闭环，负责接收外部消息、写入合适的情报入口，并观察 operator projection 决定是否向外部通道通知。当前飞书适配器位于 `src/channel/adapters/feishu/`（基于 `@larksuiteoapi/node-sdk`，参考 Deepseek-Cowork `feishu-module` 的传输层实现，**不**依赖 OpenClaw 或 Cowork AI/ChannelBridge）。

运行时数据位于：

```text
<JEA_HOME>/subjects/<data_namespace>/data/channel/
├── worker-state.json
├── tasks/pending_tasks.json
├── events.jsonl
├── reload-request.json          # setup 完成后写入；daemon 消费后移除
├── reload-state.json            # 最近一次 listener reload 状态
├── feishu-operator-binding.json # JEA BIND 结果
├── feishu-register-qr.png       # setup 扫码注册时生成的二维码图片
├── desktop/sessions/*.jsonl     # desktop 会话 append-only 记录
├── inbound/pending|processed|failed/
└── outbox/pending|sent|failed/
```

`worker-state.json` 由 coordinator 与各 role 共享同一 `.lock`。启动时先顺序注册 role 占位，再并行跑 loop；心跳写失败走 `safeUpdate*`。停止时 child `finally` 是唯一常规 writer；desktop supervisor 只在子进程退出后对仍 `running`/`stopping` 的 role 做 `safeMark*` 兜底，避免双写把锁打满。

Desktop spawn 的 Channel coordinator 会把 token-free supervisor lease 摘要镜像到 aggregate/role worker-state。Desktop 每 5 秒续租、默认 TTL 30 秒；主进程 crash/kill 后 coordinator 触发现有 abort/shutdown 链，listener 与所有 role 一并自停。外部 CLI Channel worker 没有 lease marker，不受此机制影响；schema-v1 supervisor 文件不启用强制租约。

常用命令：

- `jea channel feishu setup --subject NAME [--write-env] [--init-subject-config]`：一键扫码注册飞书应用、写入 subject 凭据 env、生成 BIND 口令、写入 reload 请求（推荐新 subject 首选入口）。
- `jea channel feishu register --subject NAME [--write-env] [--force]`：仅注册应用并拿凭据，不写 reload 请求、不自动生成 BIND 口令。
- `jea channel status [--json]`：查看 channel worker、队列、inbound/outbox 健康。
- `jea channel events [--limit N] [--json]`：查看 channel 审计事件。
- `jea channel inbox put [--file PATH | --stdin]`：放入 `inbound/pending` 并入队 `channel_classifier`；Presence 只在分类完成后重算表达候选。
- `jea channel outbox [--json]`：查看待发送消息。
- `jea channel send --to CHAT_ID --text TEXT [--dry-run]`：手工排队或预览一条出站消息。
- `jea channel desktop send [--session ID] --text TEXT [--id MESSAGE_ID]`：向本地 desktop 会话投递入站消息并入队 classifier；重复 `--id` 不会重复入队。
- `jea channel desktop read [ID] [--offset N] [--limit N | --tail N]`：读取 desktop 会话；返回稳定记录 id、逻辑 offset，并在读侧按 id 去重。`desktop sessions` 列出会话。
- `jea channel tick`：运行一次 channel dispatcher，按 pending inbound、attention signals、outbox 入队任务。
- `jea channel doctor [--json]`：诊断 channel worker 与任务队列；`--purge-deprecated --yes` 取消队列中 pending 的废弃任务；`--repair-worker-state --yes` 显式收敛死亡/stale worker（`status` 只读，不会偷偷改盘）；`--probe-network` 做不泄密的 SDK/DNS/HTTPS/凭据化 bot 探测；`--probe-ws` 仅显式启用，且 live channel worker 存在时拒绝第二条 WS。
- `jea channel queue purge-deprecated [--yes]`：预览或取消 `channel_ingest` / `channel_reply` / `channel_watch` pending 任务。channel daemon 启动时**不再**自动 purge；需手动执行上述命令。

### 飞书快速部署（新 subject）

依赖 `@larksuiteoapi/node-sdk`（`registerApp` 需 ≥ 1.61.1）与 `qrcode`（终端/PNG 二维码）。若 `npm install` 遇 peer 冲突，可用 `npm install --legacy-peer-deps`。

典型流程：

```powershell
jea subject init my-bot
jea data init --all --subject my-bot
jea channel feishu setup --subject my-bot --write-env --init-subject-config
jea daemon start --subject my-bot --domain channel
```

setup 会：

1. 调用 SDK `registerApp()`，在终端打印 ASCII 二维码，并保存/打开 PNG：`<JEA_HOME>/subjects/<ns>/data/channel/feishu-register-qr.png`。
2. 将 `client_id` / `client_secret` 写入 **subject 运行时** `.env`（`<JEA_HOME>/subjects/<ns>/.env`）的 `JEA_CHANNEL_FEISHU_APP_ID` / `JEA_CHANNEL_FEISHU_APP_SECRET`（文件已按 subject 隔离，变量名不再带 slug；同名 key 已存在且值不同需 `--force`）。项目根 `.env` 里带 slug 的旧变量仍可作为回退。
3. 若未配置 BIND 口令，自动生成 `JEA_CHANNEL_FEISHU_BIND_TOKEN` 并写入同一运行时 `.env`。
4. 可选 `--init-subject-config` 写入 `<JEA_HOME>/subjects/registry.json` 最小 `channels.feishu` skeleton（Secret 不进 JSON）。
5. 写入 `reload-request.json`，供运行中的 channel daemon 热加载。

扫码完成后，在飞书**私聊**新机器人发送：

```text
JEA BIND <口令>
```

口令来自 subject 运行时 `.env` 的 `JEA_CHANNEL_FEISHU_BIND_TOKEN`（setup 会生成；项目根带 slug 的旧变量为回退）。绑定成功后写入 `feishu-operator-binding.json`，并作为默认出站目标。

setup/register 可选参数：

| 参数 | 含义 |
| --- | --- |
| `--write-env` | 写入/更新 `<JEA_HOME>/subjects/<ns>/.env`（setup 默认开启；register 默认只打印） |
| `--force` | 覆盖该 `.env` 中已有同名 key |
| `--init-subject-config` | 自动补齐 JEA Home registry 的 `channels.feishu` skeleton |
| `--no-qr` | 不渲染终端二维码 |
| `--no-qr-image` | 不生成 PNG |
| `--no-open-qr` | 生成 PNG 但不自动用系统查看器打开 |
| `--json` | 机器可读输出（不打印二维码） |

验收建议：

```powershell
jea channel doctor --subject my-bot
jea channel events --subject my-bot --limit 20
```

`channel status` 里的 `feishu.listener.running` 在**独立 CLI 进程**中查询时可能为 `false`（listener 状态在 daemon 进程内存中）；以 `channel events` 中的 `feishu_listener_started` / `feishu_listener_connected` / `channel_message_received` 为准。

### 配置热更新（channel daemon 运行中）

channel worker 每轮 loop 会：

- 重新加载项目根 `.env`（`loadProjectEnv`），再按 subject 叠加运行时 `<JEA_HOME>/subjects/<ns>/.env`（后者优先，不写进全局 `process.env`）。
- 消费 `reload-request.json`。
- 调用 `ensureFeishuListener()`：凭据/domain/listener 开关变化时自动重启 WS listener；仅 allowlist、bind、operator binding 变化时只刷新 policy，不重连。

因此 **setup 写入 subject 运行时 `.env` 后，已运行的 `jea daemon start --domain channel` 通常无需重启**；数秒内应出现 `feishu_listener_started` 或 `channel_config_reloaded` 事件。

仍会触发 listener 重建的变化：`app_id`、`app_secret`、`domain`、`encrypt_key`、`verification_token`、`enabled` / `listenerEnabled` 开关。

`channel status --json` 的 `feishu.reload` 字段可查看 pending reload、`last_error`、`config_fingerprint`。

### 飞书 I/O deadline 与关闭

Feishu listener 由独立 supervisor 管理，不阻塞 classifier、presence、notify、speech、agent、control role 启动。`channel status --json` 的 `feishu.listener.state` / `feishu.reload.listener_state` 区分 `starting`、`connected`、`reconnecting`、`failed` 与 `stopped`；只有 `connected` 表示 SDK 已真实 ready。

默认边界为 listener connect 20 秒、单次 outbound send 30 秒、listener stop 5 秒、daemon shutdown grace 10 秒。可在 `channels.feishu` 中设置 `connect_timeout_ms`、`send_timeout_ms`、`stop_timeout_ms`、`shutdown_grace_ms`，或使用 `.env.example` 中对应的全局/subject 环境变量覆盖。

Listener supervisor 对 **SDK 尚未连上** 的 start/reload 失败做指数退避（默认 base 5s、×2、max 5min、jitter 20%、无限次数）。SDK 已连接后的内部 reconnect 不计入该状态机。连接成功、配置 fingerprint 变化或显式 reload request 时 attempt 清零；凭据缺失/监听关闭不做高频重试。`feishu.reload` 投影 `retry_attempt`、`backoff_ms`、`next_retry_at` 与最后错误码。一次连接失败只记一组 start failure，再由 supervisor 记 `feishu_listener_retry_scheduled`。

- send timeout 的远端结果可能不确定，因此不盲重试：notify task 与 outbox item 均落 `failed`，事件码为 `channel_timeout`。
- stop request、SIGINT 或 SIGTERM 产生 `channel_aborted`：进行中的 task 释放回 `pending` 并清除 lease，**不消耗**本次 claim 的 attempts。`channel_agent_run` 把 daemon AbortSignal 传到 `ctx.host.abortSignal`；Cursor SDK 在已绑定 run 时调用一次 `run.cancel()`，随后有界 `asyncDispose`。abort 记 `channel_agent_run_aborted` / `channel_task_aborted`，不得记 `channel_agent_run_failed`，也不触发失败后的 expression recompute。同一 `channel_agent_run_id` 依赖 deliverable/outbox 幂等键避免重启后重复发送。
- 启动、停止和 crash 路径会 `reconcileChannelWorkerState`：死亡 PID 或 stale 的 `running/stopping` role 转为 `stopped`，并重算 coordinator。重复 `daemon stop` 时只要 PID 已死即标 stopped，避免留下 `worker_zombie`。Viewer `channel_health` acknowledge 走 reconcile，而不是再把死亡 PID 标成 `stopping`。显式修复：`jea channel doctor --repair-worker-state --yes`。
- shutdown 会取消 HTTP、强制关闭 WebSocket，并在 10 秒 grace 内结束；不应依赖 SIGKILL。Agent 执行中的 stop 必须在 grace 内返回：停止耗时小于 10 秒、无 `channel_shutdown_grace_exceeded`、无 `worker_zombie`、无残留 daemon/Agent 子进程。
- timeout/abort/诊断事件只记录错误码、deadline 和 outbound id；不得写 App Secret、bind token、Authorization header、代理凭据或完整请求配置。`jea channel doctor --probe-network` 用 HTTPS token 探测做凭据化 bot check，不构造飞书 SDK Client / 不拉起 WS；区分 DNS、HTTPS/API 权限、WS 握手和 timeout。`--probe-ws` 仅显式启用，live worker 存在时拒绝第二条 WS。一次 listener connect 失败只记一组 `feishu_listener_start_failed`，再由 supervisor 记 `feishu_listener_retry_scheduled`。

入站分类边界（由 **`channel_classifier`** 批量 LLM/规则分类，不再在 presence 内同步正则分类）：

- 审批/发布类话语 → `approval_request` operator brief（软意图，非 `approval_granted`）。
- 已确认长期口径 → `operator_fact`（高置信且措辞明确时；否则降级为 observation）。
- 待核实或下一轮关注 → `verification_request` brief。
- 明确的本地控制命令 → `control_request`（见下文 Channel Control Actions）。
- 普通外部消息 → `intel_observations` 作为可推翻 evidence。
- 飞书 listener / `inbox put` 只写 `inbound/pending`；分类由 classifier role 按固定 `interval_ms` 批量处理（`batch_size` 上限，旧到新，超出留待下批）。
- 飞书入站（含 `JEA BIND`）默认立刻加表情回复 `OK`，用户消息下方会出现机器人小头像表示已收到。回执异步发出，失败只记 `feishu_receipt_reaction`，不挡 ingest / classifier。开放平台需开通「添加消息表情回复」权限（`im:message.reactions:write`）。可用 `channels.feishu.receipt_reaction=false` 或运行时 `.env` 的 `JEA_CHANNEL_FEISHU_RECEIPT_REACTION=0` 关闭；`receipt_reaction_emoji` / `JEA_CHANNEL_FEISHU_RECEIPT_REACTION_EMOJI` 改表情（如 `DONE`、`THUMBSUP`）。

出站由 **`channel_notify`** 独立任务 flush（outbox 有货即可入队，不依赖 presence 决策完成）；**所有对外表达**由 presence reactor 两阶段产出：`speech_intent`（决策）→ `channel_speech_generation`（人设/LLM 生成正文）→ outbox。旧 `channel_reply` / `channel_watch` / **`channel_ingest`** 任务类型已废弃；队列中若仍有，`jea channel doctor` 会提示 cancel。

### Desktop 本地会话

`channels.desktop` 提供不依赖宿主 UI 或外部 API 的 inbound/outbound adapter。入站仍写 `inbound/pending`，完整复用 classifier → ingest → presence → speech → outbox → notify；出站目标使用 `desktop:<session>`，notify 将 assistant 消息追加到对应 JSONL 会话。desktop 与 Feishu 可同时启用，transport 由每条 outbound 的 target/channel 决定。

```json
"channels": {
  "desktop": {
    "enabled": true,
    "default_session": "main"
  },
  "presence": {
    "default_transport": "desktop",
    "default_target": "desktop:main"
  }
}
```

会话记录带 `schema_version`、稳定 `id` 和 append offset；存储只追加，读取 API/CLI 支持 offset、tail，并按稳定 id 去重。session id 仅允许字母、数字、点、下划线和连字符。

共享三栏工作区的 Conversation surface 复用同一 adapter：renderer 只通过受控 Client API 调用 send/read/list，消息回复仍必须经过 classifier → presence → speech → outbox → notify。主进程按逻辑 offset 增量读取 desktop session，并实时投影 processed inbound 的 `classifier.understanding`；飞书消息显示在统一 inbound feed，但不会伪装成 desktop session。`fs.watch` 只负责低延迟唤醒，30 秒 reconcile 负责补偿漏事件。

### Channel Classifier（`channels.classifier`，固定频率批量）

**`channel_classifier` 任务**（classifier role worker 领取）：

1. 从 `inbound/pending` 按时间顺序取最多 `batch_size` 条
2. BIND / duplicate 机械处理（不进 LLM batch）
3. LLM（或 `deterministic` 回退）批量输出受限 schema：`approval_request` / `verification_request` / `operator_fact` / `control_request` / `observation` / `ignore`，以及每条非 `ignore` 项的 **`understanding`** 对象（`user_intent`、`needs_immediate_action`、`action_hint`、`temporal`、`complexity`）；deterministic 回退用规则推断同等字段
4. 写入 brief / fact / control task / observation 并移到 `processed`（`classifier.understanding` 保留在 processed JSON）；失败按 `fallback` 保留 pending 或降级 observation
5. 非 `control_request` 分类完成后 `requestExpressionRecompute`（`reason: inbound_classified`）；`control_request` 由 control executor 完成后唤醒 presence

协调器按 `classifier.interval_ms` 调度入队（幂等键 `${subject}:channel_classifier:pending`）；与 presence tick（默认 5min）独立。

`<JEA_HOME>/subjects/registry.json` 示例：

```json
"classifier": {
  "enabled": true,
  "mode": "llm",
  "interval_ms": 30000,
  "batch_size": 20,
  "timeout_ms": 25000,
  "fallback": "observation"
}
```

- `mode`: `llm` | `deterministic` | `mock`（无 API key 时 deterministic 回退）
- `fallback`: `observation`（批内缺项降级）| `retry`（保留 pending 下轮重试）

### Channel Control Actions（`control_request` + `channel_control_action`）

Classifier 识别 `control_request` 后**不直接执行**配置变更，而是入队 `channel_control_action` 任务，由 **control role worker** 通过白名单 registry 执行。

首批注册动作：

| action_id | 含义 | 写操作 | 需要授权 |
| --- | --- | --- | --- |
| `daemon_evolution_state_set` | 切换 `active` / `paused` | 是 | operator binding 或 allowlist |
| `daemon_evolution_state_show` | 查看当前 evolution state | 否 | 否 |
| `daemon_reaction_request` | 入队显式 reaction / cognitive wake | 是 | operator binding 或 allowlist |
| `daemon_evolution_mode_set` | 已弃用：只写 `evolution.mode`，不改变 `evolution.state` | 是 | operator binding 或 allowlist |
| `daemon_evolution_mode_show` | 已弃用：查看 legacy evolution mode | 否 | 否 |
| `daemon_cycle_request` | `daemon_reaction_request` 的兼容别名 | 是 | operator binding 或 allowlist |

约束：

- Classifier 只能输出注册过的 `action_id` + 明确 `params`；高置信才允许写类 action；未知 action / 低置信 / 非法参数会进入 control executor 失败审计，而不是静默降级。
- Presence planner **不能**直接改 `evolution.state` / `evolution.mode`；只能基于 control executor 的审计事件回复结果。
- 远端发布、`approval_granted`、凭据、subject policy 仍不可通过 channel 自动执行。

默认 channel daemon roles：`notify` / `control` / `agent` / `presence` / `speech` / `classifier`。升级后需重启 channel daemon。

### Channel Presence Loop（`channels.presence`，transport-agnostic，async reactor）

外部刺激只请求「表达状态重算」：飞书 listener / `jea channel inbox put` 先写 `inbound/pending` 并入队 classifier；classifier 完成、presence tick、daemon attention 等统一 append `expression_recompute_requested` 并入队 `channel_presence`。**Presence 不读取 raw inbound，也不在 presence 路径分类 inbound。**

**Bounded reactor**（`channel_presence` 任务 → `runPresenceReactor`）：

1. claim 一批 channel events（合并多 wake）
2. `buildPresenceContext`（扫描全部**已分类** processed，按最老未 handled 项构建有界 candidate page；recent/background prompt context 仍有界；另读 pending unclassified 计数、daemon signals 等）
3. 构建 `expression.candidates`：把可表达对象统一成 `reply.*` / `notify.*` candidates；`ignore` 只作背景，不生成 candidate
4. `planPresence` → `no_op` / `speak` / `silence` / `act`；`speak` 只产出 `speech_intent`（**不写 outbox**）
5. 对 `speech_intent` append `speech_generation_requested` 事件，入队 `channel_speech_generation`

**内容生成**（`channel_speech_generation` → `runChannelSpeechGenerationTask`，speech role worker）：按 subject persona + `content_requirements` 生成最终文本，成功后 `writeOutboxMessage` 并推进 handled；失败/超时记 `channel_speech_generation_failed` / `channel_presence_timeout`，不写 outbox、不推进 handled，并按 `speech_generation_max_attempts` 有界 requeue。rate-limit / cooldown 跳过同样不推进 handled。

所有 speech 文本、agent deliverable 与 outbox payload 在持久化前统一经过 `redactSecrets`；`writeOutboxMessage` 是所有 transport 的最终兜底边界，防止生成或渲染分支把凭据写盘或送出。

Delivery 的幂等/恢复边界：

- candidate 只有在 speech 正文成功持久化到 outbox 后才进入 `handled_candidates`；
- 生成失败、timeout、rate-limit 或 cooldown 都不推进 handled，并按 `speech_generation_max_attempts` 有界重试；
- notify 只消费 durable outbox；desktop session 以稳定 message id 去重，Feishu timeout 结果不确定时标 failed 而不盲重放；
- operator projection 分开呈现 Conversation readiness、pending evidence、pending channel/daemon tasks 与 attention，Channel 不把这些计数合并成单一 backlog。

`runChannelTick`：presence tick（`reason: timer_tick` 的表达重算 + notify）；classifier tick 单独按 `interval_ms` 入队 classifier。默认多 role 下 notify / control / agent / presence / speech / classifier **并行领取**，互不阻塞。

事件队列与审计 `events.jsonl` 分离。`jea channel status --json` 的 `presence.event_queue` / `presence.reactor` / `presence.pending_speech_generation` 可观测 reactor 与待生成话术。

`<JEA_HOME>/subjects/registry.json` 示例：

```json
"channels": {
  "presence": {
    "enabled": true,
    "planner": "llm",
    "max_actions_per_tick": 2,
    "cooldown_ms": 1800000,
    "max_messages_per_hour": 8,
    "timeout_ms": 60000,
    "decision_timeout_ms": 15000,
    "speech_generation_timeout_ms": 30000,
    "default_target": "oc_xxx"
  }
}
```

- `enabled`: 设为 `false` 时 reactor 跳过表达（inbound 仍由 classifier 处理，若 classifier 启用）。
- `planner`: `deterministic`（规则决定 `speech_intent` + 模板生成）或 `llm`（决策与生成均可调 DeepSeek）。
- `timeout_ms` / `decision_timeout_ms` / `speech_generation_timeout_ms`: reactor 与两阶段 deadline；超时记 audit，worker 不永久卡死。
- `cooldown_ms` / `max_messages_per_hour`: 出站节流（按 `channel_speech_generated` 计数）。
- 游标 + reactor：`presence-state.json` 只保留近期 `handled_candidates` 投影及 `reactor.status|deadline_at|event_ids`、`pending_speech_generation`；完整 handled 真相在 `presence-handled-index.json`。`inbound/processed-index.json` 保存已分类消息的紧凑索引，Presence 每轮不再解析全部历史消息文件。
- 交互记忆：`intel_observations`（`source: channel_presence`）。
- 审计：`channel_expression_recompute_requested` / `channel_expression_planned` / `channel_expression_noop` / `channel_expression_silenced` / `channel_speech_generated` / `channel_presence_completed` / `channel_presence_timeout` 等。
- 决策动作：`speech_intent`（仅意图）、`start_agent_async`（只入队只读 `channel_agent_run`）、`write_operator_brief`、`record_observation`；表达计划可为 `no_op` / `speak` / `silence` / `act`，**不能**直接 `approval_granted` 或改 decision queue。
- **Classifier understanding**：`expression.candidates` 可携带 `understanding`（来自 `inbound/processed` 的 `classifier` 字段）。LLM planner 据此决定 agent / brief；`needs_immediate_action=true` 时 **跳过** approval/verification 的 fast ack，进入完整审议；deterministic planner 在 `temporal=now` 且非 high complexity 时可自动 `start_agent_async`。

**生产建议**：默认已分 role worker；仅需调试时用 `--channel-role` 启动子集。`--channel-role all` 恢复单 worker 消费全部任务类型。升级 channel 代码后需重启 channel daemon。

手工跑一轮：`npm run jea -- channel presence run --subject NAME`。`jea channel work` 仅保留 `notify` 子命令（发送 pending outbox）。

确定性 planner 默认行为（与旧 guarded reply 类似）：

| 输入/信号 | 默认行为 |
| --- | --- |
| 新入站 `approval_request` | fast ack「已记录为下一轮审批意图」（若 `understanding.needs_immediate_action` 则改走 LLM 审议，可同时 agent） |
| 新入站 `verification_request` | fast ack「已记录为下一轮核实请求」（同上） |
| 新入站需立刻调查的 `observation` | deterministic：`start_agent_async` + ack（当 understanding 满足 now + 非 high） |
| 新入站 `operator_fact` | ack「已记录为高置信 operator fact」 |
| 新入站寒暄类 `observation` | 简短在场确认 |
| 未 handled 的 `task_failed` / `daemon_health` / `reactor_backlog` / `cycle_drift` / `requires_human_review` 等 | 主动通知（受 cooldown） |

修改 `channels.presence` 或 allowlist/bind 后，运行中的 channel daemon 会在下一轮 loop 读盘生效。修改 `app_id` / `app_secret` 或关闭 listener 时，daemon 会自动重建 WS 连接。**升级 JEA 代码后需重启 channel daemon。**

### 私聊绑定（`JEA BIND`）

仅私聊、未手填 `ou_` 时，可在 `channels.feishu.bind` 开启口令绑定。推荐用 `jea channel feishu setup` 自动生成 BIND 口令并写入 subject 运行时 `.env`；也可手工设置。

1. `<JEA_HOME>/subjects/<ns>/.env` 设置 `JEA_CHANNEL_FEISHU_BIND_TOKEN`（或 JEA Home registry 的 `bind.token_env`；项目根带 slug 的旧变量为回退）。
2. 启动 `jea daemon start --subject NAME --domain channel`（若已在运行，setup 写 env 后会通过 reload 热加载，通常无需重启）。
3. 在飞书里**私聊**机器人，发送：`JEA BIND <口令>`（短语默认 `JEA BIND`，可在 `bind.phrase` 自定义）。
4. 绑定结果写入 `<JEA_HOME>/subjects/<ns>/data/channel/feishu-operator-binding.json`，并自动作为 `allow_from` / 默认出站目标；`jea channel status --json` 的 `feishu.config.operator` 可查看（open_id 脱敏）。成功时 events 可见 `feishu_operator_bound`。

未绑定前仅接受绑定握手消息；群聊可用 `group_policy: disabled` 关闭。覆盖他人绑定需再次发送带**同一口令**的 `JEA BIND`。

飞书配置按 **subject 隔离**（每个 subject 可绑定不同机器人）。凭据写在该 subject 的运行时 `.env`，用短变量名即可。`app_secret` 不要明文写入 JEA Home registry，用 `app_secret_env` 指向环境变量名。

`<JEA_HOME>/subjects/registry.json` 示例（`my-subject` 与 `other-subject` 各用各的 bot）：

```json
{
  "subjects": {
    "my-subject": {
      "channels": {
        "feishu": {
          "enabled": true,
          "app_id_env": "JEA_CHANNEL_FEISHU_APP_ID",
          "app_secret_env": "JEA_CHANNEL_FEISHU_APP_SECRET",
          "dm_policy": "allowlist",
          "allow_from": [],
          "group_policy": "allowlist",
          "require_mention": true,
          "bind": {
            "enabled": true,
            "phrase": "JEA BIND",
            "token_env": "JEA_CHANNEL_FEISHU_BIND_TOKEN"
          }
        }
      }
    },
    "other-subject": {
      "channels": {
        "feishu": {
          "enabled": true,
          "app_id": "cli_bbbb",
          "app_secret_env": "JEA_CHANNEL_FEISHU_APP_SECRET",
          "default_chat_id": "oc_bbbb"
        }
      }
    }
  }
}
```

优先写 `<JEA_HOME>/subjects/my-subject/.env`。文件已经按 subject 隔离，变量名不带 slug：

```env
JEA_CHANNEL_FEISHU_APP_ID=cli_aaaa
JEA_CHANNEL_FEISHU_APP_SECRET=REPLACE_WITH_YOUR_APP_SECRET
JEA_CHANNEL_FEISHU_BIND_TOKEN=choose-a-long-random-token
```

| 变量 | 含义 |
| --- | --- |
| `JEA_CHANNEL_FEISHU_APP_ID` | App ID |
| `JEA_CHANNEL_FEISHU_APP_SECRET` | App Secret |
| `JEA_CHANNEL_FEISHU_DEFAULT_CHAT_ID` | 默认出站群（可选） |
| `JEA_CHANNEL_FEISHU_BIND_TOKEN` | 私聊 `JEA BIND` 口令 |
| `JEA_CHANNEL_FEISHU_RECEIPT_REACTION` | `0` 关闭入站表情回执（默认开） |
| `JEA_CHANNEL_FEISHU_RECEIPT_REACTION_EMOJI` | 回执表情，默认 `OK` |

项目根 `.env` 里带 slug 的旧变量（`JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` 等）仍可作回退；`<SUBJECT>` 为 subject id 的 env slug（见 `subjectEnvSlug()`）。多主体并行时把凭据放进各自的运行时 `.env`，不要共用一份全局 `JEA_CHANNEL_FEISHU_APP_ID`。

| 变量 | 含义 |
| --- | --- |
| `JEA_CHANNEL_FEISHU_MOCK=1` | 全部 subject 出站 mock |
| `JEA_CHANNEL_FEISHU_DOMAIN` | 默认域名 `feishu` / `lark` |

`jea daemon start --domain channel` 在凭证齐全时会为**当前 subject** 启动 Feishu WebSocket listener；多 subject 需分别启动 daemon 进程。禁用 listener：`--no-feishu-listener`。listener 是否在运行，优先看 `jea channel events` 中的 `feishu_listener_*` 事件，而非独立 CLI 进程的 `channel status`。
