# Channel 多 Worker 与 LLM 批量分类

> 日期：2026-06-03

## 变更摘要

- `jea daemon start --domain channel` 默认启动 `notify`、`presence`、`speech`、`classifier` 四个 role worker，按任务类型隔离领取。
- 新增 `channel_classifier`：固定 `interval_ms` 批量处理 `inbound/pending`（旧到新，`batch_size` 上限），LLM 受限 schema 分类后落盘。
- `runPresenceReactor` 不再调用 `drainChannelInbound`；presence 只读已分类结果与 `pending_unclassified_count`。
- `claimNextTask` 支持 `types[]`；`worker-state.json` 使用 `workers` map 记录各 role 健康态。

## 主要模块

| 文件 | 职责 |
| --- | --- |
| `src/channel/channel-roles.mjs` | role → task types、`--channel-role(s)` 解析 |
| `src/channel/classifier-config.mjs` | `channels.classifier` 配置 |
| `src/channel/classifier.mjs` | 批量分类任务 |
| `src/channel/domain-worker.mjs` | 多 role 循环与协调器 tick |
| `src/channel/worker-state.mjs` | 多 worker 状态 |

## 配置示例

见 `AGENTS.md` 中 `channels.classifier` 与多 role 启动说明。
