# 反应器迁移观察期记录（Phase 3–6）

- 正式起算：**2026-08-13**（PR #41 合 main `bf06161`）
- **验收口径（已改为快速确认，不再等 2 周）**：5 轮沙盒 mock + 回滚对照 + 列车只读对照
- 关联：#33 / #34 / #39
- 沙盒主体：`js-evolution-agent`（reactor）
- 列车主体：`agentank-tank`（2026-08-14 registry 灰度 `reactor`；M5 默认代码路径亦切 `reactor`）

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

- 停写段（2026-08-13）：reactor 默认停写；agent_loop 当时仍写
- **删除段（2026-08-15）**：`writeCarryover*` 恒 no-op；agent_loop / diary 不再写盘或销账；读 leftover 保留

| 窗口 | coverage_gap | 备注 |
| --- | ---: | --- |
| 停写前累计 | 14 | 列车对照累计 8 |
| 快速 5 轮 | **0 新增** | 每轮日志 `carryover write skipped`；列车 registry 仍无 `pipeline: reactor` |

## 真实 DeepSeek 沙盒轮（2026-08-13，M5 前置）

### 修复前 — `cycle-20260812164012-8bca93f4`（~193s）

`JEA_FORCE_MOCK=0` + observe env：

| 项 | 结果 |
| --- | --- |
| honesty | 1 × `reactor_report_honesty` |
| calibrate | skipped（auto_apply=0） |
| carryover | 停写确认 |
| reconcile | ok |
| Decide 契约 | **未过**：`decision.action must be an object`；入队 1 条 `action` 为字符串、`type=undefined`，exec 跳过；另 skipped=2 |
| 其他 | investigate closing `tool_choice` 400（thinking 模式）；assess/diary ECONNRESET，日记 fallback |

脏队列 `cycle-20260812164012-8bca93f4:0` 已标 `cancelled`，不再进 exec。

### 修复后 — `cycle-20260812171800-58c1c0b6`（~294s）

宿主入队闸：`validateQueuedAction` 先走 `validateActionShape`；`normalizeAnalyzeDecision` 丢掉非对象 action。`JEA_FORCE_MOCK=0` + observe env：

| 项 | 结果 |
| --- | --- |
| honesty | 1 × `reactor_report_honesty`（findings_count=0） |
| calibrate | skipped（auto_apply=0） |
| carryover | 停写确认 |
| reconcile | ok（contract_error_count=0） |
| Decide 契约 | **已过**：入队 3 条均为对象且有 `action.type`（`record_observation` / `propose_probe` / `write_retrospective`）；`queued=3 skipped=1`；日志无 `decision.action must be an object` |
| skipped | 1 条 `agent_run` 因 `run_spec` 契约失败被拒（`primary_cwd_kind` / `expected_output`），未入队 |
| exec | 3 条因缺记录型必填 params 失败（`content` / `success_signal` 等）——属模型质量，不是非对象入队 |
| 其他 | closing `tool_choice` 400 后 ladder 回落到 `auto` 成功；assess/diary ECONNRESET，日记 fallback |

列车 `agentank-tank` registry 仍无 `pipeline: reactor`。

**结论（当时）：** 沙盒 mock 灰度可收口；真实 Decide **非对象 action 不再入队**。exec 缺 params 与 `tool_choice` 400 另跟。

### 必填 params + tool_choice 修复后（2026-08-13）

代码：reactor Decide prompt 注入 `actionRegistry.toPromptSection()`；`validateQueuedAction` 校验记录型必填字段；closing ladder 在 thinking≠off 时只用 `auto`；`agent_run` 契约抛错改为 skip。

mock 沙盒 `cycle-20260812173350-13dc7c3e`：`queued=3 skipped=0`，exec 三条全部 completed（`record_observation` / `propose_probe` / `write_retrospective`），无 `missing required field(s)`。

真实轮（observe env + `JEA_FORCE_MOCK=0`）：

| cycle | 结果 |
| --- | --- |
| `cycle-20260812173353-7168d7fe` | 入队闸未包住 `expected_output` 非数组时契约 `.some` 抛错，整轮失败（随后已改为 skip） |
| `cycle-20260812173641-e51343b8`（~157s） | closing 只用 `toolChoice="auto"`，**无 400**；decide ECONNRESET → queued=0；honesty=ok；calibrate skipped；carryover 停写；diary fallback |
| `cycle-20260812173928-95398dc1`（~273s） | 同样无 400；report/decide ECONNRESET → queued=0；honesty=ok；calibrate skipped；carryover 停写；reconcile ok |

