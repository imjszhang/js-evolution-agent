# 单一心跳 + 分步事件驱动：从整轮同步链到 step 级调度

> 日期：2026-05-30  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现  
> 来源：Cursor Agent 对话（设计 → 实施 → 审查）  

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [已知差距与风险](#6-已知差距与风险)
7. [后续演化](#7-后续演化)

---

## 1. 背景与动机

2026-05-18 已落地 [`jea daemon`](../../src/cli/commands/daemon.mjs) 任务队列与 `run_cycle` worker，把「整轮演化」从一次性 CLI 进程里拆出来，交给可租约、可重试的后台调度。但 **daemon 的 loop 仍是忙轮询 dispatcher**（`interval-ms` / `idle-interval-ms` 拉队列），**调度的最小单位仍是整轮** [`run.mjs`](../../run.mjs) Phase 1→5 同步链。

操作者提出第二阶段架构升级：

- **只保留一个核心心跳 loop**，固定每 **5 分钟** 执行一次；
- 工作流里其它步骤改成 **异步、事件驱动** 的 step，不再绑在同一条同步调用栈上。

真正的问题不是「有没有 daemon」，而是 **推进力与因果链仍写在 `runCycle` 的代码顺序里**。要把演化系统做成可持续后台运转的形态，需要把 **「代码顺序粘连」换成「事件因果粘连」**，并把 worker 从「执行整轮」降级为「执行一个 step」。

**同日进展**：先产出设计 journal，随后按渐进式五小步完成首版落地；审查确认基础设施可用，但 step 逐步路径尚不能完整替代整轮 `run.mjs`。

---

## 2. 分析过程

### 2.1 耦合点（设计时 vs 落地后）

| 部位 | 设计时现状 | 落地后 |
| --- | --- | --- |
| [`run.mjs`](../../run.mjs) | Phase 1→5 同步链 | 整轮路径保留；支持 `JEA_CYCLE_STEP` + `JEA_CYCLE_ID` 单 step 入口；Phase 逻辑抽到 [`cycle-steps.mjs`](../../src/evolution/cycle-steps.mjs) |
| [`daemon.mjs#runDaemonWorker`](../../src/cli/commands/daemon.mjs) | 忙轮询 + 整轮 `run_cycle` | 默认 **5min tick**（`--tick-ms`）+ reconcile；step 完成 **即时 dispatch**；`run_cycle` 兼容保留 |
| [`daemon-tasks.mjs`](../../src/cli/utils/daemon-tasks.mjs) | 仅 `run_cycle` | 扩展 8 种 step type；`idempotency_key = subject:cycleId:step`；同 cycle step 顺序约束 |
| 阶段间数据 | 磁盘副作用 + 代码顺序 | 新增 `cycle-state/<cycleId>.json` + reducer 显式 guard |
| [`jea evolve`](../../src/cli/commands/evolve.mjs) | manifest 轮级断点 | **未改**；与 cycle-state **分层并存** |

[`journal/2026-05-18/jea-daemon-event-driven-foundation.md`](../2026-05-18/jea-daemon-event-driven-foundation.md) 第一版不拆 Phase；本次是在其上的 **第二阶段首版实现**。

### 2.2 关键发现（设计阶段，仍成立）

1. 心跳与业务推进不应混在同一 busy loop。
2. 失败 / skip 语义须从 `run.mjs` if 分支迁入 reducer。
3. 单 subject 串行不变量不能丢（subject lock + 未关闭 cycle 不开新轮）。
4. 事件总线不必上 MQ：复用 `evolution-events.jsonl` + `pending_tasks.json` + 租约即可。

### 2.3 已确认决策

| 决策 | 选择 | 状态 |
| --- | --- | --- |
| 心跳角色 | **兜底力**：step 完成即时推进；5min tick 做 reconcile + 开新 cycle | ✅ 已落地 |
| 迁移节奏 | 渐进式五小步，每步可回滚 | ✅ 已按此执行 |
| `exec_failed` 下游 | skip belief/goals，仍 enqueue `diary` | ✅ reducer 已实现；逐步路径 artifact 尚弱 |
| evolve manifest vs cycle-state | **分层**（轮 vs step），尚未打通 | ⏳ 待做 |

---

## 3. 方案设计

### 3.1 三层划分（已落地）

```mermaid
flowchart TD
  subgraph heartbeat [心跳层 - 5min tick]
    Tick[daemon_tick / cycle_due]
    Reconcile[reconcileOpenCycles]
  end

  subgraph scheduler [调度层]
    Reducer[nextSteps + reconcileCycle]
    CycleState["cycle-state/cycleId.json"]
    Dispatch[cycle-dispatch.mjs]
  end

  subgraph executor [执行层]
    Worker[workOnce / workRunCycleStep]
    RunStep[runSingleStep → run.mjs]
    RunCycle[workRunCycle → runSingleCycle]
  end

  Tick --> Dispatch
  Dispatch --> Reducer
  CycleState --> Reducer
  Reducer --> Worker
  Worker --> RunStep
  Worker --> RunCycle
  RunStep --> Dispatch
  Reconcile --> Reducer
```

### 3.2 Phase → step 映射

| 现状 Phase | step 类型 | 触发 | 完成事件 |
| --- | --- | --- | --- |
| 节律 | — | `tick` | `cycle_due` |
| Phase 1 | `intel` | `cycle_due` | `intel_ready` |
| Phase 1.5 | `intel_report` | `intel_ready` | `report_ready` |
| Phase 2 | `exec` | `intel_ready`（reducer：decisions>0 才 enqueue） | `exec_done` / `exec_failed` |
| Phase 3 | `verify` | `exec_done` / `exec_skipped` | `verify_done` |
| Phase 3.5 | `belief_update` | `verify_done` | `beliefs_*` |
| Phase 4 / 4.5 | `goals_assess` / `goals_calibrate` | `verify_done` + report 就绪 | `goals_*` |
| Phase 5 | `diary` | 关键 step 收敛 | `cycle_closed` |

**实现注记**：daemon 的 `intel` step 子进程内 **合并执行** `intel_report`（与 ConversationalIntelPipeline 一体），reducer 仍保留独立 `intel_report` step 以兼容分步调度；若 state 已为 `done` 则不会重复 enqueue。

### 3.3 正确性约束（落地情况）

| 约束 | 做法 | 状态 |
| --- | --- | --- |
| 幂等 | `subject:cycleId:stepType` | ✅ |
| 恰好推进一次 | reducer 读 cycle-state 再 enqueue | ✅ |
| 单 subject 串行 | open cycle + pending 任务时不开新 cycle；subject lock | ✅ |
| 崩溃恢复 | reconcile + 租约回收 | ✅ 基础路径 |
| 长任务 | step 内 watchdog 续租（沿用 `workRunCycle` 模式） | ✅ |

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 因果模型 | 事件 + reducer | 可测试、可恢复 |
| 心跳职责 | tick + reconcile；业务以 step 完成 dispatch 为主 | 5min 纯轮询过慢 |
| 任务队列 | 扩展 `pending_tasks.json`，不复用 `pending_decisions.json` | 与 2026-05-18 奠基一致 |
| 兼容 | 保留 `run_cycle` | 可回滚、可对比 |
| 双路径 | `jea run` 整轮 + daemon step 逐步 | 渐进迁移，降低一刀切风险 |

---

## 4. 实现要点

### 4.1 运行时结构

```text
runtime/subjects/<ns>/data/evolution/
├── tasks/pending_tasks.json       # type: intel | exec | ... | run_cycle
├── cycle-state/<cycleId>.json     # per-cycle step 状态机
├── views/current-state.json       # 含 cycles / step_tasks 投影
└── ...

src/
├── cli/utils/cycle-reducer.mjs    # nextSteps, reconcileCycle, stepIdempotencyKey
├── cli/utils/cycle-state.mjs      # 读写 cycle-state，markStepStatus
├── cli/utils/cycle-dispatch.mjs   # dispatchCycleEvent, runHeartbeatTick, startCycleFromTick
├── cli/commands/daemon.mjs        # workRunCycleStep, 5min tick loop
├── cli/commands/evolve.mjs        # runSingleStep, parseStepResult
├── evolution/cycle-steps.mjs    # Phase 执行器（整轮与单 step 共用）
└── run.mjs                        # JEA_CYCLE_STEP 入口 + 整轮 runCycle
```

### 4.2 关键模块

| 文件 | 职责 |
| --- | --- |
| [`cycle-reducer.mjs`](../../src/cli/utils/cycle-reducer.mjs) | 纯函数 reducer；单测覆盖 skip/fail guard |
| [`cycle-state.mjs`](../../src/cli/utils/cycle-state.mjs) | lockfile + 原子写；`open` / `closed` cycle |
| [`cycle-dispatch.mjs`](../../src/cli/utils/cycle-dispatch.mjs) | 事件 → reducer → 条件 enqueue；心跳 tick |
| [`cycle-steps.mjs`](../../src/evolution/cycle-steps.mjs) | `runIntelStep` … `runDiaryStep`；旁路写 cycle-state |
| [`daemon.mjs`](../../src/cli/commands/daemon.mjs) | `runDaemonWorker`：`runHeartbeatTick` + `workOnce`；step / `run_cycle` 分派 |
| [`daemon-tasks.mjs`](../../src/cli/utils/daemon-tasks.mjs) | step 顺序 claim；step 幂等键 |
| [`daemon-projection.mjs`](../../src/cli/utils/daemon-projection.mjs) | `cycles`、`tasks.step_tasks` |
| [`run.mjs`](../../run.mjs) | `JEA_CYCLE_STEP` / `JEA_CYCLE_ID`；整轮 `runCycle` 仍可用 |

### 4.3 数据流（daemon step 模式）

```text
runHeartbeatTick
  → reconcileOpenCycles（补缺失 enqueue）
  → startCycleFromTick（无 open cycle 且无 pending 时）
  → cycle_due → enqueue intel

workOnce → workRunCycleStep
  → runSingleStep(step, cycleId)
  → dispatchAfterStepCompletion → nextSteps → enqueue 下一步（即时）

每 5min tick 兜底；有 pending 任务时不自动开新 cycle（避免抢占 run_cycle）。
```

### 4.4 操作入口

```bash
# step 化 daemon（默认 5min tick + 即时推进）
jea daemon start

# 可调 tick 间隔（毫秒）
jea daemon start --tick-ms 300000

# 兼容整轮
jea daemon enqueue --type run_cycle
jea run --mock

# 查看 step / cycle 投影
jea daemon status --json
```

---

## 5. 验证与测试

### 5.1 已执行

| 项 | 命令 / 文件 | 结果 |
| --- | --- | --- |
| reducer 单测 | [`test/cycle-reducer.test.mjs`](../../test/cycle-reducer.test.mjs) | ✅ 通过 |
| cycle-state + dispatch | [`test/cycle-state-dispatch.test.mjs`](../../test/cycle-state-dispatch.test.mjs) | ✅ 通过 |
| daemon 回归 | [`test/cli.test.mjs`](../../test/cli.test.mjs) daemon 段 | ✅ 130/130（含 tick 与 run_cycle 共存） |
| 全量 | `npm test` | **349/352**；失败 3 个在 `actions.test.mjs` lane worktree git，**与本次无关** |

### 5.2 尚未自动化

| 项 | 说明 |
| --- | --- |
| `jea run --mock` vs daemon step 事件序列对比 | 未做集成对比测试 |
| mock 端到端单 step worker | 未覆盖 |
| 杀 worker mid-step → reconcile 恢复 | 未自动化 |
| evolve + daemon 并发 | 依赖既有 subject lock，无新增用例 |

---

## 6. 已知差距与风险

审查结论：**基础设施层已按计划落地，step 逐步路径尚不能完整替代整轮 `run.mjs`。**

### 6.1 与同步链的语义偏差

| 点 | 原 `run.mjs` | 当前 reducer / step 路径 |
| --- | --- | --- |
| `decisions_queued = 0` | 仍跑 exec（空队列） | 标记 `exec` **skipped**，并可能 enqueue `verify`（`exec_skipped`） |
| `exec_failed` | throw，中断后续 | skip belief/goals，enqueue `diary` ✅ |

无决策时跳过 exec 与旧行为不一致，可能导致 verify 缺少 receipt——**P0 待修**。

### 6.2 单 step 子进程 artifact 不完整

[`run.mjs#runSingleStepMode`](../../run.mjs) 中 verify 及之后 step 使用占位 `intelResult` / `execResult`（如 `executed: []`），未从磁盘加载完整产物：

- `verify` 可能空跑
- `goals_calibrate` 固定 `goalsAssessResult: null`，单独跑此 step 永远 skip
- `diary` 缺少 rich context

**整轮 `jea run` / `run_cycle` 仍更可靠**；daemon step 模式适合 intel→exec 前半链或后续补 checkpoint 后扩展。

### 6.3 未完成项（计划步骤 5 残余）

- evolve manifest 与 cycle-state **未打通**
- [`AGENTS.md`](../../AGENTS.md) 未补充 `--tick-ms`、step type、`cycle-state/` 说明
- evolution viewer 未做 step 级 UI

### 6.4 双路径并存

| 路径 | 适用 |
| --- | --- |
| `jea run` / `run_cycle` | 生产整轮演化 |
| `daemon start` step 模式 | 后台节律 + 逐步推进（首版） |

同时 enqueue `run_cycle` 与 step 时按 priority 竞争（step priority 更高）。

---

## 7. 后续演化

### 7.1 优先级

| 优先级 | 项 |
| --- | --- |
| **P0** | `decisions_queued=0` 时仍 enqueue exec（或显式 skip verify），与 `run.mjs` 对齐 |
| **P0** | step 模式增加 checkpoint / 从磁盘加载 intel、exec、assess 产物，修复 verify→diary 链 |
| **P1** | `goals_calibrate` 从 cycle-state 或磁盘读 assess 结果 |
| **P1** | 补 `jea run --mock` vs daemon step 事件序列对比测试 |
| **P2** | 更新 AGENTS.md；evolve manifest 增加可选 `cycle_id`；viewer step 级展示 |

### 7.2 机制化改进

- viewer / `daemon inbox` step 级时间线与卡住告警
- 与 [beliefs-driven loop](../2026-05-28/beliefs-driven-evolution-loop.md) 对齐：belief_update 仍在 verify 之后
- 长跑 `agent_run` 与 5min reconcile 窗口：首版保留 step 内 watchdog

---

## 附：问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 如何只保留 5min 心跳，并把 Phase 1→5 改为事件驱动 step？ |
| 思考 | 瓶颈在同步链与整轮 `run_cycle`；复用队列/租约/事件流；需 cycle-state + reducer；心跳作兜底非唯一推进力。 |
| 方案 | 三层架构；混合推进；渐进五小步；保留 `run_cycle` 兼容。 |
| 执行 | 落地 `cycle-reducer` / `cycle-state` / `cycle-dispatch` / `cycle-steps`；daemon 5min tick + step worker；`run.mjs` 单 step 入口；投影扩展；单测 + daemon 回归通过；审查记录语义偏差与 artifact 缺口。 |
