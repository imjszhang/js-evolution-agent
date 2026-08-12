# Rule feedback evidence 单位标定（Phase 4）

- 日期：2026-08-09
- 关联：#33 Phase 4 / #39
- 状态：M1 滚动回放完成；**尚未启用生产 evidence 阈值**（M2 灰度入口见文末）

## 方法

### 第一轮（截面）

`jea goals feedback-compare --subject NAME --json` 对同一份历史 receipts 同时计算：

- `cycle`：每 goal 每 cycle 选一条最佳签名 receipt（当前生产语义）
- `evidence`：每条带 `serves_goal` 的 receipt 独立成桶

### M1（滚动历史截点）

```bash
jea goals feedback-compare --subject NAME --rolling 5 --receipt-limit 500 \
  --starved-strategy both --include-fp --json
```

- `--at TIMESTAMP`：单点 as-of（ISO 或 epoch ms）
- `--rolling N`：在 receipt 时间轴上均匀取 N 个截点，逐点截断 receipts/goal_events 后双跑
- `--starved-strategy global_count|wall_clock|both`：饥饿策略对照
- `--include-fp`：附带历史 `rule_feedback_escalated` 与 `trigger=rule_feedback_dead` questions
- **只读**：不写 goals / questions / events / claim ledger
- **已知偏差**：仍用**当前** `active_goals.json` 树与当前 guards/carryover，不重建历史目标树

默认配置（未设新 env 时行为与生产一致）：

- cycle window = 8；evidence window = 24
- dead = 3；starved 默认等于 dead（独立 env 未设时）
- escalate = 5；mutate cooldown = 2
- starved strategy 默认 `global_count`

## 第一轮结果（截面，保留）

### agentank-tank

- goals=6，cycle/evidence 有差异=5
- cycle：starved=3，escalate_eligible=1
- evidence：starved=3，escalate_eligible=3
- `iterate-skill-with-calibrated-sim-v28`：starved 4 cycles → 23 global serving evidence；因此直接沿用 escalate=5 会误放大报警

### js-evolution-agent

- goals=2，有差异=1
- `safe-runtime`：starved 8 cycles → 24 global serving evidence
- 两模式均已 escalate

## M1 结果（滚动回放，2026-08-09）

### agentank-tank — `global_count`

| as_of | receipts | cycle esc | evidence esc | cycle starved | evidence starved |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-05-28 | 1 | 0 | 0 | 0 | 0 |
| 2026-05-31 | 125 | 2 | 2 | 2 | 2 |
| 2026-06-04 | 250 | 2 | 2 | 2 | 2 |
| 2026-08-03 | 374 | 1 | 2 | 2 | 2 |
| 2026-08-09 | 500 | **1** | **3** | 3 | 3 |

状态转移：15 条（cutpoint 间 state/escalate/starved 变化）。

最新截面差异主因：`iterate-skill…` / `guard-readonly-learning-v29` 在 evidence 下 `starved_streak` 升到 14–23，越过 escalate=5，而 cycle 下未 escalate。

### agentank-tank — `wall_clock`（48h）

| as_of | receipts | cycle esc | evidence esc | cycle starved | evidence starved |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-05-28 | 1 | 3 | 3 | 3 | 3 |
| 2026-05-31 | 125 | 2 | 2 | 2 | 2 |
| 2026-06-04 | 250 | 1 | 1 | 1 | 1 |
| 2026-08-03 | 374 | 1 | 1 | 1 | 1 |
| 2026-08-09 | 500 | **2** | **2** | 2 | 2 |

最新截面：cycle/evidence escalate **对齐为 2**（与 cycle 历史频率同量级，+1）。早期截点因「从未服务」→ ∞ 小时，wall_clock 会偏严——适合活跃 subject，冷启动需配合观察。

### js-evolution-agent

- `global_count` 最新：cycle esc=1 / evidence esc=1（对齐）
- `wall_clock` 全程 escalate=1（沙盒目标稀疏，饥饿长期成立）
- 转移：global_count 4 / wall_clock 8

### 历史 FP / 漏报对照（`--include-fp`）

| subject | escalated events | questions | 备注 |
| --- | ---: | ---: | --- |
| agentank-tank | 2 | 2 | `guard-memory-audit-v28` dead streak=6 → resolved；`enforce-deep-analysis-and-switch` live/starved streak=0 → pending（饥饿 escalate，非签名死亡） |
| js-evolution-agent | 1 | 1 | `safe-runtime` live/starved → pending |

回放与历史事件一致：当前 cycle 模式也会对 starvation 打开 `rule_feedback_dead` question（文案仍写 death streak）。evidence + `global_count` 会把同类饥饿报警从 1 放大到 3（tank），属误报放大风险；`wall_clock` 将最新 esc 压回 2。

## M1 结论与候选阈值

1. **不能**把 cycle 的 3/5 直接搬进 evidence 的 `global_count` starved（tank：esc 1→3）。
2. **签名死亡**（dead）可继续按 serving evidence 计数，候选 `DEAD_STREAK=3` / `ESCALATE_STREAK=5`。
3. **饥饿**建议与 dead 解耦，evidence 灰度优先：
   - `JEA_RULE_FEEDBACK_STARVED_STRATEGY=wall_clock`
   - `JEA_RULE_FEEDBACK_STARVED_WINDOW_HOURS=48`
   - 备选：保留 `global_count` 但设 `JEA_RULE_FEEDBACK_STARVED_STREAK_EVIDENCE=12`（使 14–23 的噪声 streak 需更高才 escalate；仍不如 wall_clock 稳）
4. 与 cycle 历史触发频率等效：tank 最新 wall_clock evidence esc=2 vs cycle esc=1（±1）；global_count evidence esc=3 不可接受。

### 建议写入沙盒观察（M2，仍不写盘）

```bash
# 仅 js-evolution-agent；列车 agentank-tank 保持默认 cycle
export JEA_RULE_FEEDBACK_STREAK_UNIT=evidence
export JEA_RULE_FEEDBACK_STARVED_STRATEGY=wall_clock
export JEA_RULE_FEEDBACK_STARVED_WINDOW_HOURS=48
export JEA_RULE_FEEDBACK_STARVED_STREAK_EVIDENCE=12
export JEA_RULE_FEEDBACK_WINDOW_EVIDENCE=24
export JEA_GOAL_AUTO_APPLY=0
```

回滚：unset 上述变量即恢复 cycle 语义。

## 验收（M1）

1. ✅ 滚动回放可复现（同参数同 cutpoints）、只读
2. ✅ 报告给出 dead/escalate/starved/window 候选值及与 cycle 频率对照
3. ✅ 默认 env 行为零变化（`STARVED_STREAK` 缺省=dead；strategy 缺省 `global_count`）
