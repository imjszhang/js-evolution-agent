# AGENTS.md

本文件是当前项目的 CLI 操作指引，面向本地操作者和自动化代理。项目主命令是 `jea`，推荐在项目根目录执行。

## 基础用法

```powershell
npm install
npm run jea -- help
```

常用入口：

```powershell
npm run jea -- <command>
npm run doctor
npm start
```

安装包 bin 链接可用后，也可以直接使用：

```powershell
jea doctor
jea run --mock
jea data status
```

## 环境与诊断

- `jea doctor`：检查 Node、依赖、`.env`、DeepSeek 配置、Cyber-Taoist 文档（`CONSTITUTION.md`、`SKILL.md`）和 `oada.config.mjs`。
- `jea llm ping`：测试 DeepSeek 连接。
- `jea llm ping --mock`：测试本地 Mock AI 路径。
- `jea policy check`：检查当前主体策略是否包含必需章节（`Subject`）。

真实模型调用依赖 `.env` 中的 `DEEPSEEK_API_KEY`。没有 API key 时，可使用 `--mock` 走本地模拟路径。

## 运行演化循环

- `jea run [--mock] [--deepseek] [--skip-goals-assess] [--skip-belief-update] [--subject NAME]`：运行一次完整演化循环并写入情报回执。
- `jea run --mock`：不调用真实模型，适合本地冒烟验证。
- `jea run --deepseek`：要求 DeepSeek API 配置存在。
- `jea run --skip-goals-assess`：跳过本轮目标评估（Phase 4 / 4.5）。
- `jea run --skip-belief-update`：跳过 post-verify 信念更新（Phase 3.5）。

单轮主流水线：

```text
Phase 1   intel pipeline（observe -> report -> analyze+decide）
Phase 1.5 intel report 持久化
Phase 2   exec（消费 pending_decisions 队列）
Phase 3   verify（机械验证 + 语义验证）
Phase 3.5 belief_update（更新 current_beliefs；可用 --skip-belief-update 跳过）
Phase 4   goals assess
Phase 4.5 goals calibrate
Phase 5   evolution diary
```

信念（Belief）在 Phase 1 被 Decide 读取约束行动，在 Phase 3.5 依据 receipt 与 verify_report 正式更新。详见下文「信念管理」与「人工审批与操作者意图」。

批量演化：

- `jea evolve --rounds N`：连续运行多轮演化，带重试和运行状态记录。
- `jea evolve status [ID]`：查看最近或指定演化运行状态。
- `jea evolve resume ID`：恢复被中断的演化运行。

相关环境变量：

- `JEA_EXEC_LIMIT`：限制单轮执行阶段最多处理的决策数，默认 `5`。
- `JEA_VIEWER_BUILD_LIMIT`：`jea intel viewer serve` / `build` 的轮次上限，默认 `50`。
- `JEA_SKIP_GOALS_ASSESS=1`：跳过目标评估。
- `JEA_SKIP_BELIEF_UPDATE=1`：跳过 post-verify 信念更新。
- `JEA_FORCE_MOCK=1`：强制使用 Mock AI。

## 运行时数据

运行时数据按 active subject 隔离，默认位于：

```text
runtime/subjects/<data_namespace>/
```

常用命令：

- `jea data status`：查看当前主体运行时数据概况。
- `jea data status --json`：输出机器可读 JSON。
- `jea data init`：创建运行时数据目录，不删除历史。
- `jea data init --all`：创建目标模板并写入初始化情报。
- `jea data backup [--name NAME]`：备份当前主体运行时数据到 `backups/subjects/<data_namespace>/`。
- `jea data reset [--yes]`：删除当前主体本地运行时数据。此命令有破坏性，自动化代理不要在未确认的情况下执行。

## 情报与报告

查看情报：

- `jea intel summary [--days N] [--limit N]`：查看近期情报记忆摘要。
- `jea intel report`：输出最新 Markdown 情报报告。
- `jea intel report list [--limit N]`：列出近期报告。
- `jea intel report --cycle <id>`：输出指定 cycle 的报告。
- `jea intel report --open`：用系统默认程序打开最新报告。
- `jea intel report --json`：输出报告索引记录 JSON，而不是 Markdown 正文。
- `jea intel viewer serve [--port N] [--open] [--limit N] [--subject NAME]`：托管 `tools/evolution-viewer/public/` 并直读当前 subject runtime（`GET /api/manifest`、`GET /api/rounds/:cycleId`）；`/events` SSE tail `evolution-events.jsonl`，推送 `round_added` / `round_updated`，**无需先 build dist**。
- `jea intel viewer build [--subject NAME] [--limit N] [--out PATH]`：可选离线快照（marked 预渲染到 `tools/evolution-viewer/dist/`）；用 `npx serve tools/evolution-viewer/dist` 等任意静态服务器打开。
- `npm run viewer:build` / `npm run viewer:serve`：同上（`viewer:serve` 默认 `--open`）。

写入情报：

