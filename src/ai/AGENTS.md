# AI 网关（ai）

本文件是 `src/ai` 模块的操作指引，由根 AGENTS.md 拆分而来。全局内容（基础用法、环境与诊断、运行时数据、Subject 管理、操作建议）见根 [AGENTS.md](../../AGENTS.md)；模块 ownership 与契约规则见 [OWNERSHIP.md](../contracts/OWNERSHIP.md)。


## LLM 档案（DeepSeek V4）

按[思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)支持模型档与推理档，而非固定单模型：

| 档案 | 模型 | 推理 |
| --- | --- | --- |
| `fast` | `deepseek-v4-flash` | off（显式 `thinking.disabled`） |
| `balanced`（默认） | `deepseek-v4-flash` | high |
| `deep` | `deepseek-v4-pro` | max |

任务默认：轻量 channel / projection summary → `fast`；investigate / report / decide / settlement / memory consolidation → `balanced`。覆盖：`JEA_LLM_PROFILE`、`JEA_LLM_PHASE_<TASK>`（如 `JEA_LLM_PHASE_REPORT=deep` 或 `pro:max`）。旧 `DEEPSEEK_MODEL` / `DEEPSEEK_THINKING` / `DEEPSEEK_REASONING_EFFORT` 仍兼容。

真实网关另有按 subject 隔离、跨进程重启保留的硬 token + spend 预算：

- `JEA_LLM_SUBJECT_TOKEN_BUDGET`：每 subject 持久累计 token 预算，默认 `1000000`；旧 `JEA_LLM_PROCESS_TOKEN_BUDGET` 只作兼容别名。
- `JEA_LLM_REQUEST_MAX_TOKENS`：每请求 completion 上限，默认且最大 `8192`。
- `JEA_LLM_SUBJECT_SPEND_BUDGET_USD`：每 subject 持久累计估算花费上限，默认 `10` USD。
- `JEA_LLM_INPUT_PRICE_PER_MILLION_USD` / `JEA_LLM_CACHE_HIT_PRICE_PER_MILLION_USD` / `JEA_LLM_OUTPUT_PRICE_PER_MILLION_USD`：每百万 token 估价，默认 `1` / `0.1` / `4` USD。

账本落在 subject runtime 的 `data/evolution/llm-budget-ledger.json`。请求前按已脱敏消息与工具 schema 保守估算 prompt，并连同 `max_tokens` 预留 token/花费；不足时在调用 API 前抛出 `llm_token_budget_exhausted` 或 `llm_spend_budget_exhausted`。reserve/settle/exhausted 先写账本审计，再通过 callback 写 `evolution-events.jsonl`；settle 保留 provider usage、cache hit/miss 和估价参数。显式非法预算/估价配置、缺失 subjectKey、账本锁/读/写失败均 fail closed。mock 客户端不受影响。

轻量连通矩阵（flash×off/high、pro×high；pro×max 需 `JEA_LIVE_DEEPSEEK_DEEP=1`）：

```powershell
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:matrix
```

**Intel 诚实矩阵**（同一 fixture 下对比模型×推理的 live reactor 最终报告质量；默认不挂在 `test:live-deepseek`）：

```powershell
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:intel-matrix
# 另含 pro×max：
$env:JEA_LIVE_DEEPSEEK_DEEP='1'; npm run test:live-deepseek:intel-matrix
# 每格重复 N 次（1–5，默认 1）：
$env:JEA_MATRIX_REPEATS='3'; npm run test:live-deepseek:intel-matrix
# 可选 LLM judge（固定 pro×high，仅硬闸通过且 attempt=1）：
$env:JEA_MATRIX_JUDGE='1'; npm run test:live-deepseek:intel-matrix
```

默认覆盖 live reactor 的 flash×high / pro×high。历史 fixture 只用于兼容读取，不是可选 live pipeline。

