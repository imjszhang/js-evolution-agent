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
| `adapters/feishu/*` | SDK、解析、发送、策略、WS listener | 写 intelligence、调 LLM、读 cycle |
| `channel_ingest` | brief/fact/observation 分类 | 直接发飞书 |
| `channel_notify` | 消费 outbox 并调用 adapter 发送 | 决定通知文案策略（由 watch 生成） |
| Cowork `feishu-module` | **仅作参考** | 不作为 npm/runtime 宿主 |

## 3. 实现要点

新增 [`src/channel/adapters/feishu/`](../../src/channel/adapters/feishu/)：

- `config.mjs`：`resolveFeishuConfig`（env + `subjects.json` 的 `channels.feishu`）
- `client.mjs` / `sender.mjs`：官方 SDK 收发
- `parser.mjs`：`normalizeInboundPayload` / `envelopeFromFeishuEvent`
- `policy.mjs`：DM/群聊白名单、@提及
- `monitor.mjs` + `listener.mjs`：WS → `writePendingInbound` → 可选 `channel_ingest` 入队
- `index.mjs`：对外 `sendOutboundMessage`

删除 [`src/channel/adapters/openclaw-lark.mjs`](../../src/channel/adapters/openclaw-lark.mjs)。

[`daemon.mjs`](../../src/cli/commands/daemon.mjs) 的 `runChannelDomainWorker` 在 worker 生命周期内 `startFeishuListener` / `stopFeishuListener`（`--no-feishu-listener` 可关）。

依赖：[`package.json`](../../package.json) 增加 `@larksuiteoapi/node-sdk`。

## 4. 验证

```bash
npm install
npm run test -- --run test/feishu-adapter.test.mjs test/channel.test.mjs
JEA_CHANNEL_FEISHU_MOCK=1 npm run jea -- channel send --to oc_test --text hello
```

## 5. 多 subject 机器人

每个 subject 在 `policies/subjects.json` 的 `channels.feishu` 下配置独立 `app_id`、`app_secret_env`、`default_chat_id`；或使用 `JEA_CHANNEL_FEISHU_<SUBJECT>_APP_ID` 环境变量。出站 sender 与 WS listener 按 subject+credentials 缓存，互不串用。

## 6. 后续

- Viewer 展示 `projection.feishu.listener` 连接态
- 卡片消息与富媒体入站
- 将 `channels.lark` 兼容层在文档中标记移除时间表