- `jea intel ingest --source NAME [--file PATH | --stdin] [--json]`：直接写入一条或多条 JSON 记录到当前主体 intelligence store。`entity_jsonl` 类 source（如 `probe_threads`）要求每条记录带 `_entity_id`。
- `jea intel inbox put --source NAME [--file PATH | --stdin] [--name LABEL]`：把 JSON 载荷放入 `_inbox`，供之后 drain。
- `jea intel inbox drain [--dir PATH] [--json]`：将 `_inbox` 中的文件导入 intelligence store。

操作者 brief（Operator Intent Brief）：

- `jea intel brief put [--file PATH | --stdin]`：为下一次 intel cycle 放入一次性操作者意图 brief。
- `jea intel brief list`：列出待处理 brief。
- `jea intel brief processed`：列出已消费 brief。

Brief 是**单轮人工意图**，不是已验证证据；Phase 1 的 report/decide prompt 会读取它，Analyze+Decide 成功入队后归档到 `processed/`。存储路径：

```text
runtime/subjects/<data_namespace>/data/evolution/operator_briefs/pending/
runtime/subjects/<data_namespace>/data/evolution/operator_briefs/processed/
```

最小 JSON 示例：

```json
{
  "kind": "approval_request",
  "scope": "next_cycle",
  "summary": "人工审批同意发布候选 X",
  "desired_decision_effect": "下一周期在 agentank_evolver scope 执行远端发布，并在发布后 getTank 探针验证 rank 变化",
  "suggested_actions": ["agent_run"],
  "expires_after_cycle": true
}
```

常用字段：`summary`、`claims_to_verify[]`、`desired_decision_effect`、`suggested_actions[]`、`kind`（如 `verification_request`、`approval_request`）、`priority`。在 chat 里口头说「同意发布」**不会**自动进入系统；操作者或自动化代理需执行 `jea intel brief put` 落盘。

## 人工审批与操作者意图

系统**没有**独立的 `jea approve` 命令。人工审批通过两层机制配合：

| 机制 | 入口 | 作用 | 是否硬开关 |
| --- | --- | --- | --- |
| Operator Intent Brief | `jea intel brief put` | 影响下一轮 Phase 1 Decide 如何排优先级 | 否（软输入，引导 LLM） |
| `approval_granted` | Decide 产出的 action 字段 | Phase 2 preflight：与 `requires_approval` 联用时，无批准则 blocked | 是 |

典型远端发布流程（如 `agentank-tank`）：

1. 某轮 `agent_run` 在 lane worktree 内完成候选生成、模拟、门禁，仅准备 release artifacts（Decide 可约束「不触发远端发布」）。
2. verify / evolution diary 标记 `requires_approval` 或 `acceptance_status: requires_human_review`。
3. 操作者 `jea intel brief put` 表达同意（或校准基线、修正口径等意图）。
4. 下一轮 Decide 调度带 `approval_granted: true` 的 `agent_run`（`permission_profile: remote_write_review`）；外部工具层（如 agentank-evolver 的 `AGENTANK_ALLOW_PUBLISH`）仍可能拦截。
5. 发布后 getTank 探针验证 rank；若 `|rank_delta|≥50`，可能再次要求人工确认新基线（再提交 brief）。

其他需人工介入的场景：

- **核心层变更**：`core_apply` 默认受 `JEA_CORE_APPLY_POLICY=review` 约束；`request_core_review` 只落审批请求，不执行变更。
- **主体边界**：`policies/subjects/<name>.md` 的 Off-Limits Without Human Approval 定义各 subject 的审批规则（凭据、远端发布、越界写入等）；AGENTS.md 不重复主体语义，用 `jea subject check` 校验 policy 结构。

自动化代理在未获操作者明确确认时，不要替其提交发布/基线校准类 brief，也不要在 action 上伪造 `approval_granted`。

## 目标管理

- `jea goals show`：显示当前 active goal hypothesis。
- `jea goals history [--limit N]`：查看目标变更事件。
- `jea goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID]`：替换 active goals 并记录目标事件。
- `jea goals assess [--cycle ID]`：让 AI 评估目标校准情况并记录评估事件。

信念管理：

- `jea beliefs show`：显示当前 active/validated/refuted 信念状态。
- `jea beliefs events [--limit N]`：查看近期信念变更事件。
- `jea beliefs update [--cycle ID]`：手动触发 post-verify 信念更新（通常由 `jea run` Phase 3.5 自动执行）。

信念是绑在 goal 上的可验证行动假设（`claim`、`next_test`、`evidence_refs`）。Decide 阶段通过 `params.run_spec.context.belief_id` / `belief_relation` 绑定 `agent_run`；**创建或调整信念的正式写入点在 Phase 3.5**，依据 action receipt 与 verify_report，而非 report 叙事。存储：`data/intelligence/beliefs/current_beliefs.json`、`belief-events.jsonl`。

目标 JSON 需要包含 `id`、`name`、`intent`、`good_signal`、`bad_signal` 和 `children`。

## Daemon 工作流

