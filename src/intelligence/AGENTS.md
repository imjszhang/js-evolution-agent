# 认知管线（intelligence / evolution）

本文件是 `src/intelligence` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。


## 运行演化循环

- `jea run [--mock] [--deepseek] [--skip-goals-assess] [--skip-belief-update] [--subject NAME]`：运行一次完整演化循环并写入情报回执。
- `jea run --mock`：不调用真实模型，适合本地冒烟验证。
- `jea run --deepseek`：要求 DeepSeek API 配置存在。
- `jea run --skip-goals-assess`：诊断用，仅跳过 goal assess/calibrate。
- `jea run --skip-belief-update`：诊断用，仅跳过 post-verify belief settlement effect。

### Reactor 同步链

`jea run` 与 daemon 共用同一组 reactors 和 settlement coordinator；同步命令只是等待链路收敛，不是另一套 driver：

```text
EvidenceEnvelope → claim → cognitive reaction（investigate → report → Decide）
→ durable exec intent → exec result / action receipt
→ expected-output verify → idempotent belief/goal settlement
→ Memory Reactor consolidation
```

信念（Belief）是 Decide 的行动约束：`run_spec.context.belief_id` / `belief_relation` 将行动绑定到可验证假设。验证后只能通过共享 settlement service 依据精确 action receipt / verify report refs 更新。查证实现在 `src/evolution/investigation/`，只读且不直接调度副作用。

兼容边界：0.1.0 cycle-state、报告和缺少可选 causal/comparison 字段的记录继续可读，并显示为 legacy/unknown；不会生成虚构链路。旧 driver 配置不再是 live 选择项。

相关 env：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `JEA_LOOP_MAX_READONLY_TURNS` | `6` | 只读查证最大 LLM 轮数（主配置） |
| `JEA_LOOP_MAX_TURNS` | （可选） | 与 `MAX_READONLY` 取较小值；兼容旧配置 |
| `JEA_LOOP_MAX_WALLCLOCK_MS` | `1200000` | 整步墙钟（查证+报告+Decide） |
| `JEA_LOOP_FINISH_RESERVE_MS` | `120000` | 留给报告+Decide 的墙钟预留（查证软截止 = 总墙钟 − 预留） |
| `JEA_LOOP_CLOSING_TIMEOUT_SEC` | `240` | 查证强制收尾轮 LLM 超时（秒） |
| `JEA_LOOP_TOOL_RESULT_MAX_CHARS` | `6000` | 回填模型的工具结果截断 |
| `JEA_REPORT_REPAIR_MAX_ROUNDS` | `1` | 报告机械契约修复最大重问轮数（0 关闭，上限 2） |

执行预算 / 队列 TTL（`JEA_EXEC_*`、`JEA_AGENT_*`、`JEA_PENDING_TTL_*`、`JEA_QUEUE_*`）见 [src/actions/AGENTS.md](../actions/AGENTS.md)。

查证工具（仅 investigation 阶段）：

- **readonly**：`get_current_time`、`intel_query`、`get_current_beliefs`、`get_active_goals`、`get_decision_queue_summary`、`read_intel_report`（后四者工具结果附 `ref` / `cite_as` 句柄）。宿主另在动态载荷 `## Cycle` 之后注入固定字段 `## Current Time`（本步快照；勿写入 system stablePrefix，以免打穿 DeepSeek KV 前缀缓存）
- **control**：`finish_investigation`（必填 `findings_summary`、`enough_for_report`；可选 `gaps_closed` / `open_gaps` / `verified_facts[{ref,statement}]`）。若 `verified_facts` 被拒且非 closing 收尾，宿主给一次重交机会（`ok: false` + `verified_facts_rejected_retry`；已接受 facts 累积保留；`fact_retry_used` 记入 investigation）。

查证不注册 action 入队工具，也不在调查 turn 内直接写完整报告。最终 Seen 由宿主以机械底板、`machine_context` 和已校验 `verified_facts` 组装；模型只写判断章节。报告先过必需标题/编造 ref 检查和有界修复，再 splice Seen、净化引用、`redactSecrets` 后只持久化一次。verify 使用最终报告，raw/repaired 文件只作查证存档。

## 证据流与反应器影子

反应器化迁移的读侧、影子与 live 路径。S9 后 evidence wake 已固化：真实 `pending_decisions` / reports index / evolution-events 由 `cognitive_reaction` 写入。列车回退已删除。

