# OpenClaw Bridge Intent：从通道意图到一键部署的 JEA/OpenClaw 接入

> 日期：2026-06-05  
> 项目：js-evolution-agent（Channel Loop / OpenClaw Bridge / CLI Deploy）  
> 类型：架构设计 / 功能实现 / 调研分析  
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)
7. [附：本轮对话问题—思考—方案—执行对照](#附本轮对话问题思考方案执行对照)

---

## 1. 背景与动机

这次问题不是“JEA 能不能接一个新通道”。

真正的问题是：**OpenClaw 已经是更通用的多通道 AI 网关，JEA 不应该重复造 Telegram、Discord、Slack、WhatsApp 这些通道轮子。**

但 JEA 也不能简单把自己的 Channel Loop 关掉。

因为 Channel Loop 不只是“回复用户消息”。它承担了更深的系统职责：

- `classifier` 把外部输入转成 `observation`、`control_request`、`approval_request` 等结构化事实；
- `presence` 根据系统内部变化决定何时表达；
- `speech_generation` 按 `SOUL.md` 生成人格化表达；
- `notify` 负责把表达从 `outbox/pending` 投递出去；
- `control` worker 执行白名单内的本地控制动作。

如果用 OpenClaw Agent Loop 直接替代 JEA Channel Loop，短期看能聊天，长期会丢掉 JEA 的治理边界和系统感知能力。

因此本轮目标变成：

> **Channel Loop 继续完整运行，但它的出站不再直接面向用户，而是生成给 OpenClaw Agent Loop 消费的表达意图。**

OpenClaw 负责多通道接入与最终对外表达。JEA 负责把信息消化成系统级意图。

第一步已经让 Channel Loop 能把出站内容写成 `bridge-intent` 文件。但这还不够。

如果每次切换 OpenClaw 模式都要手动改 `runtime/subjects/registry.json`、手写 `AGENTS.md`、创建 intent 目录、再拼 OpenClaw 配置片段，这个能力就还只是“内部机制”，不是一个可部署的功能。

因此第二阶段目标变成：

> **把 OpenClaw bridge 变成 JEA 的独立部署功能，并且部署后可以和原有 Feishu 模式自由切换。**

---

## 2. 分析过程

### 2.1 先确认两个系统的边界

对 OpenClaw 的调研结论是：它是一个自托管多通道 AI 网关，Gateway 可以托管多个 agent，每个 agent 有自己的 `workspace`、`agentDir` 和 session store。`agents.list[].workspace` 可以指向任意目录，这意味着一个 JEA subject runtime 目录可以直接作为 OpenClaw agent 的 workspace。

对 JEA 的调研结论是：它的 channel 子系统已经是文件系统驱动的 loop：

```text
inbound/pending
  -> classifier
  -> intelligence / control / presence event
  -> presence reactor
  -> speech_generation
  -> outbox/pending
  -> notify worker
```

这个结构天然适合做 bridge。关键是找到最小切入点。

### 2.2 被否定的方向

一开始有几种方案：

| 方案 | 为什么没有选 |
| --- | --- |
| OpenClaw 直接替代 JEA Channel Loop | 会绕过 classifier、presence、control 等 JEA 核心机制 |
| JEA notify worker 直接调用 OpenClaw SDK 发给用户 | 表达仍然绕过 OpenClaw Agent Loop，无法结合当前会话上下文做最终措辞 |
| 独立 bridge 进程强行轮询并移动 `outbox/pending` | 容易与现有 notify worker 竞争，也破坏原有 outbox 状态机 |
| 在 OpenClaw 侧写完整插件 | 方向长期可行，但第一步成本过高，不利于验证 JEA 内部抽象 |

最后留下来的方案更小：

> **把 JEA notify worker 的发送目标抽象成 adapter。Feishu 仍是默认 adapter；新增 `bridge-intent` adapter，只把 outbox 消息写成 intent 文件。**

### 2.3 关键发现：JEA 已经半抽象化，只有发送端硬编码

阅读 `src/channel/` 后发现，JEA 写出站消息时已经携带 `channel` 字段：

- `speech-generation.mjs` 通过 `resolveOutboundTarget()` 得到 `routed.transport`；
- `delivery-renderer.mjs` 也会按 transport/target 写 outbox；
- `writeOutboxMessage()` 只负责把消息放入 `outbox/pending`。

真正硬编码的是 notify worker：

```text
runChannelNotifyTask
  -> normalizeOutboundMessage
  -> sendOutboundMessage from adapters/feishu/index.mjs
```

也就是说，JEA 的上游已经知道“我要发到哪个 channel”，但最后一步没有使用这个信息。

这就是本轮最小改造点。

### 2.4 第二个关键发现：部署与切换本质是 registry 状态切换

继续看 CLI 和 subject registry 后，发现 JEA 已有一套非常适合做 deploy 的模式：

- CLI 入口 `src/cli/jea.mjs` 是手动路由；
- 命令文件导出 `*Command()`；
- subject 配置通过 `readSubjectsRegistry()` / `writeSubjectsRegistry()` 原子写回；
- `channel feishu setup` 已经有“读 registry → 合并 channels 配置 → 写回”的先例。

所以 deploy 不需要新守护进程，也不需要直接修改 OpenClaw 配置。

真正要切换的是：

```json
{
  "channels": {
    "presence": {
      "default_transport": "bridge-intent"
    }
  }
}
```

而 undeploy 则恢复部署前的 transport：

- 如果部署前没有显式 transport，就删除 `default_transport` 字段，回到默认 Feishu fallback；
- 如果部署前有显式 transport，就恢复原值；
- 重复 deploy 不应把“原值”覆盖成 `bridge-intent`。

这个重复 deploy 的边界后来被专门补了测试，因为它决定了“自由切换”是不是真的可靠。

---

## 3. 方案设计

### 3.1 总体模型

新的关系不是替代，而是分层：

```text
JEA Channel Loop
  classifier -> presence -> speech_generation -> outbox
  -> bridge-intent adapter
  -> data/bridge/openclaw/intents/pending/*.json

OpenClaw Agent Loop
  读取 JEA subject workspace
  读取 pending intents
  结合当前会话上下文
  最终对用户表达
```

JEA 继续完成“想清楚该说什么”。OpenClaw 负责“什么时候、以什么口吻、在哪个通道说出去”。

### 3.2 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 改造点 | 只改 notify worker 发送端 | 上游 outbox 已带 `channel`，不用重写 presence / speech |
| 兼容策略 | `feishu` / `lark` 默认走原 Feishu adapter | 不影响现有飞书通道 |
| 新 adapter 名称 | `bridge-intent`，别名 `openclaw-intent` | 表达其本质：写意图，不直接发送消息 |
| intent 落盘位置 | `data/bridge/openclaw/intents/pending/` | 与 `data/channel/` 分离，避免污染现有 channel 状态机 |
| notify 成功语义 | 写入 intent 文件即视为 sent | 对 Channel Loop 来说，消息已投递给下一层表达系统 |
| target 解析 | bridge 配置优先，缺省用 subject | 避免 speech generation 因缺少 target 中断 |

### 3.3 配置预期

后续 subject 可以这样选择走 OpenClaw bridge：

```json
{
  "channels": {
    "presence": {
      "default_transport": "bridge-intent"
    },
    "bridge-intent": {
      "target": "jea-alpha"
    }
  }
}
```

如果不配置，默认仍走现有 Feishu 路径。

### 3.4 部署命令设计

第二阶段把上面的配置切换封装成 `jea bridge` 命令组：

```bash
jea bridge deploy --subject alpha --agent-id jea-alpha
jea bridge undeploy --subject alpha
jea bridge status --subject alpha
jea bridge intents list --subject alpha --status pending
```

关键决策：

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 部署入口 | 新增顶层 `jea bridge` | 这是跨 OpenClaw 的部署功能，不属于 Feishu 子命令 |
| 是否自动改 OpenClaw 配置 | 否，只生成 `openclaw-config-snippet.json5` | 避免越权修改另一个产品的用户配置 |
| 模式切换 | 修改 `channels.presence.default_transport` | 与现有 transport 解析机制一致 |
| undeploy 恢复 | 记录首次部署前 `previous_transport` | 支持从任意旧 transport 切回，不只是假定 Feishu |
| `AGENTS.md` 覆盖策略 | 默认不覆盖，`--force` 才重写 | 保护用户后续手工调整的 OpenClaw agent 指南 |

---

## 4. 实现要点

### 项目结构

```text
src/
├── channel/
│   ├── adapter-registry.mjs
│   ├── tasks.mjs
│   ├── transport.mjs
│   └── adapters/
│       ├── feishu/
│       └── bridge-intent/
│           └── index.mjs
├── bridge/
│   └── openclaw/
│       ├── deploy.mjs
│       ├── status.mjs
│       └── templates/
│           └── AGENTS.md.mjs
└── cli/
    ├── jea.mjs
    └── commands/
        └── bridge.mjs
```

### 关键模块

| 文件 | 职责 |
| --- | --- |
| [`src/channel/adapter-registry.mjs`](../../src/channel/adapter-registry.mjs) | 根据 `outbound.channel` 解析出站 adapter；保留 Feishu 默认兼容 |
| [`src/channel/adapters/bridge-intent/index.mjs`](../../src/channel/adapters/bridge-intent/index.mjs) | 将 outbound message 写为 OpenClaw bridge intent 文件 |
| [`src/channel/tasks.mjs`](../../src/channel/tasks.mjs) | `runChannelNotifyTask()` 从硬编码 Feishu 改为 adapter dispatch |
| [`src/channel/transport.mjs`](../../src/channel/transport.mjs) | 支持 `bridge-intent` / `openclaw-intent` 的 target 解析 |
| [`src/bridge/openclaw/deploy.mjs`](../../src/bridge/openclaw/deploy.mjs) | 实现 deploy/undeploy：切换 transport、生成 `AGENTS.md`、写 bridge 配置与 OpenClaw 配置片段 |
| [`src/bridge/openclaw/status.mjs`](../../src/bridge/openclaw/status.mjs) | 读取 bridge 状态并统计 pending/delivered/skipped intent |
| [`src/bridge/openclaw/templates/AGENTS.md.mjs`](../../src/bridge/openclaw/templates/AGENTS.md.mjs) | 生成 OpenClaw Agent 的 workspace 行为指南 |
| [`src/cli/commands/bridge.mjs`](../../src/cli/commands/bridge.mjs) | 注册 `deploy`、`undeploy`、`status`、`intents list` 子命令 |
| [`src/cli/jea.mjs`](../../src/cli/jea.mjs) | 将 `bridge` 注册为顶层 CLI 命令，并更新 help text |
| [`test/channel.test.mjs`](../../test/channel.test.mjs) | 增加 bridge-intent notify 路由测试 |
| [`test/cli.test.mjs`](../../test/cli.test.mjs) | 增加 bridge deploy/undeploy/status/intents 测试 |

### intent 文件形态

`bridge-intent` adapter 会在 subject runtime 下写入：

```text
runtime/subjects/<subject>/data/bridge/openclaw/intents/pending/*.json
```

文件内容保留原始 outbound，同时加上 bridge 语义：

```json
{
  "schema_version": 1,
  "type": "channel_outbound_intent",
  "subject": "alpha",
  "target": "jea-alpha",
  "channel": "bridge-intent",
  "outbound": {
    "text": "..."
  },
  "metadata": {
    "bridge": "openclaw"
  }
}
```

这不是最终用户消息，而是给 OpenClaw Agent Loop 的“待表达意图”。

### deploy 产物

`jea bridge deploy` 会在 subject runtime 下生成：

```text
runtime/subjects/<subject>/
├── AGENTS.md
└── data/bridge/openclaw/
    ├── config.json
    ├── intents/
    │   ├── pending/
    │   └── delivered/
    └── openclaw-config-snippet.json5
```

其中 `AGENTS.md` 明确告诉 OpenClaw Agent：

- 如何读取 JEA runtime；
- 如何消费 `intents/pending/`；
- 表达成功后如何移动到 `intents/delivered/`；
- 哪些用户输入应通过 `jea channel inbox put --stdin` 喂回 JEA classifier；
- 不得直接修改 evolution/intelligence/goals/channel runtime 数据。

---

## 5. 验证与测试

第一阶段运行了聚焦测试：

```bash
npm test -- test/channel.test.mjs
```

结果：

```text
Test Files  1 passed (1)
Tests       118 passed (118)
```

同时检查了编辑文件的 linter 诊断：

```text
No linter errors found.
```

新增测试覆盖了核心行为：

1. 配置 `presence.default_transport = "bridge-intent"`；
2. 写入一条 `channel: "bridge-intent"` 的 outbox；
3. 运行 `runChannelNotifyTask()`；
4. 确认 outbox 被标记为 sent；
5. 确认 `data/bridge/openclaw/intents/pending/` 中生成 intent 文件。

第二阶段实现 deploy 命令组后，扩展为运行：

```bash
npm test -- test/cli.test.mjs test/channel.test.mjs
```

最终结果：

```text
Test Files  2 passed (2)
Tests       248 passed (248)
```

新增测试覆盖了：

1. `deploy` 会把 `presence.default_transport` 写成 `bridge-intent`；
2. `deploy` 会生成 `AGENTS.md`、intent 目录和 OpenClaw 配置片段；
3. 重复 deploy 不覆盖已有 `AGENTS.md`；
4. `undeploy` 能恢复默认 Feishu fallback；
5. `undeploy` 能恢复部署前的显式 transport；
6. `status` 与 `intents list` 能读取 bridge 状态和 pending intent。

---

## 6. 后续演化

下一步不应该急着接 OpenClaw SDK。更稳的路径是继续把运行边界做实：

1. **真机部署一个 subject**
   运行 `jea bridge deploy --subject <name> --agent-id <id>`，把生成的 `openclaw-config-snippet.json5` 合入 OpenClaw，验证 Gateway 能加载该 agent workspace。

2. **验证 OpenClaw Agent 消费 intent**
   让 JEA Channel Loop 产生一条真实 presence intent，确认 OpenClaw heartbeat 能读取、表达并移动到 `delivered/`。

3. **补 skipped / archived 状态**
   当前 deploy 创建 `pending/` 和 `delivered/`，status 已能统计 `skipped/`。后续应明确 OpenClaw Agent 何时把过期或重复 intent 移到 `skipped/`。

4. **让 `bridge status` 更会诊断**
   未来可检查 `AGENTS.md` 是否存在、OpenClaw 配置片段是否过期、当前 channel daemon 是否仍在用旧 transport。

5. **保留 Feishu 直连能力**  
   `bridge-intent` 是新增 transport，不是替换 Feishu。需要继续保证默认配置下现有 Feishu channel 行为不变，并让 `undeploy` 保持可靠。

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 希望 JEA 介入 OpenClaw 生态，但不让 OpenClaw 替代 JEA Channel Loop |
| 思考 | Channel Loop 的价值是分类、presence、speech、control；OpenClaw 的价值是通用通道和最终对话表达；部署能力的本质是安全切换 transport |
| 方案 | 把 Channel Loop 出站改为 adapter dispatch，新增 `bridge-intent` adapter；再新增 `jea bridge deploy/undeploy/status` 把这套能力做成可切换部署功能 |
| 执行 | 新增 adapter registry、bridge adapter、deploy/status 模块、AGENTS 模板和 CLI 命令；补 deploy/undeploy 恢复逻辑 |
| 验证 | `npm test -- test/cli.test.mjs test/channel.test.mjs` 通过，248 个测试全部成功 |
