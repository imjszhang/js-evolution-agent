# Classifier Understanding 透传到 Presence Planner

> 日期：2026-06-04  
> 项目：js-evolution-agent  
> 类型：架构改进 / 功能实现

---

## 动机

Channel loop 中 classifier 与 presence planner 是两次独立 LLM 调用，但 classifier 的 `rationale`、`confidence` 等理解结果未传递到 planner。Planner 仅看到 500 字截断 + `ingest_kind`，难以稳定判断何时 `start_agent_async`。此外 `approval_request` / `verification_request` 的 fast ack 会短路 planner，复合意图（「先帮我查 rank 再审批」）的调查部分被丢弃。

## 方案

不合并两次 LLM 调用，而是在 classifier 输出中增加结构化 `understanding`，沿数据流透传到 expression candidates：

| 字段 | 含义 |
| --- | --- |
| `user_intent` | 用户想要什么（自然语言） |
| `needs_immediate_action` | 是否需要系统立刻做事 |
| `action_hint` | 只读调查 objective 提示 |
| `temporal` | `now` / `next_cycle` / `ongoing` |
| `complexity` | `low` / `medium` / `high` |

## 数据流

```text
classifier (LLM/deterministic)
  → inbound/processed (classifier.understanding)
  → summarizeRecentIngested
  → buildExpressionCandidates
  → planPresence
```

## 行为变更

1. **Fast ack 旁路**：任一 brief 候选 `needs_immediate_action === true` 时，不执行 `planPresenceOperatorBriefFastAck`，进入 LLM 完整审议。
2. **Deterministic planner**：满足 `needs_immediate_action` + `temporal=now` + `complexity≠high` 时，可产出 `start_agent_async` + ack。
3. **LLM planner prompt**：明确使用候选上的 `understanding` 做 agent / brief 决策。

## 主要文件

- `src/channel/classifier-understanding.mjs`（新建）
- `src/channel/classifier.mjs`
- `src/channel/ingest.mjs`
- `src/channel/presence-context.mjs`
- `src/channel/expression-candidates.mjs`
- `src/channel/presence-planner.mjs`
- `test/channel.test.mjs`

## 验证

- `npm run test -- test/channel.test.mjs`：83 passed
- `npm run test`：625 passed
