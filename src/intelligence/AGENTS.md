# 认知管线（intelligence / evolution）

本文件是 `src/intelligence` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。


## 运行演化循环

- `jea run [--mock] [--deepseek] [--skip-goals-assess] [--skip-belief-update] [--subject NAME]`：运行一次完整演化循环并写入情报回执。
- `jea run --mock`：不调用真实模型，适合本地冒烟验证。
- `jea run --loop` / `jea run --pipeline agent_loop`：显式指定 **agent_loop**（现为默认，通常可省略）。
- `jea run --pipeline phases`：deprecated 回退路径（经典 observe→report→decide；无 tool-calling）。
- `jea run --deepseek`：要求 DeepSeek API 配置存在。
- `jea run --skip-goals-assess`：跳过本轮目标评估（Phase 4 / 4.5）。
- `jea run --skip-belief-update`：跳过 post-verify 信念更新（Phase 3.5）。

### Agent Loop 管道（默认）

`agent_loop` **仅替代 Phase 1**，按报告中心生产线编排；**Phase 2 exec 仍独立执行** pending_decisions；verify / belief / goals / diary **保持固定收尾**。

内部阶段：

```text
机械 Seen 底板 → 只读查证（tool loop，可交 verified_facts）
→ 宿主组装最终 Seen（machine_context + 机械底板 + verified_facts）
→ 模型定稿判断章节（Inferred / Cyber-Taoist / 下一轮建议）
→ 机械契约检查（必需标题 / 编造 ref）→ 有界重问修复（默认最多 1 轮）
→ 宿主 splice Seen + 引用字形净化 → 经典 Analyze+Decide JSON 批入队
```

完整单轮 step 图：

```text
agent_loop → exec → verify → belief_update → goals_assess → goals_calibrate → diary
```

信念（Belief）在 Phase 1 被 Decide 读取约束行动，在 Phase 3.5 依据 receipt 与 verify_report 正式更新。详见下文「信念管理」与 [src/actions/AGENTS.md](../actions/AGENTS.md) 的「人工审批与操作者意图」。

模式解析优先级（仿 evolution.mode）：

1. `runtime/subjects/registry.json` → `subjects.<name>.evolution.pipeline`
2. CLI `--loop` / `--pipeline agent_loop|phases`
3. env `JEA_CYCLE_PIPELINE`
4. 默认 `agent_loop`

显式选择 `phases` 时会打一次 deprecation 警告；可用 `JEA_SUPPRESS_PHASES_DEPRECATION=1` 静音。历史 cycle-state 若缺 `meta.pipeline`，读盘时仍按 `phases` 步图 reconcile（避免误判旧 open cycle）。

**deprecated `phases` Phase 1**（仅显式启用时）：

```text
Phase 1   intel pipeline（observe -> report -> analyze+decide）
Phase 1.5 intel report 持久化
→ 其后与 agent_loop 相同：exec → verify → belief → goals → diary
```

相关 env：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JEA_CYCLE_PIPELINE` | `agent_loop` | `agent_loop` 或 `phases`（deprecated） |
| `JEA_SUPPRESS_PHASES_DEPRECATION` | （关） | `1`/`true` 时静音 phases deprecation 警告 |
| `JEA_LOOP_MAX_READONLY_TURNS` | `6` | 只读查证最大 LLM 轮数（主配置） |
| `JEA_LOOP_MAX_TURNS` | （可选） | 与 `MAX_READONLY` 取较小值；兼容旧配置 |
| `JEA_LOOP_MAX_WALLCLOCK_MS` | `1200000` | 整步墙钟（查证+报告+Decide） |
| `JEA_LOOP_FINISH_RESERVE_MS` | `120000` | 留给报告+Decide 的墙钟预留（查证软截止 = 总墙钟 − 预留） |
| `JEA_LOOP_CLOSING_TIMEOUT_SEC` | `240` | 查证强制收尾轮 LLM 超时（秒） |
| `JEA_LOOP_TOOL_RESULT_MAX_CHARS` | `6000` | 回填模型的工具结果截断 |
| `JEA_REPORT_REPAIR_MAX_ROUNDS` | `1` | 报告机械契约修复最大重问轮数（0 关闭，上限 2）；phases 与 agent_loop 共用 |

Phase 2 执行预算 / 队列 TTL（`JEA_EXEC_*`、`JEA_AGENT_*`、`JEA_PENDING_TTL_*`、`JEA_QUEUE_*`）见 [src/actions/AGENTS.md](../actions/AGENTS.md)。

查证工具（仅 investigation 阶段）：

- **readonly**：`get_current_time`、`intel_query`、`get_current_beliefs`、`get_active_goals`、`get_decision_queue_summary`、`read_intel_report`（后四者工具结果附 `ref` / `cite_as` 句柄）。宿主另在动态载荷 `## Cycle` 之后注入固定字段 `## Current Time`（本步快照；勿写入 system stablePrefix，以免打穿 DeepSeek KV 前缀缓存）
- **control**：`finish_investigation`（必填 `findings_summary`、`enough_for_report`；可选 `gaps_closed` / `open_gaps` / `verified_facts[{ref,statement}]`）。若 `verified_facts` 被拒且非 closing 收尾，宿主给一次重交机会（`ok: false` + `verified_facts_rejected_retry`；已接受 facts 累积保留；`fact_retry_used` 记入 investigation）。

