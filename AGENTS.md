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

- `jea doctor`：检查 Node、依赖、`.env`、DeepSeek 配置、权威文档（`policies/authority/CONSTITUTION.md`、`GUIDE.md`）、`oada.config.mjs`，以及 `repolink.config.mjs` 声明的兄弟仓库链接（`jea doctor` 的 Repo Links 段）。
- `jea llm ping`：测试 DeepSeek 连接。
- `jea llm ping --mock`：测试本地 Mock AI 路径。
- `jea policy check`：检查当前主体策略是否包含必需章节（`Subject`）。

真实模型调用依赖 `.env` 中的 `DEEPSEEK_API_KEY`。没有 API key 时，可使用 `--mock` 走本地模拟路径。

## 外部仓库链接（js-repolink）

JEA 通过 [js-repolink](https://github.com/imjszhang/js-repolink) 引用同机器上活跃开发中的兄弟仓库（lane 目标、configured external actions），避免在 `runtime/subjects/registry.json` 中硬编码绝对路径。

| 文件 | 作用 |
| --- | --- |
| `repolink.config.mjs` | 声明链接 id、envVar、entry、preflight、versionProbe（可提交） |
| `.env` | 各链接的绝对路径，如 `AGENTANK_EVOLVER_PATH=D:/github/My/agentank-evolver` |
| `runtime/subjects/registry.json` | 使用 `link:<id>` 引用，如 `"repo": "link:agentank-evolver"` |

常用命令：

```powershell
jea doctor                    # Repo Links 段：ok / unconfigured / path-missing / entry-missing
npx repolink list             # 若全局安装 js-repolink，可独立查看链接状态
npx repolink check --link agentank-evolver
```

`external_tools.<tool>.link` 指向 repolink link id 时，Phase 2 exec 会在运行 configured external action 前做 link preflight；失败返回 `blocked` receipt（`blocked_reason: repo_link_unavailable`），而不是 ENOENT 裸报错。

自动化代理在未确认操作者路径前，不要替其写入 `.env` 中的链接路径；`link:` 引用未配置时 `jea subject check` 会报 `lane.repo_link_unresolved` / `resources.link_unresolved` 诊断。

## 运行演化循环

- `jea run [--mock] [--deepseek] [--skip-goals-assess] [--skip-belief-update] [--subject NAME]`：运行一次完整演化循环并写入情报回执。
- `jea run --mock`：不调用真实模型，适合本地冒烟验证。
- `jea run --loop` / `jea run --pipeline agent_loop`：使用 **agent_loop** 管道（见下节）。
- `jea run --deepseek`：要求 DeepSeek API 配置存在。
- `jea run --skip-goals-assess`：跳过本轮目标评估（Phase 4 / 4.5）。
- `jea run --skip-belief-update`：跳过 post-verify 信念更新（Phase 3.5）。

单轮主流水线（默认 `phases`）：

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

### Agent Loop 管道

`agent_loop` **仅替代 Phase 1**，按报告中心生产线编排；**Phase 2 exec 仍独立执行** pending_decisions；verify / belief / goals / diary **保持固定收尾**。

内部阶段：

```text
机械 Seen 底板 → 只读查证（tool loop，可交 verified_facts）
→ 宿主组装最终 Seen（machine_context + 机械底板 + verified_facts）
→ 模型单次定稿判断章节（Inferred / Cyber-Taoist / 下一轮建议）
→ 宿主 splice Seen + 引用字形净化 → 经典 Analyze+Decide JSON 批入队
```

模式解析优先级（仿 evolution.mode）：

1. `runtime/subjects/registry.json` → `subjects.<name>.evolution.pipeline`
2. CLI `--loop` / `--pipeline agent_loop|phases`
3. env `JEA_CYCLE_PIPELINE`
4. 默认 `phases`

agent_loop 管道 step 图：

```text
agent_loop → exec → verify → belief_update → goals_assess → goals_calibrate → diary
```

相关 env：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JEA_CYCLE_PIPELINE` | `phases` | `phases` 或 `agent_loop` |
| `JEA_LOOP_MAX_READONLY_TURNS` | `6` | 只读查证最大 LLM 轮数（主配置） |
| `JEA_LOOP_MAX_TURNS` | （可选） | 与 `MAX_READONLY` 取较小值；兼容旧配置 |
| `JEA_LOOP_MAX_WALLCLOCK_MS` | `1200000` | 整步墙钟（查证+报告+Decide） |
| `JEA_LOOP_FINISH_RESERVE_MS` | `120000` | 留给报告+Decide 的墙钟预留（查证软截止 = 总墙钟 − 预留） |
| `JEA_LOOP_CLOSING_TIMEOUT_SEC` | `240` | 查证强制收尾轮 LLM 超时（秒） |
| `JEA_LOOP_TOOL_RESULT_MAX_CHARS` | `6000` | 回填模型的工具结果截断 |
| `JEA_EXEC_LIMIT` | `5` | Decide 批入队上限；超出进 deferred/carryover；Phase 2 exec 仍按该上限消费队列 |
| `JEA_QUEUE_AUTO_ARCHIVE` | 开启 | `0`/`false` 关闭；agent_loop 开始前自动归档 completed/expired 决策 |

查证工具（仅 investigation 阶段）：

- **readonly**：`intel_query`、`get_current_beliefs`、`get_active_goals`、`get_decision_queue_summary`、`read_intel_report`（工具结果附 `ref` / `cite_as` 句柄）
- **control**：`finish_investigation`（必填 `findings_summary`、`enough_for_report`；可选 `gaps_closed` / `open_gaps` / `verified_facts[{ref,statement}]`）

查证阶段**不**注册 action 入队工具，也**不**在 loop 内写完整 Intel 报告。**phases 与 agent_loop 的最终 Seen 均由宿主组装**：机械底板 + `machine_context` bullets（agent_loop 另可并入已校验 `verified_facts`；phases 无查证阶段故 `verifiedFacts=[]`）。模型只写判断章节。落盘次序：`transformMd` 在 `persistIntelReport` 内、`redactSecrets` 之前做字形净化与 `## Seen` splice（只写盘一次）；persist 后发单次诚实事件（`phases_report_honesty` / `agent_loop_report_honesty`）。agent_loop 查证若有 `rejected_facts`，另发 `agent_loop_rejected_facts`（不进 carryover）。模型裸写存档：`phases_report_raw.md` / `agent_loop_report_raw.md`（诚实矩阵 raw 列测裸写纪律；最终产物硬闸看 splice+脱敏后报告）。有意不对称：phases 报告 prompt 仍含 intelligenceContext + observe + Machine Context JSON；agent_loop 报告 prompt 更瘦。verify 复放的是宿主最终报告（raw 仅存档）。

机械守护（`evolution.guards`，不占 Decide 入队预算）：

在 `runtime/subjects/registry.json` 的 `subjects.<name>.evolution.guards` 配置固定节奏动作（如凭据 sync、记忆审计）。`runExecStep` 在消费决策队列前按 `every_cycles` 到期执行；状态在 `data/evolution/agent_loop_guard_state.json`。

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

Carryover：由查证 `open_gaps`、Decide `deferred` / goal suggestions 合并覆写 `data/evolution/agent_loop_carryover.json`；下一轮查证 initial prompt 的 `## Carryover from previous cycle` 注入（空数组也会写盘以清空过期项）。

产物路径（subject runtime）：

```text
data/evolution/cycle-state/<cycleId>/agent_loop.json
data/evolution/cycle-state/<cycleId>/intel.json   # Phase 1 兼容
data/evolution/cycle-state/<cycleId>/exec.json    # 由独立 Phase 2 exec 写入
data/evolution/records/<cycleId>/conversation_context.json
data/evolution/records/<cycleId>/agent_loop_turns.jsonl   # 仅查证 turns
data/evolution/records/<cycleId>/agent_loop_report_raw.md # agent_loop 模型裸写（splice 前）
data/evolution/records/<cycleId>/phases_report_raw.md     # phases 模型裸写（splice 前）
data/evolution/agent_loop_carryover.json
data/evolution/agent_loop_guard_state.json
```

审批语义：Decide JSON 可带 `approval_granted`；真正执行仍走 Phase 2 handler 内 `preflightAgentRun` / `JEA_APPROVAL_MODE`。本地冒烟：

```powershell
npm run jea -- run --mock --loop --subject js-evolution-agent
```

Intel 报告测试两道闸（mock / CI）：

1. **交付物契约**（`test/intel-report-deliverable-e2e.test.mjs`）：落盘、index、章节结构、`E2E_REPORT_TOKEN`。
2. **证据诚实**（`test/intel-report-honesty-e2e.test.mjs`）：Seen/Evidence bullet 须带可解析 typed ref（store 类型 + `machine_context:<key>` 枚举，枚举见 `src/intelligence/machine-context-refs.mjs`）；operator brief 毒句不得进入 Seen。**phases 与 agent_loop 均宿主 splice**：模型脏 Seen 被覆盖；Seen 经 persist 脱敏；每轮恰好一条 `phases_report_honesty` / `agent_loop_report_honesty`。agent_loop 另可断言 `verified_facts` 与 `agent_loop_rejected_facts`。

诚实层用 fixture + 注入 mock 报告做机械审计；phases 与 agent_loop 共用同一最终产物标尺（宿主组装 Seen）。诚实矩阵硬闸最终产物（宿主接线）；质量列（Inferred 接地、埋答案、raw_mode、usage）为信息列，不挡硬闸。

**真实 DeepSeek 诚实闸**（opt-in，默认 `npm test` 跳过；需 `.env` 中 `DEEPSEEK_API_KEY`）：

```powershell
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek
```

覆盖 phases + agent_loop Intel-only；对最终落盘报告跑同一诚实断言（无 canned MD / 不要求 `E2E_REPORT_TOKEN`）。最终产物 Seen 由宿主组装；硬闸失败多为接线/组装回归。默认 CI 不跑此文件。可用 `JEA_LLM_PROFILE` 换档后复跑。

### LLM 档案（DeepSeek V4）

按[思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)支持模型档与推理档，而非固定单模型：

| 档案 | 模型 | 推理 |
| --- | --- | --- |
| `fast` | `deepseek-v4-flash` | off（显式 `thinking.disabled`） |
| `balanced`（默认） | `deepseek-v4-flash` | high |
| `deep` | `deepseek-v4-pro` | max |

阶段默认：`observe` / channel / diary → `fast`；`report` / `decide` / `agent_loop` → `balanced`。覆盖：`JEA_LLM_PROFILE`、`JEA_LLM_PHASE_<PHASE>`（如 `JEA_LLM_PHASE_AGENT_LOOP=deep` 或 `pro:max`）。旧 `DEEPSEEK_MODEL` / `DEEPSEEK_THINKING` / `DEEPSEEK_REASONING_EFFORT` 仍兼容。

轻量连通矩阵（flash×off/high、pro×high；pro×max 需 `JEA_LIVE_DEEPSEEK_DEEP=1`）：

```powershell
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:matrix
```

**Intel 诚实矩阵**（同一 fixture 下对比模型×推理×pipeline 的最终报告交付质量；默认不挂在 `test:live-deepseek`）：

```powershell
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:intel-matrix
# 另含 pro×max × phases/agent_loop：
$env:JEA_LIVE_DEEPSEEK_DEEP='1'; npm run test:live-deepseek:intel-matrix
# 每格重复 N 次（1–5，默认 1）：
$env:JEA_MATRIX_REPEATS='3'; npm run test:live-deepseek:intel-matrix
# 可选 LLM judge（固定 pro×high，仅硬闸通过且 attempt=1）：
$env:JEA_MATRIX_JUDGE='1'; npm run test:live-deepseek:intel-matrix
```

默认 5 格：phases 的 flash×off / flash×high / pro×high，以及 agent_loop 的 flash×high / pro×high。

| 层 | 列 | 是否硬闸 |
| --- | --- | --- |
| Gates | `ok` / poison / missing_ref / dangling / unknown_type / `host_fixture` | 是（宿主接线；`host_seen_missing_fixture_ref` 检查宿主 Seen 是否含 fixture id） |
| Quality | `grounding` / invented / off_palette / palette_used / synth / conflict / stale / distractor / fixture_j / poison_unframed / calls / tokens / hit_ratio / judge | 否（判断章节质量；埋答案召回；成本） |

`raw_mode`：`placeholder`（模型服从宿主占位契约）/ `full`（仍写完整 Seen）/ `missing` / `none`。埋答案 fixture 含合成对、冲突对、superseded 陷阱与干扰项；guidance **不**泄露期望。产物落盘：`test-artifacts/intel-honesty-matrix/<run_id>.jsonl` 与 `.md`（已 gitignore）。

### DeepSeek KV 缓存（context caching）

DeepSeek 按请求消息流**从位置 0 开始的连续 token 前缀**自动命中 context cache（约 1/10 价格）。设计准则：整条消息流按**稳定度降序**排布；中间任一 token 变化会使其后内容全部 miss。system / user 角色对缓存透明——重要的是序列化后的前缀是否字节级稳定。

**观测字段**（phase outputs / conversation_context / agent_loop checkpoint 的 `prompt_cache`）：

| 字段 | 含义 |
| --- | --- |
| `usage.prompt_tokens` | API 报告的 prompt token 数 |
| `usage.cache_hit_tokens` | 前缀缓存命中（来自 `prompt_cache_hit_tokens`） |
| `usage.cache_miss_tokens` | 前缀缓存未命中 |
| `usage.cache_hit_ratio` | hit / prompt（或 hit/(hit+miss)） |
| `usage.call_count` | 仅查证循环累加时存在（多 turn） |

mock 路径 `usage` 为 `null`。真实调用时日志可见 `[prompt-cache ...]` 摘要行。

**动态载荷约定**（改 prompt 时的 review 准则）：会话首条 user 消息的 dynamic payload 段序为 `Rules → Operator Guidance → Goals → Cycle → 其余每轮变化段`。`stablePrefix`（含权威文献与任务规则）保持跨部署稳定，不要为「阅读顺序」去改它的物理位置。

**会话链同 profile**：report → decide（以及 agent_loop 查证 turn 间）依赖会话前缀复用。同一会话链内保持同 LLM profile（例如不要单独设 `JEA_LLM_PHASE_DECIDE=deep`），否则 decide 会对整个 report 会话前缀按原价重付。thinking on/off 不保证共享同一缓存家族——保守假设 `fast` 与 `balanced` 虽同为 flash 也不互相暖缓存。


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
- `jea intel viewer serve [--port N] [--open] [--limit N] [--subject NAME] [--subjects a,b]`：托管 `tools/evolution-viewer/public/` 并直读 subject runtime；**默认追踪所有已注册 subject**（等同 `--all`），用 `--subject` / `--subjects` 缩小范围。Live API：`GET /api/subjects`（daemon 摘要 + `attention` 计数/最高严重度）、`GET /api/subjects/:subject/manifest|daemon|observability|events/recent|rounds/:id|cycles/:id`（`cycles/:id` 含 `diagnostics` / `observability_attention`）；兼容默认 subject 的旧路径 `GET /api/manifest`、`GET /api/rounds/:cycleId`、`GET /api/daemon`、`GET /api/observability`、`GET /api/cycles/:cycleId`、`GET /api/events/recent`。UI：**默认运维总览（Ops Home）**（KPI、待关注、open cycles、Channel、briefs、事件流）；选中轮次或 `#cycle-…` 进入 **阅读视图**（报告/日记主区，诊断与任务在右侧折叠栏）。不再自动打开最新 round。`/events` SSE tail 各 subject 的 `evolution-events.jsonl`，payload 含 `subject` / `namespace`，推送 `round_added` / `round_updated` / `daemon_event` / `runtime_updated`，**无需先 build dist**。多 subject 时浏览器用 `?subject=NAME#cycle-…` 定位。
- `jea intel viewer build [--subject NAME] [--limit N] [--out PATH]`：可选离线快照（marked 预渲染到 `tools/evolution-viewer/dist/`）；用 `npx serve tools/evolution-viewer/dist` 等任意静态服务器打开。**离线 build 不含 daemon 控制台**（无 `/api/daemon`）；daemon 运行态仅 live serve 可用。
- `npm run viewer:build` / `npm run viewer:serve`：同上（`viewer:serve` 默认 `--open`）。

写入情报：

- `jea intel ingest --source NAME [--file PATH | --stdin] [--json]`：直接写入一条或多条 JSON 记录到当前主体 intelligence store。`entity_jsonl` 类 source（如 `probe_threads`）要求每条记录带 `_entity_id`。
- `jea intel inbox put --source NAME [--file PATH | --stdin] [--name LABEL]`：把 JSON 载荷放入 `_inbox`，供之后 drain。
- `jea intel inbox drain [--dir PATH] [--json]`：将 `_inbox` 中的文件导入 intelligence store。

## 操作者输入

进化系统区分四类人工/操作者输入，不要混用：

| 类型 | 含义 | 典型入口 |
| --- | --- | --- |
| **Constraint（约束）** | 长期必须遵守的边界或偏好 | `human_guidance.md`、subject policy、OADA 规则 |
| **Intent（意图）** | 下一轮关注什么，**不是事实** | `jea intel brief put` |
| **Fact（确立事实）** | 操作者已确认、可当 Seen 引用 | `operator_fact` via `intel ingest` |
| **Evidence（证据）** | 世界发生了什么，可被推翻 | `intel ingest` / `inbox`、probe、receipt |

另有 **Action（硬开关）**：如 `approval_granted`，由 Decide 产出、Phase 2 执行；操作者不应直接写 `pending_decisions.json` 绕过 Decide。

### Operator Intent Brief

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

### Operator Fact

- 入口：`jea intel ingest --source intel_observations [--file PATH | --stdin] [--json]`；记录需带 `kind: "operator_fact"`（或 `source: "operator_fact"`）。
- 存储：`runtime/subjects/<data_namespace>/data/intelligence/` 下的 `intel_observations`（持久，**不是**单轮消费队列）。
- 作用：在 Temporal Decision Brief 中升格为 **Seen**（`operator_established_fact`），后续 report / decide / goal assess 可当作已确立事实引用；`buildContextSummary()` 也会优先展示 operator facts。
- 与 brief 区别：brief 是「下一轮请核实 / 请这样排优先级」的**一次性意图**；fact 是操作者已确认、希望系统长期遵守的**领域口径或基线**（如 rank 方向、术语定义）。待验证命题用 brief；已确认口径用 fact。

最小 JSON 示例：

```json
{
  "kind": "operator_fact",
  "source": "operator",
  "subject": "agentank-tank",
  "content": "standing.rank lower is better; rankScore higher is better",
  "confidence": "high"
}
```

常用字段：`content`（或 `summary`）、`subject`、`confidence`（仅 `high` 或缺省时会进入 Seen；`medium` / `low` 不会升格为 `operator_established_fact`）、`supersedes`（字符串或字符串数组，指向要被替换的旧 fact `id`）。没有独立的 `jea intel fact put` 命令；与 generic observation 共用 `intel ingest`。自动化代理在未获操作者明确确认时，不要替其写入 operator fact。

**修正或撤回已确立口径**：追加一条新的 `operator_fact`，在 `supersedes` 中列出旧 fact 的 `id`；读取侧（Temporal Decision Brief、diary anchors、`buildContextSummary`）只会把未被 supersede 的高置信 fact 升格为 `operator_established_fact`。旧记录仍保留在 store 中供审计，不要手改 JSONL。

替换示例：

```json
{
  "kind": "operator_fact",
  "source": "operator",
  "subject": "agentank-tank",
  "content": "standing.rank lower is better; rankScore higher is better",
  "confidence": "high",
  "supersedes": ["operator-fact-rank-score-old-id"]
}
```

仅撤回、无新口径时，可写入 withdrawal 类 content，并同样 `supersedes` 旧 id：

```json
{
  "kind": "operator_fact",
  "source": "operator",
  "content": "Previous operator fact <old_id> is withdrawn; do not use it as an established fact.",
  "confidence": "high",
  "supersedes": ["<old_id>"]
}
```

### Operator Guidance（长期约束）

- 路径：`runtime/subjects/<data_namespace>/data/evolution/human_guidance.md` 的 `## Current` 段。
- 注入：Phase 1 report/decide 的 **Operator Guidance** 区块；**每轮**都会读，当前 pipeline 不会在 cycle 结束后自动清空。
- 适合：稳定规则（如「ENOENT 必须带 execution_root 解释」）。
- 不适合：「下一轮请核实 X」——应改用 `jea intel brief put`。

### 主体策略与权威文档

- `runtime/subjects/<data_namespace>/SUBJECT.md`：`Off-Limits Without Human Approval` 等审批与安全边界；`SOUL.md` 为 channel persona（不参与治理权威文献）；用 `jea subject check` 校验结构。
- `runtime/subjects/registry.json`：lane、resource root 等机器可读配置。
- `policies/authority/CONSTITUTION.md`、`policies/authority/GUIDE.md`、`oada.config.mjs`：Phase 1 权威文档，优先级高于情报材料。

### 通用情报写入（Evidence，非 operator_fact）

- 见上文「写入情报」的 `intel ingest` / `inbox`；可写入任意合法 source（`probe_results`、`goal_events` 等）。
- 普通 observation 默认 `kind: observation`、`confidence: medium`，**不会**升格为 `operator_established_fact`。
- 适合：外部探针结果、可推翻的手工观测；与 `operator_fact` 的「已确认口径」区分开。

### 目标与信念

- `jea goals update`：替换 active goals，写 `goal-events.jsonl`（演化方向的人工写入点）。
- `jea beliefs update`：手动触发 Phase 3.5；信念的正式创建/调整通常由 verify 自动完成，依据 receipt 与 verify_report，而非 report 叙事。详见下文「目标管理」。

### 记录型 action（经 Decide 间接落盘）

Decide 可调度、`Phase 2` 执行的记录型动作，用于落已有结论而非调查：`record_observation`、`run_evidence_audit`、`propose_probe`、`write_retrospective`、`request_core_review`。操作者通常通过 brief 引导 Decide，而不是直接写决策队列。

### 不建议的操作者入口

| 入口 | 原因 |
| --- | --- |
| 直接编辑 `pending_decisions.json` | 绕过 Decide，破坏 OADA 闭环 |
| 手改 `standing_memory.json` | 易污染 Remembered；应由报告管线更新 |
| chat 口头审批 | 不会进入系统；需 `jea intel brief put` |

### 入口对照

| 场景 | 用哪个 |
| --- | --- |
| 长期约束、稳定偏好 | `human_guidance.md` 或 subject policy |
| 下一轮核实 / 审批意图 / 排优先级 | `jea intel brief put` |
| 已确认领域口径或术语 | `operator_fact`（`intel ingest`） |
| 可推翻的外部观测 | `intel ingest` / `inbox`（普通 observation） |
| 调整演化目标假设 | `jea goals update` |
| 远端发布 / 核心变更放行 | brief → Decide 产出 `approval_granted`（+ env 如 `AGENTANK_ALLOW_PUBLISH`） |

| 机制 | 入口 | 生命周期 | 证据地位 |
| --- | --- | --- | --- |
| Operator Intent Brief | `jea intel brief put` | 单轮；入队后归档 | 软意图，不可当事实 |
| Operator Fact | `jea intel ingest --source intel_observations` | 持久 | 高置信时可作 Seen 事实 |
| Operator Guidance | `human_guidance.md` ## Current | 持续，直至手动清空 | 约束，非证据 |
| 普通 observation | `jea intel ingest --source intel_observations` | 持久（90 天 retention） | 证据，非自动 Seen |

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
- **主体边界**：`runtime/subjects/<data_namespace>/SUBJECT.md` 的 Off-Limits Without Human Approval 定义各 subject 的审批规则（凭据、远端发布、越界写入等）；AGENTS.md 不重复主体语义，用 `jea subject check` 校验 policy 结构。

自动化代理在未获操作者明确确认时，不要替其提交发布/基线校准类 brief，也不要在 action 上伪造 `approval_granted`。

### 环境变量审批策略（JEA_APPROVAL_MODE）

`.env` 可配置审批策略，默认 `manual`（保持现状）：

| 值 | 含义 |
| --- | --- |
| `manual` | 所有需要 `approval_granted` 的 `agent_run` 必须显式批准 |
| `auto_guarded` | 仅自动批准低风险动作：只读 `agent_run`（`permission_profile=read_only`）、`record_observation`、`run_evidence_audit`、`propose_probe`、`write_retrospective` |
| `auto_all` | 自动批准所有需审批动作（含远端发布、`workspace_write` / `remote_write_review`）；`core_apply` 在 `JEA_CORE_APPLY_POLICY=review` 时也会自动执行；外部工具 `approvalFlag` 会自动追加 `--force`。`JEA_CORE_APPLY_POLICY=disabled` 仍硬拦截 |

`auto_guarded` **不会**自动：

- 远端发布（`remote_write_review` / publish intent）
- 更新 rank baseline
- 解除 `iterate-skill` 人工介入阻塞
- `core_apply`（仍由 `JEA_CORE_APPLY_POLICY` 独立控制）
- 外部工具 `--force`（如 `AGENTANK_ALLOW_PUBLISH` 路径）

`auto_all` **适合完全沙盒或本地实验**；生产主体（如 `agentank-tank`）慎用，因为会跳过人工 brief 与显式 `approval_granted`。

建议用法：本地长期演化时设 `JEA_APPROVAL_MODE=auto_guarded`，让凭据合规探针、记忆审计探针、只读 replay 分析、记录型 action 无需每轮人工 brief；远端发布仍通过 `jea intel brief put` 或 Decide 显式 `approval_granted: true`。需要完全无人值守时再设 `auto_all`。

自动批准会在 action receipt 中留下 `auto_approval` 审计字段（`mode`、`reason`、`guardrails`）。

## 目标管理

- `jea goals show`：显示当前 active goal hypothesis。
- `jea goals history [--limit N]`：查看目标变更事件（含 `assessment`、`updated`、`patched`）。
- `jea goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID]`：整棵替换 active goals 并记录 `updated` 事件。
- `jea goals patch --file PATH --reason TEXT [--evidence REF] [--cycle ID]`：应用 `goal_patches` JSON 数组（子目标增删改）；记录 `patched` 事件。`remove_child` 会自动 retire 绑定该 `goal_id` 的 active/validated 信念。
- `jea goals assess [--cycle ID]`：让 AI 评估目标校准并记录 `assessment` 事件（可含 `goal_patches` 或 `proposed_goal`）。

**Phase 4.5 自动校准**（`goals_calibrate`）：

默认策略 **`liberal`**（`JEA_GOAL_CALIBRATE_MODE`，可设 `strict` 恢复保守行为）：

| 策略 | `goal_patches` | 整棵 `proposed_goal` |
| --- | --- | --- |
| **liberal**（默认） | `refine` / `split` / `replace` + 置信度 ≥ `medium`；逐条部分应用；无 outcome 个数上限（除非设 `JEA_GOAL_MAX_OUTCOME_CHILDREN`） | 同上状态 + 置信度 ≥ `medium`；patch 失败时可 fallback |
| **strict** | 仅 `refine`；`add`/`remove` 需 `high`；`update` 需 `medium+`；整批预览；outcome 1–2 个 | 仅 `refine` + `high` |

环境变量：

- `JEA_GOAL_CALIBRATE_MODE=liberal|strict`（默认 `liberal`）
- `JEA_GOAL_MAX_OUTCOME_CHILDREN=N`（`0` = 无上限；liberal 默认不限制）
- `JEA_GOAL_AUTO_APPLY=0`：只写 Phase 4 assessment，Phase 4.5 不落盘

Assessor prompt 仍建议 `goal_patches` 与 `proposed_goal` 互斥；执行器先尝试 patches，失败可在 liberal 下 fallback `proposed_goal`。`add_child` 的 child 建议带 `role: outcome|guard`（供审计）。

信念管理：

- `jea beliefs show`：显示当前 active/validated/refuted 信念状态。
- `jea beliefs events [--limit N]`：查看近期信念变更事件。
- `jea beliefs update [--cycle ID]`：手动触发 post-verify 信念更新（通常由 `jea run` Phase 3.5 自动执行）。

信念是绑在 goal 上的可验证行动假设（`claim`、`next_test`、`evidence_refs`）。Decide 阶段通过 `params.run_spec.context.belief_id` / `belief_relation` 绑定 `agent_run`；**创建或调整信念的正式写入点在 Phase 3.5**，依据 action receipt 与 verify_report，而非 report 叙事。存储：`data/intelligence/beliefs/current_beliefs.json`、`belief-events.jsonl`。

目标 JSON 需要包含 `id`、`name`、`intent`、`good_signal`、`bad_signal` 和 `children`。

## Daemon 工作流

Daemon 用于 **事件驱动的 step 级演化**。推荐用 `jea daemon start` 启动 worker：默认 **持续进化模式**（`continuous`）下每 **5 分钟** heartbeat tick（独立定时器，**不**被 step 子进程阻塞）会 reconcile open cycle、入队 cycle 启动请求并尝试开新 cycle（无 open cycle 且无 pending 任务时）；step 完成后 **即时** enqueue 下一步；5min tick 同时做 reconcile 补偿（含 step checkpoint 与 task queue 漂移修复）。

**按需进化模式**（`on_demand`）：tick **不会**自动入队开轮请求，仅 reconcile + 消费已有请求（`jea daemon cycle request`、`jea intel brief put` 等）。worker idle 时也会尝试消费 pending 请求，不必等 5 分钟。无 open cycle、无 pending request 时 long idle 为 **healthy**（不算 stalled）。

**step 完成以 checkpoint 为准**：cycle-state / `cycle-state/<id>/<step>.json` 为完成依据；若子进程 hang 但 checkpoint 已写入，watchdog（约每 `heartbeat-ms`）会终止 runner 并按产物完成 task；tick reconcile 会修复「cycle-state 已 terminal 但 task 仍 running」的 drift。

演化模式解析优先级：`runtime/subjects/registry.json` 中 `subjects.<name>.evolution.mode` > `jea daemon start --evolution-mode` > env `JEA_EVOLUTION_MODE` > 默认 `continuous`。

**热加载**：daemon worker 运行中修改 `runtime/subjects/registry.json` 的 `evolution.mode` **无需 restart**（下一轮 worker loop 重新读盘，通常数秒内 idle 生效；`daemon events` 可见 `evolution_mode_changed`）。修改 `.env` 的 `JEA_EVOLUTION_MODE` 或启动时的 `--evolution-mode` **需** `daemon stop` 后重新 `start` 才生效。

`run_cycle` 整轮任务与 `jea run` 同步链仍保留，供本地调试与兼容；**后台长期运行请优先 step 模式**。

### 任务与 worker

- `jea daemon start [--mock] [--tick-ms N] [--evolution-mode continuous|on_demand] [--heartbeat-ms N] [--lease-ms N]`：前台 worker；默认 `tick-ms=300000`（5min）。**Windows 长期后台**勿用 Cursor/IDE 后台 shell（会话结束会中止子进程）；用 `npm run daemon:start:detached`（或 `scripts/daemon-start-detached-win.ps1 -Subject NAME [-StopFirst] [-Force]`），日志在 `runtime/logs/daemon-<subject>.*.log`。
- `jea daemon evolution-mode show [--json]`：查看当前 subject 演化模式与来源。
- `jea daemon evolution-mode set continuous|on_demand [--json]`：写入 `subjects.json` 并 emit `evolution_mode_changed`（viewer SSE / worker 热加载）。
- `jea daemon cycle request [--reason TEXT] [--note TEXT]`：入队 cycle 启动请求（写入 `data/evolution/cycle-start-requests.json`），由 worker 在前提满足时开轮。
- `jea daemon work --once [--mock]`：领取并执行一个 task（step 或 `run_cycle`）后退出。
- `jea daemon enqueue --type <step|run_cycle>`：手动入队 step 任务；step 类型含 `intel`、`exec`、`verify`、`belief_update`、`goals_assess`、`goals_calibrate`、`diary` 等。
- `jea daemon stop` / `jea daemon stop --all`：请求 worker 优雅停止。

### Step 状态与 checkpoint

每轮 cycle 的状态与 step 产物位于：

```text
runtime/subjects/<data_namespace>/data/evolution/cycle-state/
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

### 韧性（队列写入与 worker 存活）

- 任务队列锁文件：`data/evolution/tasks/pending_tasks.lock`（与 `pending_tasks.json` 分离，避免 Windows 上锁与 rename 冲突）。
- 队列写入对 `EPERM`/`EBUSY` 自动重试；**写失败不会终止 worker**（记 `queue_write_failed` 事件，空闲循环继续）。
- `jea daemon status` / `doctor` 健康态除 heartbeat 外会校验 **PID 是否存活**：
  - `worker_zombie`：状态文件为 running 但进程已死 → `ok=false`，应 `jea daemon start`。
  - `evolution_stalled`：continuous 模式下无 open cycle/无 pending，且超过 `tick_ms` 未开新轮 → `ok=false`。
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

Channel worker-state 写入已使用与 task queue 相同的原子重试写入；loop 内心跳写失败会记 `channel_worker_state_write_failed` 并降级继续，不会直接终止 cycle domain。

## Channel 通道

Channel 是 daemon 下与 cycle 平级的通信闭环，负责接收外部消息、写入合适的情报入口，并观察运行态决定是否向外部通道通知。当前飞书适配器位于 `src/channel/adapters/feishu/`（基于 `@larksuiteoapi/node-sdk`，参考 Deepseek-Cowork `feishu-module` 的传输层实现，**不**依赖 OpenClaw 或 Cowork AI/ChannelBridge）。

运行时数据位于：

```text
runtime/subjects/<data_namespace>/data/channel/
├── worker-state.json
├── tasks/pending_tasks.json
├── events.jsonl
├── reload-request.json          # setup 完成后写入；daemon 消费后移除
├── reload-state.json            # 最近一次 listener reload 状态
├── feishu-operator-binding.json # JEA BIND 结果
├── feishu-register-qr.png       # setup 扫码注册时生成的二维码图片
├── inbound/pending|processed|failed/
└── outbox/pending|sent|failed/
```

常用命令：

- `jea channel feishu setup --subject NAME [--write-env] [--init-subject-config]`：一键扫码注册飞书应用、写入 subject 凭据 env、生成 BIND 口令、写入 reload 请求（推荐新 subject 首选入口）。
- `jea channel feishu register --subject NAME [--write-env] [--force]`：仅注册应用并拿凭据，不写 reload 请求、不自动生成 BIND 口令。
- `jea channel status [--json]`：查看 channel worker、队列、inbound/outbox 健康。
- `jea channel events [--limit N] [--json]`：查看 channel 审计事件。
- `jea channel inbox put [--file PATH | --stdin]`：放入 `inbound/pending` 并入队 `channel_classifier`；Presence 只在分类完成后重算表达候选。
- `jea channel outbox [--json]`：查看待发送消息。
- `jea channel send --to CHAT_ID --text TEXT [--dry-run]`：手工排队或预览一条出站消息。
- `jea channel tick`：运行一次 channel dispatcher，按 pending inbound、attention signals、outbox 入队任务。
- `jea channel doctor [--json]`：诊断 channel worker 与任务队列；`--purge-deprecated --yes` 取消队列中 pending 的废弃任务。
- `jea channel queue purge-deprecated [--yes]`：预览或取消 `channel_ingest` / `channel_reply` / `channel_watch` pending 任务。

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

1. 调用 SDK `registerApp()`，在终端打印 ASCII 二维码，并保存/打开 PNG：`runtime/subjects/<ns>/data/channel/feishu-register-qr.png`。
2. 将 `client_id` / `client_secret` 写入 `.env` 的 `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` / `_APP_SECRET`（同名 key 已存在且值不同需 `--force`）。
3. 若未配置 BIND 口令，自动生成 `JEA_CHANNEL_FEISHU_<SUBJECT>_BIND_TOKEN`。
4. 可选 `--init-subject-config` 写入 `subjects.json` 最小 `channels.feishu` skeleton（Secret 不进 JSON）。
5. 写入 `reload-request.json`，供运行中的 channel daemon 热加载。

扫码完成后，在飞书**私聊**新机器人发送：

```text
JEA BIND <口令>
```

口令来自 `.env` 的 `JEA_CHANNEL_FEISHU_<SUBJECT>_BIND_TOKEN`（setup 会生成）。绑定成功后写入 `feishu-operator-binding.json`，并作为默认出站目标。

setup/register 可选参数：

| 参数 | 含义 |
| --- | --- |
| `--write-env` | 写入/更新项目根 `.env`（setup 默认开启；register 默认只打印） |
| `--force` | 覆盖 `.env` 中已有同名 key |
| `--init-subject-config` | 自动补齐 `subjects.json` 的 `channels.feishu` skeleton |
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

- 重新加载项目根 `.env`（`loadProjectEnv`）。
- 消费 `reload-request.json`。
- 调用 `ensureFeishuListener()`：凭据/domain/listener 开关变化时自动重启 WS listener；仅 allowlist、bind、operator binding 变化时只刷新 policy，不重连。

因此 **setup 写入 `.env` 后，已运行的 `jea daemon start --domain channel` 通常无需重启**；数秒内应出现 `feishu_listener_started` 或 `channel_config_reloaded` 事件。

仍会触发 listener 重建的变化：`app_id`、`app_secret`、`domain`、`encrypt_key`、`verification_token`、`enabled` / `listenerEnabled` 开关。

`channel status --json` 的 `feishu.reload` 字段可查看 pending reload、`last_error`、`config_fingerprint`。

入站分类边界（由 **`channel_classifier`** 批量 LLM/规则分类，不再在 presence 内同步正则分类）：

- 审批/发布类话语 → `approval_request` operator brief（软意图，非 `approval_granted`）。
- 已确认长期口径 → `operator_fact`（高置信且措辞明确时；否则降级为 observation）。
- 待核实或下一轮关注 → `verification_request` brief。
- 明确的本地控制命令 → `control_request`（见下文 Channel Control Actions）。
- 普通外部消息 → `intel_observations` 作为可推翻 evidence。
- 飞书 listener / `inbox put` 只写 `inbound/pending`；分类由 classifier role 按固定 `interval_ms` 批量处理（`batch_size` 上限，旧到新，超出留待下批）。

出站由 **`channel_notify`** 独立任务 flush（outbox 有货即可入队，不依赖 presence 决策完成）；**所有对外表达**由 presence reactor 两阶段产出：`speech_intent`（决策）→ `channel_speech_generation`（人设/LLM 生成正文）→ outbox。旧 `channel_reply` / `channel_watch` / **`channel_ingest`** 任务类型已废弃；队列中若仍有，`jea channel doctor` 会提示 cancel。

### Channel Classifier（`channels.classifier`，固定频率批量）

**`channel_classifier` 任务**（classifier role worker 领取）：

1. 从 `inbound/pending` 按时间顺序取最多 `batch_size` 条
2. BIND / duplicate 机械处理（不进 LLM batch）
3. LLM（或 `deterministic` 回退）批量输出受限 schema：`approval_request` / `verification_request` / `operator_fact` / `control_request` / `observation` / `ignore`，以及每条非 `ignore` 项的 **`understanding`** 对象（`user_intent`、`needs_immediate_action`、`action_hint`、`temporal`、`complexity`）；deterministic 回退用规则推断同等字段
4. 写入 brief / fact / control task / observation 并移到 `processed`（`classifier.understanding` 保留在 processed JSON）；失败按 `fallback` 保留 pending 或降级 observation
5. 非 `control_request` 分类完成后 `requestExpressionRecompute`（`reason: inbound_classified`）；`control_request` 由 control executor 完成后唤醒 presence

协调器按 `classifier.interval_ms` 调度入队（幂等键 `${subject}:channel_classifier:pending`）；与 presence tick（默认 5min）独立。

`runtime/subjects/registry.json` 示例：

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
| `daemon_evolution_mode_set` | 切换 `continuous` / `on_demand` | 是 | operator binding 或 allowlist |
| `daemon_evolution_mode_show` | 查看当前 evolution mode | 否 | 否 |
| `daemon_cycle_request` | 入队 cycle start request | 是 | operator binding 或 allowlist |

约束：

- Classifier 只能输出注册过的 `action_id` + 明确 `params`；高置信才允许写类 action；未知 action / 低置信 / 非法参数会进入 control executor 失败审计，而不是静默降级。
- Presence planner **不能**直接改 evolution mode；只能基于 control executor 的审计事件回复结果。
- 远端发布、`approval_granted`、凭据、subject policy 仍不可通过 channel 自动执行。

默认 channel daemon roles：`notify` / `control` / `agent` / `presence` / `speech` / `classifier`。升级后需重启 channel daemon。

### Channel Presence Loop（`channels.presence`，transport-agnostic，async reactor）

外部刺激只请求「表达状态重算」：飞书 listener / `jea channel inbox put` 先写 `inbound/pending` 并入队 classifier；classifier 完成、presence tick、daemon attention 等统一 append `expression_recompute_requested` 并入队 `channel_presence`。**Presence 不读取 raw inbound，也不在 presence 路径分类 inbound。**

**Bounded reactor**（`channel_presence` 任务 → `runPresenceReactor`）：

1. claim 一批 channel events（合并多 wake）
2. `buildPresenceContext`（读**已分类** processed、pending unclassified 计数、daemon signals、ignored/background context 等）
3. 构建 `expression.candidates`：把可表达对象统一成 `reply.*` / `notify.*` candidates；`ignore` 只作背景，不生成 candidate
4. `planPresence` → `no_op` / `speak` / `silence` / `act`；`speak` 只产出 `speech_intent`（**不写 outbox**）
5. 对 `speech_intent` append `speech_generation_requested` 事件，入队 `channel_speech_generation`

**内容生成**（`channel_speech_generation` → `runChannelSpeechGenerationTask`，speech role worker）：按 subject persona + `content_requirements` 生成最终文本，成功后 `writeOutboxMessage`；失败/超时记 `channel_speech_generation_failed` / `channel_presence_timeout`，不写 outbox。

`runChannelTick`：presence tick（`reason: timer_tick` 的表达重算 + notify）；classifier tick 单独按 `interval_ms` 入队 classifier。默认多 role 下 notify / control / agent / presence / speech / classifier **并行领取**，互不阻塞。

事件队列与审计 `events.jsonl` 分离。`jea channel status --json` 的 `presence.event_queue` / `presence.reactor` / `presence.pending_speech_generation` 可观测 reactor 与待生成话术。

`runtime/subjects/registry.json` 示例：

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
- 游标 + reactor：`presence-state.json`（`handled_candidates`、`reactor.status|deadline_at|event_ids`、`pending_speech_generation`）。
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
| 未 handled 的 `task_failed` / `daemon_health` / `cycle_drift` / `requires_human_review` 等 | 主动通知（受 cooldown） |

修改 `channels.presence` 或 allowlist/bind 后，运行中的 channel daemon 会在下一轮 loop 读盘生效。修改 `app_id` / `app_secret` 或关闭 listener 时，daemon 会自动重建 WS 连接。**升级 JEA 代码后需重启 channel daemon。**

### 私聊绑定（`JEA BIND`）

仅私聊、未手填 `ou_` 时，可在 `channels.feishu.bind` 开启口令绑定。推荐用 `jea channel feishu setup` 自动生成 BIND 口令并写入 `.env`；也可手工设置。

1. `.env` 设置 `JEA_CHANNEL_FEISHU_<SUBJECT>_BIND_TOKEN`（或 `subjects.json` 的 `bind.token_env`）。
2. 启动 `jea daemon start --subject NAME --domain channel`（若已在运行，setup 写 env 后会通过 reload 热加载，通常无需重启）。
3. 在飞书里**私聊**机器人，发送：`JEA BIND <口令>`（短语默认 `JEA BIND`，可在 `bind.phrase` 自定义）。
4. 绑定结果写入 `runtime/subjects/<ns>/data/channel/feishu-operator-binding.json`，并自动作为 `allow_from` / 默认出站目标；`jea channel status --json` 的 `feishu.config.operator` 可查看（open_id 脱敏）。成功时 events 可见 `feishu_operator_bound`。

未绑定前仅接受绑定握手消息；群聊可用 `group_policy: disabled` 关闭。覆盖他人绑定需再次发送带**同一口令**的 `JEA BIND`。

飞书配置按 **subject 隔离**（每个 subject 可绑定不同机器人）。`app_secret` 不要明文写入 `subjects.json`，用 `app_secret_env` 指向环境变量名；`app_id` 可写在 JSON，或用 `app_id_env` / `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` 从环境读取。

`runtime/subjects/registry.json` 示例（`my-subject` 与 `other-subject` 各用各的 bot）：

```json
{
  "subjects": {
    "my-subject": {
      "channels": {
        "feishu": {
          "enabled": true,
          "app_id_env": "JEA_CHANNEL_FEISHU_MY_SUBJECT_APP_ID",
          "app_secret_env": "FEISHU_MY_SUBJECT_APP_SECRET",
          "dm_policy": "allowlist",
          "allow_from": [],
          "group_policy": "allowlist",
          "require_mention": true,
          "bind": {
            "enabled": true,
            "phrase": "JEA BIND",
            "token_env": "JEA_CHANNEL_FEISHU_MY_SUBJECT_BIND_TOKEN"
          }
        }
      }
    },
    "other-subject": {
      "channels": {
        "feishu": {
          "enabled": true,
          "app_id": "cli_bbbb",
          "app_secret_env": "FEISHU_OTHER_SUBJECT_APP_SECRET",
          "default_chat_id": "oc_bbbb"
        }
      }
    }
  }
}
```

`.env` 与上表 `my-subject` 对应的最小凭证示例：

```env
JEA_CHANNEL_FEISHU_MY_SUBJECT_APP_ID=cli_aaaa
FEISHU_MY_SUBJECT_APP_SECRET=REPLACE_WITH_YOUR_APP_SECRET
JEA_CHANNEL_FEISHU_MY_SUBJECT_BIND_TOKEN=choose-a-long-random-token
```

也可用 subject 前缀环境变量（无需在 JSON 里写 `app_id` / `app_id_env`）：

| 变量模式 | 含义 |
| --- | --- |
| `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` | App ID（或与 `app_id_env` 配合）；如 `my-subject` → `JEA_CHANNEL_FEISHU_MY_SUBJECT_APP_ID` |
| `FEISHU_<SUBJECT>_APP_SECRET` 或 `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_SECRET` | App Secret（或与 `app_secret_env` 配合） |
| `JEA_CHANNEL_FEISHU_<SUBJECT>_DEFAULT_CHAT_ID` | 该 subject 默认出站群 |
| `JEA_CHANNEL_FEISHU_<SUBJECT>_BIND_TOKEN` | 私聊 `JEA BIND` 口令（或与 `bind.token_env` 配合） |

`<SUBJECT>` 为 subject id 的 env slug：非字母数字替换为 `_` 并大写（见 `subjectEnvSlug()`）。

全局变量（`JEA_CHANNEL_FEISHU_APP_ID` 等）仅作**未在 subject 块单独配置时**的回退，多主体并行时推荐只用 per-subject 配置。

| 变量 | 含义 |
| --- | --- |
| `JEA_CHANNEL_FEISHU_MOCK=1` | 全部 subject 出站 mock |
| `JEA_CHANNEL_FEISHU_DOMAIN` | 默认域名 `feishu` / `lark` |

`jea daemon start --domain channel` 在凭证齐全时会为**当前 subject** 启动 Feishu WebSocket listener；多 subject 需分别启动 daemon 进程。禁用 listener：`--no-feishu-listener`。listener 是否在运行，优先看 `jea channel events` 中的 `feishu_listener_*` 事件，而非独立 CLI 进程的 `channel status`。

## Subject 管理

Subject 决定策略、命名空间和运行时路径。

- `jea subject list`：列出 registry 中的 subjects 与 default subject。
- `jea subject show [--subject NAME]`：显示 subject、core layer、namespace 和 runtime paths；无 `--subject` 时使用 default subject。
- `jea subject init <name> [--use]`：从模板创建新 subject 并写入 registry；`--use` 同时设为 default。
- `jea subject use <name>` / `jea subject default <name>`：更新 `runtime/subjects/registry.json` 中的 default subject。
- `jea subject check [--subject NAME]`：校验 subject policy。
- `jea subject lane status|init [--subject NAME]`：检查或初始化目标仓库 lane。
- `jea run --subject NAME`：显式指定单轮演化主体；`jea evolve` / `jea daemon` 已支持 `--subject` / `--subjects` / `--all`。

`runtime/subjects/registry.json` 是本地 registry，可承载机器可读的 `lane` 与 `resources` 字段；字段形态参考 `policies/subjects.example.json`。主体 Markdown policy 只保留主体语义、安全边界和人工审批规则，不维护 repo、branch、resource root、resource mapping 等机器字段。

创建或切换 subject 后，通常先执行：

```powershell
jea data init --all --subject <name>
```

## 审计与动作

- `jea audit queue`：检查决策队列健康状态、未知动作和陈旧 in-progress 项。
- `jea audit queue --archive`：预览归档 completed/expired 队列项。
- `jea audit queue --archive --yes`：执行归档。
- `jea audit evidence [--subject NAME] [--json] [--strict] [--ingest] [--no-narrative]`：机械审计证据引用（信念 `evidence_refs`、standing memory typed refs、operator_fact `supersedes` 链、近期 report/diary 叙事引用）。`--strict` 时 warnings 也非零退出；`--ingest` 写入一条 `source: evidence_audit` observation（摘要，不含完整 findings）；`--no-narrative` 跳过 report/diary 扫描。`verify_report:` 引用必须用磁盘文件名（`exec-…` 或 `cycle-…`），裸 `cycle-…` 也会解析为 verify report。
- `jea actions list`：列出已注册 action types。
- `jea actions check`：检查待处理决策中的未知 action types。

Phase 2（exec）action 选择口径：

- 主执行：优先 `agent_run`（调查、改代码、模拟、发布准备等“做事”任务）。
- 记录型：`record_observation`、`run_evidence_audit`（机械证据审计）、`propose_probe`、`write_retrospective`、`request_core_review` 只落已有结论/提案/审批请求/审计摘要，不用于读文件或调查。
- 系统/兼容：`lane_status`、`lane_observe`、`lane_verify`、`github_open_lane_pr` 是机械 lane 能力；`run_probe`、`agent_execute` 是旧兼容动作；`core_apply` 仅用于 core 层审批变更。subject policy 不应维护 subject-specific action 菜单，业务能力通过 `subjects.json` 的 lane/resources 或 configured external actions 表达。

## 旧脚本（已移除）

以下 npm 脚本已删除，请改用 `jea`：

| 旧命令 | 替代 |
| --- | --- |
| `npm run intel` | `npm run jea -- run --mock`（或 daemon step `intel`） |
| `npm run exec` | Phase 2 由 `jea run` / daemon `exec` step 执行 |
| `npm run decisons` | `jea audit queue` |

底层 engine 源码位于 `src/engine/`；旧 `node_modules/js-evolution-engine` 路径不再使用。

## 操作建议

- 先运行 `jea doctor`，再运行真实演化。
- 本地验证优先使用 `jea run --mock` 或 `jea daemon work --once --mock`。
- 涉及删除或重置数据的命令，例如 `jea data reset --yes`，必须确认当前 subject 和 namespace。
- 多主体并行时，用 `jea daemon status --all`、`jea daemon doctor --all` 和 `jea daemon inbox --all` 做总览。
- 新 subject 接飞书机器人：先 `jea subject init` + `jea data init --all`，再 `jea channel feishu setup --subject NAME --write-env --init-subject-config`，然后 `jea daemon start --domain channel`，最后在飞书私聊 `JEA BIND <口令>`；用 `jea channel events` 验收收消息与 ingest。
- 自动化脚本需要结构化输出时，优先使用带 `--json` 的命令。
- 发布/基线校准等人工作业：先读最新 evolution diary 与 verify report，再用 `jea intel brief put` 提交意图，然后 `jea daemon enqueue --type run_cycle` 或 `jea run`；用 `jea intel brief list` / `processed` 确认 brief 是否已被消费。
- 已确认的领域口径或术语定义（非待验证命题）：用 `jea intel ingest --source intel_observations` 写入 `operator_fact`；待核实或单轮优先级调整仍用 `jea intel brief put`。
- 长期稳定约束写 `human_guidance.md` 的 `## Current`；一次性核实请求不要写进 guidance，改用 brief。
- 调整演化方向用 `jea goals update`；不要手改 `standing_memory.json` 或直接写 `pending_decisions.json`。
