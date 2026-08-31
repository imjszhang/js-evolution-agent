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
  <a href="https://github.com/imjszhang/js-evolution-agent/actions/workflows/ci.yml"><img src="https://github.com/imjszhang/js-evolution-agent/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/imjszhang/js-evolution-agent/actions/workflows/codeql.yml"><img src="https://github.com/imjszhang/js-evolution-agent/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/理论-cyber--taoist.ai-FCD228?style=flat-square&labelColor=000000" alt="cyber-taoist.ai" />
  <img src="https://img.shields.io/badge/CLI-jea-000000?style=flat-square&labelColor=FCD228" alt="jea CLI" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 22.13" />
</p>

> 不是「固定 `/goal` 直到测试通过」的 coding loop，而是带理论约束、治理边界与可审计回执的 **演化 loop** — 当旧目标（法则）被后果证伪时，系统进入规则更新期，而非空转或硬撑。

## 产品（0.3.1）

已发布产品是 **0.3.1**（[v0.3.1](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.3.1)）。认证清单见 [docs/release/0.3.1-certification.md](docs/release/0.3.1-certification.md)。

JEA 0.3.1 是 **macOS Apple Silicon** 应用，并附带托管 `jea` CLI。Electron 与 Web 共用三栏操作者工作区：

1. **Subject 与本地会话**
2. **受治理对话**，走 Channel classifier / presence / speech 管道（聊天文本不是 hard approval）
3. **Evolution Inspector**，查看因果执行链、期望对照、settlement、Memory Reactor 新鲜度与运行时健康

Settings 覆盖 JEA Home、默认 Subject、CLI 安装、外观和 About。Electron 与 localhost Web 加载同一套 React 应用。安装与 Gatekeeper 见 [docs/release/installation.md](docs/release/installation.md)。无头生命周期：`jea start --no-open`、`jea status --json`、`jea url`、`jea stop`。

下文的源码命令同时也是开发、诊断和恢复路径。

---

## 目录