查证阶段**不**注册 action 入队工具，也**不**在 loop 内写完整 Intel 报告。**phases 与 agent_loop 的最终 Seen 均由宿主组装**：机械底板 + `machine_context` bullets（agent_loop 另可并入已校验 `verified_facts`；phases 无查证阶段故 `verifiedFacts=[]`）。模型只写判断章节。落盘次序：首稿写入 `*_report_raw.md` → 机械契约检查（缺必需标题 / 判断章节编造 ref）→ 有界重问修复（最多 `JEA_REPORT_REPAIR_MAX_ROUNDS` 轮，默认 1；修复稿另存 `*_report_repaired.md`；事件 `intel_report_repair`）→ `transformMd` 在 `persistIntelReport` 内、`redactSecrets` 之前做字形净化与 `## Seen` splice（只写盘一次）→ persist 后发单次诚实事件（`phases_report_honesty` / `agent_loop_report_honesty`）。agent_loop 查证若最终仍有 `rejected_facts`，另发 `agent_loop_rejected_facts`（不进 carryover）。诚实矩阵 raw 列始终审修复前首稿；最终产物硬闸看 splice+脱敏后报告。有意不对称：phases 报告 prompt 仍含 intelligenceContext + observe + Machine Context JSON；agent_loop 报告 prompt 更瘦。verify 复放的是宿主最终报告（raw 仅存档）。

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
| **Fact（确立事实种子）** | 操作者断言：注入后恰好一轮默认为真，轮末消化进信念 | `jea intel fact put`（或 `intel ingest` 带 `kind: operator_fact`） |
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

### Operator Fact（一次性种子）

operator_fact **不再是永久权威事实**。它是操作者注入的一次性种子：

1. **注入**：进入 `operator_facts/pending/`，下一轮 Phase 1 升格为 Seen（`operator_established_fact`），恰好默认为真一轮。
2. **消化**（Phase 3.5 belief_update）：对照本轮 receipts / verify_report：
   - `supported` → 写入信念 `validated`，`origin: operator`
   - `untested` → 写入信念 `active` + `high`，标记未验证
   - `contradicted` → **不**入库为真，打开 operator question 向人求证
3. 信念进入原生生命周期，后续证据可 weaken / refute——权威衰减自动发生。

入口：

- `jea intel fact put [--file PATH | --stdin]`（推荐）
- `jea intel fact list` / `jea intel fact digested`
- `jea intel ingest --source intel_observations` 若记录带 `kind: "operator_fact"`，自动改写入 pending store（兼容旧习惯）
- channel classifier 识别的 operator_fact 同样写 pending store

存储路径：

```text
runtime/subjects/<data_namespace>/data/evolution/operator_facts/pending/
runtime/subjects/<data_namespace>/data/evolution/operator_facts/digested/
```

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

常用字段：`content`（或 `summary`）、`subject`、`confidence`（种子仅接受 `high` 或缺省）。长期边界类约束仍写 `human_guidance.md` / subject policy，不要用 fact 冒充永久合同。

**修正口径**：重新 `jea intel fact put` 注入新种子即可（续期一轮后重新消化）；不必再维护 `supersedes` 链（旧读侧仍兼容 observation store 中的历史 supersedes）。自动化代理在未获操作者明确确认时，不要替其写入 operator fact。

