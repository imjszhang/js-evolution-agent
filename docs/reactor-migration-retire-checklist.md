# M5 列车退役单向门 Checklist

**状态：M5 完成（#43/#45/#46）；M6 锚点通过（KV #47 + honesty/kill-9）**  
观察期正式起算：**2026-08-13**（PR #41 合 main；见 `docs/reactor-migration-observation.md`）  
关联：#33 Phase 6 / #34  
确认留言：https://github.com/imjszhang/js-evolution-agent/issues/34#issuecomment-5295423845

## 过门条件

| # | 条件 | 状态 |
| --- | --- | --- |
| 1 | 每个灰度 subject 真实 reactor 无回切（快速确认，不等 2 周） | **通过**：沙盒 3 轮 + 列车 3 轮（2026-08-14） |
| 2 | 三不变量（诚实 / 治理 / 可恢复）在每个 subject 验证 | **通过**：两边真实路径 honesty=ok、无 400 / 无 ECONNRESET、reconcile ok |
| 3 | M2 evidence 灰度观察通过 | **通过**：快速 5 轮 mock（2026-08-13） |
| 4 | M4 carryover 停写观察通过并完成删除段 | **通过**：停写段 + 删除段（写侧 no-op，diary 销账停用，读 leftover 保留） |
| 5 | #34 留言确认执行 | **已确认**（2026-08-14） |

## 确认后执行顺序

1. **完成**：默认 pipeline → `reactor`（PR #43，`resolveCyclePipeline` default + 文档）
2. **完成**：停用 tick 自动开轮与 step 产物对账补偿（reactor 默认关；`JEA_TICK_OPEN_CYCLE=1` / `JEA_STEP_ARTIFACT_RECONCILE=1` 可恢复；abandon stale / 缺步入队保留）
3. **完成**：法则清单 A 类逐条销账（§15）；已消解挂 #44/#45；残留标专项。生产调用删除：operator_fact 迁移、channel 启动自动 purge
4. **完成**（2026-08-15）：全量回归 1043 passed / 7 skipped；三 subject mock 冒烟（`feishu-flow-test` 走默认 reactor、沙盒、列车含 memory-audit guard）均整轮 closed
5. **完成**（2026-08-15）：M6 锚点——KV 度量对照列车基线（reactor 合计 ~5.3 万 tokens ≪ 554273）；live honesty e2e 硬断言；kill-9 simulate + live 演练 claims 无悬挂、reconcile ok
