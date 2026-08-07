<p align="center">
  <img src="docs/img/cyber-taoist-logo.svg" alt="Cyber-Taoist logo" width="96" />
</p>

<h1 align="center">JS-EVOLUTION-AGENT</h1>

<p align="center">
  <strong>受控的自演化宿主（JEA）</strong><br/>
  <strong>Cyber-Taoist 进化学</strong> × <strong>Loop Engineering</strong> — 带目标自修正的 OADA 演化闭环
</p>

<p align="center">
  <a href="https://cyber-taoist.ai"><strong>理论框架</strong></a> ·
  <a href="https://github.com/imjszhang/cyber-taoist"><strong>Cyber-Taoist</strong></a> ·
  <a href="https://x.com/imjszhang"><strong>@imjszhang</strong></a> ·
  <a href="./README.md"><strong>English</strong></a> ·
  <a href="./AGENTS.md"><strong>CLI 参考</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/理论-cyber--taoist.ai-FCD228?style=flat-square&labelColor=000000" alt="cyber-taoist.ai" />
  <img src="https://img.shields.io/badge/CLI-jea-000000?style=flat-square&labelColor=FCD228" alt="jea CLI" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 18" />
</p>

> 不是「固定 `/goal` 直到测试通过」的 coding loop，而是带理论约束、治理边界与可审计回执的 **演化 loop** — 当旧目标（法则）被后果证伪时，系统进入规则更新期，而非空转或硬撑。

---

## 目录

