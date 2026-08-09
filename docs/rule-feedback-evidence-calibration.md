# Rule feedback evidence 单位标定（Phase 4）

- 日期：2026-08-09
- 关联：#33 Phase 4 / #39
- 状态：第一轮只读回放；**尚未启用生产 evidence 阈值**

## 方法

`jea goals feedback-compare --subject NAME --json` 对同一份历史 receipts 同时计算：

- `cycle`：每 goal 每 cycle 选一条最佳签名 receipt（当前生产语义）
- `evidence`：每条带 `serves_goal` 的 receipt 独立成桶

命令只读，不写 goals、questions、events 或 claim ledger。默认配置：

- cycle window = 8
- evidence window = 24
- dead / escalate / mutate cooldown 暂同为 3 / 5 / 2，仅用于暴露量纲差异

## 第一轮结果

### agentank-tank

- goals=6，cycle/evidence 有差异=5
- cycle：starved=3，escalate_eligible=1
- evidence：starved=3，escalate_eligible=3
- `iterate-skill-with-calibrated-sim-v28`：starved 4 cycles → 23 global serving evidence；因此直接沿用 escalate=5 会误放大报警
- `guard-memory-audit-v28`：签名 streak 7 cycles → 3 receipts（24 条窗口内）；receipt 密度和其他 goal 竞争使简单线性换算失真

### js-evolution-agent

- goals=2，有差异=1
- `safe-runtime`：starved 8 cycles → 24 global serving evidence
- 两模式均已 escalate；证据不足以独立标定 dead 签名阈值

## 结论

1. 3/5/2 不能直接从 cycle 搬到 evidence。
2. “同 goal 签名 streak”可逐 serving receipt 计数；“starved”若按全局其他 goal receipts 计数，会受 subject 活跃度与 goal 竞争显著影响，需独立阈值，或改为 per-goal 墙钟/相关证据窗口。
3. 当前只合入单位抽象与 replay；生产默认保持 `JEA_RULE_FEEDBACK_STREAK_UNIT=cycle`。

## 下一轮标定待办

- 增加独立 `starved` 阈值与候选策略对照（global evidence count vs wall-clock）
- 扩大 receipt limit，按历史时间点滚动回放，而非只看当前截面
- 统计状态转移、mutate 后 effective true/false/null、历史 operator question 结果
- 得到候选阈值后，仅在 `js-evolution-agent` 显式设置 evidence env，先 `JEA_GOAL_AUTO_APPLY=0` 观察
