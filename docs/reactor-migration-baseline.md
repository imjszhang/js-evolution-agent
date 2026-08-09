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
path = "runtime/subjects/agentank-tank/data/intelligence/evolution_events/evolution-events.jsonl"
for line in open(path):
    e = json.loads(line)
    if e.get("cycle_id") == cycle:
        print(e.get("type"), e.get("status"))
PY
```

期望：事件 **type 集合** 与上表一致（顺序可因反应器驱动变化）；honesty 计数仍为 1；无新增 `evolution_event contract invalid`。

---

## 5. 待补

- [ ] 真实 DeepSeek 轮 token / 时长基线（`jea run` 无 `--mock`）
- [ ] 多 subject 基线（`js-evolution-agent` sandbox）
- [x] Phase 1 读侧投影对账：`jea intel stream --reconcile`（`contract_errors=0` 为通过；见 `src/intelligence/evidence-stream.mjs`）
