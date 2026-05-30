# Cycle 启动请求与演化模式：把「tick 到了」和「该不该开轮」拆开

> 日期：2026-05-30  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现  
> 来源：Cursor Agent 对话（daemon 心跳分析 → 驱动模式讨论 → 最小增量方案 → 落地实现 → 热加载 / Viewer / CLI 切换）

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)
7. [附：问题—思考—方案—执行对照](#附问题思考方案执行对照)

（§4.5 Worker 热加载 · §4.6 Evolution Viewer 与 SSE）

---

## 1. 背景与动机

2026-05-30 同日，[`single-heartbeat-event-driven-steps.md`](./single-heartbeat-event-driven-steps.md) 已把 daemon 从「整轮 `run_cycle`」推进到 **step 级事件驱动**：5 分钟 tick 做 reconcile + 开新 cycle，step 完成即时 dispatch 下一步。

操作者在复盘 daemon 行为时提出一个更根本的问题：

**真正驱动 intel 的，是「时间到了」，还是「有事情要做」？**

当时实现里，tick 几乎等价于「尝试开一轮」：`runHeartbeatTick` → `startCycleFromTick` → 前提满足即 `cycle_due` → enqueue `intel`。Step 链内部已是事件因果（`intel_ready` → `exec` → …），但 **cycle 的诞生仍绑在节律 tick 上**。

这与项目其它层的语义并不同构：

- **Operator Intent Brief** 表达的是「下一轮请这样排优先级」，不是「每 5 分钟请 orient 一遍」。
- **`ai-researcher`** 等调研型主体更适合按需演化，而非持续空转 intel。
- **`pending_decisions`** 积压意味着「该 exec」，不一定意味着「该重新 intel」。

因此需要在 **不大改 reducer / step 链** 的前提下，增加「何时值得尝试开 cycle」的可配置策略，并把 tick 从「开轮指令」降级为「节律 + 补偿 +（可选）自动入队」。

---

## 2. 分析过程

### 2.1 现有机制实际在优化什么

| 层 | 行为 | 本质 |
| --- | --- | --- |
| **开新轮**（`startCycleFromTick`） | 无 open cycle、无 pending task → 开 cycle | 节律驱动的空轮探测 |
| **漏步补偿**（`reconcileOpenCycles`） | 按 cycle-state 补 enqueue 缺失 step | 状态机与队列的一致性修复 |

Reconcile 是工程自愈，不负责回答「该不该演化」。Health 里的 `evolution_stalled` 也默认「超过 tick 窗口没开新轮 = 不健康」，强化了持续进化假设。

### 2.2 对话中的方案演进

1. **第一轮分析**：梳理 tick → `cycle_due` → intel 的完整链路；区分「5min 节律 tick」与「任务租约 heartbeat」。
2. **驱动模式讨论**：项目里已有 brief、ingest、decisions 队列、审批流等多种「意图/证据」入口，但 **未接到 cycle 诞生逻辑**；tick 应作兜底，不应是唯一主驱动力。
3. **最小增量**：不重构 reducer，只加「信号检测 + 空闲时复用开轮流程」——brief 入列后 worker idle 即可消费。
4. **最终收敛**：用户明确两种模式——
   - **持续进化**（`continuous`）：tick 到点 → **产生** cycle 启动请求 → 前提检查 → 开轮。
   - **按需进化**（`on_demand`）：tick 到点 → **只消费**已有请求，不产生 tick 请求；请求由 brief / CLI 等入列。

### 2.3 关键约束（落地时保留）

- 单 subject 串行：open cycle 或 pending task 时不开新轮（现有 `shouldStartCycleFromTick` 守卫不变）。
- Reconcile 与演化模式无关，始终执行。
- `jea run` / `run_cycle` 旁路不变，不经过请求队列。
- 默认 **`continuous`**，与改造前行为兼容。

---

## 3. 方案设计

### 3.1 核心模型：请求队列 + 统一消费

```mermaid
flowchart TD
  subgraph producers [入列来源]
    TickContinuous["tick continuous 模式"]
    BriefHook["intel brief put"]
    CLI["jea daemon cycle request"]
  end

  subgraph queue [持久队列]
    CSR["cycle-start-requests.json"]
  end

  subgraph consumer [消费 共用]
    Process["processCycleStartRequests"]
    Guards["shouldStartCycle guards"]
    Start["createCycle + cycle_due"]
  end

  TickContinuous -->|"enqueue reason=tick"| CSR
  BriefHook -->|"enqueue reason=operator_brief"| CSR
  CLI -->|"enqueue reason=manual"| CSR

  TickAny["tick 任意模式"] --> Process
  Idle["worker idle"] --> Process
  CSR --> Process
  Process --> Guards
  Guards -->|pass| Start
  Guards -->|block| CSR
```

| 模式 | tick 行为 | 默认 |
| --- | --- | --- |
| `continuous` | reconcile → **入队** `reason=tick` → **尝试消费** | 是 |
| `on_demand` | reconcile → **仅尝试消费** | 否 |

**不变**：[`cycle-reducer.mjs`](../../src/cli/utils/cycle-reducer.mjs)、[`run.mjs`](../../run.mjs)、各 step 执行器、reconcile 漏步补偿语义。

### 3.2 三层职责划分

```text
策略层：该不该演化、开哪种轮次（continuous / on_demand + 入列来源）
调度层：reducer + dispatch（已有）
可靠性层：reconcile + 租约（已有，漏步补偿留在这里）
```

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 请求持久化 | 单文件 `cycle-start-requests.json`，每 subject 最多 1 条 pending | 简单、可审计；合并 reasons 避免 tick 风暴堆叠 |
| 与 `pending_tasks` 分离 | 独立队列 | 「想开轮」≠「step 任务」；职责清晰 |
| 消费时机 | tick + worker idle | on_demand 下 brief 入列不必等 5 分钟 |
| 阻塞时请求 | 保留 pending，记 `cycle_start_deferred` | open cycle / pending task 时不丢意图 |
| 模式解析优先级 | subjects.json > CLI > env > 默认 continuous | 主体可差异化；默认向后兼容 |
| brief 入列位置 | [`intel-briefs.mjs`](../../src/cli/commands/intel-briefs.mjs) 而非 intelligence 层 | 避免 intelligence → cli 反向依赖 |
| P2 暂缓 | inbox 扫描、pending_decisions 触发、drop-in 文件 | 控制改动面；首版覆盖 brief + CLI + tick |

---

## 4. 实现要点

### 4.1 运行时结构

```text
runtime/subjects/<ns>/data/evolution/
├── cycle-start-requests.json      # pending + history
├── cycle-start-requests.lock
├── tasks/pending_tasks.json       # step 任务（不变）
└── cycle-state/<cycleId>.json
```

pending 请求结构示例：

```json
{
  "pending": {
    "request_id": "...",
    "reasons": ["tick", "operator_brief"],
    "created_at": "...",
    "updated_at": "...",
    "meta": { "brief_ids": ["brief-abc"] }
  },
  "history": []
}
```

### 4.2 关键模块

| 文件 | 职责 |
| --- | --- |
| [`cycle-start-requests.mjs`](../../src/cli/utils/cycle-start-requests.mjs) | enqueue / read / consume / defer；锁 + 原子写 |
| [`evolution-mode.mjs`](../../src/cli/utils/evolution-mode.mjs) | `continuous` \| `on_demand` 解析 |
| [`cycle-dispatch.mjs`](../../src/cli/utils/cycle-dispatch.mjs) | `processCycleStartRequests`、`startCycleFromRequest`、`runHeartbeatTick` 分模式入队/消费 |
| [`daemon.mjs`](../../src/cli/commands/daemon.mjs) | idle 消费、`jea daemon cycle request`、`--evolution-mode` |
| [`intel-briefs.mjs`](../../src/cli/commands/intel-briefs.mjs) | `brief put` 后入队 `operator_brief` |
| [`daemon-projection.mjs`](../../src/cli/utils/daemon-projection.mjs) | `evolution_mode`、pending 请求摘要；on_demand 下调整 stall 判定 |
| [`evolution-mode-apply.mjs`](../../src/cli/utils/evolution-mode-apply.mjs) | CLI 写 `subjects.json` + 事件 + worker-state + `current-state` 投影 |
| [`viewer-api.mjs`](../../src/intelligence/evolution-viewer/viewer-api.mjs) | 监听 `subjects.json` / `current-state.json`；`/api/daemon` no-store |
| [`tools/evolution-viewer/public/app.js`](../../tools/evolution-viewer/public/app.js) | daemon 栏模式 chip、SSE 即时 patch、`live-state.js` fingerprint |

### 4.3 数据流

**`runHeartbeatTick`（改造后）**

```text
1. record daemon_tick
2. reconcileOpenCycles（不变）
3. if evolution_mode === continuous:
     enqueueCycleStartRequest(reason=tick)
4. processCycleStartRequests()
```

**`processCycleStartRequests`**

```text
读 pending → shouldStartCycleFromTick 守卫
  → 通过：startCycleFromRequest（写入 trigger meta）→ consume → cycle_start_consumed
  → 阻塞：defer → cycle_start_deferred（同 blocked_reason debounce）
```

**Worker 主循环**

- tick 窗口：`safeRunHeartbeatTick`（含 reconcile + 模式相关入队 + process）
- `workOnce` idle：`safeProcessCycleStartRequests`（仅 process，不入队 tick）
- **每轮 loop 重读 `subjects.json`**（`refreshWorkerEvolutionMode`）：模式变更写 `evolution_mode_changed` 并更新 `worker-state`；**长 step 执行期间**（`workOnce` 阻塞）热加载会延迟到该 step 结束

### 4.4 配置与命令

| 入口 | 说明 |
| --- | --- |
| `JEA_EVOLUTION_MODE=continuous\|on_demand` | 全局 env（见 [`.env.example`](../../.env.example)） |
| `jea daemon start --evolution-mode on_demand` | CLI 覆盖 env（**需 restart worker** 才生效） |
| `subjects.json` → `evolution.mode` | per-subject 覆盖（见 [`subjects.example.json`](../../policies/subjects.example.json)）；**worker 运行中热加载** |
| `jea daemon evolution-mode show [--json]` | 查看当前 subject 模式与来源 |
| `jea daemon evolution-mode set continuous\|on_demand [--json]` | 写 `subjects.json`、emit `evolution_mode_changed`、更新 worker-state / `current-state.json` |
| `jea daemon cycle request [--reason TEXT]` | 显式入队 |
| `jea intel brief put` | 自动入队 `operator_brief` |

审计事件（`evolution-events.jsonl`）：`cycle_start_requested`、`cycle_start_deferred`、`cycle_start_consumed`、**`evolution_mode_changed`**；`cycle_due` 增加 `trigger` / `trigger_reasons`。

### 4.5 Worker 热加载（subjects.json）

| 配置来源 | worker 运行中变更 | 说明 |
| --- | --- | --- |
| `policies/subjects.json` → `evolution.mode` | **是** | 下一轮 worker loop 重 `resolveEvolutionMode`；变更时 `recordDaemonEvent(evolution_mode_changed)` + `updateWorkerHeartbeat` |
| `.env` → `JEA_EVOLUTION_MODE` | **否** | 进程启动时读 env，需 `daemon stop` + `start` |
| `daemon start --evolution-mode` | **否** | 同上 |

注意：热加载发生在 **loop 迭代开头**。若当前正在跑长耗时 step（如 intel/exec），模式切换会等到 `workOnce` 返回后才生效；操作者可用 `jea daemon evolution-mode set` 立即落盘并推 SSE，或 restart worker 立即对齐。

### 4.6 Evolution Viewer 与 SSE

**问题**：`buildDaemonProjection` 已输出 `evolution_mode`，但旧 viewer 进程 API 无该字段时，前端 fallback 为 `continuous`，造成「配置已是 on_demand、界面仍显示持续」。

**实现**：

| 层 | 行为 |
| --- | --- |
| **Daemon 栏** | chip：`模式: 持续`（紫）/ `按需`（黄）；来源 tooltip；pending 开轮请求 chip |
| **`/api/daemon`** | `Cache-Control: no-store`；每次 projection 重读 `subjects.json` |
| **文件 watch** | `worker-state.json`、`current-state.json`、**`policies/subjects.json`** → SSE `runtime_updated` → 客户端 debounce 拉 daemon |
| **SSE 事件** | `evolution_mode_changed` 携带 `from` / `to` / `source`；客户端 **即时 patch** daemon 栏 + 事件流文案「持续 → 按需」 |
| **fingerprint** | `daemonBarFingerprint` 含 `evolution_mode`、pending 请求，避免无变化时漏重绘 |

**操作注意**：`jea intel viewer serve` 更新代码后需 **重启 viewer 进程**（不必 build）；离线 `dist/` 需 `jea intel viewer build` 后再重启静态服务。

---

## 5. 验证与测试

| 项 | 命令 / 文件 | 结果 |
| --- | --- | --- |
| 请求队列单测 | `test/cycle-start-requests.test.mjs` | enqueue 合并、consume、defer、continuous/on_demand tick、open cycle 阻塞保留请求 |
| 演化模式解析 | `test/evolution-mode.test.mjs` | 默认 continuous、subject/env/CLI 优先级、`setSubjectEvolutionMode`、`applyEvolutionModeChange` |
| 热加载 | `test/evolution-mode-hot-reload.test.mjs` | 改 subjects.json 后 resolve / tick 行为变化 |
| Viewer live-state | `test/evolution-viewer-live-state.test.mjs` | mode / pending 请求 fingerprint |
| Viewer API / SSE | `test/evolution-viewer-live.test.mjs` | `/api/daemon` 含 `evolution_mode`；`formatDaemonEventForApi` 含 transition 字段 |
| dispatch 回归 | `test/cycle-state-dispatch.test.mjs` | 通过 |
| 全量 | `npm test` | **418/418** 通过（含 Viewer / CLI 模式切换增补） |

**本地冒烟（`ai-researcher`）**

```bash
# 查看 / 切换模式（推荐操作入口）
npm run jea -- daemon evolution-mode show
npm run jea -- daemon evolution-mode set on_demand
npm run jea -- daemon evolution-mode set continuous

# 按需模式 + 显式开轮
npm run jea -- daemon cycle request

# Viewer（改代码后 restart serve）
npm run jea -- intel viewer serve --open
# 另开终端切换模式，浏览器 daemon 栏应 SSE 更新；事件流见 evolution_mode_changed
curl -s http://127.0.0.1:4173/api/daemon | jq '.evolution_mode, .evolution_mode_source'
```

**2026-05-30 联调记录**：`subjects.json` 改 `on_demand` 后 `daemon status` 立即正确；旧 viewer 进程（4173）API 无 `evolution_mode` 字段时 UI 误显持续——重启 viewer 后修复。`jea daemon evolution-mode set` 切换 continuous ↔ on_demand，API 与 `evolution-events.jsonl` 一致。

---

## 6. 后续演化

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| P2 | `_inbox` 非空 → 入队 | 外部证据到达时唤醒，仍走同一请求队列 |
| P2 | `cycle-request.json` drop-in | 脚本/自动化友好入口 |
| P2 | `pending_decisions` 触发策略 | 需区分 exec-only 续链 vs 完整 intel，避免重复 Decide |
| P3 | 请求 TTL / 过期审计 | 长期 deferred 除 `cycle_start_blocked` 外可主动 expire |
| ~~P3~~ | ~~Viewer 展示 pending 请求与 `evolution_mode`~~ | **已完成**（daemon 栏 + SSE + `jea daemon evolution-mode`） |
| P3 | loop 内长 step 期间更快热加载 | 可选：租约续期路径或 step 边界 re-read mode，减少「改了 subjects.json 但要等 intel 跑完」的延迟 |

与 [`single-heartbeat-event-driven-steps.md`](./single-heartbeat-event-driven-steps.md) 的关系：该 journal 解决 **step 链内** 的事件驱动；本篇解决 **cycle 诞生** 的策略层，二者叠加后 tick 角色更清晰——**兜底 + reconcile +（可选）自动入队**，而非唯一的演化意图来源。

---

## 附：问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| **问题** | Daemon tick 直接开 cycle，与 brief/按需主体语义冲突；「漏步补偿」与「该不该演化」混在一起。 |
| **思考** | 开轮与 step 推进应分层；tick 不应等于开轮指令；项目已有多种入列来源但未接到 cycle 诞生；改动应限于请求队列 + 消费，不动 reducer。 |
| **方案** | `cycle-start-requests.json` + `continuous`/`on_demand`；tick 在 continuous 下入队 `tick` 请求；统一 `processCycleStartRequests`；idle 快速消费；brief/CLI 入列。 |
| **执行** | 新增 `cycle-start-requests.mjs`、`evolution-mode.mjs`、`evolution-mode-apply.mjs`；改 `cycle-dispatch`、`daemon`、`daemon-projection`、`intel-briefs`、Viewer（`app.js` / `live-state.js` / `viewer-api.mjs` / `daemon-sse.mjs`）；`jea daemon evolution-mode show\|set`；热加载 + SSE；更新 `AGENTS.md` / `.env.example` / `subjects.example.json`；测试 418 通过。 |
