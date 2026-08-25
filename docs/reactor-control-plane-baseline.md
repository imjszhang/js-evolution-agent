# Reactor 控制面 backlog 基线（0.3.0 / #209）

- 日期：2026-08-25
- 状态：测量-only，不改调度 / activation / cursor / claim 语义
- 父 issue：[\#208](https://github.com/imjszhang/js-evolution-agent/issues/208)
- 命令：`npm run perf:reactor-backlog-baseline -- --size smoke --json`

本笔记记录 **当前 0.2.x 实现** 把权威证据投影成 Reactor 工作的方式，以及 journal rebuild / 新 generation 之后 handled coverage 是否还在。数字来自隔离 temp `JEA_HOME` 上的确定性合成夹具，**不读取、不复制** 真实 `~/.jea` 或 `agentank-tank` 运行时。

## 1. 夹具与命令

| Profile | 约权威条数 | 用途 |
| --- | ---: | --- |
| `tiny` | ≥150 | 聚焦测试 / schema |
| `smoke` | ≥2 000 | 本地与 CI smoke（默认） |
| `large` | ≥20 000 | 0.3.0 本地阈值夹具 |
| `incident` | ~43 000 | 对标 S0 记录的 agentank-tank 量级（仍是合成数据） |

合成运行时包含：大量 evidence envelope、handled / failed / released claim 历史、Channel lifecycle 噪声、operator brief / receipt / verify / belief / goal、LLM budget 耗尽账本、重复失败的 `cognitive_reaction` 任务。`--size large` 与 `incident` 把 jsonl 历史放到数万量级；json 目录类证据有上限，避免 inode 爆炸。

输出 schema：`reactor-backlog-baseline.v1`（`scripts/reactor-baseline/constants.mjs`）。后续 #210–#215 应复用该夹具与字段，不要另造私有计数。

## 2. 当前实现测到的结构

1. **权威证据 ≠ 可认领工作。** `readEvidenceStream` / health snapshot 统计全部 envelope；claimable 还要过 reactor eligibility、covered set、consumed marker。
2. **Cognitive / Rule / Memory 不可相加。** belief / goal / verify 可同时对多个 reactor 可认领；报告给出 `union`、`additive_sum` 和 pairwise overlap。
3. **投影 backlog ≠ claim 路径 backlog。** daemon/health 用 `readClaimLedgerForProjection`（含 covered-index）；`listEligibleEvidence` / `claimEvidenceBatch` 在 cursor 已 initialized 时只读 hot `claims.json`，**不**引导 covered-index。
4. **当前 Cognitive 放大是 16 条原始记录一批。** 机械路径每批至少 report + decide 两次 LLM；`decision_producing_reactions` 等于批次数（Decide 总会跑，但不保证入队决策）。
5. **Channel lifecycle 默认仍是 Cognitive 可认领 kind。** classifier / presence / delivery 与 operator 消息走同一 `channel_events` 门，这是历史 replay 的主要放大源之一。

## 3. Rebuild / 新 generation 对 handled coverage 的影响

`rebuildEvidenceJournal` 的现行契约是：

- 新 generation，cursor **一律回到 offset 0**（`safe_replay_from_zero`）
- **复制** `consumed/` markers
- **不改** claim ledger / covered-index

因此当前实现的语义 coverage **只部分保留**（tiny 实测，2026-08-25）：

| 历史 handled 身份 | rebuild 后 claim 路径 | 投影 pending |
| --- | --- | --- |
| consumed marker（认领时写入） | 仍跳过，**保留**（tiny：24 保留 / 0 丢失） | 若也在 covered-index 则仍排除 |
| 仅 covered-index / archive（无 marker） | 新 generation 把 cursor initialized 到 0 → **不再引导 archive，重新可认领**（tiny：20 丢失 / 0 保留） | 仍按 covered-index 排除 |

`rebuild.handled_coverage` 为 `partial`。tiny 上 claimable 从 Cognitive/Rule/Memory 175/38/10 升到 183/44/16；marker-backed 不变。**此处不修复**；#213 应把 handled 身份改成跨 generation 的语义键。

tiny 量级快照（隔离 temp `JEA_HOME`，无网络 / 无真实 LLM）：权威 205；rebuild 前 claimable 175/38/10（union 189，additive 223，三反应器 handled 18/12/14）；16 条一批 → 11 个 Cognitive reaction、22 次 LLM、约 1.2e5 保守 prompt token。exclusive 四类均非空（handled 8 / realtime 76 / replay 109 / unknown 4），另有 `not_reactor_work` 8。

S0 笔记中的 agentank-tank 形状（`pending_count=43272`，`handled=4`，最老未认领约 90 天，worker 未跑）说明：一旦 rebuild 把 cursor 打回 0，而 covered-index 又不被 claim 路径使用，历史证据会再次表现为无界 Cognitive 工作。夹具复现该形状，不提交任何真实 subject 数据。

## 4. 给 0.3.0 的推荐阈值夹具

| 下游 issue | 建议 profile | 必须断言的字段 |
| --- | --- | --- |
| #210 Contracts | `tiny` | schema 字段稳定；三 reactor 非加性 |
| #211 Router | `smoke` | Channel lifecycle vs operator/verify 分桶；`activation_targets` 有/无 |
| #212 Scheduler | `smoke` | realtime vs replay 分桶；budget exhausted 任务不是新的 evidence |
| #213 Migration | `smoke` + 强制 rebuild | `covered_index_only_lost` 必须降到 0 才算修完 |
| #214 Cognitive | `smoke` | `amplification.reaction_batches` 相对 raw records 应收束 |
| #215 Projection | `large` | cold scan 不得再等于全部权威条数；warm 有界 |
| #216 Certification | `large` 或 `incident` | 与本基线同一 JSON 对照，禁止改 0.2.0 closure target |

CI 默认跑 `tiny` 聚焦测试；需要命令级 smoke 时用 `--size smoke`。不要把 `incident` 挂到 PR required check。

## 5. 非目标（本基线刻意不做）

- 不改 eligibility / activation / cursor / claim
- 不删历史证据把计数归零
- 不把 catch-up / token 上限当主修复
- 不提交 live runtime、密钥或 `~/.jea`
- 不升版本号（保持 0.2.1）
