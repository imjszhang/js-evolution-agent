# Feishu Adapter 解耦：弃用 openclaw-lark，内置官方 SDK 传输层

> 日期：2026-06-02  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现  
> 来源：Cursor Agent 对话

---

## 1. 背景与动机

Channel 域已用 `openclaw-lark` 做薄封装，但团队已有 Deepseek-Cowork 的 `feishu-module`（`@larksuiteoapi/node-sdk` + WebSocket），且不希望继续依赖 OpenClaw 插件生态。

目标：在 JEA 内建立**独立、可解耦**的飞书 adapter，保留现有 channel ingest/outbox/OADA 边界。

## 2. 解耦原则

| 层 | 职责 | 禁止 |
| --- | --- | --- |
| `adapters/feishu/*` | SDK、解析、发送、策略、WS listener、绑定握手 | 写 intelligence、调 LLM、读 cycle |
| `channel_ingest` | brief/fact/observation 分类 | 直接发飞书 |
| `channel_notify` | 消费 outbox 并调用 adapter 发送 | 决定通知文案策略（由 watch 生成） |
| Cowork `feishu-module` | **仅作参考** | 不作为 npm/runtime 宿主 |

## 3. 实现要点

### 3.1 模块结构

新增 [`src/channel/adapters/feishu/`](../../src/channel/adapters/feishu/)：

| 模块 | 作用 |
| --- | --- |
| `config.mjs` | `resolveFeishuConfig`：per-subject 凭证、`bind` 设置、合并 runtime 绑定 |
| `client.mjs` / `sender.mjs` | 官方 SDK 收发；`ou_` → `open_id`，`oc_` → `chat_id` |
| `parser.mjs` | `normalizeInboundPayload` / `envelopeFromFeishuEvent`；导出 `parseTextContent` |
| `policy.mjs` | DM/群白名单、`@` 提及；绑定握手消息在 allowlist 前放行 |
| `binding.mjs` | `JEA BIND` 口令绑定、持久化、`tryHandleFeishuBind` |
| `monitor.mjs` + `listener.mjs` | WS → 绑定处理 → `writePendingInbound` → `channel_ingest` 入队 |
| `index.mjs` | 对外 `sendOutboundMessage`；sender 按 `subject+appId+secret` 缓存 |

删除 [`src/channel/adapters/openclaw-lark.mjs`](../../src/channel/adapters/openclaw-lark.mjs)。

[`daemon.mjs`](../../src/cli/commands/daemon.mjs) 的 `runChannelDomainWorker` 在 worker 生命周期内 `startFeishuListener` / `stopFeishuListener`（`--no-feishu-listener` 可关）。

[`tasks.mjs`](../../src/channel/tasks.mjs) 的 `channel_ingest` 对绑定消息同样走 `tryHandleFeishuBind`（兼容 `channel inbox put` 路径）。

依赖：[`package.json`](../../package.json) 增加 `@larksuiteoapi/node-sdk`。

### 3.2 Per-subject 机器人

每个 subject 在 `policies/subjects.json` 的 `channels.feishu` 配置独立机器人：

- `app_id` + `app_secret_env`（**不要**明文 secret）
- 可选 `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` / `_APP_SECRET` / `_DEFAULT_CHAT_ID` 环境变量
- 解析优先级：**subjects.json → subject 前缀 env → 全局 env**
- 出站 sender 与 WS listener 按 `subject + credentials` 分桶，多 subject 需**各起一个** `jea daemon start --subject X --domain channel`

### 3.3 私聊优先（`ai-researcher` 示例）

```json
"channels": {
  "feishu": {
    "enabled": true,
    "app_id": "cli_xxxx",
    "app_secret_env": "FEISHU_AI_RESEARCHER_APP_SECRET",
    "domain": "feishu",
    "dm_policy": "allowlist",
    "allow_from": [],
    "group_policy": "disabled",
    "bind": {
      "enabled": true,
      "phrase": "JEA BIND",
      "token_env": "JEA_CHANNEL_FEISHU_AI_RESEARCHER_BIND_TOKEN"
    }
  }
}
```

