# 法则清单：补偿性 vs 本质性（反应器化前置梳理）

- 日期：2026-08-07（销账表 2026-08-15）
- 状态：M5 销账完成（A 类已挂证据；残留标专项，不在本轮删除）
- 背景：架构方向讨论的结论是「调整架构优先于新增法则」——把认知管线从**固定 step 列车**迁往**证据流反应器**（证据到达 → 认知反应 → 行动 → 新证据）。本文先盘点现有全部「法则」（机制、闸门、阈值、补偿规则），标出哪些是**补偿性**（结构改了就能删或自然消失）、哪些是**本质性**（治理边界，必须保留），作为迁移的范围定义。
- 相关：[`docs/mechanism-diagram.md`](./mechanism-diagram.md)、[`docs/reactor-target-mechanism.md`](./reactor-target-mechanism.md)（目标机制图与新规则集）、[`src/contracts/OWNERSHIP.md`](../src/contracts/OWNERSHIP.md)、`policies/authority/CONSTITUTION.md`

## 0. 分类标准

| 类 | 含义 | 迁移处置 |
| --- | --- | --- |
| **A 补偿性** | 为「轮次结构 / step 列车」的结构性缺陷还债；结构改了即可删或自然消失 | 删除或自然消失 |
| **B 本质性** | 治理边界、理论法则、诚实契约；与循环形态无关 | 保留（形式可能变） |
| **C 模型可靠性** | 补偿 LLM 不可靠 / 成本结构；与循环形态无关 | 保留 |
| **D 基础设施** | 补偿 OS / 进程 / 文件系统的不可靠；与循环形态无关 | 保留 |
| **混合** | 意图本质、实现绑轮 | **拆分**：意图保留，载体换单位 |

「换单位」指：把以「轮（cycle）」为计量/生命周期单位的法则，改为以**证据批（evidence batch）**、**墙钟**或**事件计数**为单位。

---

## 1. 轮次节拍与开轮（A 为主）

| 法则 | 位置 | 补什么 | 分类 | 处置 |
| --- | --- | --- | --- | --- |
| continuous 模式 5min tick 自动开轮 | `daemon` worker tick（`tick-ms=300000`） | 时间驱动代偿「证据驱动」缺失 | **A** | **已停用（reactor 默认）**（2026-08-15）：heartbeat 不再入队 `reason: tick`；遗留 tick-only 请求被消费并忽略。`JEA_TICK_OPEN_CYCLE=1` 或 agent_loop/phases 可恢复 |
| `continuous` / `on_demand` 双模式与解析优先级 | `evolution-mode.mjs`、registry、env | 同上；on_demand 是向证据驱动迈的半步 | **A** | **残留待专项**：reactor 下开轮行为已等价（#45）；CLI / channel control / 健康文案仍绑双模式 |
| cycle-start-requests 消费 | `cycle-start-requests.mjs` | 人工开轮入口绑定「轮」概念 | 混合 | 保留入口，改为一条 operator 证据事件 |
| `JEA_CYCLE_STEP` / `JEA_CYCLE_ID` / `JEA_CYCLE_DRIVER` env 接力 | `runner.mjs` | 子进程列车需要环境变量传递轮次身份 | **A** | **残留待专项**：daemon step 子进程（含 reactor step）仍依赖；随「去子进程列车」一起拆 |

## 2. Step 列车韧性（A 为主，是最大的补偿群之一）

