# 反应器迁移观察期记录（Phase 3–6）

- 正式起算：**2026-08-13**（PR #41 合 main `bf06161`）
- **验收口径（已改为快速确认，不再等 2 周）**：5 轮沙盒 mock + 回滚对照 + 列车只读对照
- 关联：#33 / #34 / #39
- 沙盒主体：`js-evolution-agent`（reactor）
- 列车主体：`agentank-tank`（保持 `agent_loop`，直至 M5 过门）

入口（仅沙盒，勿写入项目根 `.env` / 列车 daemon）：

```bash
bash scripts/jea-sandbox-observe.sh run --mock
node scripts/reactor-observe-check.mjs --subject js-evolution-agent --days 1
```

## M2 — evidence 灰度：快速通过

入口由 `scripts/jea-sandbox-observe.sh` 注入：`STREAK_UNIT=evidence`、`STARVED_STRATEGY=wall_clock`、`STARVED_WINDOW_HOURS=48`、`STARVED_STREAK_EVIDENCE=12`、`WINDOW_EVIDENCE=24`、`JEA_GOAL_AUTO_APPLY=0`。

历史对照：合 PR 前沙盒累计 `rule_feedback_escalated=1`。

| 日期 | assess 轮次 | 本轮 escalated | 备注 |
| --- | ---: | ---: | --- |
| 2026-08-13 | 5（mock 连跑） | **0** | 每轮 `reactor_report_honesty=1`；calibrate skipped；reconcile ok |

快速验收：

1. 5 轮均 honesty=1，无新增 `rule_feedback_escalated`（累计仍为 1，相对历史 ±0）
2. cycle vs evidence 最新截面 escalate 对齐为 1，无误报放大
3. 回滚：unset observe env → `streakUnit=cycle`、`starvedStrategy=global_count`、`starvedStreak=deadStreak=3`、`JEA_GOAL_AUTO_APPLY` 默认开启

## M3 — 灰度加固（已完成）

见 `docs/reactor-migration-baseline.md` §6。

## M4 — carryover 停写观察：快速通过（停写段）

- reactor 默认停写；agent_loop 仍写
- 删除写侧代码仍另开 PR，不在本次做

| 窗口 | coverage_gap | 备注 |
| --- | ---: | --- |
| 停写前累计 | 14 | 列车对照累计 8 |
| 快速 5 轮 | **0 新增** | 每轮日志 `carryover write skipped`；列车 registry 仍无 `pipeline: reactor` |

## M5 — 列车退役（仍未执行）

快速验收覆盖沙盒 M2/M4 停写段，**不**等于过 M5 单向门。仍需明确说「执行 M5」才会切默认 pipeline。

## M6 — 锚点

仍待 M5 之后：KV 对照、关 #33/#34/#39。