Daemon 用于事件驱动的前台 worker 循环。每个 subject 应独立运行 worker，避免同一 subject 并发演化。

任务与 worker：

- `jea daemon enqueue --type run_cycle`：加入一个 daemon 任务。
- `jea daemon work --once [--mock]`：执行一个 daemon 任务后退出。
- `jea daemon start [--mock] [--heartbeat-ms N] [--lease-ms N]`：在前台启动 worker 循环。
- `jea daemon stop`：请求当前主体 worker 优雅停止。
- `jea daemon stop --all`：请求所有选中主体 worker 停止。

观测与诊断：

- `jea daemon status [--all | --subjects a,b] [--json]`：查看 worker、队列、健康状态、锁和最近事件。
- `jea daemon doctor [--all | --subjects a,b] [--json]`：诊断 daemon 健康状态。
- `jea daemon events [--all | --subjects a,b] [--limit N] [--json]`：查看近期 daemon/task 生命周期事件。
- `jea daemon inbox [--all | --subjects a,b] [--json]`：汇总最新 intel report、evolution diary、verify report、standing memory 和健康注意项。

任务列表与处置：

- `jea daemon tasks list [--all | --subjects a,b] [--status STATUS] [--json]`：列出任务。
- `jea daemon tasks inspect <task_id>`：查看单个任务详情。
- `jea daemon tasks retry <task_id>`：重试任务。
- `jea daemon tasks cancel <task_id>`：取消任务。
- `jea daemon tasks acknowledge <task_id>`：确认已检查过的失败任务（别名 `ack`）。

`jea daemon start` 和 `jea daemon work --once` 保持单 subject 单进程；多主体并行应由外部终端或编排器分别启动。

## Subject 管理

Subject 决定策略、命名空间和运行时路径。

- `jea subject list`：列出 registry 中的 subjects 与 default subject。
- `jea subject show [--subject NAME]`：显示 subject、core layer、namespace 和 runtime paths；无 `--subject` 时使用 default subject。
- `jea subject init <name> [--use]`：从模板创建新 subject 并写入 registry；`--use` 同时设为 default。
- `jea subject use <name>` / `jea subject default <name>`：更新 `policies/subjects.json` 中的 default subject。
- `jea subject check [--subject NAME]`：校验 subject policy。
- `jea subject lane status|init [--subject NAME]`：检查或初始化目标仓库 lane。
- `jea run --subject NAME`：显式指定单轮演化主体；`jea evolve` / `jea daemon` 已支持 `--subject` / `--subjects` / `--all`。

`policies/subjects.json` 是本地 registry，可承载机器可读的 `lane` 与 `resources` 字段；字段形态参考 `policies/subjects.example.json`。主体 Markdown policy 只保留主体语义、安全边界和人工审批规则，不维护 repo、branch、resource root、resource mapping 等机器字段。

创建或切换 subject 后，通常先执行：

```powershell
jea data init --all --subject <name>
```

## 审计与动作

- `jea audit queue`：检查决策队列健康状态、未知动作和陈旧 in-progress 项。
- `jea audit queue --archive`：预览归档 completed/expired 队列项。
- `jea audit queue --archive --yes`：执行归档。
- `jea actions list`：列出已注册 action types。
- `jea actions check`：检查待处理决策中的未知 action types。

Phase 2（exec）action 选择口径：

- 主执行：优先 `agent_run`（调查、改代码、模拟、发布准备等“做事”任务）。
- 记录型：`record_observation`、`propose_probe`、`write_retrospective`、`request_core_review` 只落已有结论/提案/审批请求，不用于读文件或调查。
- 系统/兼容：`lane_status`、`lane_observe`、`lane_verify`、`github_open_lane_pr` 是机械 lane 能力；`run_probe`、`agent_execute` 是旧兼容动作；`core_apply` 仅用于 core 层审批变更。subject policy 不应维护 subject-specific action 菜单，业务能力通过 `subjects.json` 的 lane/resources 或 configured external actions 表达。

## 旧脚本

这些脚本仍保留，主要用于兼容或低层调试：

```powershell
npm run intel
npm run exec
npm run decisions
npm run reset-data
```

优先使用 `jea` 命令族；只有在需要直接访问底层 engine CLI 时再使用旧脚本。

## 操作建议

- 先运行 `jea doctor`，再运行真实演化。
- 本地验证优先使用 `jea run --mock` 或 `jea daemon work --once --mock`。
- 涉及删除或重置数据的命令，例如 `jea data reset --yes`，必须确认当前 subject 和 namespace。
- 多主体并行时，用 `jea daemon status --all`、`jea daemon doctor --all` 和 `jea daemon inbox --all` 做总览。
- 自动化脚本需要结构化输出时，优先使用带 `--json` 的命令。
- 发布/基线校准等人工作业：先读最新 evolution diary 与 verify report，再用 `jea intel brief put` 提交意图，然后 `jea daemon enqueue --type run_cycle` 或 `jea run`；用 `jea intel brief list` / `processed` 确认 brief 是否已被消费。