| 法则 | 位置 | 补什么 | 分类 | 处置 |
| --- | --- | --- | --- | --- |
| tick reconcile（checkpoint / task queue 漂移修复） | daemon tick | 列车 + 双源真相（cycle-state 与 task queue）必然漂移 | **A** | **部分停用**（2026-08-15）：`reconcileStepStateDrift`（按产物假完成 running task）reactor 默认关；abandon stale / 缺步入队保留。`JEA_STEP_ARTIFACT_RECONCILE=1` 或列车 pipeline 可恢复 |
| stuck step watchdog（hang 但 checkpoint 已写 → 杀 runner 按产物完成） | daemon heartbeat | 子进程列车可能 hang | A/D 混合 | **拆分保留**：进程超时（D）仍在；tick 路径「按产物假完成」已关（#45） |
| `drift_steps` / `progress_stalled` / `stuck_steps` 健康判定 | `daemon-projection` | 观测列车是否卡住 | **A** | **残留待专项**：doctor / inbox / viewer / channel 仍消费；先换 reactor backlog 指标再删 |
| step checkpoint 接力（下游从 `<step>.json` 重建上游产物） | `cycle-checkpoints.mjs` | step 子进程隔离切断了内存传递 | 混合 | **可恢复性是本质需求**；但「按 step 切檔」是列车派生。换单位：以证据批为 checkpoint 单元 |
| 历史 cycle-state 缺 `meta.pipeline` 按 `phases` reconcile | `cycle-reducer.mjs` | 双 pipeline 兼容 | **A** | **残留待专项**：旧 open cycle 防误判；确认无缺 pipeline 的 open cycle 后再删 |
| `run_cycle` 整轮任务与 step 任务并存 | daemon tasks | 新旧两种驱动方式共存 | **A** | **残留待专项**：`jea evolve --enqueue-only` / 本地整轮调试仍用；先 deprecate 再删 |

## 3. 跨轮信息流：carryover 家族（最典型的补偿群，几乎全 A）

这些法则全部在为同一个结构缺陷还债：**轮次边界切断了信息流**，于是需要人工搬运、销账、防腐。

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| mechanical carryover 项（open_gaps / deferred / overflow 搬运） | `carryover.mjs` | **A** | **已删写侧**（2026-08-15）：`writeCarryover*` 恒 no-op；读 leftover 保留 |
| `CARRYOVER_MECHANICAL_LIMIT=8` + origin 优先级裁剪 + `carryover_items_dropped` | `carryover.mjs` | **A** | **已停用写路径**；库函数仍在，生产不再写盘/发 drop 事件 |
| diary 销账规则（M1..Mn 编号、typed ref 核验可销、`decide_deferred` 拒销、越界拒销） | `carryover.mjs` + diary prompt | **A** | **已删**：diary 不再要求销账章节，生产不再 apply retirements |
| stale item 机械丢弃（`step_status_snapshot` 对照、字面提及 step + pending 词组丢弃） | `carryover.mjs` | **A** | **已停用写路径**；生产不再过滤后回写 |
| fingerprint / `first_seen_cycle` / `seen_count` 跨轮计数与 Jaccard 匹配 | `carryover.mjs` | **A** | **已停用写路径**；换单位：证据条目自带时间戳与引用计数 |
| suggestion coverage 软闸（S1..Sn 顶层计数、`deferred: unaddressed` 补记、`decide_coverage_gap`） | `report-suggestions.mjs` | **A** | **reactor 已不发生**：Decide schema 无 coverage，不发 `decide_coverage_gap`。agent_loop 回退路径仍保留软闸 |
| diary 时间线契约（phase1 叙事写于轮初、phase2 receipt 快照不得抄进日记） | diary prompt + AGENTS | **A** | **已审视**（#44）：销账章节已删；「不把 receipt 抄进日记」属诚实约束，按 B 保留 |

## 4. 决策队列跨轮生存（A / D 拆分）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| `cycles_seen` TTL（pending>5、blocked>10 过期） | `decision-queue.mjs` | **A** | **残留待专项**：墙钟后备已在（D）；按轮 TTL 等队列换单位专项 |
| `JEA_QUEUE_WALLCLOCK_TTL_DAYS=30` 墙钟后备 | 同上 | **D** | 保留（防计数异常的最后保险，本来就是墙钟） |
| `JEA_QUEUE_AUTO_ARCHIVE`（agent_loop 开始前归档） | `cycle-steps.mjs` | A/D | 保留归档，触发点从「轮初」改为容量/时间 |
| `queue_ops`（requeue / retire） | Decide JSON | 混合 | **认知对积压的处置权是本质**；保留，只是不再按轮注入 backlog 摘要 |
| fingerprint 入队去重 | queue | **D** | 保留 |
| attempts → blocked 状态机 | queue | **D** | 保留 |

