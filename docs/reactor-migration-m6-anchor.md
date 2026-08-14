# M6 锚点验收草稿

- 日期：2026-08-13（观察期正式起算；token 锚点仍用 2026-08-09 M3 基线）
- 状态：**部分完成**（依赖 M5 过门后关 epic；**不得提前关 #33**）
- 关联：#33 / #34 / #39

## Token / KV 对照

| 锚点 | 值 | 来源 |
| --- | --- | --- |
| 列车 agent_loop prompt 合计 | 554273（hit 150272） | `cycle-20260809054015-ff185d6a` 日志 |
| 沙盒 reactor 墙钟 | ~588s | `cycle-20260809054010-ff341afa` |
| 列车墙钟 | ~1336s | 同上表 |
| reactor prompt 合计 | **待补** | reactor 路径需确认 `[prompt-cache …]` 汇总日志打点 |

验收目标：证据批组织 KV 前缀后，reactor token ≤ 列车基线 +10%（同 subject 同工作负载时对照；跨 subject 仅作量级参考）。

## 文档收尾清单

- [x] `docs/rule-feedback-evidence-calibration.md` M1
- [x] `docs/reactor-migration-baseline.md` M3
- [x] `docs/reactor-migration-observation.md` M2/M4 观察入口
- [x] `docs/reactor-migration-retire-checklist.md` M5 单向门
- [x] `docs/reactor-migration-rule-inventory.md` carryover 停写标注
- [x] `src/intelligence/AGENTS.md` 操作指引
- [ ] 机制图与 OWNERSHIP 在 M5 过门后最终对齐
- [ ] 关闭 #33 / #34 / #39（**仅在 M5 确认并执行后**）

## 不可提前关闭

在 M5 checklist 未全部勾选且 #34 无确认留言前，不得关闭 epic #33。