| 层 | 列 | 是否硬闸 |
| --- | --- | --- |
| Gates | `ok` / poison / missing_ref / dangling / unknown_type / `host_fixture` / `repair` | 是（宿主接线；`host_seen_missing_fixture_ref` 检查宿主 Seen 是否含 fixture id；`repair` 为信息列显示修复轮数，不挡硬闸） |
| Quality | `grounding` / invented / off_palette / palette_used / synth / conflict / stale / distractor / fixture_j / poison_unframed / `hidden` / `vf` / calls / tokens / hit_ratio / judge | 否（判断章节质量；开卷埋答案召回；闭卷检索；成本） |

`raw_mode`：`placeholder`（模型服从宿主占位契约）/ `full`（仍写完整 Seen）/ `missing` / `none`。埋答案 fixture 含两组信号：

- **开卷推理**（当天写入，进 7 天 prompt 窗口）：合成对、冲突对、superseded 陷阱与干扰项。
- **闭卷检索**（回填到约 14 天前的 `daily_jsonl` 分区，落在 7 天 prompt 窗口外、90 天 `intel_query` 窗口内）：hidden 根因记录含唯一结论 token（`CFGTOKEN_GHE_DIGEST_7B2`）；当天 breadcrumb 只给检索线索、不给答案。`hidden` 列形如 `S✓C✓K✗`（Seen 升格 / 判断引用 / 结论 token），`vf` 列形如 `acc/sub`（verified_facts）。

live runner 会夹断 `reportContext.observations` 读取为 7 天，避免把 90 天 observations 白送给模型；`intel_query`（`limit≤50`）与诚实审计（`days=3650`）不受影响。

guidance **不**泄露期望。产物落盘：`test-artifacts/intel-honesty-matrix/<run_id>.jsonl` 与 `.md`（已 gitignore）。

## DeepSeek KV 缓存（context caching）

DeepSeek 按请求消息流**从位置 0 开始的连续 token 前缀**自动命中 context cache（约 1/10 价格）。设计准则：整条消息流按**稳定度降序**排布；中间任一 token 变化会使其后内容全部 miss。system / user 角色对缓存透明——重要的是序列化后的前缀是否字节级稳定。

**观测字段**（reactor output / conversation context / checkpoint 的 `prompt_cache`）：

| 字段 | 含义 |
| --- | --- |
| `usage.prompt_tokens` | API 报告的 prompt token 数 |
| `usage.cache_hit_tokens` | 前缀缓存命中（来自 `prompt_cache_hit_tokens`） |
| `usage.cache_miss_tokens` | 前缀缓存未命中 |
| `usage.cache_hit_ratio` | hit / prompt（或 hit/(hit+miss)） |
| `usage.call_count` | 仅查证循环累加时存在（多 turn） |

mock 路径 `usage` 为 `null`。真实调用时日志可见 `[prompt-cache ...]` 摘要行。

**动态载荷约定**（改 prompt 时的 review 准则）：会话首条 user 消息的 dynamic payload 段序为 `Rules → Operator Guidance → Goals → Cycle → 其余每轮变化段`。`stablePrefix`（含权威文献与任务规则）保持跨部署稳定，不要为「阅读顺序」去改它的物理位置。

**会话链同 profile**：investigate → report → decide 依赖会话前缀复用。同一会话链内保持同 LLM profile（例如不要单独设 `JEA_LLM_PHASE_DECIDE=deep`），否则 decide 会对整个 report 会话前缀按原价重付。thinking on/off 不保证共享同一缓存家族——保守假设 `fast` 与 `balanced` 虽同为 flash 也不互相暖缓存。

## 兼容与预算操作

- 0.1.0 的 `DEEPSEEK_MODEL` / thinking env 和历史 task label 仍可读取；新配置应使用 profile / task override，不再把旧 pipeline 名写进 live 配置。
- `JEA_LLM_SUBJECT_TOKEN_BUDGET` 默认每 subject 持久 `1000000`，`JEA_LLM_SUBJECT_SPEND_BUDGET_USD` 默认 `10`，`JEA_LLM_REQUEST_MAX_TOKENS` 默认且最大 `8192`。预算在 API 调用前持久 reserve，失败不会产生外部调用。
- mock 不消耗真实 token 预算。发布前的 live provider 验证保持 opt-in，普通 CI 不注入密钥。