- 群聊：`group_policy: disabled` 忽略所有群消息
- 未绑定前：仅放行与 `bind.phrase` 匹配的私聊握手；其它 DM 被拒
- 绑定后：`allow_from` / `defaultChatId` 自动设为操作者 `open_id`（`ou_`）

### 3.4 口令绑定（`JEA BIND`）

1. `.env` 设置 `JEA_CHANNEL_FEISHU_<SUBJECT>_BIND_TOKEN`（或 `bind.token` / `bind.token_env`）
2. `jea daemon start --subject NAME --domain channel`（需飞书后台 **长连接** + `im.message.receive_v1`）
3. 私聊机器人：`JEA BIND <口令>`（默认短语 `JEA BIND`，可 `bind.phrase` 自定义）
4. 写入 runtime（不进 intelligence）：

   ```text
   runtime/subjects/<data_namespace>/data/channel/feishu-operator-binding.json
   ```

5. 机器人回复确认；审计事件 `feishu_operator_bound` / `feishu_bind_failed`
6. 覆盖他人绑定：需正确口令；同一 `open_id` 可重绑刷新

`jea channel status --json` → `feishu.config.operator`（`bound`、`open_id` 脱敏）。

**注意**：`feishu.listener.running` 仅在**同一 daemon 进程**内为 true；另开 CLI 查 status 常为 false，以 `events.jsonl` 的 `feishu_listener_started` / `feishu_listener_connected` 为准。

## 4. 验证

### 4.1 自动化

```bash
npm install
npm run test -- --run test/feishu-adapter.test.mjs test/feishu-binding.test.mjs test/channel.test.mjs
```

### 4.2 本地冒烟

```bash
# mock 出站
JEA_CHANNEL_FEISHU_MOCK=1 npm run jea -- channel send --to ou_test --text hello --dry-run

# 真实链路（需凭证 + daemon）
npm run jea -- daemon start --subject ai-researcher --domain channel
# 私聊: JEA BIND <token>
npm run jea -- channel status --subject ai-researcher --json
npm run jea -- channel send --subject ai-researcher --to <ou_xxx> --text "JEA outbound test"
npm run jea -- channel work notify --subject ai-researcher   # 无 daemon 时手动 flush outbox
```

### 4.3 联调记录（2026-06-02）

| 步骤 | 结果 |
| --- | --- |
| 配置 `cli_aa970a50f4b8dcdd` + `.env` secret | `hasAppSecret: true` |
| 旧 worker（无 listener）期间发 BIND | **未收到**（无 `feishu_listener_*` 事件） |
| `daemon stop` + `daemon start --domain channel` | `feishu_listener_connected` |
| 私聊 `JEA BIND 1234567890` | `feishu_operator_bound`，`operator.bound: true` |
| `channel send` + daemon `channel_notify` | 两条 `channel_message_sent`（测试文案 + watch 告警），用户确认收到 |

**运维教训**：更换 adapter 或首次接 listener 后必须**重启 channel daemon**；否则 WS 不在旧进程内，私聊无法入站。

## 5. 文档与配置

- [`AGENTS.md`](../../AGENTS.md)：Channel 通道、per-subject 变量表、**私聊绑定（JEA BIND）**
- [`.env.example`](../../.env.example)：`FEISHU_*`、`BIND_TOKEN` 占位
- [`policies/subjects.example.json`](../../policies/subjects.example.json)：DM + `bind` 示例

## 6. 后续

- Viewer 展示 `projection.feishu.listener` 连接态（跨进程状态需从 events 推断）
- `channel send` 省略 `--to` 时默认使用绑定 `open_id`
- 卡片消息与富媒体入站
- 将 `channels.lark` 兼容层在文档中标记移除时间表
