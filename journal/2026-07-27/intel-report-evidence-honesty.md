# Intel 报告证据诚实闸：先量尺子，再谈模型纪律

> 日期：2026-07-27  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现 / 调研分析  
> 来源：Cursor Agent 对话  
> 相关提交：`0ee2a57`、`47ecaad`

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)
7. [附：本轮对话问题—思考—方案—执行对照](#附本轮对话问题思考方案执行对照)

---

## 1. 背景与动机

真正的问题不是「报告写得漂不漂亮」。

真正的问题是：Intel 报告的 `## Seen` / Evidence 能不能经得起机械审计——引用是否存在、bullet 是否带 typed ref、operator brief 的意图有没有被当成事实写进 Seen。

交付物契约（章节齐全、`E2E_REPORT_TOKEN`）只能证明「有报告」。它不能证明「报告诚实」。CI 需要第二道闸，把悬空引用、毒句渗入、近失引用字形等问题拦在 merge 前。

同时用户希望用真实 DeepSeek（不同模型档 × 推理档）跑矩阵，而不是只靠 mock canned MD。

## 2. 分析过程

### 2.1 三类失败模式

| 失败 | 含义 |
| --- | --- |
| `seen_dangling_ref` | `[type:id]` 在 store / 词表里解析不到 |
| `seen_bullet_missing_ref` | Seen bullet 没有可解析 typed ref |
| `seen_contains_forbidden_intent` | operator brief 的 claim / summary 原文进了 Seen |

E2E 用毒句常量 `POISON_INTENT_CLAIM_E2E` 专门测 brief 渗入。

### 2.2 「尺子缺项」不等于「模型不诚实」

首轮 live 矩阵里，大量失败其实是审计词表不认宿主渲染态：决策队列、active goals、standing memory 等本就是模型「看见」的机器上下文，却没有合法 cite 形态。

`47ecaad` 的判断是：先补齐 `machine_context:<key>` 枚举与 LLM profile（flash/pro × off/high/max），让失败真正反映 Seen 纪律，而不是尺子缺口。

### 2.3 LLM 档案

按 DeepSeek V4 思考模式文档引入档案，而不是固定单模型：

| 档案 | 模型 | 推理 |
| --- | --- | --- |
| `fast` | `deepseek-v4-flash` | off |
| `balanced`（默认） | `deepseek-v4-flash` | high |
| `deep` | `deepseek-v4-pro` | max |

阶段默认：`observe` / channel / diary → `fast`；`report` / `decide` / `agent_loop` → `balanced`。覆盖：`JEA_LLM_PROFILE`、`JEA_LLM_PHASE_<PHASE>`。

## 3. 方案设计

两道闸并列：

1. **交付物契约**：落盘、index、章节结构、`E2E_REPORT_TOKEN`。
2. **证据诚实**：Seen/Evidence bullet 须带可解析 typed ref；operator brief 毒句不得进入 Seen。

诚实逻辑从测试 helper 抽到生产模块 [`src/intelligence/report-honesty.mjs`](../../src/intelligence/report-honesty.mjs)，供审计、字形净化与后续宿主 splice 复用。

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 审计位置 | 机械规则，不靠 LLM 自评 | 诚实必须可复现、可 CI |
| 宿主状态引用 | `machine_context:<enum>` | 区分 store 记录与机器渲染态 |
| live 默认 | opt-in（`JEA_LIVE_DEEPSEEK=1`） | 不拖慢日常 `npm test` |
| 矩阵深档 | `JEA_LIVE_DEEPSEEK_DEEP=1` 才跑 pro×max | 成本与时延更高 |

### machine_context 词表

[`src/intelligence/machine-context-refs.mjs`](../../src/intelligence/machine-context-refs.mjs) 枚举包括：`decision_queue`、`active_goals`、`standing_memory`、`current_beliefs`、`source_counts`、`operator_intent_briefs`、`cycle_stage` 等。brief 正文本身不进 machine_context bullets。

## 4. 实现要点

### 关键模块

| 文件 | 职责 |
| --- | --- |
| [`src/intelligence/report-honesty.mjs`](../../src/intelligence/report-honesty.mjs) | `auditIntelReportEvidenceHonesty`、`resolveTypedRef`、`sanitizeCitationGlyphs`、`detectNearMissCitations` |
| [`src/intelligence/machine-context-refs.mjs`](../../src/intelligence/machine-context-refs.mjs) | `MACHINE_CONTEXT_IDS`、宿主 Seen bullets 构建 |
| [`src/ai/llm-profile.mjs`](../../src/ai/llm-profile.mjs) | 模型档 / 推理档解析 |
| [`test/helpers/intel-report-honesty-assert.mjs`](../../test/helpers/intel-report-honesty-assert.mjs) | Vitest 包装 + 毒句常量 |
| [`test/helpers/intel-report-honesty-live-runner.mjs`](../../test/helpers/intel-report-honesty-live-runner.mjs) | live / matrix 共用 runner |
| [`test/intel-report-honesty-e2e.test.mjs`](../../test/intel-report-honesty-e2e.test.mjs) | mock 诚实 e2e |
| [`test/intel-report-honesty-matrix-live.test.mjs`](../../test/intel-report-honesty-matrix-live.test.mjs) | 模型×推理×pipeline 矩阵 |

### 审计要点

- 解析 `Seen` / `Evidence` / `本轮看到`。
- brief summary → `forbiddenInSeen`。
- 每条 bullet 至少一个可解析 `[type:id]`；支持全角近失诊断。
- `reports` 等 source alias 归一到 honesty readers，避免 `memorySourceType` 与审计词表漂移。

## 5. 验证与测试

Mock / CI：

```powershell
npm test
```

覆盖交付物 e2e 与诚实 e2e（phases + agent_loop）。

Opt-in live：

```powershell
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek
$env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:intel-matrix
# 另含 pro×max：
$env:JEA_LIVE_DEEPSEEK_DEEP='1'; npm run test:live-deepseek:intel-matrix
```

默认矩阵 5 格：phases 的 flash×off / flash×high / pro×high，以及 agent_loop 的 flash×high / pro×high。每格对最终产物硬闸；`raw` / `raw_sanitized` 列后来用于计量模型裸写纪律（宿主 splice 之后，见次日日记）。

## 6. 后续演化

矩阵复跑后结论很硬：**低档模型写机械 Seen 不稳**——错引文、毒句、字形问题反复出现。靠再加 prompt 约束边际收益低。

正确方向不是「再教模型写 Seen」，而是 **宿主组装 Seen，模型只写判断章节**。这直接导向次日的 Route A 落地。

另：LLM profile 已就位，但真实 cache hit 计量仍缺——见 `2026-07-28/deepseek-kv-cache-usage-and-payload-order.md`。

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 交付物契约不够；Seen 可能悬空引用或把 brief 当事实。 |
| 思考 | 先机械审计 + 补齐 machine_context / LLM 档位，再谈模型纪律。 |
| 方案 | 生产模块化诚实审计 + mock/live/matrix 两道闸。 |
| 执行 | `0ee2a57` / `47ecaad` 落地；矩阵暴露「模型写 Seen」本身不可靠。 |