### 证据流读侧

- `jea intel stream [--limit N] [--since ISO] [--kind KIND] [--cycle ID] [--json]`：虚拟只读投影，把 receipts / verify / briefs / channel events 等散落源统一为 `EvidenceEnvelope[]`（不写盘）。
- `jea intel stream --reconcile [--json]`：逐源对账（disk 行数 vs stream 条目；`contract_errors=0` 为通过）。duplicate id 记 data-quality 警告，不阻断 ok。
- `jea data evidence-journal inspect [--subject NAME] [--json] [--replay-epoch PATH]`：流式只读检查可重建 index journal，报告 bytes、有效/损坏行、unique/duplicate、kind 字节分布、generation/cognitive-rule-memory cursors、相对权威 sources 的 missing/orphan/unknown，以及 Activation Ledger 和解预览（preserved / activated-as-replay / legacy-unknown / conflicting / quarantined，按 Reactor 与 kind）。
- `jea data evidence-journal rebuild --subject NAME --dry-run --json`：停机迁移预览；确认 Cycle/Channel 均停止后加 `--yes`。实际 rebuild/rollback 在整个生命周期持有 subject `.evolve.lock`；重建从权威 sources 流式生成 v3 generation，按 `evidence_key` 去重。cursor 无法精确映射时从 offset 0 安全重放，但会把 0.2.x covered index / claim archive / consumed markers 和解到 Activation Ledger 身份 `(reactor, evidence_key, activation_policy_version)`；generation 切换本身不创造新工作。policy 版本变更必须带授权且非 preview 的 `kind: policy_backfill` replay epoch（`--replay-epoch PATH`）。回滚创建新的安全 generation，合并回滚后新产生的 handled 标记，绝不删除权威 evidence。磁盘分片位于系统临时目录，操作前应预留 journal 与 authority 合计数倍空间。产品面通过 `jea readiness` / `service.getReadiness` 的 `upgrade` 字段展示 `detect → inspect → disk_preflight → sidecar_backup → stage → validate → atomic_switch → ready`；空账本文件旁若有历史权威且无匹配 generation journal，不得视为 ready。

实现：`src/intelligence/evidence-stream.mjs`；契约：`src/contracts/evidence-envelope.mjs`。

### Incremental Evidence Router（0.3.0 控制面）

`src/evolution/reactor/evidence-router.mjs` 把**新追加**的 `EvidenceEnvelope` 增量写成可重建的 Activation Ledger。路由只判断“有没有工作”，不执行、不调度。契约从 `src/contracts/reactor-control-plane.mjs` 导入，身份为 `aiv1/<reactor>/activation-policy.v1/<evidence_key>`。journal generation 不是身份的一部分，换代不产生工作。策略字符串只有在资格规则变更时才允许 bump，且必须走 `evaluateActivationPolicyChange` + 显式 replay epoch，禁止静默回填。

策略表与 0.2.x `legacy_unknown` / `legacy_fallback` 口径见 [`src/evolution/reactor/evidence-router.md`](../evolution/reactor/evidence-router.md)。派生账本由 `src/evolution/reactor/activation-ledger-store.mjs` 独占，路径为 `data/evolution/reactor/evidence-index-generations/<generation>/activation-ledger.json`（永远不是 evidence / belief / receipt / settlement 的权威）。Daemon 不得再放第二份 ledger store。

### 认知反应器影子

- `jea reactor shadow run [--subject NAME] [--mock] [--limit N] [--skip-investigate] [--json]`：claim 一批未覆盖证据 → investigate（可选）→ 宿主组装 Seen → 报告 → Decide → **仅写 shadow 产物**。
- `jea reactor shadow status [--subject NAME] [--json]`：claim ledger、近期 shadow runs、honesty 计数。
- `jea reactor shadow compare --cycle ID [--batch BATCH] [--subject NAME] [--json]`：shadow Decide 与同期 live `pending_decisions` 指纹对照（matched / shadow_only / live_only / coverage）。

**绝不写入**（影子模式硬边界）：

- `data/evolution/pending_decisions.json`
- `data/intelligence/reports/index.jsonl`
- `data/intelligence/evolution_events/evolution-events.jsonl`

**Shadow 产物路径**（subject runtime）：

