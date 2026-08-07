# JEA 重构 PRD：新核架构（core rebuild）

> **日期**: 2026-08-07
> **状态**: Draft（待操作者裁决两项开放决策后转 Accepted）
> **类型**: 产品需求文档 / 目标架构定义
> **前置分析**: [journal/2026-06-13/jea-refactor-plan-archive.md](../../journal/2026-06-13/jea-refactor-plan-archive.md) · GitHub issue #6（decide+exec 1:1 绑定，已暂停）· issue #18（机械硬规则审查 epic）

---

## 1. 背景与动机

JEA 当前约 58k 行宿主源码 + 30k 行测试，经历了四个演化阶段（OADA 奠基 → Channel/Viewer 产品化 → 绞杀者重构半途 → 情报诚实与救火循环）。三类偏离已被项目自身文献和外部分析共同确认：

| 偏离 | 证据 |
| --- | --- |
| **精力偏离**：周边产品面吃掉核心创新预算 | 目标自校正核心逻辑约 3k 行（<5%）；channel 9.5k 行、诚实机械层 + 测试约 6k 行 |
| **方法论偏离**：LLM 契约的 by-inspection 军备竞赛 | standing memory 三连修补、carryover 销账、suggestion coverage、rule feedback 叠层；issue #18 自诊「安全空转」，违反宪章第八条（法则繁则交易稀） |
| **架构偏离**：两次重构均半途而废 | 2026-06-13 计划 Phase 3（领域迁出 CLI）未做、上帝文件回潮；issue #6（work tick / 持久工作树）当天暂停 |

结构性症状：`cli/utils` 是事实内核（依赖全面倒挂 + 循环依赖）；`src/domain` 是 63 行 re-export 空壳；vendored engine 一半死代码；deprecated `phases` 双管线并存；五个 1800+ 行上帝文件；约 70 个 `JEA_*` 环境变量无收敛。

**结论**：不再做第三次绞杀者。采用**新核重建**（new core rebuild）——在同仓库新建 `core/`，从零实现内核，读写同一套 runtime 数据契约，跑同一份不变量测试；`src/` 降级为参考实现并最终移入 `legacy/`。

---

## 2. 产品定义

### 2.1 内核一句话

> **一个受审批约束的目标自校正演化循环**：subject 以 OADA 节拍行动，目标是可被后果证伪的法则假设；当后果证伪旧法则时，系统机械地重写目标树；全部认知留下可审计的痕迹。

### 2.2 北极星与核心创新

- 核心创新是 **goal self-correction**（`rule_status`: continue / learn / mutate / stop / insufficient_evidence + `goal_patches` 机械落盘），这是 JEA 区别于固定目标 `/goal` 循环的唯一存在理由。
- Cyber-Taoist 权威文献（CONSTITUTION / GUIDE）是理论约束层，语义不动。
- 一切其他能力（channel、viewer、多 provider、诚实矩阵）都必须回答：「删掉它，内核还成立吗？」

### 2.3 用户与核心场景

单一用户角色：**操作者**（owner，本地运行）。核心场景闭环：

1. `jea subject init` → 定义 SUBJECT.md 边界与初始目标树
2. `jea run` / daemon 长跑 → 系统自主查证、决策、执行、验证、更新信念与目标
3. 操作者通过四分级入口介入：Constraint（guidance/policy）、Intent（brief）、Fact（一次性种子）、Evidence（ingest）
4. 审批类动作经 brief → Decide `approval_granted` → exec preflight 放行
5. 操作者通过报告 / 日记 / 只读 viewer 观测，通过 goal/belief 事件流审计

---

## 3. 范围裁决

### 3.1 内核（In Scope，`core/` 从零实现）

