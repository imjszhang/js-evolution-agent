# JEA 机制图

- 日期：2026-08-22
- 范围：0.2.0 belief-driven async loop、Channel delivery、operator projection 与跨模块数据契约
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
    Reactor["Evolution Reactors<br/>cognitive · exec · verify · rule · memory"]
    Channel["Channel Domain<br/>飞书入站 / 表达 / 控制"]
  end

  subgraph Cognition["认知管线"]
    Intel["intelligence<br/>store · 报告 · Decide · 信念 · 目标"]
    Evol["evolution<br/>claim · checkpoint · settlement · memory"]
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
  CLI --> Reactor
  CLI --> Channel
  CLI --> Viewer
  Reactor --> Cognition
  Reactor --> Exec
  Channel -->|channel-api 写 brief/fact| Intel
  Evol --> Intel
  Cognition --> AI
  Channel --> AI
  Exec --> AI
  Cognition --> Kernel
  Exec --> Kernel
  Reactor --> Kernel
  Channel --> Kernel
  Actions -->|receipt| Cognition
  Viewer -.->|只读 runtime| Kernel
```

要点：

- **Evolution Reactors** 负责「证据 → 报告 → 决策 → 执行 → 验证 → settlement → 记忆」。
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

## 3. Belief-driven async loop

```mermaid
flowchart LR
  A["EvidenceEnvelope<br/>claim batch"] --> B["cognitive reaction<br/>查证 + 报告 + belief-bound Decide"]
  B --> C["exec intent<br/>副作用前持久化"]
  C --> D["exec result + receipt"]
  D --> E["expected-output verify<br/>maker ≠ verifier"]
  E --> F["idempotent settlement<br/>belief + goal effects"]
  F --> G["Memory Reactor<br/>低频 consolidation"]
  F -.->|new evidence wake| A
```

### 3.1 Cognitive reaction

```mermaid
flowchart TB
  S0["机械 Seen 底板"] --> S1["只读查证 tool loop<br/>intel_query / beliefs / goals…"]
  S1 --> S2["宿主组装最终 Seen<br/>+ verified_facts"]
  S2 --> S3["模型写判断章节<br/>Inferred / Cyber-Taoist / 建议"]
  S3 --> S4["契约检查 + 有界修复"]
  S4 --> S5["splice Seen · 脱敏 · 落盘报告"]
  S5 --> S6["belief-bound Decide JSON<br/>全量入队 pending_decisions"]
```

### 3.2 Exec / verify

```mermaid
flowchart TB
  Q["pending_decisions 队列维护<br/>TTL / expire / queue_ops"] --> G["mechanical guards"]
  G --> A["通道 A：非 agent_run<br/>串行 · 无预算"]
  G --> B["通道 B：agent_run 波次<br/>预算 / 并行 / 重试→blocked"]
  A --> R["executed[] + receipts"]
  B --> R
  R --> I["写 exec intent/result<br/>传播 causal IDs"]
  I --> V["独立 verify<br/>expected vs observed"]
```

### 3.3 幂等 settlement 与目标自修正

```mermaid
flowchart LR
  Receipts["精确 action receipt refs<br/>+ verify report refs"] --> Settle["settlement_id<br/>claim + effect checkpoints"]
  Settle --> Stats["rule_feedback_stats"]
  Stats --> Assess["goal assess effect<br/>rule_status"]
  Assess -->|continue / learn| Keep["保持或学习"]
  Assess -->|mutate| Cal["goal calibrate effect<br/>应用 goal_patches"]
  Cal --> Goals["active_goals.json"]
  Keep --> Next["下一轮 Decide 读取新/旧目标"]
  Goals --> Next
  Settle -.-> Events["append-only belief/goal events<br/>权威事实"]
```

`settlements.json` 只是可重建协调 sidecar；带 `settlement_id` /
`settlement_effect` 的 append-only belief/goal events 才是权威事实。

---

## 4. Channel delivery（与 Evolution Reactors 平级）

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
  SP --> OB["redactSecrets → durable outbox<br/>成功后才推进 handled"]
  OB --> NT["notify flush → 飞书"]
```

