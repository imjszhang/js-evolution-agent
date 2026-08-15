# S9 删除清单

日期：2026-08-15
前置：S8 隔离晋升闸通过（`scripts/reactor-s8-promote-check.mjs` + `npm run reactor:canary`）。

忽略 `archives/` 与 `journal/` 历史叙述。

## 删除顺序

1. investigation 实现已迁到 `src/evolution/investigation/`；`src/evolution/agent-loop/` 只留 re-export，随后删除目录。
2. Daemon 列车调度：`run_cycle`、`workRunCycle`、`workRunCycleStep`。
3. `JEA_CYCLE_*` 子进程中继（`src/evolution/runner.mjs` subprocess 路径）。
4. Pipeline 双模：`agent_loop` / `phases` 解析改为明确报错。
5. Feature gates / compensation gates：行为固化为 S8 默认，删除门控模块。
6. CLI：`jea daemon enqueue --type run_cycle` 报错；`--pipeline agent_loop|phases` / `--loop` 报错。
7. 列车专用 e2e 改写为 reactor 等价覆盖或删除。

## 符号

- `workRunCycle` / `workRunCycleStep` / `run_cycle`
- `JEA_CYCLE_STEP` / `JEA_CYCLE_ID` / `JEA_CYCLE_DRIVER`
- `isEvidenceWakeEnabled` 等临时 gate（固化后删除）
- `isTickOpenCycleEnabled` / `isStepArtifactReconcileEnabled`（reactor 永远关）

## 状态（2026-08-15）

已完成：investigation 迁出、`agent-loop/` 删除、`run_cycle` / 列车 step 执行路径删除、`--pipeline agent_loop|phases` / `--loop` 报错、feature-gates 与 compensation-gates 模块删除。历史 cycle-state JSON 仍可读。

## 保留

- `jea run` 同步 reactor 链
- 历史 cycle-state JSON 可读
- `continuous` / `on_demand` 调度模式
- investigation 中性模块与 DeepSeek 重试 / 死 PID lock 回收
