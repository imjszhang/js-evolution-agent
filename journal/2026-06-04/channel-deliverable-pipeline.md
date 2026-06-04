# Channel Deliverable 管线：agent 跑出的结果是交付物，不是一句通知

> 日期：2026-06-04  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现  
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [分析过程](#2-分析过程)
3. [方案设计](#3-方案设计)
4. [实现要点](#4-实现要点)
5. [逻辑审查与修正](#5-逻辑审查与修正)
6. [验证与测试](#6-验证与测试)
7. [后续演化](#7-后续演化)
8. [附：本轮对话问题—思考—方案—执行对照](#附本轮对话问题思考方案执行对照)

---

## 1. 背景与动机

上一轮工作（[Channel Presence 异步 Agent](./channel-presence-async-agent.md)）解决了「用户一句话能异步触发 agent 调查，但不拖住对话回路」。

这一轮要解决的是它的**下半场**：**agent 跑完了，结果怎么交给用户？**

现状是这样的：用户在飞书发一条调研请求，presence 异步启动 `channel_agent_run`，agent 跑完后唤醒 presence，由 `speech_intent` → `speech_generation` 生成一句话回复。

操作者一针见血地指出问题：

> 现在会调用 speak intent 来生成消息，但这个更像是**通知**，而不是主体执行 agent run 后的**交付**。

这是两个完全不同的东西。

- **通知**：人设化、口语化、受字数和节奏限制的一句话，告诉你「我看了一下，大概是……」。
- **交付**：agent 真正产出的完整结果，应该原样、结构化地给到用户。

把 agent 的完整调研结果塞进 speech 通道，会被 LLM 二次改写、截断、套上人设语气——**内容保真度直接丢失**。用户要的是 agent 写的报告，不是主体对报告的转述。

操作者进一步明确了形态：

> 交付物应该统一为 **markdown 格式文件**（先保存到运行时特定目录，要归档，要入情报库），至于最后发送给用户的是飞书卡片，还是其它什么的形式应该设计一个机制。

并且特别强调：

> Markdown 内容由模板生成 这个感觉有点问题，我希望 **agent run 的完整结果**。

所以本轮目标很清楚：建一条**与对话通道解耦的交付管线**，把 agent 的原始输出落成 markdown 交付物，归档、入情报库，再按通道渲染成飞书文档并发送链接。

---

## 2. 分析过程

### 2.1 真正的问题不是「飞书不支持文档」

对话最初是从「为什么 agent run 里不能用飞书文档功能」切入的。但顺着代码读下去，发现这是个伪命题。

`channel_agent_run` 走的是通用 `agent_execute`，只给 `Read/Grep/Glob` 这类只读工具，本来就不该、也不需要直接调飞书文档 API。真正卡住体验的，是结果的**投递方式**，而不是 agent 的**工具集**。

所以问题被重新定义：

> 真正的问题不是 agent 能不能写飞书文档，而是 agent 的产出在系统里**没有「交付物」这个一等公民**——它只能借 speech 通道这条为「说话」设计的路出去。

### 2.2 speech 通道的三个硬约束

复用 speech 通道做交付，会撞上三堵墙：

| 约束 | 后果 |
| --- | --- |
| LLM 二次生成 | agent 原文被改写，保真度丢失 |
| 人设 + 字数限制 | 长报告被截断，结构被压平 |
| cooldown / 限流 | 交付被节流当成「主动发言」对待 |

这些约束对「说话」是合理的，对「交付」是致命的。

### 2.3 系统里已经有可复用的「交付物」范式

不需要从零造。情报库里的 `intel_reports` 已经是一个成熟范式：**一份 MD 文件 + 一条 jsonl 索引记录**。

交付物完全可以照抄这个模式：

- MD 文件存正文（agent 原始输出）。
- jsonl 索引存元信息，便于检索。
- 再补一条 observation 进情报库，让交付结果可被后续轮次引用。

---

## 3. 方案设计

核心是一条「快车道」：agent 完成后**绕过 presence 的 speech 生成**，直接持久化 → 渲染 → 投递。

```text
channel_agent_run 完成
  -> persistChannelDeliverable   落 MD + 索引 + observation
  -> renderDeliveryToOutbox      按通道渲染成飞书文档 outbound
  -> writeOutboxMessage          写 outbox
  -> enqueueNotifyIfOutboxPending 直接排 notify
  -> completion 事件标记 delivered:true
       -> presence 跳过该候选，不再 speak
```

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 交付正文来源 | `result.agent.raw_response` 原文 | 操作者明确要 agent 完整结果，拒绝模板生成 |
| 交付物形态 | MD 文件（YAML frontmatter + 原文正文） | 与 `intel_reports` 范式一致，可归档可检索 |
| 投递路径 | 快车道，绕过 speech 生成 | 避开 LLM 改写、人设、限流三重约束 |
| 与 presence 的关系 | completion 事件带 `delivered:true`，presence 跳过 | 防止「快车道已投递」+「presence 又 speak」重复打扰 |
| 入情报库 | 索引记录 + 一条 observation | 让交付结果成为后续轮次可引用的证据 |
| 通道渲染 | 飞书文档 + 普通文本链接 | 长报告天然适合文档承载，不再受卡片长度和分片顺序限制 |
| 失败/deferred | 同样落交付物并生成文档链接 | 如实告知胜过 speech 通道的幻觉式转述 |

### 备选方案对比

| 方案 | 为什么没选 |
| --- | --- |
| 继续用 speech 通道传结果 | LLM 改写 + 截断 + 限流，保真度无法保证 |
| 模板渲染 MD | 操作者明确否定，要 agent 原文 |
| 只在 agent_run 内直接调飞书文档 API | 会把投递能力塞进 agent 工具集；最终选择在 channel adapter 层支持文档交付 |

---

## 4. 实现要点

### 关键模块

| 文件 | 职责 |
| --- | --- |
| [`src/channel/deliverable.mjs`](../../src/channel/deliverable.mjs) | 把 agent 原始输出落成 MD（frontmatter+原文），写索引、写 observation，抽取 TLDR |
| [`src/channel/delivery-renderer.mjs`](../../src/channel/delivery-renderer.mjs) | 把交付物渲染成 `document` outbox 消息，由 Feishu adapter 创建云文档 |
| [`src/channel/adapters/feishu/client.mjs`](../../src/channel/adapters/feishu/client.mjs) | 调用 `docx.document.create` 创建文档，并用 `docx.document.convert(content_type=markdown)` 转换 Markdown 块 |
| [`src/channel/adapters/feishu/sender.mjs`](../../src/channel/adapters/feishu/sender.mjs) | 负责创建飞书文档，并向目标会话发送文档链接 |
| [`src/channel/agent-runner.mjs`](../../src/channel/agent-runner.mjs) | 快车道编排：持久化→渲染→写 outbox→排 notify，并在 completion 事件标记 `delivered` |
| [`src/intelligence/specs.mjs`](../../src/intelligence/specs.mjs) | 新增 `channel_deliverables` 的 `append_jsonl` spec |
| [`src/intelligence/store.mjs`](../../src/intelligence/store.mjs) | 新增 `recordChannelDeliverable` / `readChannelDeliverables` |
| [`src/channel/expression-candidates.mjs`](../../src/channel/expression-candidates.mjs) | 过滤掉 `already_delivered` 的 agent run 候选，不再交给 planner |
| [`src/channel/presence-decision-executor.mjs`](../../src/channel/presence-decision-executor.mjs) | 把已投递候选标记为 handled，推进 presence 游标 |

### 关键数据流

交付物落盘后分布在两处，沿用情报库范式：

```text
runtime/subjects/<ns>/data/channel/deliverables/<date>/<id>.md   # 正文（agent 原文）
runtime/subjects/<ns>/data/intelligence/channel_deliverables/index.jsonl  # 索引
runtime/subjects/<ns>/data/intelligence/intel_observations/...   # 一条可被引用的 observation
```

### 防重复打扰的闭环

这是整条管线最容易出错的地方。快车道投递后，presence 仍会收到 `channel_agent_run_completed` 事件，如果不处理就会**二次 speak**。

闭环靠两个动作：

1. completion 事件携带 `delivered:true`（`!!dispatch`，即真正写了 outbox 才算）。
2. `expression-candidates` 过滤 `already_delivered` 候选；`presence-decision-executor` 把这些候选标记为 handled，推进游标但不生成话术。

注意一个细分流：**执行后返回失败/deferred 的 run 会被如实落成文档并投递链接 → presence 跳过**；而 **validation 失败或 `agent_execute` 抛异常**（`channel_agent_run_failed`，无 `delivered`）**仍走 presence 通知**。两条路各管一段，不冲突。

---

## 5. 逻辑审查与修正

实现完成后继续复查，操作者进一步要求：**交付物不要用飞书卡片，要支持飞书文档**，并参考 `openclaw-lark` 的文档工具。

这个要求改变了投递层的最终形态。

### 5.1 从卡片迁移到飞书文档

原先的卡片方案虽然能把内容送出去，但它仍然有两个问题：

- 卡片不是报告载体，长内容需要截断或拆分。
- 卡片投递解决的是“消息展示”，不是“交付物沉淀”。

参考 `openclaw-lark` 后，关键启发是：文档能力应该被抽象成“从 Markdown 创建云文档”，而不是让 agent 自己在运行过程中调用飞书 API。

因此最新实现改为：

```text
Markdown deliverable
  -> document outbound
  -> FeishuSender.createDocumentFromMarkdown()
  -> 发送文档链接到会话
```

### 5.2 文档创建路径

JEA 当前 channel 凭据是机器人应用凭据，不是 `openclaw-lark` MCP 工具里的 UAT 用户令牌。因此这里没有直接复刻 MCP `create-doc`，而是在 Feishu adapter 内走 SDK：

- `docx.document.create` 创建新版文档。
- `docx.document.convert(content_type=markdown)` 把 Markdown 转成文档块。
- `docx.documentBlockChildren.create` 插入转换后的块。
- 最后发送普通文本链接，而不是 interactive card。

文档目录可通过 `doc_folder_token` / `JEA_CHANNEL_FEISHU_<SUBJECT>_DOC_FOLDER_TOKEN` 配置；文档 URL 前缀可通过 `doc_base_url` / `JEA_CHANNEL_FEISHU_<SUBJECT>_DOC_BASE_URL` 配置。

### 5.3 幂等窗口补齐

`deliverable_id` 每次执行随机生成，outbox 文件名带时间戳、不按 key 去重。因此若同一 `channel_agent_run` 任务在「成功 dispatch 之后」才失败并被重试，理论上可能重复投递。

后续已补齐这层机制：交付消息的 outbox `idempotency_key` 改为优先使用稳定的 `channel_agent_run_id`，不再依赖每次新生成的 `deliverable_id`；`writeOutboxMessage` 在 pending / sent outbox 中按 key 查重，命中后不再写第二条消息。

这样即使同一 `channel_agent_run` 被重试，也会复用同一组交付 key，避免重复投递。

---

## 6. 验证与测试

`test/channel.test.mjs` 与 `test/intelligence.test.mjs` 同步更新，覆盖：

- `persistChannelDeliverable`：写 MD 原文、写索引、写 observation。
- `resolveDeliverablePath` / `extractDeliverableTldr`。
- `renderDeliveryToOutbox`：生成 `document` outbound，正文完整写入文档 Markdown。
- `renderDeliveryToOutbox`：交付 outbox key 优先使用稳定的 `channel_agent_run_id`，格式为 `...:document`。
- `writeOutboxMessage`：pending / sent outbox 中按 `idempotency_key` 去重。
- `FeishuSender`：创建飞书文档后发送文档链接。
- `runChannelTask`：agent run 完成后落交付物、写 outbox、记审计事件，且 presence 候选**不**再出现 `reply.agent_run`。
- `channel deliverables` CLI：可 list 索引记录，也可按 `deliverable_id` / `channel_agent_run_id` show Markdown 正文。
- `intelligence` spec 列表新增 `channel_deliverables`。

运行结果：

```bash
npx vitest run test/channel.test.mjs
# Test Files  1 passed (1)
#      Tests  105 passed (105)
```

切换到飞书文档交付后，全量 channel 测试绿。

---

## 7. 后续演化

- **权限与分享**：当前实现创建文档并发送链接，后续可补充文档权限/分享策略，确保目标会话成员稳定可读。
- **MCP/UAT 路径**：若未来 channel 具备用户授权令牌，可复用 `openclaw-lark` 的 MCP `create-doc` 路径，支持更完整的文档导入能力。
- **多通道渲染**：`delivery-renderer` 目前面向飞书文档，后续接入其它通道时可按 transport 扩展渲染分支。

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | agent run 的完整结果被 speech 通道当成「一句通知」转述，保真度丢失；操作者要求把结果作为「交付物」原样投递 |
| 思考 | 真正的瓶颈不是飞书工具集，而是系统里缺少「交付物」一等公民；speech 通道的 LLM 改写、人设、限流三重约束对「交付」是致命的；情报库 `intel_reports` 已有可复用范式 |
| 方案 | 建一条快车道：agent 原文落 MD（frontmatter+原文）→ 写索引 + observation → 按通道渲染飞书文档 outbound → 直接进 outbox/notify；completion 事件标记 `delivered`，presence 跳过避免重复打扰 |
| 执行 | 新增 `deliverable.mjs`、`delivery-renderer.mjs`，改 `agent-runner.mjs` 快车道、`specs.mjs`/`store.mjs` 注册交付物源、`expression-candidates`/`presence-decision-executor` 跳过已投递候选；补齐 outbox 幂等去重与 `channel deliverables` 检索入口；参考 `openclaw-lark` 增加 Feishu 文档创建与链接投递；105 个 channel 测试通过 |

---

## 8. 第二轮：输出契约与通用交付物协议改造

### 8.1 问题

操作者通过飞书提问后，channel agent run 把**系统 JSON receipt 原样**当成交付物正文投递，操作者收到的是 JSON 而不是人话。

### 8.2 定位澄清

明确 channel agent run 的真实用途：**运行时情报查询 agent**。

- 操作者提问 → agent 在运行时数据目录（`runtime.dataRoot`）中自主探索（`Read/Grep/Glob`）→ 产出面向操作者的交付物。
- agent provider（claude/cursor/reasonix）为主，`llm_only` 为保底。
- 权限保持 `read_only`、工具保持只读、cwd 保持 `dataRoot` 不变。
- 真正的「做事」仍走 evolution cycle 的 `agent_run`（完整 cwd / 写权限 / 审批），channel 不是第二条执行管线。

### 8.3 三层改造

**1) Agent 输出契约（`agent-runner.mjs`）**

`acceptance` / `run_spec.expected_output` / `context` 从「Return a strict JSON receipt」改为情报查询助理契约，附运行时目录结构（`RUNTIME_LAYOUT`）与 deliverable 契约（`DELIVERABLE_CONTRACT`）。agent 在 receipt 顶层附带 `deliverable`，自己决定交付形态：

```text
{
  status, confidence, sources[], follow_up_hint,
  deliverable: { type, title, content, summary, url, data, reason }
}
type ∈ document | message | link | data | none
```

`MockAIClient` 默认响应同步为新契约。

**2) 持久化层（`deliverable.mjs`）**

- 新增 `parseAgentReceipt` / `resolveDeliverableSpec`：从 `agent.raw_response` 解析 deliverable 契约（严格 JSON + 嵌入 JSON 提取）。
- `resolveBody` 三级 fallback：`deliverable.content` → 自由文本 `raw_response` → summary/message。
- frontmatter / 索引扩充 `deliverable_type`、`title`、`confidence`、`sources`、`follow_up_hint`、`url`。
- `type=none`：跳过 `.md`，仍写索引（`delivery_status=skipped`）与 observation，供审计。

**3) 通用交付物投递协议（`delivery-renderer.mjs`）**

引入 delivery item 抽象 `{ medium, payload, fallback_medium, fallback_payload }`，两阶段：

- `resolveDeliveryItems(deliverable)`：按 `type` + 内容特征（`hasRichFormatting`：长度 / 代码块 / 表格 / 多级标题）决定介质。`message` 短文本→`text`，长/富格式自动升级为 `document`；`link`→带链接的 `text`；`data` 小→`text`、大→`document`；`none`→无 item。
- adapter 能力降级：`DEFAULT_CHANNEL_CAPABILITIES`（feishu = `text` + `document`），不支持的介质自动降级到 fallback。未来 image/PDF/video 只需扩展 medium 与 adapter 分支，不动 agent 契约。

idempotency key 升级为 `channel-deliverable:<subject>:<key>:<medium>:<index>`。

**下游消费**：`channel_agent_run_completed` 事件扩充 `deliverable_type`/`confidence`/`follow_up_hint`；`expression-candidates` 在 agent_run 候选上携带 `deliverable_type`，供 presence 对 `none`/低置信交付物决定是否补充表达。

### 8.4 验证

```bash
npx vitest run test/channel.test.mjs
# Test Files  1 passed (1)
#      Tests  111 passed (111)
```

端到端（agentank-tank，真实飞书）：`scripts/test-channel-deliverable-pipeline.mjs` 用 document 契约的 mock receipt 驱动 `runChannelAgentRunTask`，确认链路 persist → 按 `type=document` 路由 → 写 outbox → daemon notify worker 创建飞书云文档并向操作者（`ou_…`）发送链接（`channel_message_sent`，key `…:document:0`）。随后 presence LLM 智能 `silence` 了重复候选，下游消费按预期工作。

### 8.5 后续

- 接入真实 provider 时，agent 即可自主探索运行时目录并产出 `deliverable.content` 人话正文。
- 新增 image / file / rich_text / PDF / video 等介质时，仅扩展 `resolveDeliveryItems` 与 adapter 发送方法。

## 9. 飞书云文档含表格时 400 根因修复（2026-06-05）

### 9.1 现象

操作者请求「最近进化结果完整发飞书」触发 agent run，交付物 `delivery-20260604-164828-d2d3` 已正确按 `document` 路由进 outbox（`channel_deliverable_dispatched fmt=document`），但 notify worker 发送时飞书 API 返回 **HTTP 400 / code 1770001 invalid param**，消息落入 `outbox/failed`。之后操作者追问「怎么没用飞书文档」被 classifier 当成普通 observation，presence 仅回话术且 persona 幻觉式声称「无权限」（与真实原因无关）。

### 9.2 根因

`createDocumentFromMarkdown`（`src/channel/adapters/feishu/client.mjs`）旧逻辑把 `docx.document.convert` 结果 `filter(first_level)` + 删 `children` 后用扁平的 `documentBlockChildren.create` 插入。markdown 含**表格**时，convert 返回嵌套块（table 31 → cell 32 → text 2），扁平插入会把表格容器变成孤儿块 → 400。

改用 descendant API 后仍 400，逐步定位（create ✅ / convert ✅ / 仅非表格块 ✅ / 仅表格块 ❌）确认真正元凶：convert 返回的 **table block 携带只读字段 `table.property.column_width` 与 `merge_info`**，descendant 创建接口拒绝。剥离这两个字段后表格成功写入（markdown 表格无合并单元格，丢弃安全）。

### 9.3 修复

- `client.mjs`：新增可测纯函数 `planDocumentInsertions(converted)`，BFS 收集 first-level 子树为 `descendants`、`children_id` 选顶层、`index` 顺序分批（默认 40/批），并在 `toDescendantBlock` 中对 table 块 `sanitizeTableProperty`（剥离 `column_width`/`merge_info`）。改用 `docx.documentBlockDescendant.create` 插入；convert 失败时回退单个纯文本块。
- `adapters/feishu/index.mjs`：`sendOutboundMessage` 对 document 增加防御性兜底——若 docx API 仍失败，则把 `title + markdown` 当作文本分块发送，绝不静默丢内容（返回带 `document_fallback: 'text'`）。
- 测试：`planDocumentInsertions` 三个用例（表格子树保留 + property 清洗、分批与顺序、空输入），`test/channel.test.mjs` 114 passed。
- 真机验证：用原失败的表格交付物 payload 经真实代码路径重发，成功创建飞书云文档并发给操作者（`document` 路径，无 fallback）。

> **完整复盘**（含投递状态回写、类型仲裁、presence 事实注入）：见 [`journal/2026-06-05/channel-deliverable-delivery-observability.md`](../2026-06-05/channel-deliverable-delivery-observability.md)。