```text
data/evolution/reactor/
├── claims.json              # 仅 active claim 的有界 hot ledger
├── archive/
│   ├── claims.jsonl         # append-only terminal claim 审计
│   ├── claims-covered-index.json
│   └── claims-summary.json  # 投影使用的有界摘要
├── shadow_decisions.json    # 影子 Decide 队列（不入真实 exec）
├── shadow-runs.jsonl        # 审计（含 shadow_report_honesty / shadow_reaction_*）
└── shadow-reports/
    └── <batch_id>.md        # 宿主 splice 后的最终报告
```

旧版 `claims.json` / `archive/claims.json` 升级前先停 daemon 并备份，再运行
`jea data migrate-claims --subject NAME --dry-run --json`；确认摘要后加 `--yes`
正式迁移。迁移保留原文件备份和 legacy archive，不得直接删除恢复数据。

诚实闸：与列车相同，宿主组装 Seen + `auditHostSeenReport`；事件 type 为 `shadow_report_honesty`（每反应恰好一条）。硬断言见 `test/reactor-shadow-honesty-e2e.test.mjs`。

典型双跑 smoke（沙盒 subject）：

```powershell
npm run jea -- run --mock --subject js-evolution-agent
npm run jea -- reactor shadow run --mock --skip-investigate --subject js-evolution-agent
npm run jea -- intel stream --reconcile --subject js-evolution-agent
npm run jea -- reactor shadow compare --cycle <上一步 cycle_id> --subject js-evolution-agent
```

Live 写入 `pending_decisions`、reports index 与 evolution events；shadow 永不写这些权威产物。隔离 mock canary：`npm run reactor:canary`。完整一致性审计：`jea intel stream --reconcile` 后运行 `jea audit closure --json`。

## 情报与报告

查看情报：

- `jea intel summary [--days N] [--limit N]`：查看近期情报记忆摘要。
- `jea intel report`：输出最新 Markdown 情报报告。
- `jea intel report list [--limit N]`：列出近期报告。
- `jea intel report --cycle <id>`：输出指定 cycle 的报告。
- `jea intel report --open`：用系统默认程序打开最新报告。
- `jea intel report --json`：输出报告索引记录 JSON，而不是 Markdown 正文。
- `jea intel viewer serve [--port N] [--open] [--limit N] [--subject NAME] [--subjects a,b]`：开发/兼容 Viewer，直读 subject runtime，默认追踪所有 registry subjects。它展示 canonical evidence/task/attention 计数、事件流、当前 verify/Memory 产物和历史 report/diary；旧 `/api/rounds/:id`、`/api/cycles/:id` 与 hash 路由只为 0.1.0 读取兼容。`/events` SSE 继续推送 subject-scoped runtime updates，**无需先 build dist**。正式 Electron/Web 产品使用共享三栏工作区与 canonical operator projection。
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
| **Intent（意图）** | 下一次 reaction 关注什么，**不是事实** | `jea intel brief put` |
| **Fact（确立事实种子）** | 操作者断言：注入后恰好一轮默认为真，轮末消化进信念 | `jea intel fact put`（或 `intel ingest` 带 `kind: operator_fact`） |
| **Evidence（证据）** | 世界发生了什么，可被推翻 | `intel ingest` / `inbox`、probe、receipt |

另有 **Action（硬开关）**：如 `approval_granted`，由 Decide 产出、exec preflight 强制检查；操作者不应直接写 `pending_decisions.json` 绕过 Decide。

### Operator Intent Brief

- `jea intel brief put [--file PATH | --stdin]`：为下一次 intel cycle 放入一次性操作者意图 brief。
- `jea intel brief list`：列出待处理 brief。
- `jea intel brief processed`：列出已消费 brief。

Brief 是**单次 reaction 的人工意图**，不是已验证证据；cognitive reactor 的 report/decide 会读取它，Decide 成功入队后归档到 `processed/`。存储路径：

