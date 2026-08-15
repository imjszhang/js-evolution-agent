# 反应器目标态 S0 观察基线

- 日期：2026-08-15
- 采集时间：2026-08-15 02:26 CST
- 分支：`feat/reactor-target-s0-s9`
- 状态：只读观察，未改运行时数据

本基线记录 S0 立项时的契约、健康口径与三 subject 实测。后续 S1–S9 用同一套字段对照，不把旧 `stuck_steps` / `progress_stalled` 当作 reactor 生产健康真相。

## 1. 契约先行

| 契约 | 文件 | 新增/扩展 |
| --- | --- | --- |
| evidence batch claim | `src/contracts/evidence-batch-claim.mjs` | 可选 `attempt`、`stream_cursor`、`activation_batch_id` |
| batch checkpoint | `src/contracts/batch-checkpoint.mjs` | 新：`stage` claimed/investigate/report/decide/committed/failed |
| wake intent | `src/contracts/wake-intent.mjs` | 新：kind cognitive/exec/verify/rule/memory，id 前缀 `wake-` |

旧记录保持可读；新写入不得破坏已有 claim ledger。Claim 覆盖按 `reactor` 独立计算。

## 2. Feature gates（双轨，单向门后删除）

| Gate | 默认 | 作用 |
| --- | --- | --- |
| `JEA_EVIDENCE_WAKE` | **开**（S8） | 周期请求转 cognitive wake；idle backlog 扫描。`0` 回退列车 |
| `JEA_IN_PROCESS_CYCLE` | **开**（S8） | 列车 step 进程内执行；`0` 或 `JEA_SUBPROCESS_CYCLE=1` 强制旧子进程。reactor task 始终进程内 |
| `JEA_SUBPROCESS_CYCLE` | 关 | 强制旧子进程列车 |
| `JEA_REACTOR_HEALTH_PRIMARY` | 开 | doctor/viewer 以 reactor 投影为主 |
| `JEA_QUEUE_DISABLE_CYCLE_TTL` | **开**（S8） | 停止递增 `cycles_seen`，只走墙钟 TTL。`0` 恢复 cycle TTL |
| `JEA_EXEC_RATE_ONLY` | **开**（S8） | exec 只认速率+并发，忽略每轮 budget。`0` 恢复 cycle budget |

## 3. 三 subject 实测（2026-08-15，只读）

命令：`jea daemon status --json --subject <name>`。

| 字段 | js-evolution-agent | agentank-tank | feishu-flow-test |
| --- | --- | --- | --- |
| pipeline / wake_policy | reactor / evidence_driven | reactor / evidence_driven | reactor / evidence_driven |
| health.status / ok | reactor_backlog_stalled / false | reactor_backlog_stalled / false | reactor_backlog_stalled / false |
| worker.running | false | false | false |
| reactor.status / ok | stalled / false | stalled / false | stalled / false |
| evidence.pending_count | 677 | 43272 | 161 |
| evidence.oldest_unclaimed_age_ms | 730091534（约 8.4 天） | 7840611380（约 90.7 天） | 6359768860（约 73.6 天） |
| claims.counts | claimed 0 / handled 29 / failed 5 | claimed 0 / handled 4 / failed 0 | claimed 0 / handled 1 / failed 0 |
| claims.expired_claimed | 0 | 0 | 0 |
| claims.last_handled_at | 2026-08-14T17:19:24.325Z | 2026-08-14T16:11:14.498Z | 2026-08-14T16:11:00.401Z |
| decisions.pending | 0 | 0 | 0 |
| reconcile.contract_error_count | 0 | 0 | 0 |
| cycles.open_count | 1（历史兼容，不阻断 reactor） | 0 | 0 |

共同诊断：三 subject 都是「过期未认领证据 + 无新鲜 worker」。安静即健康仍然成立——无 pending 时不因时间流逝失败；这里失败是因为 backlog 已超过 stale 阈值且 worker 未跑。

## 4. S1–S9 拆分与单向门

同一目标态 epic，实现落在 `feat/reactor-target-s0-s9`。GitHub issue 按下列门拆：

| 门 | 验收 | 单向门删除条件 |
| --- | --- | --- |
| S1 健康投影 | doctor/viewer 以 reactor 为主；worker × stale backlog 同诊断 | 旧 `stuck_steps` / `progress_stalled` 不再被 reactor 路径读取 |
| S2 换单位 | rule-feedback / TTL / exec 双算；默认仍可回退 cycle | `JEA_QUEUE_DISABLE_CYCLE_TTL` 与 `JEA_EXEC_RATE_ONLY` 默认打开且旧 env 无调用方 |
| S3 持久 wake | 跨进程锁、生产者写 intent、backlog 扫 evidence | `JEA_EVIDENCE_WAKE` 默认打开 |
| S4 认知脱钩 | checkpoint 写 investigate/report/decide/failed；不丢 event_ids | `reactor.json` / step artifact 不再被 live 路径读取 |
| S5 exec/verify | verify 读持久 exec 结果；`ok=false` 不 complete；durable intent | exec 不再依赖 cycle-state checkpoint 接力 |
| S6 法则/操作者 | claim 按 reactor 独立覆盖；kind 用证据流复数名；per-goal cursor | 法则不再走固定 belief/goals step |
| S7 记忆压实 | 写 `last_compacted_at`，只压上次之后的 handled batches | diary step 从默认步图移除 |
| S8 删周期双源 | **默认开门 + 隔离验证**（2026-08-15） | 三生产 subject 一周观察改为操作者可选加固，不再挡 S9 |
| S9 删 agent_loop/phases | 当前仅显式回退 | 无 `--pipeline agent_loop\|phases` 调用方，且 S8 已删 |

S8 已把三 gate 默认打开；列车入口仍可 `=0` 回退。S9 硬删见 `docs/reactor-s9-deletion-manifest.md`。

## 5. 本 PR 验收与回滚

- 隔离 mock canary（不写三个生产 subject）：`npm run reactor:canary`
- 故障套件：`npx vitest run test/contracts.test.mjs test/exec-recovery.test.mjs test/reactor-wake.test.mjs test/reactor-shadow.test.mjs test/reactor-event-driven.test.mjs`
- 隔离晋升闸：临时 `JEA_HOME` 上 `subject init` → `data init --all` → 多轮 `run --mock` → `node scripts/reactor-s8-promote-check.mjs --subject NAME`
- 生产灰度（可选加固）：`feishu-flow-test → js-evolution-agent → agentank-tank`；每级先 `jea data backup`，见 `docs/reactor-s8-gray-runbook.md`。
- 回滚：显式 `JEA_EVIDENCE_WAKE=0` / `JEA_QUEUE_DISABLE_CYCLE_TTL=0` / `JEA_EXEC_RATE_ONLY=0`；必要时 `JEA_REACTOR_HEALTH_PRIMARY=0` 或 registry `"pipeline": "agent_loop"`。unset 不再回退（默认已开）。
- uncertain intent：`daemon doctor --json` 看 `reactor.exec_intents.uncertain`；人工确认外部效果后改决策状态，不要自动重放。