| 能力 | 说明 |
| --- | --- |
| 查证 → 报告 → 决策 | agent_loop 形态：只读查证 tool loop → 宿主组装 Seen → 模型判断章节 → Decide JSON 入队 |
| 持久决策队列 + exec | 队列 v2 状态机语义保留（pending/in_progress/completed/blocked/retired/expired + queue_ops）；`agent_run` 为主执行抽象 + 审批门 |
| verify | maker ≠ verifier，独立 phase |
| beliefs | Phase 3.5 唯一正式写入点，依据 receipt / verify |
| goals assess + calibrate | `rule_status` + `goal_patches` 自动落盘，goal 事件流审计 |
| 情报记忆 | js-intel-store 接入 + standing memory（简化，见 4.4） |
| operator 四分级输入 | brief / fact / question / guidance |
| step + checkpoint 状态机 | 任何 step 可从 checkpoint 恢复 |

### 3.2 支撑件（In Scope，最小化实现）

- 调度器：单 worker、单域 daemon（continuous / on_demand）
- subject registry + lane（lane 在首个需要外部仓库的 subject 出现时搬运）
- 诚实层 **by-construction 部分**：宿主 Seen、typed ref、脱敏
- diary（审计叙事，简化）、只读报告 viewer、薄壳 CLI
- LLM gateway（profiles + KV 缓存友好的 payload 组装）+ 一个 agent provider

### 3.3 独立产品（Out of Scope，冻结共存）

| 子系统 | 处置 |
| --- | --- |
| **Channel 全栈**（classifier / presence / speech / 飞书） | 剥离为独立产品：继续跑在旧代码上，通过 runtime 数据契约与新核交互（inbound → operator 入口文件；outbound ← evolution-events / 报告）。重构期间零新功能 |
| **Viewer 运维控制台**（daemon console、channel panel、多 subject 总览） | 降级为只读报告浏览器；其余冻结 |
| **诚实矩阵 live 测试设施** | 研究工具，归档至 `tools/`，不算内核测试 |

### 3.4 删除清单（新核不搬运；`src/` 移入 legacy 后随之退役）

1. `phases` 管线全套（`ConversationalIntelligencePipeline` + 双管线调度 + 相关测试）
2. `src/engine` 未接线部分（IntelligencePipeline / VerifyPipeline / PromptBuilder / GitHub 面 / AutoEvolutionEngine / SelfAnalyzer）
3. `src/domain` re-export 空壳
4. `src/bridge`（OpenClaw）
5. deprecated env 兼容（`JEA_EXEC_LIMIT`、旧 `DEEPSEEK_MODEL/THINKING/REASONING_EFFORT` 别名等）
6. by-inspection 机械叠层：carryover 销账细则、suggestion coverage 补账、diary tldr 提取规则、standing memory 三级候选阶梯、报告重问修复（`JEA_REPORT_REPAIR_*`）——由 by-construction 原则整体替代（见 4.3）
7. 巨石测试中测实现细节的部分（`cli.test.mjs` 4144 行、`actions.test.mjs` 3579、`channel.test.mjs` 2986 不背走）

---

## 4. 目标架构

### 4.1 分层与目录

依赖方向单向：`edge → domain → infra → contracts`。CLI 是薄壳，不再充当共享内核。

```text
core/
├── contracts/        # 数据契约唯一定义点（schema + 校验；对旧 runtime 格式兼容）
│   ├── decision.mjs / receipt.mjs / checkpoint.mjs / goal-belief-events.mjs
│   └── runtime-layout.mjs        # runtime/subjects/<ns>/ 目录约定
├── infra/            # 机制层（无业务语义）
│   ├── json-store.mjs            # 原子写 + 锁（唯一实现）
│   ├── event-log.mjs             # JSONL append + 投影（唯一实现）
│   ├── task-queue.mjs
│   ├── worker-loop.mjs
│   ├── llm/                      # gateway + profiles + usage/cache 观测
│   └── config.mjs                # JEA_* 分域 schema（loop / exec / queue / llm / goal），
│                                 #   唯一 process.env 读取点
├── domain/           # 领域层（纯函数优先，策略注入）
│   ├── cognition/                # goals（rule_status/patches/校准策略）+ beliefs
│   ├── intel/                    # 查证 loop、宿主 Seen 组装、报告、standing memory
│   ├── exec/                     # 决策队列消费、agent_run、审批门、receipt
│   ├── verify/
│   ├── cycle/                    # 节拍编排：work tick + metacognition pass（见 4.2）
│   └── subject/                  # registry / lane / operator 四分级入口
├── agents/           # agent provider 适配（初期一个）
├── prompts/          # 模板数据化（.md 模板 + 变量注入；stable/dynamic 分段显式）
└── edge/
    ├── cli/                      # 薄壳：解析参数 → 调 domain
    ├── daemon/                   # 单 worker 调度
    └── viewer/                   # 只读
```

