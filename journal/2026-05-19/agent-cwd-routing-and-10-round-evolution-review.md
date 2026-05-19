# Agent Cwd 路由与 10 轮进化复盘：耗时归因、发布缺失与执行目录修复

> 日期：2026-05-19  
> 项目：js-evolution-agent（主体：agentank-tank）  
> 类型：问题排查 / 调研分析 / 功能实现  
> 来源：Cursor Agent 对话  

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [验证与测试](#5-验证与测试)
6. [后续演化](#6-后续演化)

---

## 1. 背景与动机

本次对话从一次实际运行开始：用 **daemon 方式执行 10 轮进化**（Run ID: `evolve-20260519T041815Z`，主体 `agentank-tank`）。10 轮全部成功完成，总耗时约 **3 小时 35 分钟**。

用户随后提出几个递进问题：

1. 这 10 轮有没有提交新的 agentank 策略？
2. 每轮耗时分布如何？瓶颈在哪？
3. 能否看到 Claude Code SDK 在 `agent_execute` 里具体做了什么？
4. 执行阶段 agent 的工作目录为什么总是错？怎么修？
5. 新主体应该在哪里设置 cwd？policy 模板要不要同步更新？

本文档把上述讨论、数据发现、归因修正、修复实施和 policy 更新整理成一篇可读日记。

---

## 2. 分析过程

### 2.1 十轮进化结果：有本地候选，无远端发布

| 指标 | 10 轮合计 |
|------|-----------|
| 生成候选 (`generate`) | 4 次 |
| 模拟 (`simulate`) | 4 次 |
| 评估 (`evaluate`) | 3 次，全部 `keep_current` |
| 发布 (`publish`) | **0 次** |
| 远端 matchCount | 始终为 10，无变化 |

**结论**：用户的观察正确——**没有向远端提交任何新 agentank 策略**。候选在本地有生成和模拟，但门禁从未通过，AI 决策层也从未调度 publish。

阻塞是三层叠加：

| 层级 | 现象 |
|------|------|
| **质量层** | 评分 std 过高（如 avg=61 但 std≈48.6 > 40），门禁合理输出 `keep_current` |
| **决策层** | 历史探针确诊：157 个 cycle 中 AI 从未将 `agentank_publish_candidate` 放入 actions 数组 |
| **目标层** | 当前 `active_goals.json` 写明「暂不要求自动发布」，goal calibrate 多次 skip |

### 2.2 耗时归因：经历一次重要修正

**初版误判**：曾把 `intel_pipeline` 到 `exec_pipeline` 之间的时间当成 intel 阶段（report + decide），得出 intel 占 85%、exec 仅 7%。

**修正后**（用 `records/cycle-*/` 的 `duration_ms` 与事件时间戳交叉验证）：

| 阶段 | 平均耗时 | 占比 |
|------|----------|------|
| observe | ~1m 09s | ~8% |
| report | ~1m 20s | ~10% |
| decide | ~1m 12s | ~9% |
| standing memory | ~45s | ~6% |
| **intel 合计** | **~4m 27s** | **~33%** |
| **exec（intel 事件 → exec 事件）** | **~6–36 分钟** | **~50–67%** |
| verify + goals + diary | ~2m | ~10% |

**真正的大头是 exec 阶段**，不是 report/decide。

### 2.3 exec 内部：agent_execute 与 run_probe 最重

10 轮里仅 **4 次 `agent_execute`**，但一旦出现往往占满该轮 exec：

| 轮次 | exec 总时长 | agent_execute | 典型 tool 调用数 |
|------|-------------|---------------|------------------|
| R1 | **36 分钟** | 2 次 | 16 + **73** |
| R5 | 6.5 分钟 | 1 次 | 28 |
| R6 | 9 分钟 | 1 次 | 25 |

**R1 第二次 agent_execute（codeHash 排序修复）** 最典型：264 条 SDK message、73 次 tool call。Agent 在 `js-evolution-agent` 全仓库盲目搜索 `injectionPoints` / `codeHash`，花了 40+ 次 Read/Grep/Glob 才找到目标在 `D:\github\My\agentank-evolver\src\cli.mjs`。

无 `agent_execute` 但 exec 仍慢的轮次（R2 约 19 分钟、R4 约 16 分钟），主要是 **`run_probe` 走同一套 Claude SDK**，调查同样慢。

轻量动作（sync / generate / simulate / evaluate）每轮合计通常只有 **几十秒到 2 分钟**。

### 2.4 执行目录问题的根因

从 action receipt 还原的路径混乱：

| 任务目标 | SDK 实际 cwd | 结果 |
|----------|--------------|------|
| 改 `agentank-evolver/src/cli.mjs` | `D:\github\My\js-evolution-agent` | 全仓库搜索 73 次 |
| 改 `parameterizationEnabled` | 同上 | 误创建 `runtime/.../agentank-evolver/` 影子目录 |
| 改 runtime `data/config/actions.json` | 混用多个绝对根 | 路径不一致 |

**第一性原理**：Agent 应在**任务对象真实所属项目的根目录**启动。当前问题是 cwd 只写在 prompt 自然语言里，Claude/Cursor SDK 实际从宿主项目根启动。

### 2.5 Claude SDK 执行过程的可观测性

**已有数据源**（无需改代码即可查看）：

| 数据源 | 路径 | 内容 |
|--------|------|------|
| Action Receipt | `runtime/.../action_receipts/action-receipts.jsonl` | `tool_uses[]`、`message_count`、`session_id` |
| Evolution Events | `data/intelligence/evolution_events/evolution-events.jsonl` | `type: agent_execute` 的 summary |
| Verify Report | `data/evolution/verify_reports/exec-*.json` | 语义验证解读 |

**未持久化**：完整 SDK 逐步对话流（assistant 回复全文、tool 返回内容）。`agent.outputs.claude` 只保留 tool 名 + 输入摘要。

---

## 3. 方案设计

### 3.1 加速讨论（未实施，留作后续）

曾讨论过多层加速方案，按优先级归纳：

| 优先级 | 方向 | 预期效果 |
|--------|------|----------|
| P0 | 生产/诊断模式分离，减少无效 probe | 每轮少 2–4 个 action |
| P0 | observe 增量化 / 可跳过 | 每轮省 5–15 分钟 |
| P1 | evaluate 通过后 deterministic publish 链式触发 | 提高有效产出 |
| P2 | exec 内 simulate/probe 并行 | 含模拟轮次省 30–40% |

用户要求「先说思路不要执行」，上述仅作记录。

### 3.2 Agent Cwd 路由（已实施）

从复杂方案收敛到**最小原则**：

> **任务属于哪个项目，Agent 就从哪个项目根目录启动。**

只做三件事：

1. **决策层**：prompt/spec 要求本地文件型 `agent_execute` / `run_probe` 必须带 `params.cwd`
2. **执行层**：Claude `options.cwd`、Cursor `local.cwd` 优先使用 action.cwd；显式 cwd 不存在则**直接失败**，不允许 Agent 自建目录
3. **主体 policy**：声明 host cwd、subject runtime cwd、external project cwd 的约定

| 决策 | 选择 | 理由 |
|------|------|------|
| cwd 放在哪定义 | subject policy + action.params.cwd | 不新建复杂权限系统 |
| 执行层校验 | 显式 cwd 必须存在且为目录 | 防止 mkdir 影子目录 |
| 无 cwd 时 | 保持现有 fallback | 不破坏其他 subject |
| 完整 trace | 非目标 | 最小改动优先 |

---

## 4. 实现要点

### 4.1 代码改动

| 文件 | 改动 |
|------|------|
| `src/intelligence/conversation-prompts.mjs` | decide prompt 增加：本地文件型 action 必须提供 `params.cwd`，路径相对 cwd 描述 |
| `src/actions/registry.mjs` | `agent_execute`、`run_probe` 的 promptHint 补充 cwd 说明 |
| `src/actions/agent-adapter.mjs` | 新增 `validateConfiguredCwd()`；Claude/Cursor 启动前校验；导出 `buildClaudeOptions` / `buildCursorOptions` 供测试 |
| `test/cli.test.mjs` | 测试 cwd 传入 options、不存在 cwd 时阻止启动 |

### 4.2 Policy 文档更新

| 文件 | 改动 |
|------|------|
| `policies/templates/project.md` | 新增 Runtime Boundary Model 段落（新主体模板） |
| `policies/project-guidance.md` | 新增 host / subject runtime / external project 的 cwd 规则 |
| `policies/subjects/agentank-tank.md` | 具体样例：runtime cwd、external cwd、禁止影子目录 |

### 4.3 新主体 cwd 应写在哪

**当前机制**：policy 声明约定 → decide 生成 action 时带 `params.cwd` → 执行层校验。

示例（agentank-tank）：

```json
{
  "type": "agent_execute",
  "params": {
    "cwd": "D:\\github\\My\\agentank-evolver",
    "objective": "修改 src/cli.mjs 中 injectionPoints 排序逻辑",
    "mode": "sandbox_patch"
  }
}
```

**尚未实现**：从 policy 自动解析 cwd 并注入 action（可后续加 `defaultAgentCwd` 配置）。

---

## 5. 验证与测试

### 5.1 单元测试

```bash
npm test
# 4 passed, 158 tests passed
```

新增用例：

- 显式 `action.cwd` 传入 Claude/Cursor options
- 不存在 cwd 时 `runAgenticAction` 返回 `agent cwd does not exist`，不启动 SDK

### 5.2 受控 cwd 验证

```bash
node --input-type=module -e "import { buildClaudeOptions, buildCursorOptions } from './src/actions/agent-adapter.mjs'; ..."
# claudeCwd === cursorCwd === 显式 tempDir
```

### 5.3 十轮 daemon 运行（对话早期）

```bash
npm run jea -- evolve --enqueue-only --rounds 10 --subject agentank-tank
npm run jea -- daemon start --subject agentank-tank --max-iterations 10
# 04:18 → 07:53 UTC，10/10 成功
```

---

## 6. 后续演化

### 6.1 近期可做

- **观察 cwd 修复效果**：再跑 1–2 轮含 `agent_execute` 的 cycle，对比 tool 调用次数是否从 70+ 降到 10 以内
- **补 agent trace**：在 `runClaudeCodeSdk` 将 `messages` 序列化到 `data/evolution/agent_traces/`，便于复盘长耗时
- **evaluate → publish 链式触发**：门禁 `publish_candidate` 时由 exec 自动 publish，不依赖 AI 调度
- **生产模式 prompt**：decide 强制 `sync → generate → simulate → evaluate` 模板，禁止重复 probe

### 6.2 长期方向

- subject-level `defaultAgentCwd` / `externalToolRoot` 自动注入
- 常见 config 修改改为确定性 handler，不走 Claude SDK
- 模拟样本量 n≥10 以降低 std 噪音

### 6.3 关键教训（给人看）

1. **「没发布」不等于「没进化」**：10 轮完成了诊断、参数化激活、候选生成，但门禁和决策层双重阻塞了 publish。
2. **耗时归因要查 record 里的 duration_ms**：事件时间戳 interval 容易把 exec 时间误算进 intel。
3. **exec 慢的主因是 agent 在错误目录里搜索**：不是 LLM 推理慢，是路径没设对。
4. **cwd 修复是最小、最高 ROI 的改动**：一行 `params.cwd` + 执行层校验，比完整权限系统简单一个数量级。

---

## 附录：10 轮 exec ID 与耗时速查

| 轮次 | exec ID | 总时长 | exec 阶段 | 备注 |
|------|---------|--------|-----------|------|
| R1 | exec-20260519-122132 | 40m 53s | ~36m | 2× agent_execute |
| R2 | exec-20260519-130232 | 24m 25s | ~19m | 探针为主 |
| R3 | exec-20260519-132745 | 19m 14s | ~13m | |
| R4 | exec-20260519-134709 | 22m 58s | ~16m | |
| R5 | exec-20260519-140952 | 12m 40s | ~6.5m | 1× agent_execute，激活 parameterization |
| R6 | exec-20260519-142301 | 16m 23s | ~9m | 1× agent_execute |
| R7 | exec-20260519-144027 | 20m 38s | ~13m | |
| R8 | exec-20260519-150119 | 14m 30s | ~6m | 最快 exec |
| R9 | exec-20260519-151540 | 22m 56s | ~15m | |
| R10 | exec-20260519-153818 | 20m 30s | ~13m | 唯一完整 generate→simulate→evaluate |

查看某次 agent_execute 的工具序列：

```bash
# 过滤 action-receipts.jsonl 中 action_type=agent_execute 的行
# 查看 result.agent.outputs.claude.tool_uses
```