```text
<JEA_HOME>/subjects/<data_namespace>/data/evolution/operator_briefs/pending/
<JEA_HOME>/subjects/<data_namespace>/data/evolution/operator_briefs/processed/
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

1. **注入**：进入 `operator_facts/pending/`，下一次 cognitive reaction 升格为 Seen（`operator_established_fact`），恰好默认为真一次。
2. **消化**（belief settlement effect）：对照该 execution window 的 receipts / verify_report：
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
<JEA_HOME>/subjects/<data_namespace>/data/evolution/operator_facts/pending/
<JEA_HOME>/subjects/<data_namespace>/data/evolution/operator_facts/digested/
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
- cognitive context 的 `pending_operator_questions`
- `jea intel question list` / `jea intel question resolve <id> [--note TEXT]`

```text
<JEA_HOME>/subjects/<data_namespace>/data/evolution/operator_questions/pending/
<JEA_HOME>/subjects/<data_namespace>/data/evolution/operator_questions/resolved/
```

答复方式复用现有入口（重新 `fact put` 或 `brief put`）；`question resolve` 仅做销账。

### Operator Guidance（长期约束）

- 路径：`<JEA_HOME>/subjects/<data_namespace>/data/evolution/human_guidance.md` 的 `## Current` 段。
- 注入：report/decide 的 **Operator Guidance** 区块；每次 reaction 都会读，不会自动清空。
- 适合：稳定规则（如「ENOENT 必须带 execution_root 解释」）。
- 不适合：「下一次请核实 X」——应改用 `jea intel brief put`。

### 主体策略与权威文档

- `<JEA_HOME>/subjects/<data_namespace>/SUBJECT.md`：`Off-Limits Without Human Approval` 等审批与安全边界；`SOUL.md` 为 channel persona（不参与治理权威文献）；用 `jea subject check` 校验结构。
- `<JEA_HOME>/subjects/registry.json`：lane、resource root 等机器可读配置。
- `policies/authority/CONSTITUTION.md`、`policies/authority/GUIDE.md`、`oada.config.mjs`：认知权威文档，优先级高于情报材料。

### 通用情报写入（Evidence，非 operator_fact）

- 见上文「情报与报告」中的 `intel ingest` / `inbox`；可写入任意合法 source（`probe_results`、`goal_events` 等）。
- 普通 observation 默认 `kind: observation`、`confidence: medium`，**不会**升格为 `operator_established_fact`。
- 适合：外部探针结果、可推翻的手工观测；与 `operator_fact` 的「已确认口径」区分开。

### 目标与信念

- `jea goals update`：替换 active goals，写 `goal-events.jsonl`（演化方向的人工写入点）。
- `jea beliefs update`：兼容的手动 settlement 入口；正式创建/调整通常由 verify 唤醒 rule reactor 完成，依据精确 receipt 与 verify_report refs，而非 report 叙事。

### 记录型 action（经 Decide 间接落盘）

Decide 可调度执行层的记录型动作，用于落已有结论而非调查：`record_observation`、`run_evidence_audit`、`propose_probe`、`write_retrospective`、`request_core_review`。操作者通常通过 brief 引导 Decide，而不是直接写决策队列。

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
| 下一次 reaction 核实 / 审批意图 / 排优先级 | `jea intel brief put` |
| 已确认领域口径或术语（种子） | `jea intel fact put` |
| 可推翻的外部观测 | `intel ingest` / `inbox`（普通 observation） |
| 系统提问待答复 | `jea intel question list` → 再 `fact put` / `brief put`，然后 `question resolve` |
| 调整演化目标假设 | `jea goals update` |
| 远端发布 / 核心变更放行 | brief → Decide 产出 `approval_granted`（+ env 如 `AGENTANK_ALLOW_PUBLISH`） |

| 机制 | 入口 | 生命周期 | 证据地位 |
| --- | --- | --- | --- |
| Operator Intent Brief | `jea intel brief put` | 单次 reaction；入队后归档 | 软意图，不可当事实 |
| Operator Fact | `jea intel fact put` | 一次 reaction 默认真 → settlement 消化进信念 | 种子；消化后走信念生命周期 |
| Operator Question | 系统打开；`jea intel question resolve` 销账 | 待人答复 | 注意力信号，非事实 |
| Operator Guidance | `human_guidance.md` ## Current | 持续，直至手动清空 | 约束，非证据 |
| 普通 observation | `jea intel ingest --source intel_observations` | 持久（90 天 retention） | 证据，非自动 Seen |

## 目标管理

- `jea goals show`：显示当前 active goal hypothesis。
- `jea goals history [--limit N]`：查看目标变更事件（含 `assessment`、`updated`、`patched`）。
- `jea goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID]`：整棵替换 active goals 并记录 `updated` 事件。
- `jea goals patch --file PATH --reason TEXT [--evidence REF] [--cycle ID]`：应用 `goal_patches` JSON 数组（子目标增删改）；记录 `patched` 事件。`remove_child` 会自动 retire 绑定该 `goal_id` 的 active/validated 信念。
- `jea goals assess [--cycle ID]`：让 AI 评估目标校准并记录 `assessment` 事件（可含 `goal_patches` 或 `proposed_goal`）。

