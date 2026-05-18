# 多轮进化运行器：从手动循环到可恢复、可调度的一轮调度

> 日期：2026-05-18  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现  
> 来源：Cursor Agent 对话  

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)

---

## 1. 背景与动机

需要执行大量「单轮进化」（intel → exec → verify → goals assess → diary）。当时做法是用 PowerShell 连续调用 `npm run jea -- run` 多次。

**实际结果：** 第 17 轮在 Phase 1 情报管线失败，错误为 **DeepSeek returned empty content**，进程以 **exit code 1** 退出，**后续轮次未执行**；前面约 16 轮已完整跑完。说明仅靠外层的 shell 循环，既不能自动重试瞬时故障，也没有可恢复的进度账本。

因此希望升级系统：**连续多轮、失败可重试、中断可断点续传**，并预留**多主体串行轮转**能力，而不是把复杂度塞进根目录 `run.mjs`。

---

## 2. 分析过程

**现状梳理**

- `jea run` → [`src/cli/commands/run.mjs`](../../src/cli/commands/run.mjs) → 子进程执行根目录 [`run.mjs`](../../run.mjs)，单轮是一个线性脚本，阶段之间靠局部变量串联，**未导出可组合的 API**。
- 活跃主体由 [`policies/active-subject.json`](../../policies/active-subject.json) 决定，解析逻辑在 [`src/cli/utils/subjects.mjs`](../../src/cli/utils/subjects.mjs)。
- 决策队列已有 [`src/intelligence/decision-queue.mjs`](../../src/intelligence/decision-queue.mjs) 的文件锁，但**没有**「批量进化 run」的全局状态文件。

**约束与取舍**

- 第一版不拆 `run.mjs` 的 Phase，避免 decision queue / verify / receipts 的副作用在「半轮恢复」上失控；**断点粒度定为「整轮」**。
- 多主体若每次改 `active-subject.json`，会污染操作者工作区；更合理的是 **进程内临时指定主体**（环境变量），子进程继承即可。
- 失败分类做不到完美：采用 **启发式关键词**（空返回、超时、429/5xx、ECONNRESET 等判为可重试；缺 key、策略缺失等判为不可重试），并允许后续收紧规则。

---

## 3. 方案设计

在 CLI 之上增加一层 **Evolution Supervisor**：manifest 持久化 + 每轮 spawn 一次现有 `run.mjs`。

```mermaid
flowchart TD
  User[User CLI] --> EvolveCommand[jea evolve]
  EvolveCommand --> RunManager[EvolutionRunManager]
  RunManager --> Manifest[Run Manifest JSON]
  RunManager --> Scheduler[SubjectScheduler]
  Scheduler --> SubjectLock[Subject Lock]
  SubjectLock --> SingleCycle[SingleCycleRunner]
  SingleCycle --> RunMjs[run.mjs Phase1to5]
```

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| 单轮实现方式 | 子进程执行 `run.mjs` | 零侵入拆分 Phase，尽快可用 |
| 断点粒度 | 轮级 | Phase 级需严格幂等与恢复契约 |
| 多主体指定 | `JEA_SUBJECT` 覆盖读取 | 不改磁盘上的 active subject |
| 并发 | 第一版串行 + 每主体文件锁 | 避免 API 限流与队列竞态 |
| 多主体轮转 | A1→B1→C1→A2… | 每轮每个主体各推进「一格」到目标 `N` 轮 |

---

## 4. 实现要点

### 新增 CLI

- **`jea evolve --rounds N`**：启动批量 run，生成 `run_id`，写入 manifest。
- **`jea evolve --rounds N --subject NAME` / `--subjects a,b,c`**：多主体时每个主体内各写一份 manifest（同名 `run_id`），轮转执行。
- **`jea evolve resume <run_id>`**：按 manifest 跳过已成功轮次，从未完成轮继续；可重试错误在 `--retries` 内退避重试。
- **`jea evolve status [run_id]`**：列出近期 run 或单个 run 的汇总（支持 `--json`）。

入口注册：[`src/cli/jea.mjs`](../../src/cli/jea.mjs)。命令实现：[`src/cli/commands/evolve.mjs`](../../src/cli/commands/evolve.mjs)。

### 状态落盘

- 路径：`runtime/subjects/<namespace>/data/evolution/runs/<run_id>.json`
- 工具：[`src/cli/utils/evolve-runs.mjs`](../../src/cli/utils/evolve-runs.mjs)

### 临时主体

- [`src/cli/utils/subjects.mjs`](../../src/cli/utils/subjects.mjs)：`readActiveSubject` 在存在 **`JEA_SUBJECT`** 时返回该主体的默认 policy 布局（不写回 `active-subject.json`）。子进程跑 `run.mjs` 时由 evolve 注入该环境变量。

### 主体锁

- `runtime/subjects/<namespace>/data/evolution/.evolve.lock`（`proper-lockfile`），防止同一主体上并发 evolve。

### 可调参数（与实现一致）

| 标志 | 含义 |
| ---- | ---- |
| `--rounds N` | 每主体目标轮数 |
| `--retries N` | 每轮额外重试次数（默认 3，即最多 1 + 3 次尝试） |
| `--retry-delay-ms` | 可重试失败后的等待（默认 30000） |
| `--continue-on-failure` | 某主体失败后仍继续其他主体/轮次 |
| `--mock` / `--deepseek` / `--skip-goals-assess` | 与 `jea run` 语义对齐，通过子进程环境传递 |

---

## 5. 验证与测试

- **单元测试**：[`test/cli.test.mjs`](../../test/cli.test.mjs) 中新增 `evolve run manifests` 用例：manifest 创建/查找/汇总、`JEA_SUBJECT` 下 runtime 与磁盘 active 分离、失败分类（空内容 vs 缺 key）。
- **建议命令**
  - `npm run jea -- evolve --rounds 5 --subject agentank-tank`
  - `npm run jea -- evolve status`
  - `npm run jea -- evolve resume <run_id>`
  - `node --preserve-symlinks ./node_modules/vitest/vitest.mjs run test/cli.test.mjs`

**说明：** 全量 `npm test` 在其它用例上可能存在与当前工作区 agentank 配置相关的既有断言差异；与本轮 evolve 功能相关的 CLI 测试应单独跑上述文件验证。

---

## 6. 后续演化

| 方向 | 说明 |
| ---- | ---- |
| Phase 级断点 | 需把 `run.mjs` 拆成可幂等调用的模块，并定义每 Phase 的输入/输出契约 |
| `--concurrency N` | 跨主体并发 + 更强的锁与 API 配额策略 |
| 失败分类 | 结合 HTTP 状态码、引擎错误码结构化分类，减少误判 |
| 与 shell 循环的关系 | 旧方式仍可应急；长期操作推荐统一用 `jea evolve` 留下可恢复账本 |

---

## 附：与「30 轮手动跑」的对比

| 维度 | PowerShell 连续 `jea run` | `jea evolve` |
| ---- | ------------------------- | ------------ |
| 进度 | 仅终端输出 | manifest 可查、可 `status` |
| 瞬时 API 失败 | 整轮退出 | 可重试 + 退避 |
| 中断后 | 需人工估算从第几轮重跑 | `resume <run_id>` |
| 多主体 | 需手写切换与轮转 | `--subjects` 轮转 + 每主体 manifest |