Channel **不能**直接写 `pending_decisions` 或伪造 `approval_granted`；审批仍走 brief → 下一轮 Decide。

---

## 5. 跨模块数据契约（机制关节）

```mermaid
flowchart LR
  Evidence["EvidenceEnvelope"] -->|"producer_batch_id"| Decide["belief-bound Decide"]
  Decide -->|"decision_id"| Intent["exec intent"]
  Intent -->|"execution_id"| Exec["exec result + receipt"]
  Exec --> Verify["expected-output verify"]
  Verify -->|"exact refs"| Settle["idempotent settlement"]
  Settle --> Belief["belief events"]
  Settle --> Goals["goal events"]
  Belief --> Memory["Memory Reactor"]
  Goals --> Memory
  Channel["Channel classifier"] -->|"brief / fact pending"| Decide
  Daemon["Daemon"] -->|"wake + claim/checkpoint"| Decide
  Verify -.-> Closure["jea audit closure"]
  Settle -.-> Closure
  Memory -.-> Closure
```

| 契约文件 | 生产者 → 消费者 |
| --- | --- |
| `pending_decisions.json` | Decide → exec |
| batch claim / checkpoint | reactors 的 claim-ack 与 crash 恢复 |
| exec intent / result | 副作用前意图 → verify 独立认领 |
| action receipts | exec → verify / settlement |
| verify report comparison | expected output → settlement |
| belief / goal events | settlement → Memory Reactor（append-only authority） |
| operator briefs / facts | Channel 或 CLI → 下一次 cognitive reaction |
| channel inbound/outbox | Channel 内部 |

---

## 6. 操作者输入分层（治理机制）

```mermaid
flowchart TB
  subgraph Soft["软输入（引导，不当永久事实）"]
    Guidance["Guidance<br/>human_guidance.md"]
    Intent["Intent Brief<br/>下一次 reaction 意图"]
    Fact["Operator Fact<br/>一次种子 → settlement 消化"]
  end

  subgraph Hard["硬开关"]
    Approval["approval_granted<br/>Decide 产出 · exec preflight"]
    OffLimits["SUBJECT.md Off-Limits"]
  end

  Guidance --> P1["cognitive prompt"]
  Intent --> P1
  Fact --> Seen["升格 Seen 一轮"]
  Seen --> Dig["belief_update 消化"]
  P1 --> Dec["Decide"]
  Dec --> Approval
  Approval --> Exec["exec 放行/阻塞"]
  OffLimits --> Exec
```

---

## 7. 运行时落盘与 maintenance（按 Subject）

```text
<JEA_HOME>/subjects/<namespace>/
├── SUBJECT.md
└── data/
    ├── evolution/          # decisions · reactor claims/checkpoints/intents/results/settlements
    ├── intelligence/       # store · receipts · verify · beliefs · reports · standing memory
    ├── channel/            # inbound · outbox · channel tasks · events
    └── goals/              # active goals · goal-events
```

Daemon 以 claim/checkpoint/intent/result 的持久状态恢复 reactor。Channel 与
Evolution 使用独立 task queue / worker-state / 锁。heartbeat 默认每 24 小时
运行 runtime maintenance：先归档 terminal sidecar records，再压缩 hot state；
active claims/leases、uncertain intents 与主 append-only evidence 不清理。

---

## 8. 一张图记住主回路

```text
人类设定边界与意图
        │
        ▼
┌─ Channel delivery ─┐      ┌──────── Evolution Reactors ──────────┐
│ classifier/presence│─wake►│ evidence→report→decision→exec→verify │
│ speech/outbox      │◄proj─│ →settlement→Memory Reactor            │
└────────────────────┘      └───────────────────────────────────────┘
        │                              │
        └────────── Viewer / CLI 只读观测 ─┘
```

核心机制不是「固定 `/goal` 刷到绿」，而是：

1. **证据诚实**（宿主组装 Seen）
2. **行动可追因**（causal IDs + intent + receipt）
3. **验证有期望**（expected ≠ execution success）
4. **settlement 幂等**（精确 refs + append-only authority）
5. **记忆低频收敛**（Memory Reactor）
6. **人机边界清晰**（brief/fact ≠ approval_granted）
