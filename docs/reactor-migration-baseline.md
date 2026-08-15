# 反应器迁移 mock 基线（Phase 0）

- 日期：2026-08-09
- 状态：基线快照（对账用，非性能承诺）
- 关联：#34 Phase 0；主体 `agentank-tank`；pipeline `agent_loop`（default）
- 录制命令：`npm run jea -- run --mock`

后续 Phase 1–3 灰度须与此基线对比：**决策产出 / honesty / evolution 事件类型 / 时长** 无意外退化。Token 成本在 mock 轮为 0（无真实 LLM）；真实 DeepSeek 基线待单独录制。

---

## 1. 运行摘要

| 项 | 值 |
| --- | --- |
| cycle_id | `cycle-20260808234352-717bad82` |
| subject | `agentank-tank` |
| pipeline | `agent_loop` |
| 墙钟时长 | ~7.8s |
| agent_loop success | true |
| decisions queued | 3 |
| exec executed | 4（含 1 mechanical guard） |
| verify verified | 4 |
| goals_calibrate | skipped |
| semantic verify | failed（mock 预期：无法解析 JSON 报告） |
| evolution_event contract warnings | **0** |

---

## 2. evolution-events 事件清单（本 cycle）

| type | status |
| --- | --- |
| agent_loop_turn | ok |
| agent_loop_report_honesty | ok |
| decide_coverage_gap | gap |
| standing_memory_update | updated |
| agent_loop_pipeline | ok |
| agent_loop_guard_executed | ok |
| exec_pipeline | ok |
| verify_pipeline | ok |
| belief_update | skipped |
| goals_assess | ok |
| goals_calibrate | skipped |
| evolution_diary | ok |

**合计：12 条**（含 1 条 honesty、1 条 coverage_gap）

---

## 3. 验收不变量（本基线已满足）

1. **诚实**：存在且仅一条 `agent_loop_report_honesty`（type 级计数 = 1）
2. **治理**：exec 走审批闸；mock 轮无 blocked 决策
3. **契约**：`recordEvolutionEvent` warn 模式下无 schema 告警

---

## 4. 对账用法

迁移阶段每步灰度后重跑 `jea run --mock`（或真实轮），对比：

```bash
# 提取某 cycle 的事件 type 列表
python3 - <<'PY'
import json, sys
cycle = sys.argv[1] if len(sys.argv) > 1 else "cycle-20260808234352-717bad82"
path = "<JEA_HOME>/subjects/agentank-tank/data/intelligence/evolution_events/evolution-events.jsonl"
for line in open(path):
    e = json.loads(line)
    if e.get("cycle_id") == cycle:
        print(e.get("type"), e.get("status"))
PY
```

期望：事件 **type 集合** 与上表一致（顺序可因反应器驱动变化）；honesty 计数仍为 1；无新增 `evolution_event contract invalid`。

---

## 5. 待补 / 已补

- [x] Phase 1 读侧投影对账：`jea intel stream --reconcile`（`contract_errors=0` 为通过；见 `src/intelligence/evidence-stream.mjs`）
- [x] 真实 DeepSeek 轮时长基线（§6.2）
- [x] 多 subject 基线（sandbox reactor + 列车 agent_loop）
- [ ] reactor 路径完整 prompt-cache 汇总日志（列车已有；reactor 本轮未打出同款 `[prompt-cache …]` 行，M6 对照时补齐）

---

## 6. Phase 3 可恢复演练 + 真实基线（M3）

### 6.1 kill -9 / claim 过期回收

工具：`node scripts/reactor-kill9-drill.mjs`

| 模式 | 命令 | 结果（2026-08-09） |
| --- | --- | --- |
| simulate | `… simulate --subject js-evolution-agent` | ✅ 过期 claimed → failed；无悬挂 claimed |
| live mock | `… live --mock --delay-ms 800` | claim 无悬挂；reconcile ok；mock 过短难命中中段 |
| **live real** | `… live --delay-ms 12000`（无 mock） | ✅ **kill -9 命中中段**；`expired_after_kill=1`；`claimed_hanging_final=0`；`duplicate_growth=[]`；`evidence_reconcile_ok=true` |

验收口径（已满足）：

1. kill/过期后 `claims` 无悬挂 `claimed`
2. 重跑后证据流 reconcile ok
3. 无**新增** fingerprint 重复（相对 kill 前）

注意：kill -9 后须清理 `<JEA_HOME>/subjects/<ns>/data/evolution/.evolve.lock.lock` 的 orphan proper-lockfile，否则下轮报 `subject_already_running`。

### 6.2 真实 DeepSeek 基线（2026-08-09，`JEA_FORCE_MOCK=0`）

| subject | pipeline | cycle_id | 墙钟 | prompt tokens（日志合计） | honesty/批 | reconcile |
| --- | --- | --- | ---: | ---: | ---: | --- |
| js-evolution-agent | reactor | `cycle-20260809054010-ff341afa` | **~588s** | （reactor 本轮未输出 `[prompt-cache]` 汇总；见待补） | **1** `reactor_report_honesty` | ok / 0 errors |
| agentank-tank | agent_loop | `cycle-20260809054015-ff185d6a` | **~1336s** | investigate 146406 + report 70967 + decide 336900 = **554273**（hit 150272 / miss 404001） | **1** `agent_loop_report_honesty` | ok / 0 errors |

沙盒 reactor 事件 type 集合：`agent_loop_turn`×4、`agent_loop_closing_turn`、`reactor_report_honesty`、`reactor_pipeline`、`reactor_reaction_completed`、`exec_pipeline`、`verify_pipeline`、`belief_update`、`goals_assess`、`goals_calibrate`、`evolution_diary`。  
日记确认 carryover 停写：`[diary] carryover write skipped (carryover_write_disabled); pipeline=reactor`。  
备注：Decide 曾产出 3 条缺 `action.type` 的决策（contract invalid 后仍入队 3 条），exec 跳过；属真实模型质量问题，记入基线，不阻塞可恢复验收。列车主体行为未改 pipeline。

### 6.3 M6 KV/token 对照锚点

列车（agent_loop）prompt 合计 **554273** 作为对照锚。reactor 已补同款 usage 汇总（PR #47）。沙盒两轮合计 **52989 / 55954**（hit_ratio 0.34–0.38），低于基线 +10%。详见 `docs/reactor-migration-observation.md` M6。
