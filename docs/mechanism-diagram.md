# JEA 机制图

- 日期：2026-08-07
- 范围：当前仓库大模块、双域调度、单轮演化闭环与跨模块数据契约
- 相关：[`src/contracts/OWNERSHIP.md`](../src/contracts/OWNERSHIP.md)、[`docs/module-decoupling-plan.md`](./module-decoupling-plan.md)、根 [`AGENTS.md`](../AGENTS.md)

本文用几张机制图说明 JEA **如何运转**，而不是罗列全部命令。

---

## 1. 系统总览：谁在驱动谁

```mermaid
flowchart TB
  subgraph Human["操作者 / 人类"]
    Policy["SUBJECT.md · 宪章 · Guidance"]
    Brief["brief / fact / 审批意图"]
    Viewer["Evolution Viewer"]
  end

  subgraph Facade["门面"]
    CLI["jea CLI"]
  end

  subgraph Domains["Daemon 双域（并行、独立队列）"]
    Cycle["Cycle Domain<br/>演化 step 调度"]
    Channel["Channel Domain<br/>飞书入站 / 表达 / 控制"]
  end

  subgraph Cognition["认知管线"]
    Intel["intelligence<br/>store · 报告 · Decide · 信念 · 目标"]
    Evol["evolution<br/>agent_loop · carryover · cycle-steps"]
  end

  subgraph Exec["执行层"]
    Actions["actions<br/>agent_run · lane · 审批闸"]
  end

  subgraph Shared["底座"]
    AI["ai<br/>DeepSeek / mock"]
    Kernel["contracts · infra · domain"]
  end

  Policy --> Cognition
  Brief --> CLI
  Brief --> Channel
  CLI --> Cycle
  CLI --> Channel
  CLI --> Viewer
  Cycle --> Cognition
  Cycle --> Exec
  Channel -->|channel-api 写 brief/fact| Intel
  Evol --> Intel
  Cognition --> AI
  Channel --> AI
  Exec --> AI
  Cognition --> Kernel
  Exec --> Kernel
  Cycle --> Kernel
  Channel --> Kernel
  Actions -->|receipt| Cognition
  Viewer -.->|只读 runtime| Kernel
```

要点：

- **Cycle** 负责「想清楚 → 做事 → 验证 → 改法则」。
- **Channel** 负责「对外收消息 / 说话 / 本地控制」，不直接改决策队列。
- 跨模块默认靠 **落盘契约** 交接，不靠互相深 import。

---

## 2. 模块依赖方向（设计约束）

```mermaid
flowchart BT
  Kernel["共享内核<br/>contracts / infra / domain"]
  AI["AI 网关"]
  Cognition["认知管线<br/>intelligence + evolution + prompts + engine"]
  Exec["执行层 actions"]
  Daemon["Daemon 编排"]
  Channel["Channel"]
  Facade["门面 cli / viewer / bridge"]

  AI --> Kernel
  Cognition --> AI
  Cognition --> Kernel
  Exec --> Kernel
  Exec --> AI
  Channel --> AI
  Channel --> Kernel
  Channel -->|"仅 channel-api.mjs"| Cognition
  Daemon --> Kernel
  Daemon --> Channel
  Daemon --> Cognition
  Facade --> Daemon
  Facade --> Channel
  Facade --> Cognition
  Facade --> Exec
  Facade --> Kernel
```

合法方向：`门面 → 业务 → AI → 内核`。  
Channel 写情报必须经 `src/intelligence/channel-api.mjs`。

---

## 3. 单轮演化机制（Cycle）

默认 Phase 1 为 `agent_loop`；其后 step 固定。

```mermaid
flowchart LR
  A["agent_loop<br/>查证 + 报告 + Decide"] --> B["exec<br/>消费 pending_decisions"]
  B --> C["verify<br/>maker ≠ verifier"]
  C --> D["belief_update"]
  D --> E["goals_assess"]
  E --> F["goals_calibrate"]
  F --> G["diary + carryover"]
  G -.->|下一轮| A
```

### 3.1 Phase 1（agent_loop）内部

```mermaid
flowchart TB
  S0["机械 Seen 底板"] --> S1["只读查证 tool loop<br/>intel_query / beliefs / goals…"]
  S1 --> S2["宿主组装最终 Seen<br/>+ verified_facts"]
  S2 --> S3["模型写判断章节<br/>Inferred / Cyber-Taoist / 建议"]
  S3 --> S4["契约检查 + 有界修复"]
  S4 --> S5["splice Seen · 脱敏 · 落盘报告"]
  S5 --> S6["Analyze+Decide JSON<br/>全量入队 pending_decisions"]
```

### 3.2 Phase 2（exec）双通道

```mermaid
flowchart TB
  Q["pending_decisions 队列维护<br/>TTL / expire / queue_ops"] --> G["mechanical guards"]
  G --> A["通道 A：非 agent_run<br/>串行 · 无预算"]
  G --> B["通道 B：agent_run 波次<br/>预算 / 并行 / 重试→blocked"]
  A --> R["executed[] + receipts"]
  B --> R
  R --> V["交给 verify"]
```