## 5. 法则反馈家族（意图本质、实现绑轮的典型混合区）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| 按轮聚合结果签名（`JEA_RULE_FEEDBACK_WINDOW=8` 轮） | `rule-feedback.mjs` | 混合 | 意图（后果感知）保留；聚合窗口换为证据批/时间窗 |
| dead / starved streak 按连续轮数判定（`DEAD_STREAK=3`） | 同上 | 混合 | 换单位：连续 N 条 serving 证据无信息增量 |
| mutate cooldown（`MUTATE_COOLDOWN=2` 轮，冷却期 dead 降级 degraded） | 同上 | **A 倾向** | 轮次粒度太粗才需要「等两轮」；证据驱动下自然表达为「等到该 goal 下一条 serving 证据再判」 |
| `mutate_effective`（化妆式 mutate 检测、不豁免报警） | 同上 | **B** | 保留（防目标自修正机制自欺，理论核心） |
| 死亡边界报警（escalate → operator question，`trigger: rule_feedback_dead`） | 同上 | **B** | 保留（校准回路失灵的最后防线），触发条件换单位 |
| guard 法则化退役/重生（宪章十三条第 5 步） | assess prompt + guards | **B** | 保留（理论法则），信号源换单位 |
| mutate 轮禁删守护子目标（守功能破形态） | `goal-calibrate` | **B** | 保留 |

## 6. Operator 输入生命周期（意图本质、节拍绑定）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| brief 单轮消费 → processed 归档 | `operator-briefs.mjs` | 混合 | 「一次性意图」本质保留；消费单位从「下一轮」改为「下一次相关反应」 |
| operator fact 恰好一轮默认真 → 轮末消化进信念 | `operator-facts.mjs`、`operator-fact-digestion.mjs` | 混合 | **权威衰减是本质设计**；「恰好一轮」是节拍绑定，改为「默认真直至被下一批相关后果消化」 |
| operator question 打开/销账 | `operator-questions.mjs` | **B** | 保留 |
| guidance `## Current` 每轮注入 | report/decide prompt | 混合 | 保留语义（持续约束），注入点改为每次认知反应 |
| 存量 operator_fact 幂等迁移（cycle 开始时） | host | **A** | **已删生产调用**（2026-08-15）：三 subject 扫盘无遗留 observation-store fact；`migrateLegacyOperatorFacts` 仅留库函数 + 单测 |

## 7. 诚实与证据闸（本质核心，B 为主）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| 宿主组装 Seen / splice / 模型脏 Seen 覆盖 | `report-builder`、`cycle-steps` | **B** | 保留（核心价值：模型不得自证证据） |
| 判断章节编造 ref 机械检查 | `report-repair.mjs` | **B** | 保留 |
| typed ref 契约 + evidence audit | `evidence-audit.mjs`、`machine-context-refs.mjs` | **B** | 保留 |
| `redactSecrets` 落盘前脱敏 | `redaction.mjs` | **B** | 保留 |
| verified_facts 拒收 + 单次重交机会 | agent-loop | **B/C** | 保留 |
| report repair 有界重问（`REPAIR_MAX_ROUNDS=1`） | `report-repair.mjs` | **C** | 保留（LLM 可靠性，与轮次无关） |
| 每轮恰好一条 honesty 事件 | `cycle-steps` | 混合 | 审计不变量保留，单位从「轮」改为「报告/证据批」 |
| observation guard / source vocab 不变式 | `observation-guard.mjs` | **B** | 保留 |

## 8. 审批与边界（B 为主，一处补偿）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| `approval_granted` + `requires_approval` preflight | `approval-gate.mjs` | **B** | 保留 |
| `JEA_APPROVAL_MODE`（manual / auto_guarded / auto_all） | `approval-policy.mjs` | **B** | 保留 |
| auto_guarded 敏感词三层闸（动作语义词 / 通用安全词 / subject 专有词） | 同上 | 混合 | 边界本质；但**关键词启发式是布尔审批粒度太粗的补偿**。属于另一条架构调整线（能力授权），本次迁移不动 |
| SUBJECT.md Off-Limits | subject policy | **B** | 保留 |
| `JEA_CORE_APPLY_POLICY`（review/disabled/auto） | `handlers/builtin.mjs` | **B** | 保留 |
| lane guard / execution root 约束 | `subject-lane-guard.mjs`、`execution-root.mjs` | **B** | 保留 |
| repolink preflight → blocked receipt | `configured-external-runner` | **B/D** | 保留 |

