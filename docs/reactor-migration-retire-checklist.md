# M5 列车退役单向门 Checklist

**状态：未执行（需确认）**  
关联：#33 Phase 6 / #34

在**全部**勾选且 #34 有操作者明确确认留言之前，**禁止**：

- 将默认 `resolveCyclePipeline` 改为 `reactor`
- 删除 tick 开轮 / reconcile / `JEA_CYCLE_*` 补偿法则
- 对法则清单 ~17 条批量销账为「已删除」

## 过门条件

| # | 条件 | 状态 |
| --- | --- | --- |
| 1 | 每个 subject 各自 ≥2 周 reactor 无回切 | ⏳ 仅沙盒 `js-evolution-agent` 已开 reactor |
| 2 | 三不变量（诚实 / 治理 / 可恢复）在每个 subject 验证 | ⏳ 沙盒部分验证；列车未切 reactor |
| 3 | M2 evidence 灰度观察通过 | ⏳ 观察入口已就绪 |
| 4 | M4 carryover 停写观察通过并完成删除段 | ⏳ 停写已启用；观察中 |
| 5 | #34 留言确认执行 | ❌ 未确认 |

## 确认后执行顺序（勿提前）

1. 默认 pipeline → `reactor`（registry + `resolveCyclePipeline` default）
2. 删除/停用 tick 开轮与 step reconcile 补偿
3. 法则清单 A 类逐条销账并附证据链接
4. 全量回归 + 多 subject 冒烟
5. 进入 M6 锚点验收