### 3.3 目标自修正（法则反馈）

```mermaid
flowchart LR
  Receipts["action receipts<br/>+ verify report"] --> Stats["rule_feedback_stats"]
  Stats --> Assess["goals_assess<br/>rule_status"]
  Assess -->|continue / learn| Keep["保持或学习"]
  Assess -->|mutate| Cal["goals_calibrate<br/>应用 goal_patches"]
  Cal --> Goals["active_goals.json"]
  Keep --> Next["下一轮 Decide 读取新/旧目标"]
  Goals --> Next
```

---

## 4. Channel 机制（与 Cycle 平级）

```mermaid
flowchart TB
  FS["飞书 WS / inbox put"] --> IN["inbound/pending"]
  IN --> CL["classifier<br/>brief / fact / observation / control / ignore"]
  CL -->|写入口| API["intelligence/channel-api"]
  CL -->|control_request| CTRL["control executor<br/>evolution-mode / cycle request"]
  CL --> WAKE["expression_recompute"]
  CTRL --> WAKE
  Tick["presence tick / attention"] --> WAKE
  WAKE --> PR["presence reactor<br/>plan → speech_intent"]
  PR --> SP["speech generation"]
  SP --> OB["outbox"]
  OB --> NT["notify flush → 飞书"]
```

Channel **不能**直接写 `pending_decisions` 或伪造 `approval_granted`；审批仍走 brief → 下一轮 Decide。

---

## 5. 跨模块数据契约（机制关节）

```mermaid
flowchart LR
  Decide["认知 Decide"] -->|"pending_decisions.json"| Exec["执行 exec"]
  Exec -->|"action receipts"| Verify["verify"]
  Verify -->|"verify report"| Belief["belief_update"]
  Verify --> Goals["goals_assess"]
  Belief --> Goals
  Exec --> Diary["diary"]
  Verify --> Diary
  Goals --> Diary
  Channel["Channel classifier"] -->|"brief / fact pending"| Decide
  Daemon["Daemon"] -->|"cycle-state checkpoints"| Decide
  Daemon --> Exec
  Daemon --> Verify
```

| 契约文件 | 生产者 → 消费者 |
| --- | --- |
| `pending_decisions.json` | Decide → exec |
| `cycle-state/<id>/<step>.json` | 各 step 接力 |
| action receipts | exec → verify / belief / diary |
| verify report | verify → belief / goals |
| operator briefs / facts | Channel 或 CLI → 下一轮认知 |
| channel inbound/outbox | Channel 内部 |

---

## 6. 操作者输入分层（治理机制）

```mermaid
flowchart TB
  subgraph Soft["软输入（引导，不当永久事实）"]
    Guidance["Guidance<br/>human_guidance.md"]
    Intent["Intent Brief<br/>下一轮意图"]
    Fact["Operator Fact<br/>一轮种子 → belief 消化"]
  end

  subgraph Hard["硬开关"]
    Approval["approval_granted<br/>Decide 产出 · Phase 2 preflight"]
    OffLimits["SUBJECT.md Off-Limits"]
  end

  Guidance --> P1["Phase 1 prompt"]
  Intent --> P1
  Fact --> Seen["升格 Seen 一轮"]
  Seen --> Dig["belief_update 消化"]
  P1 --> Dec["Decide"]
  Dec --> Approval
  Approval --> Exec["exec 放行/阻塞"]
  OffLimits --> Exec
```

---

## 7. 运行时落盘骨架（按 Subject）

```text
runtime/subjects/<namespace>/
├── SUBJECT.md
└── data/
    ├── evolution/          # cycle-state · decisions · briefs · carryover · diary
    ├── intelligence/       # store · beliefs · reports · standing memory
    ├── channel/            # inbound · outbox · channel tasks · events
    └── goals/              # active goals · goal-events
```

Daemon 以 **checkpoint 是否写完** 判定 step 完成；Channel 与 Cycle 使用独立 task queue / worker-state / 锁。

---

## 8. 一张图记住主回路

```text
人类设定边界与意图
        │
        ▼
┌─ Channel ─┐              ┌────────────── Cycle ──────────────┐
│ 收消息分类 │──brief/fact─►│ 查证→报告→Decide→执行→验证        │
│ 表达/通知  │◄─attention──│ →信念→目标校准→日记→下一轮         │
└───────────┘              └───────────────────────────────────┘
        │                              │
        └────────── Viewer / CLI 只读观测 ─┘
```

核心机制不是「固定 `/goal` 刷到绿」，而是：

1. **证据诚实**（宿主组装 Seen）  
2. **行动可审计**（queue + receipt + verify）  
3. **法则可修正**（goals assess/calibrate）  
4. **人机边界清晰**（brief/fact ≠ approval_granted）