## 9. Exec 资源治理（换单位为主）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| `JEA_EXEC_AGENT_BUDGET=8`（每轮 agent_run 预算） | `pipelines/exec.mjs` | 混合 | **速率载体已就绪**（#36）：`JEA_EXEC_AGENT_RATE` + 滑动窗口账本；与每轮预算双闸并存；按轮预算留待 Phase 5 观察期后再删 |
| 波次调度、写类 profile 独占波宽 1 | 同上 | **B** | 保留（写冲突安全） |
| `JEA_AGENT_MAX_ATTEMPTS` 重试 → blocked | queue | **D** | 保留 |
| mechanical guards `every_cycles` 到期执行 | `guard-runner.mjs` | 混合 | 本质是 cron；调度单位从轮改为时间/事件 |
| exec journal（轮内兄弟 action 信息共享，`Earlier actions this cycle`） | `exec-journal.mjs` | **A 倾向** | **残留待专项**：reactor 仍走独立 `exec` step，同轮多 agent_run 仍需兄弟上下文 |
| decision backlog 注入 Decide prompt | `phase1-shared` | 混合 | 保留（认知需看见积压），注入时机改为反应时 |

## 10. LLM 成本与档位（C，与本次迁移无关但有一处交叉）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| KV 缓存 stablePrefix 契约（Current Time 不进 system 前缀等） | `prompt-cache-metadata.mjs`、prompts | **C** | 保留；**注意**：轮次曾是缓存前缀的天然稳定单元，反应器化需重新设计「证据批」级的稳定前缀锚点 |
| `JEA_LLM_PROFILE` / phase 档位覆盖 | `llm-profile.mjs` | **C** | 保留 |
| tool result 截断（`TOOL_RESULT_MAX_CHARS`）、墙钟预留（`FINISH_RESERVE_MS`） | agent-loop | **C** | 保留 |

## 11. Channel（已是反应器形态，补偿性法则最少）

| 法则 | 位置 | 分类 | 处置 |
| --- | --- | --- | --- |
| presence cooldown / `max_messages_per_hour` 出站节流 | presence config | **B** | 保留（对外表达治理） |
| reactor deadline / 两阶段 timeout | presence | **D** | 保留 |
| classifier 批量 interval / batch_size / fallback | classifier config | **D** | 保留 |
| 幂等键（`${subject}:channel_classifier:pending`） | dispatch | **D** | 保留 |
| 废弃任务类型 purge（`channel_ingest` 等） | doctor | **A**（历史债） | **启动自动 purge 已删**（2026-08-15）：三 subject 队列无 deprecated pending；保留 `jea channel queue purge-deprecated` 手动命令 |

Channel 的 classifier → 唤醒 → bounded reactor → 两阶段表达，正是认知侧要迁往的目标形态的**在库先例**。

## 12. 基础设施可靠性（D，全部保留）

subject lock、`worker-state` 心跳与 zombie 检测、队列写 EPERM/EBUSY 重试、锁文件与数据文件分离、原子 JSON 写入、`JEA_EXIT_RECORD` 退出协议——与循环形态无关，照旧。

---

## 13. 汇总与迁移含义

粗略计数（按上表条目）：

| 分类 | 条数 | 说明 |
| --- | --- | --- |
| **A 补偿性（可删/自然消失）** | ~17 | 集中在三处：**跨轮信息流（carryover 家族 7 条）**、**step 列车韧性（5 条）**、**轮次节拍（4 条）** |
| **混合（拆分：意图保留、换单位）** | ~13 | 集中在法则反馈、operator 生命周期、exec 预算、checkpoint |
| **B 本质性（保留）** | ~18 | 诚实闸、审批边界、理论法则（mutate_effective、死亡边界报警、退役/重生） |
| **C/D（与架构无关，保留）** | ~14 | LLM 可靠性、成本、OS/进程可靠性 |

三个结论：