**Goal settlement 自动校准**（`goals_calibrate` effect）：

默认策略 **`liberal`**（`JEA_GOAL_CALIBRATE_MODE`，可设 `strict` 恢复保守行为）：

| 策略 | `goal_patches` | 整棵 `proposed_goal` |
| --- | --- | --- |
| **liberal**（默认） | `refine` / `split` / `replace` + 置信度 ≥ `medium`；逐条部分应用；无 outcome 个数上限（除非设 `JEA_GOAL_MAX_OUTCOME_CHILDREN`） | 同上状态 + 置信度 ≥ `medium`；patch 失败时可 fallback |
| **strict** | 仅 `refine`；`add`/`remove` 需 `high`；`update` 需 `medium+`；整批预览；outcome 1–2 个 | 仅 `refine` + `high` |

环境变量：

- `JEA_GOAL_CALIBRATE_MODE=liberal|strict`（默认 `liberal`）
- `JEA_GOAL_MAX_OUTCOME_CHILDREN=N`（`0` = 无上限；liberal 默认不限制）
- `JEA_GOAL_AUTO_APPLY=0`：只写 assessment，不应用 calibrate effect
- `JEA_GOAL_INTENT_SOFT_MAX`：update_child 后 intent 长度软上限（默认 `1500`）；超限发 `goal_intent_bloat` 警告事件，不硬拦

Assessor prompt 仍建议 `goal_patches` 与 `proposed_goal` 互斥；执行器先尝试 patches，失败可在 liberal 下 fallback `proposed_goal`。`add_child` 的 child 建议带 `role: outcome|guard`（供审计）。`rule_status=mutate` 时机械拒绝 `remove_child` 守护子目标（`role=guard` 或 id 前缀 `guard-` / `monitor-`），只允许 `update_child` 修订观测点（守功能、破形态）。**continue/learn + refine 轮允许**对已被机械维持的守护目标 `remove_child`（mechanized retirement）。`patched` goal_event 会附带 `rule_status`。

**法则反馈健康度**（`rule_feedback_stats`）：

宿主按 `action.serves_goal` 聚合近期 receipts 的结果签名（`key=value` 归一化 hash），并对照 `evolution.guards` 配置，为每个子目标计算 `feedback_state`。只读命令 `jea goals feedback-compare --subject NAME [--json] [--at TIMESTAMP|--rolling N] [--starved-strategy both] [--include-fp]` 可对比历史 cycle 分桶与逐 receipt evidence，并做截点回放（不写运行时数据）。注入点：

- **goal assess effect**：完整 JSON，含 `mechanical_guards` 段，驱动 `rule_status` 与退役/重生。
- **Decide context**：压缩的 `## Rule Feedback Health`（dead / degraded / starved / mechanized），避免原样重复无信息探针。

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
| `JEA_RULE_FEEDBACK_STREAK_UNIT` | `evidence` | `evidence`（生产默认，逐条 serving receipt）或显式 `cycle` 回退 |
| `JEA_RULE_FEEDBACK_WINDOW_EVIDENCE` | `24` | evidence 模式统计窗口（serving receipt 条数） |
| `JEA_RULE_FEEDBACK_DEAD_STREAK` | `3` | 判 dead 的连续签名停滞阈值 |
| `JEA_RULE_FEEDBACK_STARVED_STREAK` | 同 dead | 饥饿阈值（与 dead **解耦**；未设置时等于 dead，保持旧行为） |
| `JEA_RULE_FEEDBACK_STARVED_STREAK_EVIDENCE` | 同 starved | evidence 模式下独立饥饿阈值 |
| `JEA_RULE_FEEDBACK_STARVED_STRATEGY` | `global_count` | `global_count`（全局未服务计数）或 `wall_clock`（距上次 serving 的墙钟小时） |
| `JEA_RULE_FEEDBACK_STARVED_WINDOW_HOURS` | `48` | `wall_clock` 策略下的饥饿小时阈值 |
| `JEA_RULE_FEEDBACK_ESCALATE_STREAK` | `5` | 死亡/饥饿边界报警阈值（见下；`wall_clock` 下饥饿 escalate 跟窗口小时） |
| `JEA_RULE_FEEDBACK_MUTATE_COOLDOWN` | `2` | mutate 后冷却轮数（`0` 关闭）；冷却期内 dead 降级为 degraded |
| `JEA_RULE_FEEDBACK_RECEIPT_LIMIT` | `120` | 参与统计的 receipt 读取上限 |