### 4.2 节拍模型：两种 tick 替代固定七步轮（裁决 issue #6）

旧架构把元认知（报告 / 信念 / 目标校准 / 日记）与执行 1:1 绑定在每轮，单轮固定 LLM 开销高、可落地行动少（issue #6 的结构性 ROI 问题）。新核直接采用解耦步图：

```text
work tick（廉价、高频）
  queue maintenance → 消费持久决策队列 → exec（agent_run / 机械动作）
  → verify → receipt 落盘
  仅当队列非空或有 guard 到期时运行

metacognition pass（昂贵、按信号触发）
  查证 → 宿主 Seen → 报告 → Decide（补充/处置队列 queue_ops）
  → belief update → goals assess/calibrate → diary
  触发信号：新 receipt 累积 ≥ N；队列耗尽或全 blocked（卡壳）；
  operator 输入到达（brief / fact / question 答复）；定时兜底（可配置）
```

约束：

- checkpoint 语义保留——两种 tick 的每个 step 都写 checkpoint，可恢复。
- 审批与信念写入点语义不变（belief 只在 metacognition pass 的 belief step 正式写入）。
- 旧的 `jea run` 单命令语义映射为「一次 metacognition pass + 排空一轮 work tick」，保证单轮调试体验不退化。

### 4.3 LLM 契约边界：by construction，不 by inspection

一次划清、全核适用的原则（取代删除清单第 6 项的全部叠层）：

1. **机械事实由宿主构造**：Seen、carryover、队列摘要、时间、目标/信念快照——全部宿主组装注入，模型不复述、不抄写。已验证于 host-assembled Seen（journal 2026-07-28）。
2. **模型自由输出宽容接收、显式标记**：判断章节、日记叙事、建议——原样落盘并标记 `origin: model`，不做重问修复、不做销账审计；下游一律当假设不当事实。
3. **需要机械可靠性的模型输出走结构化出口**：Decide JSON、goal_patches、verified_facts——过 contracts 校验，失败即拒绝该项（不重问），拒绝本身是 receipt/事件，交给下一次 metacognition 处置。
4. Prompt 全部模板数据化（`core/prompts/`），stable prefix / dynamic payload 分段显式声明，KV 缓存序为 review 准则。

### 4.4 记忆与 carryover 简化

- standing memory：单一组装路径（宿主 compose + typed ref 校验），失败即空段落 + 事件，不做 preserved/minimal 三级阶梯。
- carryover：机械项唯一来源是结构化残留（open_gaps、queue 摘要、operator question），由宿主生成；不再接收 diary 叙事 bullets、不做销账协议。
- 队列即工作状态：跨轮待续以队列 blocked/pending 为主载体（结构化），carryover 只补充非行动类线索。

### 4.5 数据契约（新旧共用，兼容承诺）

新核对以下格式**只做加法或同值填充**：

- `runtime/subjects/<ns>/` 目录约定
- `pending_decisions.json`（v2 状态机）、action receipts、`cycle-state/<id>/<step>.json`
- intel store（js-intel-store 保持 npm 依赖）
- `goal-events.jsonl` / `belief-events.jsonl` / `active_goals.json` / `current_beliefs.json`
- operator briefs / facts / questions 目录、`human_guidance.md`
- `evolution-events.jsonl`（channel 与 viewer 的消费面）

