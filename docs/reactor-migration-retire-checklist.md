# M5 列车退役单向门 Checklist

**状态：默认切换进行中（#34 已确认）**  
观察期正式起算：**2026-08-13**（PR #41 合 main；见 `docs/reactor-migration-observation.md`）  
关联：#33 Phase 6 / #34  
确认留言：https://github.com/imjszhang/js-evolution-agent/issues/34#issuecomment-5295423845

## 过门条件

| # | 条件 | 状态 |
| --- | --- | --- |
| 1 | 每个灰度 subject 真实 reactor 无回切（快速确认，不等 2 周） | **通过**：沙盒 3 轮 + 列车 3 轮（2026-08-14） |
| 2 | 三不变量（诚实 / 治理 / 可恢复）在每个 subject 验证 | **通过**：两边真实路径 honesty=ok、无 400 / 无 ECONNRESET、reconcile ok |
| 3 | M2 evidence 灰度观察通过 | **通过**：快速 5 轮 mock（2026-08-13） |
| 4 | M4 carryover 停写观察通过并完成删除段 | 停写段通过；**删除段另开 PR，不挡本次切换** |
| 5 | #34 留言确认执行 | **已确认**（2026-08-14） |

## 确认后执行顺序

1. **进行中**：默认 pipeline → `reactor`（`resolveCyclePipeline` default + 文档）
2. 删除/停用 tick 开轮与 step reconcile 补偿（后续 PR）
3. 法则清单 A 类逐条销账并附证据链接（后续 PR）
4. 全量回归 + 多 subject 冒烟
5. 进入 M6 锚点验收