live Decide 因 API `ECONNRESET` 未产出记录型决策，exec 缺 params 的真实路径本窗口未能复现；闸与 mock 路径已覆盖。closing **不再出现** `400 Thinking mode does not support this tool_choice`。

### 复测 — `cycle-20260814141428-973e3b50`（2026-08-14，~493s）

零成本复测（observe env + `JEA_FORCE_MOCK=0`；未改网络重试 / thinking 归一化）：

| 项 | 结果 |
| --- | --- |
| honesty | 1 × `reactor_report_honesty`（findings_count=0） |
| calibrate | skipped（auto_apply=0） |
| carryover | 停写确认 |
| reconcile | ok（contract_error_count=0） |
| Decide | **queued=4 skipped=0**；4 条均为对象且带 `action.type` + 必填 params |
| exec | 4/4 completed：`record_observation` ×2 / `propose_probe` / `write_retrospective`；无 `missing required field(s)` |
| closing | 仅 `toolChoice=auto`，**无 400** |
| 网络 | **无 ECONNRESET**；diary 走真实模型（非 fallback）；belief_update skipped（非网络失败） |

此前空盘挡住的「必填参数闸」真实正向样本已补上。ECONNRESET 在本窗口未复现，暂不升优先级做网络重试。

本 PR 另将 `normalizeThinkingMode('low'|'medium')` 改为 `off`（DeepSeek 仅 off/high/max；原先误升为 high，会覆盖 diary/channel 等 fast 默认）。reactor report/decide 显式传 `thinking: 'off'`。复测当时尚未改此映射。

**仍不过 M5**（当时列车未切 reactor；#34 未确认）。

## 双主体真实灰度（2026-08-14，#42 合 main 后）

未改 `resolveCyclePipeline` 默认值（仍 `agent_loop`）。沙盒继续 observe env；列车仅 registry 一行 `"pipeline": "reactor"`（gitignored，可回切）。

### 沙盒 `js-evolution-agent`（thinking=off 后连跑 3 轮）

| cycle | 时长 | Decide | exec | 备注 |
| --- | ---: | --- | --- | --- |
| `cycle-20260814145851-7c30f9a1` | ~358s | queued=4 skipped=1 | 4/4 completed | report/decide/diary `thinking=off` |
| `cycle-20260814150502-70f6daa3` | ~344s | queued=3 skipped=0 | 3/3 completed | 无 400 / 无 ECONNRESET |
| `cycle-20260814151053-df8c906f` | ~298s | queued=0 skipped=1 | 0（空盘，闸跳过） | 整轮仍完成；honesty=ok |

三轮均 `reactor_report_honesty=1`、calibrate skipped、carryover 停写、reconcile ok。第 3 轮空盘是模型只产出被闸跳过的 action，不是契约漏过。

### 列车 `agentank-tank`（registry 灰度 3 轮）

先放弃悬挂 `cycle-20260809053128-7b6da642`。`jea run --subject agentank-tank`（无 observe env）：

| cycle | 时长 | Decide | exec | 备注 |
| --- | ---: | --- | --- | --- |
| `cycle-20260814151622-05dfeb05` | ~359s | queued=2 skipped=2 | 3（含 credential-sync guard） | honesty=ok；calibrate applied（列车原有 auto_apply） |
| `cycle-20260814152233-c702a696` | ~529s | queued=4 skipped=0 | 6（含 credential-sync + memory-audit） | `run_evidence_audit` 等均 completed |
| `cycle-20260814153128-be27e074` | ~354s | queued=1 skipped=0 | 2（含 credential-sync） | calibrate skipped；carryover 停写 |

三轮均无 400 / 无 ECONNRESET；`reactor_report_honesty=3`（当日窗口）；列车 reconcile ok（`contract_error_count=0`）。mechanical guards 与 reactor 共存正常。

**M5 默认切换已确认**（#34，2026-08-14）：`resolveCyclePipeline` 默认改为 `reactor`。回切单个 subject：registry `"pipeline": "agent_loop"`。

**M5 tick / 产物对账**（2026-08-15）：reactor 默认不再因 heartbeat tick 自动开轮，也不按 step 产物假完成 running task。`JEA_TICK_OPEN_CYCLE=1` / `JEA_STEP_ARTIFACT_RECONCILE=1` 可恢复。法则清单 A 类逐条销账仍待后续 PR。

## M6 — 锚点

仍待 M5 之后：KV 对照、关 #33/#34/#39。