Channel（旧代码）与新核仅通过上述文件契约交互，无代码级依赖。

---

## 5. 不变量（验收标准，新旧两边同一套件）

1. Seen 的机械事实由宿主组装，模型只写判断章节
2. Seen/Evidence 引用必须是可解析的 typed ref；operator brief 毒句不得进入 Seen
3. 审批边界不可被任何 LLM 输出绕过（`approval_granted` 仅 Decide 产出，preflight 在 exec 内强制）
4. `read_only` profile 不落盘
5. 信念的正式写入点只在 belief step，依据 receipt / verify，不依据报告叙事
6. 目标变更必须落 `goal-events.jsonl` 且可回放
7. step 完成以 checkpoint 为准，任何 step 可从 checkpoint 恢复
8. maker ≠ verifier（exec 产物由独立 step 验收）
9. 任何落盘产物先经 secret redaction
10. 同一 runtime 数据在新旧实现下均可读（契约兼容）

---

## 6. 非目标

- 不做大爆炸切换：切换前新旧共存，runtime 数据不迁移不重置
- 不重写 channel / viewer 前端
- 不改 Cyber-Taoist 权威文献语义
- 不全仓 TypeScript（运行时 schema + JSDoc）
- 不引入多 IM transport 抽象、不为假想的多租户设计
- 不在新核里复刻旧 `phases` 管线

---

## 7. 阶段规划与防中断

### 7.1 冻结清单（PRD 生效即执行）

- 旧代码只修影响在跑 subject 的 P0
- 不再新增机械护栏（issue #18 剩余项 #15/#16 搁置——病根随 by-construction 消失）
- channel / viewer 零新功能

### 7.2 阶段与可弃点（每段独立成立）

| 阶段 | 交付 | 可弃点价值（若永远停在此） |
| --- | --- | --- |
| **0** | 本 PRD 定稿 + 不变量测试套件（先跑在旧系统上） | 旧系统获得一份高价值回归护栏 |
| **1** | `core/` 最小闭环（mock 驱动）：metacognition pass + work tick 全 step，读写真实 runtime 格式 | 干净的参考实现；数据契约被迫显式化 |
| **2** | 真实 LLM + 一个 agent provider + 单 worker daemon | 可实际使用的单 subject 演化宿主 |
| **3** | 默认入口切换到新核；`src/` → `legacy/`；外围按需搬运（lane、第二 provider、viewer 只读） | 主产品瘦身完成，legacy 可随时删除 |

每阶段验收：不变量套件在新旧两边全绿 + `jea run --mock` 产物等价（阶段 1 起）。

### 7.3 体量预期

内核 + 最小支撑件 ≤ 10k 行（对照现状 58k）；以「参考旧实现被真正使用的面」为搬运判据，按需不按清单。

---

## 8. 开放决策

| # | 决策 | 建议（默认采纳，可否决） | 状态 |
| --- | --- | --- | --- |
| D1 | Channel 按「独立产品、冻结共存、文件契约交互」处理 | 采纳（见 3.3 / 4.5） | 待操作者确认 |
| D2 | 新核直接采用两 tick 解耦步图，而非先照搬旧七步轮 | 采纳（见 4.2；重建是还此债成本最低的时机） | 待操作者确认 |

---

## 9. 参考文献

- `journal/2026-06-13/jea-refactor-plan-archive.md` — 四层架构与八大结构性问题（本 PRD 的增量修订基础）
- `journal/2026-07-27/agent-loop-report-centric-pipeline.md`、`journal/2026-07-28/host-assembled-seen.md` — by-construction 原则的验证
- GitHub issue #6 — work tick / 持久工作树路线图（本 PRD 4.2 裁决其方向）
- GitHub issue #18 — 机械硬规则的宪章第八条审查（本 PRD 4.3 以原则替代逐条拆弹）
- `policies/authority/CONSTITUTION.md` / `GUIDE.md` — 理论约束层（语义不动）