**存量迁移**：cycle 开始时宿主把 observation store 中仍 active 的高置信 operator_fact 幂等迁入 pending/，随后走新消化流程。

### Operator Question（向人求证）

当消化发现矛盾（或后续 stuck-detection）时，系统打开 operator question，露出在：

- `jea daemon inbox`（attention 汇总）
- Phase 1 上下文 `pending_operator_questions`
- `jea intel question list` / `jea intel question resolve <id> [--note TEXT]`

```text
runtime/subjects/<data_namespace>/data/evolution/operator_questions/pending/
runtime/subjects/<data_namespace>/data/evolution/operator_questions/resolved/
```

答复方式复用现有入口（重新 `fact put` 或 `brief put`）；`question resolve` 仅做销账。

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

- 见上文「情报与报告」中的 `intel ingest` / `inbox`；可写入任意合法 source（`probe_results`、`goal_events` 等）。
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
| 已确认领域口径或术语（种子） | `jea intel fact put` |
| 可推翻的外部观测 | `intel ingest` / `inbox`（普通 observation） |
| 系统提问待答复 | `jea intel question list` → 再 `fact put` / `brief put`，然后 `question resolve` |
| 调整演化目标假设 | `jea goals update` |
| 远端发布 / 核心变更放行 | brief → Decide 产出 `approval_granted`（+ env 如 `AGENTANK_ALLOW_PUBLISH`） |

| 机制 | 入口 | 生命周期 | 证据地位 |
| --- | --- | --- | --- |
| Operator Intent Brief | `jea intel brief put` | 单轮；入队后归档 | 软意图，不可当事实 |
| Operator Fact | `jea intel fact put` | 一轮默认真 → Phase 3.5 消化进信念 | 种子；消化后走信念生命周期 |
| Operator Question | 系统打开；`jea intel question resolve` 销账 | 待人答复 | 注意力信号，非事实 |
| Operator Guidance | `human_guidance.md` ## Current | 持续，直至手动清空 | 约束，非证据 |
| 普通 observation | `jea intel ingest --source intel_observations` | 持久（90 天 retention） | 证据，非自动 Seen |

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
- `JEA_GOAL_INTENT_SOFT_MAX`：update_child 后 intent 长度软上限（默认 `1500`）；超限发 `goal_intent_bloat` 警告事件，不硬拦

Assessor prompt 仍建议 `goal_patches` 与 `proposed_goal` 互斥；执行器先尝试 patches，失败可在 liberal 下 fallback `proposed_goal`。`add_child` 的 child 建议带 `role: outcome|guard`（供审计）。`rule_status=mutate` 时机械拒绝 `remove_child` 守护子目标（`role=guard` 或 id 前缀 `guard-` / `monitor-`），只允许 `update_child` 修订观测点（守功能、破形态）。**continue/learn + refine 轮允许**对已被机械维持的守护目标 `remove_child`（mechanized retirement）。`patched` goal_event 会附带 `rule_status`。

**法则反馈健康度**（`rule_feedback_stats`）：

宿主按 `action.serves_goal` 聚合近期 receipts 的结果签名（`key=value` 归一化 hash），并对照 carryover 跨轮计数与 `evolution.guards` 配置，为每个子目标计算 `feedback_state`。注入点：

- **Phase 4 goals assess**（完整 JSON，含 `mechanical_guards` 段，驱动 `rule_status` 与退役/重生）
- **Phase 1 Decide**（agent_loop 仅）：压缩段 `## Rule Feedback Health`（dead / degraded / starved / mechanized），信息用法——签名恒定或 starved 的 goal 不应原样重复同一探针；`mechanically_maintained` 目标勿再入队相同探针；不行动须在 `deferred` / `goal_coverage.not_covered` 说明。phases 路径不注入。