- [核心创新：目标自修正](#核心创新目标自修正)
- [与 Loop Engineering 的对齐](#与-loop-engineering-的对齐)
- [这是什么](#这是什么)
- [核心能力](#核心能力)
- [架构概览](#架构概览)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [演化循环](#演化循环)
- [Subject 与多主体](#subject-与多主体)
- [Daemon 长期运行](#daemon-长期运行)
- [Channel 通道](#channel-通道)
- [观测与 Evolution Viewer](#观测与-evolution-viewer)
- [操作者输入](#操作者输入)
- [配置](#配置)
- [安全边界](#安全边界)
- [开发与测试](#开发与测试)
- [文档索引](#文档索引)
- [License](#license)

---

## 核心创新：目标自修正

业界常见的 [Loop Engineering](https://x.com/addyosmani/status/2064127981161959567) 假设 **目标在 loop 启动时即固定** — 例如「所有 auth 测试通过且 lint 干净」，loop 只负责反复 prompt agent 直到 gate 通过。这在任务边界清晰时有效，但在长期演化场景会失效：**当环境（天道）已变、旧目标不再产生有效反馈时，agent 会在错误法则内空转**。

JEA 的核心创新，是把 [cyber-taoist.ai](https://cyber-taoist.ai) 的进化学框架 **落地为可机械执行的目标自修正机制**：

| Cyber-Taoist 概念 | 在 JEA 中的对应 | 作用 |
| --- | --- | --- |
| **自然（N）** — 天道不可直接观测，只能通过后果感知 | verify 报告、probe 结果、action receipt、外部探针 | 用已发生、可验证的后果反推环境变化 |
| **法则（R）** — 主体构建的规则防火墙，永远滞后 | `active_goals.json`、SUBJECT.md 约束、信念（beliefs） | 当前演化「认为对的」目标与行动假设 |
| **交易（T）** — 感知天道的探头 | `agent_run`、probe、record 型 action | 在法则内或经审批突破法则的交互 |
| **生态位（NI）** — 与现行法则的相容程度 | `good_signal` / `bad_signal` 匹配、成果指标 | 衡量当前策略是否仍在法则内有效 |
| **规则更新期** — 旧法则被证伪后沉淀新法则 | Phase 4 `goals assess` + Phase 4.5 `goals_calibrate` | **自动改写目标树**，进入下一轮演化 |

### 进化阶段 → 目标校准

依据宪章「感知滞后 → 试探 → 成败筛选 → **规则更新**」五阶段，Phase 4 评估器输出 `rule_status`：

| `rule_status` | 含义（Cyber-Taoist） | 系统行为 |
| --- | --- | --- |
| `continue` | 常规阶段：法则内交易反馈仍清晰 | 保持当前目标 |
| `learn` | 感知滞后：反馈不足或证据缺口 | 下一轮偏向只读学习、诊断、反馈回路校准 |
| `mutate` | 规则更新期：旧法则已被后果证伪 | Phase 4.5 **自动应用 `goal_patches`**，改写成果子目标 |
| `stop` | 核心守护失败 | 暂停成果探索，先恢复连续性 |
| `insufficient_evidence` | 无法从后果反推 | 不轻改目标，等待更多交易反馈 |

这与「只给建议、不落地」的 agent 工作流不同：默认 **`goals_calibrate` 会把高置信校准写入 `active_goals.json`**，并记录 `goal-events.jsonl` 供审计；`remove_child` 等 patch 还会联动 retire 相关信念。

### 为什么需要理论，而不只是 prompt

目标自修正若缺少顶层约束，容易退化为「失败就降标」或「任意扩 scope」。JEA 把 [CONSTITUTION.md](./policies/authority/CONSTITUTION.md) 与 [GUIDE.md](./policies/authority/GUIDE.md) 作为 **权威文献** 注入 assess 阶段 — 评估器必须先与宪章相容，再引用 verify / receipt / belief 等情报作结论。例如：过程目标（合规、审计）完成后须 **升回成果压力**；`mutate` 不得绕过 SUBJECT.md 中的发布审批边界。

简言之：**Loop 不只改代码，还能在理论约束下改「往哪演化」** — 这是 JEA 相对 Ralph loop、`/goal` 类固定目标 loop 的根本差异。

---

## 与 Loop Engineering 的对齐

JEA 可被理解为 **带治理层的 Orchestration Loop** — 人类设计 loop 结构与 guardrails，系统负责发现工作、委派 agent、独立验证、持久化状态、决定下一轮（含目标是否 mutate）。

```text
Loop Engineering 五步          JEA 对应
─────────────────────────────────────────────────────────
find work                  →  Phase 1 observe + analyze/decide（pending_decisions）
delegate to agent          →  Phase 2 exec（agent_run / probe / record actions）
gate (pass/fail)           →  Phase 3 verify（机械 + 语义；maker ≠ verifier）
record state               →  intel store、cycle-state、receipts、evolution diary
decide next                →  Phase 3.5 beliefs + Phase 4/4.5 goals + 下一轮 intel

额外一层（JEA 特有）       →  目标/法则自修正 + SUBJECT 审批 + operator brief/fact
```

| Loop Engineering 要素 | JEA 实现 |
| --- | --- |
| **Scheduling** | `jea daemon start`（`continuous` / `on_demand`）、channel classifier tick |
| **Worktrees** | Subject `lane` — 外部目标仓库隔离 worktree |
| **Persistent memory** | `js-intel-store`、standing memory、goal/belief events |
| **Maker–Verifier split** | Exec agent 写代码 / 执行；Verify 与 Goals assess **独立阶段**，不依赖执行者自评 |
| **Verifiable stopping** | 单 action 级 verify；轮次级 diary + `requires_human_review` |
| **Guardrails** | SUBJECT.md Off-Limits、`approval_granted`、brief/fact 分层 |
| **动态目标**（JEA 扩展） | 固定 `/goal` → **可变 goals + Cyber-Taoist rule_status** |

```text
                    ┌──────────────────────────────────────┐
                    │  人类：Subject 策略 · brief · 审批      │
                    └─────────────────┬────────────────────┘
                                      │ guardrails
┌─────────────── Evolution Loop ──────▼──────────────────────────────┐
│  Intel → Exec → Verify → Belief → Goals Assess → Goals Calibrate   │
│     ↑                                      │                       │
│     └──────── 下一轮（目标可能已 mutate）─────┘                       │
└────────────────────────────────────────────────────────────────────┘
         Daemon / Channel 调度 · 多 Subject 并行 · Evolution Viewer 观测
```

若你熟悉 Claude Code 的 `/loop` + `/goal`：JEA 相当于在 **orchestration loop** 之上，增加了 **「goal 本身也是法则假设，可被后果证伪并更新」** 的演化层。

---

## 这是什么

`js-evolution-agent` 是一个 **本地运行的演化宿主**，把以下能力组合成一条可重复、可审计的闭环：

| 组件 | 作用 |
| --- | --- |
| **OADA 引擎**（`src/engine/`，vendored） | 决策队列、ExecutionPipeline，以及 Phase 1 辅助（规则 / 目标 / guidance / logger） |
| **Cyber-Taoist 权威文献**（`policies/authority/`） | 跨 subject 共享的治理上下文（宪章、指南） |
| **Subject 策略**（`runtime/subjects/<ns>/SUBJECT.md`） | 每个演化主体的语义边界与审批规则 |
| **js-intel-store** | 文件型情报记忆（观测、回执、报告、信念等） |
| **CLI `jea`** | 操作者入口：单轮运行、daemon、channel、数据与审计 |

典型用途：让 AI 主体在 **lane worktree** 或外部资源上调查、改代码、模拟与发布准备，同时把每一轮的报告、验证结果与演化日记落盘，供人工审阅或通过飞书等通道交互。

---

## 核心能力

- **Cyber-Taoist 目标自修正** — Phase 4/4.5 依据交易反馈判断法则是否滞后，并机械落地 `goal_patches`（见 [核心创新](#核心创新目标自修正)）
- **完整演化流水线** — Intel → Exec → Verify → Belief Update → Goals Assess/Calibrate → Evolution Diary
- **Subject 隔离** — 多主体并行，各自 namespace、策略、lane 与运行时数据
- **Daemon step 模式** — 事件驱动的 step 级演化，支持 `continuous` / `on_demand` 两种模式
- **人工审批与软意图** — Brief（下一轮意图）+ `approval_granted`（硬开关）双层机制
- **信念与目标管理** — 可验证假设（beliefs）与目标树（goals）的 formal 更新路径
- **多 Agent 后端** — DeepSeek、Claude Agent SDK、Cursor SDK、Reasonix CLI 等
- **Channel（飞书）** — 入站分类、Presence 表达、控制命令（切换演化模式、请求开轮等）
- **Evolution Viewer** — 本地 Web UI，实时查看轮次、报告、daemon 与 observability

---

## 架构概览

```text
┌─────────────────────────────────────────────────────────────────┐
│                         jea CLI / Daemon                         │
├──────────────┬──────────────────────┬───────────────────────────┤
│  Cycle Domain │    Channel Domain     │   Evolution Viewer (web)  │
│  intel→exec→  │  classifier→presence  │   rounds / reports / SSE  │
│  verify→…     │  →speech→outbox       │                           │
├──────────────┴──────────────────────┴───────────────────────────┤
│  src/engine/ (OADA)  │  src/actions/  │  src/intelligence/       │
│  queue · exec ·       │  agent_run ·   │  store · reports ·       │
│  verifyActions       │  lane · gates  │  beliefs · goals           │
├──────────────────────┴────────────────┴───────────────────────────┤
│  policies/authority/  +  runtime/subjects/<ns>/SUBJECT.md         │
│  runtime/subjects/<ns>/data/  (evolution · intelligence · goals)  │
└─────────────────────────────────────────────────────────────────┘
```

单轮主流水线：

```text
Phase 1   intel pipeline（observe → report → analyze+decide）
Phase 1.5 intel report 持久化
Phase 2   exec（消费 pending_decisions 队列）
Phase 3   verify（机械 + 语义验证）
Phase 3.5 belief_update
Phase 4   goals assess
Phase 4.5 goals calibrate
Phase 5   evolution diary
```

---

## 环境要求

- **Node.js** ≥ 18
- 可选：**DeepSeek API Key**（无 key 时可用 `--mock` 走本地 Mock AI）
- 可选：Claude Agent SDK / Cursor SDK / Reasonix CLI（用于 `agent_run` 执行路径）
- 可选：飞书开放平台应用（Channel 适配器）

---

## 快速开始

```bash
git clone <repo-url> js-evolution-agent
cd js-evolution-agent
npm install

# 环境检查
npm run doctor

# 创建 subject 并初始化运行时数据
npm run jea -- subject init my-bot --use
npm run jea -- data init --all --subject my-bot

# 本地冒烟（不调用真实模型）
npm run jea -- run --mock --subject my-bot

# 查看运行时概况
npm run jea -- data status
npm run jea -- intel report
```

安装完成后也可直接使用 bin 链接：

```bash
jea doctor
jea run --mock
```

配置真实模型：复制 `.env.example` 为 `.env`，填入 `DEEPSEEK_API_KEY`，然后：

```bash
jea llm ping
jea run --deepseek --subject my-bot
```

---

## 演化循环

**单轮调试** — 适合本地验证与排错：

```bash
jea run [--mock | --deepseek] [--subject NAME]
jea run --skip-goals-assess      # 跳过 Phase 4/4.5
jea run --skip-belief-update     # 跳过 Phase 3.5
```

**批量演化**：

```bash
jea evolve --rounds 5
jea evolve status
jea evolve resume <run-id>
```

**常用观测命令**：

```bash
jea intel summary [--days 7]
jea intel report [--cycle <id>] [--open]
jea daemon inbox [--json]
jea audit queue
jea beliefs show
jea goals show
```

完整命令说明见 [AGENTS.md](./AGENTS.md)（中文操作指引）。

---

## Subject 与多主体

每个 **Subject** 是独立的演化单元：自己的策略、数据 namespace、可选 lane（目标仓库 worktree）与 channel 配置。

```text
runtime/subjects/
├── registry.json              # 本地 registry（gitignore，勿提交）
└── <data_namespace>/
    ├── SUBJECT.md             # 治理策略（边界、审批规则）
    ├── SOUL.md                # Channel 人设（不参与 Decide 治理）
    └── data/
        ├── evolution/
        ├── intelligence/
        └── goals/
```

```bash
jea subject list
jea subject init my-product --use
jea subject show --subject my-product
jea subject check
jea data init --all --subject my-product
```

Registry 机器可读字段（lane、resources、channels、evolution.mode）参考 [`policies/subjects.example.json`](./policies/subjects.example.json)。创建与配置细节见 [`policies/README.md`](./policies/README.md)。

多主体并行时，**每个 subject 一个 daemon 进程**：

```bash
jea daemon start --subject subject-a
jea daemon start --subject subject-b
jea daemon status --all
```

---

## Daemon 长期运行

Daemon 以 **step 粒度** 驱动演化，推荐用于长期无人值守运行。

```bash
# 前台 worker（cycle + channel 同进程）
jea daemon start --subject my-bot

# 生产建议：cycle 与 channel 分进程，故障隔离
jea daemon start --subject my-bot --domain cycle
jea daemon start --subject my-bot --domain channel

# Windows 后台 detached
npm run daemon:start:detached
```

| 模式 | 行为 |
| --- | --- |
| `continuous`（默认） | 心跳 tick 自动 reconcile、无 open cycle 时尝试开新轮 |
| `on_demand` | 仅响应显式请求（`jea daemon cycle request`、operator brief 等） |

```bash
jea daemon evolution-mode show
jea daemon evolution-mode set on_demand
jea daemon cycle request --reason "manual kick"
jea daemon status --json
jea daemon doctor
```

---

## Channel 通道

Channel 与 cycle **平级**，负责外部消息收发与表达决策。当前内置 **飞书** 适配器。

**新 subject 接飞书**：

```bash
jea channel feishu setup --subject my-bot --write-env --init-subject-config
jea daemon start --subject my-bot --domain channel
# 飞书私聊机器人：JEA BIND <口令>
```

入站消息经 **classifier** 批量分类（审批意图、核实请求、operator fact、控制命令、普通观测等），**presence** 两阶段产出话术并入 outbox。

Channel 不能绕过审批直接发布或修改凭据；远端发布仍需 brief → Decide → `approval_granted` 路径。

---

## 观测与 Evolution Viewer

本地 Web UI，默认追踪所有已注册 subject：

```bash
npm run viewer:serve
# 或
jea intel viewer serve [--port 8787] [--open]
```

- **Ops Home** — KPI、待关注项、open cycles、事件流
- **阅读视图** — 选中轮次查看报告、日记、诊断与 observability
- Live API + SSE，无需先 build dist

离线快照：

```bash
npm run viewer:build
```

---

## 操作者输入

系统区分四类人工输入，**不要混用**：

| 类型 | 含义 | 典型入口 |
| --- | --- | --- |
| **Constraint** | 长期必须遵守的边界 | `human_guidance.md`、SUBJECT.md |
| **Intent** | 下一轮关注什么（非事实） | `jea intel brief put` |
| **Fact** | 操作者已确认、可当 Seen 引用 | `operator_fact` via `jea intel ingest` |
| **Evidence** | 可被推翻的外部观测 | `jea intel ingest` / inbox、probe |

**Action（硬开关）** 如 `approval_granted` 由 Decide 产出、Phase 2 执行；操作者不应直接编辑 `pending_decisions.json`。

审批策略可通过 `JEA_APPROVAL_MODE` 配置：`manual`（默认）| `auto_guarded` | `auto_all`。详见 [AGENTS.md § 人工审批](./AGENTS.md#人工审批与操作者意图)。

---

## 配置

复制环境模板：

```bash
cp .env.example .env   # Windows: copy .env.example .env
```

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 真实模型调用（缺省则 Mock） |
| `DEEPSEEK_MODEL` | 默认 `deepseek-v4-flash` |
| `JEA_LANGUAGE` | UI/报告语言，`zh-CN` \| `en-US` |
| `JEA_APPROVAL_MODE` | `manual` \| `auto_guarded` \| `auto_all` |
| `JEA_EVOLUTION_MODE` | Daemon 默认演化模式 |
| `JEA_AGENT_PROVIDER` | 默认 agent 后端 |
| `JEA_EXEC_AGENT_BUDGET` | 单轮最多消费的 `agent_run` 数（默认 8）；机械动作无上限 |
| `JEA_AGENT_MAX_CONCURRENCY` | agent_run 波内并行宽度上限（默认 2） |
| `JEA_AGENT_MAX_ATTEMPTS` | 失败后转 `blocked` 前的重试次数（默认 2） |
| `JEA_EXEC_LIMIT` | deprecated，映射为 `JEA_EXEC_AGENT_BUDGET` |

飞书 per-subject 凭证：`JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` 等，见 `.env.example` 与 `policies/subjects.example.json`。

权威文献目录覆盖：

```bash
CYBER_TAOIST_DOCS_DIR=/path/to/custom-authority jea run
```

---

## 安全边界

- Phase 1 默认只 **记录** 观测、探针提案、回顾与回执，不修改引擎源码、权威文献或 intel-store 本身。
- **核心层变更**（`core_apply`）默认需人工 review；`JEA_CORE_APPLY_POLICY=review|disabled` 可进一步约束。
- **远端发布、凭据、越界写入** 由 SUBJECT.md 的 Off-Limits 与 `approval_granted` 双重约束；Channel 不能自动放行。
- `jea data reset --yes` 会删除当前 subject 运行时数据，**有破坏性**；自动化脚本执行前需确认 subject。

---

## 开发与测试

```bash
npm test
npm run jea -- help
```

- 引擎 vendoring 说明：[`src/engine/VENDORED.md`](./src/engine/VENDORED.md)
- 自动化代理与本地操作完整指引：[AGENTS.md](./AGENTS.md)
- 变更日志与 design notes：`journal/`

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](./README.md) | English README（主版） |
| [cyber-taoist.ai](https://cyber-taoist.ai) | 进化学框架官网：N/R/T/EC/NI 概念与宪章全文 |
| [AGENTS.md](./AGENTS.md) | CLI 完整参考、daemon/channel 工作流、操作者输入规范 |
| [policies/README.md](./policies/README.md) | Subject / registry / lane / goals 创建指南 |
| [policies/subjects.example.json](./policies/subjects.example.json) | Registry 配置示例 |
| [policies/authority/](./policies/authority/) | 本地权威文献副本（CONSTITUTION、GUIDE） |
| [.env.example](./.env.example) | 环境变量模板 |

---

## License

[MIT 许可证](./LICENSE) — 版权所有 © [imjszhang](https://x.com/imjszhang)。