1. **补偿性法则的分布精确指认了结构病灶**：carryover 家族全部在补「轮次边界切断信息流」；reconcile/watchdog 全部在补「step 子进程列车 + 双源真相」；TTL/预算/一轮生命周期全部在补「时间节拍代替证据节拍」。反应器化直接消解这三个病灶，约 17 条法则可删，另 13 条可从「按轮」简化为「按证据批/墙钟」。
2. **本质法则不动**：诚实闸（宿主组装 Seen、typed ref、脱敏）、审批边界（approval preflight、Off-Limits、core policy）、理论法则（化妆式 mutate 检测、死亡边界报警、guard 退役/重生）在任何循环形态下都必须存在——它们是治理，不是补偿。
3. **需要重新安放的锚点**（迁移代价，不是省掉的）：checkpoint 可恢复性、KV 缓存稳定前缀、honesty 事件审计单元。三者都曾搭「轮」的便车，迁移时需以**证据批**为新单位重建。

## 14. 前置依赖（本清单之外、迁移之前）

1. `evolution-events.jsonl` 补 schema（`src/contracts/evolution-event.mjs`，OWNERSHIP 已登记）——没有契约的事件流不能安全地成为驱动源。
2. 定义**证据批（evidence batch）**：反应器的最小反应单元、审计单元、缓存单元；相当于把「轮」从语义单位降级为批次 id。
3. Channel presence reactor 的 claim-batch / bounded-deadline / 幂等唤醒模式作为参考实现评审一遍，确认可推广到认知侧。

---

## 15. M5 销账表（2026-08-15）

对照第 13 节约 17 条 A 类。**已消解** = 生产路径不再发生该补偿；**残留待专项** = 结构病灶未完全消失或仍有消费方，本轮不删。

| # | 法则 | 销账 | 证据 |
| --- | --- | --- | --- |
| A1 | tick 自动开轮 | **已消解**（reactor 默认） | [PR #45](https://github.com/imjszhang/js-evolution-agent/pull/45) |
| A2 | continuous / on_demand 双模式 | 残留待专项 | #45 后开轮行为已等价；API/channel 未收敛 |
| A3 | `JEA_CYCLE_*` env 接力 | 残留待专项 | `runner.mjs` / `runReactorStep` 仍读 env |
| A4 | tick reconcile 产物假完成 | **已消解**（reactor 默认） | [PR #45](https://github.com/imjszhang/js-evolution-agent/pull/45) |
| A5 | stuck watchdog 按产物完成 | 部分消解 | 进程超时保留（D）；tick 假完成已关（#45） |
| A6 | drift / stalled / stuck 健康判定 | 残留待专项 | doctor / viewer / channel 仍消费字段 |
| A7 | 缺 `meta.pipeline` → phases | 残留待专项 | `cycle-reducer.mjs` `cyclePipelineOf` |
| A8 | `run_cycle` 与 step 并存 | 残留待专项 | evolve enqueue-only / 本地整轮调试 |
| A9–A13 | carryover 写侧家族（搬运 / 限额 / 销账 / stale / fingerprint） | **已消解** | [PR #44](https://github.com/imjszhang/js-evolution-agent/pull/44) |
| A14 | suggestion coverage / `decide_coverage_gap` | **reactor 已不发生** | `cognitive-reactor.mjs` Decide 无 coverage；agent_loop 残留 |
| A15 | diary 时间线 / 销账章节 | **已消解销账；时间线按 B 保留** | [PR #44](https://github.com/imjszhang/js-evolution-agent/pull/44) |
| A16 | 存量 operator_fact 迁移 | **已删生产调用** | 本 PR；三 subject 扫盘无遗留 |
| A17 | channel 废弃任务自动 purge | **已删启动自动 purge** | 本 PR；手动 `purge-deprecated` 保留 |
| — | exec journal | 残留待专项（A 倾向） | reactor 仍走独立 exec step |
| — | `cycles_seen` TTL | 残留待专项 | 墙钟后备已在；按轮 TTL 另立项 |

M6 锚点（第 13 节结论 3）不在本表删除范围内：KV 前缀、批次 checkpoint、honesty 审计单元。
