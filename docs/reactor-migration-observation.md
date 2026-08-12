# 反应器迁移观察期记录（Phase 3–6）

- 正式起算：**2026-08-13**（PR #41 合 main `bf06161` + 沙盒悬挂 cycle 已放弃 + M2 env 生效）
- 关联：#33 / #34 / #39
- 沙盒主体：`js-evolution-agent`（reactor）
- 列车主体：`agentank-tank`（保持 `agent_loop`，直至 M5 过门）

入口（仅沙盒，勿写入项目根 `.env` / 列车 daemon）：

```bash
bash scripts/jea-sandbox-observe.sh run --mock
bash scripts/jea-sandbox-observe.sh run          # 真实 DeepSeek
node scripts/reactor-observe-check.mjs --subject js-evolution-agent --days 14
```

本地 overlay：`runtime/subjects/js-evolution-agent/.env.observe`（gitignore）。

## M2 — evidence 灰度（观察中）

**入口配置（由 `scripts/jea-sandbox-observe.sh` 注入）：**

```bash
export JEA_RULE_FEEDBACK_STREAK_UNIT=evidence
export JEA_RULE_FEEDBACK_STARVED_STRATEGY=wall_clock
export JEA_RULE_FEEDBACK_STARVED_WINDOW_HOURS=48
export JEA_RULE_FEEDBACK_STARVED_STREAK_EVIDENCE=12
export JEA_RULE_FEEDBACK_WINDOW_EVIDENCE=24
export JEA_GOAL_AUTO_APPLY=0
```

**验收目标：** ≥2 周或 ≥20 轮 assess；`rule_feedback_escalated` 与 cycle 模式历史频率同量级（±1）；回滚 = 不用 observe 脚本 / unset 上述 env。

历史对照（合 PR 前 cycle 模式）：沙盒累计 `rule_feedback_escalated=1`（`safe-runtime`，2026-08-05）。

| 日期 | assess 轮次 | escalated（窗口/累计） | 备注 |
| --- | ---: | --- | --- |
| 2026-08-09 | 0 | — | 入口文档就绪；时钟未正式起算（#41 未合） |
| 2026-08-13 | 0（起算日） | 14d=1 / all=1 | #41 已合；`JEA_GOAL_AUTO_APPLY=0`；wall_clock；悬挂 cycle 已 abandon |
| 2026-08-13 | 1（mock） | 本轮 0；累计 1 | `cycle-20260812161851-5f5e15d1`：honesty=1；calibrate skipped（auto_apply=0）；reconcile ok |

## M3 — 灰度加固（已完成演练）

- simulate / live real kill -9：见 `docs/reactor-migration-baseline.md` §6.1（2026-08-09 通过）
- 真实基线：sandbox reactor `cycle-20260809054010-ff341afa`（~588s，honesty=1）；列车 `cycle-20260809054015-ff185d6a`（~1336s，honesty=1）
- 每轮对账：`jea intel stream --reconcile` ok

## M4 — carryover 停写（第一段已启用；观察中）

- reactor 管道下默认**停写** carryover（读侧保留）
- 全局关闭：`JEA_CARRYOVER_WRITE=0`
- reactor 临时恢复写：`JEA_REACTOR_CARRYOVER_WRITE=1`
- 观察 ≥2 周：对照 `decide_coverage_gap` 频率与 deferred 复现率
- 通过后删除写侧代码并销账 `docs/reactor-migration-rule-inventory.md`

| 窗口 | coverage_gap 次数 | 备注 |
| --- | ---: | --- |
| 停写前（沙盒累计至 2026-08-13） | 14（近 14 天=14） | 列车对照累计 8 / 近 14 天 8；列车仍写 carryover |
| 停写后起点 2026-08-13 | 本轮 0 | `cycle-20260812161851-5f5e15d1` 日志：`carryover write skipped (carryover_write_disabled)` |

## M5 — 列车退役（单向门，未执行）

**前置 checklist（全部打勾后，需 #34 留言确认）：**

- [ ] 每个 subject ≥2 周 reactor 无回切
- [ ] 三不变量（诚实/治理/可恢复）在每个 subject 验证
- [ ] M2 evidence 观察通过
- [ ] M4 carryover 观察通过并完成删除段
- [ ] 操作者在 #34 明确确认执行

**禁止在未确认时**切换默认 pipeline 或删除 `JEA_CYCLE_*` 补偿法则。

## M6 — 锚点

- KV/token 对照 M3 真实基线（+10% 上限）
- 更新机制图 / AGENTS / OWNERSHIP
- 关闭 #33 / #34 / #39