| 状态 | 含义 | assess 期望 |
| --- | --- | --- |
| `live` | 签名随世界变化，有信息增量；**或** `mechanically_maintained` 且 trailing receipts 全 success（健康恒定签名不算死亡） | continue / learn；若 `eligible_for_retirement` 则 continue+refine remove_child |
| `degraded` | 签名连续 ≥2 轮相似（失败信号） | 提高敏感度；区分通道故障 vs 法则滞后 |
| `dead` | 签名连续 ≥`JEA_RULE_FEEDBACK_DEAD_STREAK`（默认 3）且 `information_gain=0`（失败信号） | 按宪章第九条/十三条必须 `rule_status=mutate`，`update_child` 修订观测点；不得再 learn 等待 |
| `degraded`（mutate 冷却） | 刚 mutate 后 `mutate_cooldown=true`（等待新签名） | 不要重复 mutate 同一观测点；优先 continue / learn |
| `starved`（派生） | **未被机械维持**的子目标（非 root）连续 ≥ dead_streak 轮无任何 serving receipt | 与 dead 同等：必须 mutate 观测点或退出条件；不得 learn 等待 |

每行额外字段：

- `is_root`：receipt 的 `serves_goal` 指向 root id 时为 true。root 判 dead 时须用 `proposed_goal` 整树换代，不能 `update_child` root。
- `mechanically_maintained`：goal id 被启用中的 `evolution.guards[].action.serves_goal` 覆盖。
- `healthy_streak` / `failure_streak`：近窗内 trailing 全 success / 全 failure 轮数。
- `starved_streak`：全局最近 cycle 序列中，该子目标连续无 receipt 的轮数（root / `mechanically_maintained` / 非 active-tree 孤儿 label 为 0）。
- `mutate_effective`：`null`（无 mutate 或冷却中）/ `true`（冷却后签名已变）/ `false`（冷却后签名未变 = 化妆式 mutate）。`mutate_effective=false` 时，即使本轮再次 mutate 该 goal，**不再豁免**死亡边界报警。

顶层另有 `mechanical_guards[]`：每条含 `guard_id`、`serves_goal`、`goal_in_active_tree`、`recent_status`、`healthy_streak`、`failure_streak`、`eligible_for_retirement`、`eligible_for_rebirth`。

相关 env：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JEA_RULE_FEEDBACK_WINDOW` | `8` | 统计窗口（cycle 数） |
| `JEA_RULE_FEEDBACK_DEAD_STREAK` | `3` | 判 dead / starved 的连续轮数阈值 |
| `JEA_RULE_FEEDBACK_ESCALATE_STREAK` | `5` | 死亡/饥饿边界报警阈值（见下） |
| `JEA_RULE_FEEDBACK_MUTATE_COOLDOWN` | `2` | mutate 后冷却轮数（`0` 关闭）；冷却期内 dead 降级为 degraded |
| `JEA_RULE_FEEDBACK_RECEIPT_LIMIT` | `120` | 参与统计的 receipt 读取上限 |

**死亡边界报警**：若某子目标 `escalate_eligible`（`feedback_state=dead` 且 sig streak ≥ escalate，或未被机械维持的子目标 `starved_streak` ≥ escalate），而本轮 assess 未 mutate 或 calibrate 未对该子目标 applied patch（含 `mode: full_replace` 整树替换），**且**该 goal 的 `mutate_effective !== false`（化妆式 mutate 不豁免），则打开 operator question（`trigger: rule_feedback_dead`），并发 `rule_feedback_escalated` 事件；同 goal 已有 pending question 时去重。这是校准回路失灵的最后防线，不是常规人工审批出口。

Carryover mechanical 项带跨轮字段 `fingerprint` / `first_seen_cycle` / `seen_count`（同 cycle 重写不重复计数；跨 cycle 精确或 Jaccard≥0.6 匹配继承）。agent_loop 查证 prompt 渲染时，`seen_count≥2` 的条目会标注「已连续 N 轮」。

### 信念管理

- `jea beliefs show`：显示当前 active/validated/refuted 信念状态。
- `jea beliefs events [--limit N]`：查看近期信念变更事件。
- `jea beliefs update [--cycle ID]`：手动触发 post-verify 信念更新（通常由 `jea run` Phase 3.5 自动执行）。

信念是绑在 goal 上的可验证行动假设（`claim`、`next_test`、`evidence_refs`）。Decide 阶段通过 `params.run_spec.context.belief_id` / `belief_relation` 绑定 `agent_run`；**创建或调整信念的正式写入点在 Phase 3.5**，依据 action receipt 与 verify_report，而非 report 叙事。存储：`data/intelligence/beliefs/current_beliefs.json`、`belief-events.jsonl`。

目标 JSON 需要包含 `id`、`name`、`intent`、`good_signal`、`bad_signal` 和 `children`。