- [产品（0.3.1）](#产品031)
- [核心创新：目标自修正](#核心创新目标自修正)
- [与 Loop Engineering 的对齐](#与-loop-engineering-的对齐)
- [这是什么](#这是什么)
- [核心能力](#核心能力)
- [架构概览](#架构概览)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [演化 loop](#演化-loop)
- [Subject 与多主体](#subject-与多主体)
- [Daemon 长期运行](#daemon-长期运行)
- [Channel 通道](#channel-通道)
- [观测与 Evolution Viewer](#观测与-evolution-viewer)
- [操作者输入](#操作者输入)
- [配置](#配置)
- [安全边界](#安全边界)
- [开发与测试](#开发与测试)
- [安全](#安全)
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
| **规则更新期** — 旧法则被证伪后沉淀新法则 | 幂等 belief/goal settlement | 从精确验证过的 execution window **自动改写目标树** |

### 进化阶段 → 目标校准

依据宪章「感知滞后 → 试探 → 成败筛选 → **规则更新**」五阶段，rule settlement 输出 `rule_status`：

| `rule_status` | 含义（Cyber-Taoist） | 系统行为 |
| --- | --- | --- |
| `continue` | 常规阶段：法则内交易反馈仍清晰 | 保持当前目标 |
| `learn` | 感知滞后：反馈不足或证据缺口 | 下一轮偏向只读学习、诊断、反馈回路校准 |
| `mutate` | 规则更新期：旧法则已被后果证伪 | settlement **自动应用 `goal_patches`**，改写成果子目标 |
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
Loop Engineering 五步          JEA 0.2.0 对应
─────────────────────────────────────────────────────────
find work                  →  claim evidence → report → belief-bound decision
delegate to agent          →  durable exec intent → agent_run / action receipt
gate (pass/fail)           →  expected-output comparison；maker ≠ verifier
record state               →  causal IDs、append-only events、checkpoint、receipts
decide next                →  幂等 belief/goal settlement → Memory Reactor

额外一层（JEA 特有）       →  目标/法则自修正 + SUBJECT 审批 + operator brief/fact
```

| Loop Engineering 要素 | JEA 实现 |
| --- | --- |
| **Scheduling** | `jea daemon start` 下由 evidence/operator wake 驱动的有界异步 reactors |
| **Worktrees** | Subject `lane` — 外部目标仓库隔离 worktree |
| **Persistent memory** | append-only belief/goal events + 低频 Memory Reactor consolidation |
| **Maker–Verifier split** | Exec 写代码 / 执行；Verify 独立对照结构化观测与 `run_spec.expected_output` |
| **Verifiable stopping** | execution 级 verify、精确 settlement refs 与 closure audit |
| **Guardrails** | SUBJECT.md Off-Limits、`approval_granted`、brief/fact 分层 |
| **动态目标**（JEA 扩展） | 固定 `/goal` → **可变 goals + Cyber-Taoist rule_status** |

```text
                    ┌──────────────────────────────────────┐
                    │  人类：Subject 策略 · brief · 审批      │
                    └─────────────────┬────────────────────┘
                                      │ guardrails
┌─────────────── Evolution Loop ──────▼──────────────────────────────┐
│ Evidence → Report → Decision → Exec → Verify → Settlement → Memory │
│    ↑                                      │                         │
│    └──────────── 持久证据触发 wake ─────────┘                         │
└────────────────────────────────────────────────────────────────────┘
         Daemon / Channel 调度 · 多 Subject 并行 · Evolution Viewer 观测
```

若你熟悉 Claude Code 的 `/loop` + `/goal`：JEA 相当于在 **orchestration loop** 之上，增加了 **「goal 本身也是法则假设，可被后果证伪并更新」** 的演化层。

---

## 这是什么

`js-evolution-agent` 是一个 **本地运行的演化宿主**，把以下能力组合成一条可重复、可审计的闭环：

| 组件 | 作用 |
| --- | --- |
| **OADA 引擎**（`src/engine/`，vendored） | 决策队列、执行/验证辅助，以及规则 / 目标 / guidance |
| **Cyber-Taoist 权威文献**（`policies/authority/`） | 跨 subject 共享的治理上下文（宪章、指南） |
| **Subject 策略**（`<JEA_HOME>/subjects/<ns>/SUBJECT.md`） | 每个演化主体的语义边界与审批规则 |
| **js-intel-store** | 文件型情报记忆（观测、回执、报告、信念等） |
| **CLI `jea`** | 操作者入口：同步 reactor chain、daemon、channel、数据与审计 |

典型用途：让 AI 主体在 **lane worktree** 或外部资源上调查、改代码、模拟与发布准备，同时让每条持久记录都可沿 evidence → decision → execution → verification → settlement 重新打开。

---

## 核心能力

- **Belief-driven async loop** — evidence batch 唤醒 cognitive、exec、verify、rule 与 memory reactors，不依赖单体 cycle driver
- **Causal IDs** — `producer_batch_id`、`reaction_id`、`decision_id`、`execution_id`、`belief_id` 串起完整链路
- **Expected verification** — 将 `run_spec.expected_output` 与结构化 result/verifier 观测对照；执行成功不等于期望匹配
- **Idempotent settlement** — 同步与异步路径共用 evidence-window 协调器和精确 receipt/verify refs
- **Memory Reactor** — 低频合并已 settlement 的 belief/goal events，不把叙事当权威事实
- **Cyber-Taoist 目标自修正** — 已验证后果可改变目标假设（见 [核心创新](#核心创新目标自修正)）
- **Subject 隔离** — 多主体并行，各自 namespace、策略、lane 与运行时数据
- **Runtime maintenance** — 保守归档/压缩有界 hot sidecars，保留 active lease、uncertain intent 与主证据
- **人工审批与软意图** — Brief（下一轮意图）+ `approval_granted`（硬开关）双层机制
- **信念与目标管理** — 可验证假设（beliefs）与目标树（goals）的 formal 更新路径
- **多 Agent 后端** — DeepSeek、Claude Agent SDK、Cursor SDK、Reasonix CLI 等
- **Channel delivery** — classifier → presence → speech → 脱敏 outbox → notify，只有持久化话术成功后才推进 handled
- **Operator projection** — Conversation readiness、evolution、attention、pending evidence/tasks 与允许的 remediation 分字段投影

---

## 架构概览

```text
┌─────────────────────────────────────────────────────────────────┐
│                         jea CLI / Daemon                         │
├──────────────┬──────────────────────┬───────────────────────────┤
│ Reactor Domain│    Channel Domain     │   Shared operator app     │
│ evidence→rule │  classifier→presence  │   projection / Inspector  │
│ →memory       │  →speech→outbox       │                           │
├──────────────┴──────────────────────┴───────────────────────────┤
│  src/engine/ (OADA)  │  src/actions/  │  src/intelligence/       │
│  queue · exec ·       │  agent_run ·   │  store · reports ·       │
│  verifyActions       │  lane · gates  │  beliefs · goals           │
├──────────────────────┴────────────────┴───────────────────────────┤
│  policies/authority/  +  <JEA_HOME>/subjects/<ns>/SUBJECT.md      │
│  <JEA_HOME>/subjects/<ns>/data/ (evolution · intelligence · goals)│
└─────────────────────────────────────────────────────────────────┘
```

0.2.0 live 主链：

```text
EvidenceEnvelope → claimed batch → report → belief-bound decision
→ exec intent（副作用前持久化）→ exec result / action receipt
→ expected-output verify → 幂等 belief/goal settlement
→ Memory Reactor consolidation → operator projection / Channel delivery
```

0.1.0 历史记录继续可读。缺失的可选 causal/comparison 字段显示为 legacy/unknown，不伪造链路；已移除的 driver 参数和任务类型明确失败，不会偷偷选择另一条 live 路径。

---

## 环境要求

- **Node.js** ≥ 22.13
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
jea llm budget status --json
jea run --deepseek --subject my-bot
```

打到主体 token/花费上限是预期操作者状态。用 `jea llm budget raise` 或 `jea llm budget period-open` 恢复，不要手改 `llm-budget-ledger.json`。Channel 与 Cycle 共用同一账本。

---

## 演化 loop

**同步入口** — 适合本地验证与排错，与 daemon 共用同一组 reactors 和 settlement 协调器：

```bash
jea run [--mock | --deepseek] [--subject NAME]
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
jea audit queue   # 演化证据 / 决策队列，不是 npm 供应链审计
jea audit closure [--subject NAME] [--json]
jea beliefs show
jea goals show
```

完整命令说明见 [AGENTS.md](./AGENTS.md)（中文操作指引）。

---

## Subject 与多主体

每个 **Subject** 是独立的演化单元：自己的策略、数据 namespace、可选 lane（目标仓库 worktree）与 channel 配置。

```text
~/.jea/subjects/
├── registry.json              # 设备本地 registry（勿提交）
└── <data_namespace>/
    ├── SUBJECT.md             # 治理策略（边界、审批规则）
    ├── SOUL.md                # Channel 人设（不参与 Decide 治理）
    └── data/
        ├── evolution/
        ├── intelligence/
        └── goals/
```

`JEA_HOME` 默认是 Linux/macOS 的 `~/.jea`、Windows 的 `%USERPROFILE%\.jea`，也可显式覆盖。源码继续留在 checkout，lane 仓库/worktree 继续作为 execution root；旧仓库运行数据必须显式迁移：

```bash
jea daemon stop --all
jea data migrate-home --dry-run
jea data migrate-home --yes
jea doctor
```

迁移会逐文件校验并原子启用新目录，同时保留旧 `runtime/subjects/` 作为人工回退来源。0.1.0 记录仍可读取：可选 causal IDs、expected-output comparison 和 settlement marker 缺失时显示 unknown；`settlements.json` 等可重建 sidecar 可由 append-only 权威事件恢复，迁移时不得虚构链路。详见 [JEA Home 迁移指南](./docs/jea-home-migration.md)。

```bash
jea subject list
jea subject init my-product --use
jea subject show --subject my-product
jea subject check
jea data init --all --subject my-product
```

Registry 机器可读字段（lane、resources、channels、`evolution.state`）参考 [`policies/subjects.example.json`](./policies/subjects.example.json)。创建与配置细节见 [`policies/README.md`](./policies/README.md)。

多主体并行时，**每个 subject 一个 daemon 进程**：

```bash
jea daemon start --subject subject-a
jea daemon start --subject subject-b
jea daemon status --all
```

---

## Daemon 长期运行

Daemon 运行有界的 **事件驱动 reactors**，推荐用于长期无人值守运行。

```bash
# 前台 worker（cycle + channel 同进程）
jea daemon start --subject my-bot

# 生产建议：evolution 与 channel 分进程，故障隔离
jea daemon start --subject my-bot --domain evolution
jea daemon start --subject my-bot --domain channel

# Windows 后台 detached
npm run daemon:start:detached
```

调度是 **事件驱动**。心跳不会凭空创建 Cognitive 工作。运行开关是 `evolution.state`：

| 状态 | 行为 |
| --- | --- |
| `active`（默认） | worker 自动消费 eligible evidence / wake |
| `paused` | 不启新的 Cognitive / Exec / Rule；verify、settlement、Memory 仍可收尾 |

`evolution.mode`（`continuous` / `on_demand`）已弃用，不再改变调度。

```bash
jea daemon evolution-state show
jea daemon evolution-state set paused
jea daemon reaction request --reason "manual kick"
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

入站消息经 **classifier** 批量分类（审批意图、核实请求、operator fact、控制命令、普通观测等），**presence** 规划表达，speech generation 持久化脱敏正文，notify 投递 outbox。生成失败或受限时不推进 handled 游标，eligible 输入会重试而不是静默丢失。

Channel 不能绕过审批直接发布或修改凭据；远端发布仍需 brief → Decide → `approval_granted` 路径。

---

## 观测与 Evolution Viewer

本地 Web UI，默认追踪所有已注册 subject：

```bash
npm run viewer:serve
# 或
jea intel viewer serve [--port 8787] [--open]
```

- **开发兼容视图** — canonical evidence/task/attention 计数与事件流
- **阅读视图** — 历史报告/日记，以及当前 verify / Memory 产物
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
| **Intent** | 下一次 reaction 关注什么（非事实） | `jea intel brief put` |
| **Fact** | 操作者已确认、可当 Seen 引用 | `operator_fact` via `jea intel ingest` |
| **Evidence** | 可被推翻的外部观测 | `jea intel ingest` / inbox、probe |

**Action（硬开关）** 如 `approval_granted` 由 Decide 产出、执行层强制检查；操作者不应直接编辑 `pending_decisions.json`。

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
| `JEA_HOME` | 设备级 Subject 状态根（默认 `~/.jea`） |
| `JEA_PROJECT_ROOT` | 源码 checkout 根；不再决定 Subject 数据位置 |
| `JEA_LANGUAGE` | UI/报告语言，`zh-CN` \| `en-US` |
| `JEA_APPROVAL_MODE` | `manual` \| `auto_guarded` \| `auto_all` |
| `JEA_EVOLUTION_MODE` | Daemon 默认演化模式 |
| `JEA_AGENT_PROVIDER` | 默认 agent 后端 |
| `JEA_EXEC_AGENT_BUDGET` | 单次 exec batch 最多消费的 `agent_run` 数（默认 8）；机械动作无上限 |
| `JEA_AGENT_MAX_CONCURRENCY` | agent_run 波内并行宽度上限（默认 2） |
| `JEA_AGENT_MAX_ATTEMPTS` | 失败后转 `blocked` 前的重试次数（默认 2） |
| `JEA_EXEC_LIMIT` | deprecated，映射为 `JEA_EXEC_AGENT_BUDGET` |
| `JEA_QUEUE_DISABLE_CYCLE_TTL` | 显式关闭 cycle-count TTL 的兼容开关；墙钟后备仍保留 |
| `JEA_LLM_PROCESS_TOKEN_BUDGET` | 真实 LLM 每 subject/进程硬 token 预算（默认 1,000,000） |
| `JEA_LLM_REQUEST_MAX_TOKENS` | 单请求 completion 上限（默认/最大 8,192） |
| `JEA_RUNTIME_MAINTENANCE` | 启用 daemon heartbeat sidecar maintenance（默认开） |
| `JEA_RUNTIME_MAINTENANCE_INTERVAL_MS` | maintenance 周期（默认 24h） |
| `JEA_SIDECAR_RETENTION_DAYS` / `JEA_SIDECAR_HOT_MAX` | 默认归档天数 / hot 记录上限（30 天 / 1,000） |

飞书 per-subject 凭证写在 `<JEA_HOME>/subjects/<ns>/.env`，变量名为 `JEA_CHANNEL_FEISHU_APP_ID` / `_APP_SECRET`，见 `.env.example` 与 `policies/subjects.example.json`。

权威文献目录覆盖：

```bash
CYBER_TAOIST_DOCS_DIR=/path/to/custom-authority jea run
```

---

## 安全边界

- investigation 只读；只有受治理的 decision 才能调度副作用。
- exec intent 在副作用前持久化；崩溃后留下的 uncertain intent 必须由操作者核对，禁止盲目重放。
- verify 对照结构化观测与声明期望；agent narrative 本身不是 observation。
- settlement 幂等，append-only belief/goal events 的权威性高于可重建 sidecar。
- **核心层变更**（`core_apply`）默认需人工 review；`JEA_CORE_APPLY_POLICY=review|disabled` 可进一步约束。
- **远端发布、凭据、越界写入** 由 SUBJECT.md 的 Off-Limits 与 `approval_granted` 双重约束；Channel 不能自动放行。
- `jea data reset --yes` 会删除当前 subject 运行时数据，**有破坏性**；自动化脚本执行前需确认 subject。

---

## 开发与测试

```bash
npm test
npm run test:ci          # 默认 reporter + JUnit，输出到 test-artifacts/
npm run test:coverage    # V8 coverage；阈值是不回退基线
npm run check
npm run desktop:typecheck
npm run desktop:build
npm run audit:ci         # 生产依赖审计 + 带到期日的例外基线
npm run reactor:canary   # 隔离 mock canary；不跑真实 DeepSeek
npm run jea -- help
```

PR、向 `main` 的 push，以及 merge group 会跑：

| 检查 | 内容 |
| --- | --- |
| `check` | 隔离主体 `ci-repo` 上的 policy / subject / actions 检查 |
| `test (22)` | Node 22 上的 `npm run test:coverage` |
| `desktop-build` | 桌面 typecheck + 可打包构建（不再重复跑 desktop tests） |
| `dependency-audit` | `npm run audit:ci` |
| CodeQL JS/TS | advanced setup，`build-mode: none` |

`main` 由 Ruleset 保护：改动必须走基于最新 `main` 的 PR。上表检查为 required checks。Nightly `reactor:canary` 只跑 mock，不是 PR required check，也绝不注入 `DEEPSEEK_API_KEY`。真实 DeepSeek 测试仍需 `JEA_LIVE_DEEPSEEK=1`。`jea doctor` 是本地诊断，不是 CI 门禁。

`jea audit queue` 检查演化证据 / 决策队列。`jea audit closure` 汇总 belief binding 与 expected-output 声明覆盖、causal correlation、batch-scoped refs、重复 settlement 候选、Memory 新鲜度，以及分离的 evidence/task backlog。两者都**不是** npm 供应链审计（`npm run audit:ci`）。

- 引擎 vendoring 说明：[`src/engine/VENDORED.md`](./src/engine/VENDORED.md)
- 自动化代理与本地操作完整指引：[AGENTS.md](./AGENTS.md)
- 变更日志与 design notes：`journal/`

---

## 安全

漏洞报告与支持范围见 [SECURITY.md](./SECURITY.md)。尚未修复的生产依赖告警由 [`.github/security/audit-baseline.json`](./.github/security/audit-baseline.json) 及其跟踪 issue 管理，不把动态清单写进政策文档。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](./README.md) | English README（主版） |
| [docs/mechanism-diagram.md](./docs/mechanism-diagram.md) | 模块与双域调度机制图（Mermaid） |
| [cyber-taoist.ai](https://cyber-taoist.ai) | 进化学框架官网：N/R/T/EC/NI 概念与宪章全文 |
| [AGENTS.md](./AGENTS.md) | CLI 完整参考、daemon/channel 工作流、操作者输入规范 |
| [SECURITY.md](./SECURITY.md) | CLI 宿主与 Electron 桌面的漏洞报告渠道 |
| [policies/README.md](./policies/README.md) | Subject / registry / lane / goals 创建指南 |
| [policies/subjects.example.json](./policies/subjects.example.json) | Registry 配置示例 |
| [policies/authority/](./policies/authority/) | 本地权威文献副本（CONSTITUTION、GUIDE） |
| [.env.example](./.env.example) | 环境变量模板 |

---

## License

[MIT 许可证](./LICENSE) — 版权所有 © [imjszhang](https://x.com/imjszhang)。