`DEAD_STREAK` / `ESCALATE_STREAK` / `MUTATE_COOLDOWN` 在 evidence 模式下单位随之变为 evidence 条数；当前默认 3/5/2 仅用于双模式对照，不能直接视为生产标定值。历史回放结论见 `docs/rule-feedback-evidence-calibration.md`。

**死亡边界报警**：若某子目标 `escalate_eligible`（`feedback_state=dead` 且 sig streak ≥ escalate，或未被机械维持的子目标 `starved_streak` ≥ escalate），而本轮 assess 未 mutate 或 calibrate 未对该子目标 applied patch（含 `mode: full_replace` 整树替换），**且**该 goal 的 `mutate_effective !== false`（化妆式 mutate 不豁免），则打开 operator question（`trigger: rule_feedback_dead`），并发 `rule_feedback_escalated` 事件；同 goal 已有 pending question 时去重。这是校准回路失灵的最后防线，不是常规人工审批出口。

### 信念管理

- `jea beliefs show`：显示当前 active/validated/refuted 信念状态。
- `jea beliefs events [--limit N]`：查看近期信念变更事件。
- `jea beliefs update [--cycle ID]`：兼容的手动 post-verify 更新入口；live 路径通常由 rule reactor settlement 自动执行。

信念是绑在 goal 上的可验证行动假设（`claim`、`next_test`、`evidence_refs`）。Decide 通过 `params.run_spec.context.belief_id` / `belief_relation` 绑定 `agent_run`；**创建或调整信念的正式写入点是 settlement effect**，依据 action receipt 与 verify_report，而非 report 叙事。存储：`data/intelligence/beliefs/current_beliefs.json`、`belief-events.jsonl`。

同步 `jea run` 与异步 rule reactor 共用 evidence-window settlement。幂等协调 sidecar 位于 `data/evolution/reactor/settlements.json`，只记录 claim、effect checkpoint 与结果摘要，可由携带 `settlement_id` / `settlement_effect` 的 belief/goal events 重建；**权威事实仍是 append-only belief/goal events，不是 settlement sidecar**。`validate` / `refute` / `reopen` 与 goal assess/calibrate 只引用该 execution window 的精确 `action_receipt:*` / `verify_report:*` refs。

### Memory Reactor 与 closure audit

Memory Reactor 只消费已完成 settlement 后的新 belief/goal events，低频更新 standing memory 与 evolution diary；它不是第二套信念存储，也不在同步 `jea run` 末尾伪造 diary。checkpoint/cursor 保证 crash 后从首个未处理 settlement 恢复。

`jea audit control-plane [--target PATH] [--json] [--skip-baseline]`（或 `npm run audit:control-plane`）是 0.3.0 控制面验收入口：始终使用临时 `JEA_HOME` 与 mock LLM，对照 `policies/release/control-plane-target-0.3.0.json`。它不替代、也不改写 `jea audit closure`。`--subject` 只命名合成 subject，不检查操作者 home。

`jea audit closure [--subject NAME] [--json]` 是 0.2.0 闭环验收入口，报告：

- belief binding / `run_spec.expected_output` 声明覆盖与 `legacy_unknown`；
- decision / receipt / verify / settlement 的 causal correlation 与 batch-scoped refs；
- duplicate settlement candidates；
- Memory Reactor 相对最新 settlement 的 freshness/lag；
- standing memory freshness，以及 evidence/task backlog 的分离统计。

审计严格只读，不修复、迁移或懒重建 sidecar/index；缺失 claim covered index 时只在内存中从 archive 兼容计算。0.2.0 冻结门槛见 `policies/release/closure-target-0.2.0.json`：新记录缺 causal/expected/belief binding、重复 settlement、Memory 不新鲜均明确失败，`legacy_unknown` 单列且不冒充通过。升级前先停 daemon 并 `jea data backup`；迁移后运行 `jea intel stream --reconcile` 与 `jea audit closure --json`。0.1.0 optional fields 缺失属于兼容 unknown，不应批量回填虚构 ID。

目标 JSON 需要包含 `id`、`name`、`intent`、`good_signal`、`bad_signal` 和 `children`。
