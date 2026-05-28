# Evolution Viewer：用静态双栏页对照情报报告与进化日记

> 日期：2026-05-28  
> 项目：js-evolution-agent（主体：agentank-tank）  
> 类型：架构设计 / 功能实现  
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

每轮演化会产出两类长文 Markdown，路径深、命名规则不同：

- **情报报告**：`data/intelligence/reports/.../cycle-*.md`（Intel 阶段）
- **进化日记**：`data/evolution/diaries/.../exec-*.md`（Exec 之后）

CLI 已有 `jea intel report --cycle X` 可单篇查看报告，但**无法在一屏内对照**「本轮判断」与「本轮实际推进」。用户希望有一个**本地静态页面**，能按 `cycle_id` 浏览时间线，并并排阅读报告与关联日记（例如 `cycle-20260528-132353` 与 `exec-20260528-132631`）。

真正的问题不是「能不能打开 Markdown 文件」。

真正的问题是：**两类产物的 ID 体系不同（`cycle-*` vs `exec-*`），关联信息散落在日记正文和事件流里**，人工在目录树里配对成本高。

---

## 2. 分析过程

### 2.1 现有数据与索引

| 数据源 | 机器可读索引 | 关联线索 |
| --- | --- | --- |
| 情报报告 | `data/intelligence/reports/index.jsonl`（`store.readIntelReports`） | `cycle_id`、`md_path`、`tldr` |
| 进化日记 | 无同级 index | 正文常见 `基于 intel cycle-…`；`evolution-events.jsonl` 中 `type: evolution_diary` 含 `diary_path` |
| 路径解析 | [`report-paths.mjs`](../../src/intelligence/report-paths.mjs)、[`diary-paths.mjs`](../../src/intelligence/diary-paths.mjs) | 兼容 Windows 绝对 `md_path` 与 `YYYY/MM/YYYY-MM-DD/` 层级 |

`jea daemon inbox` 仅暴露 `latest_report` / `latest_diary`（按 mtime），不适合历史轮次对照。

### 2.2 浏览器侧约束

纯静态 HTML **不能**在 `file://` 下随意 `fetch` runtime 目录中的 `.md`（CORS / 本地文件限制）。因此必须在构建阶段把内容打包进 `dist/`，再用本地 HTTP 打开。

### 2.3 被否定的方案

| 备选 | 为何不选 |
| --- | --- |
| Docsify / VitePress | 默认按文档树导航，难做「按 intel cycle 聚合 + 双栏」；定制 theme 成本接近自研 |
| 11ty 每轮一页 HTML | 轮次上百时构建慢、dist 体积大；MVP 不需要 SEO |
| 运行时读盘 SPA（无 build） | 依赖常驻服务或浏览器扩展，不符合「静态、可分享文件夹」目标 |
| 内嵌单文件 `file://` | 可作后续变体，MVP 优先 `serve dist` |

对话中先只输出思路（不执行、不写代码），确认采用 **manifest 驱动的小构建 + 单页双栏** 后，再按实施计划落地。

---

## 3. 方案设计

### 核心原则

> **以 `cycle_id` 为轮次主键；构建时算好报告↔日记关联；浏览器只读 JSON + HTML。**

```mermaid
flowchart LR
  runtime[Runtime 数据]
  build[build-manifest]
  dist[dist 静态站]
  browser[浏览器双栏]
  runtime --> build
  build --> dist
  dist --> browser
```

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 架构 | 构建脚本 + manifest + 静态壳 | 贴合异构 ID 与对照 UX；与 `jea intel report list` 数据源一致 |
| 输出目录 | `tools/evolution-viewer/dist/` | 与 runtime 解耦；根目录 `.gitignore` 已忽略 `dist/` |
| 默认范围 | 最近 50 轮（`--limit` 可调） | agentank-tank 报告索引已 400+ 条，全量构建非 MVP 必需 |
| Markdown | 构建期 `marked` 转 HTML | 浏览器无 CDN 依赖 |
| 日记关联 | 正文正则 + `evolution_diary` 事件 | 对齐现有写法 `intel cycle-20260528-132353` |
| 打开方式 | `jea intel viewer serve`（Node 静态 HTTP，默认 4173） | 避免 CORS；可选 `--open` |

### 关联规则

1. 递归扫描 `data/evolution/diaries/**/*.md`，读前 2KB 解析 `intel cycle-(cycle-…)`，`exec_id` 取自文件名。
2. 读取 `evolution-events`（`limit = max(200, reportLimit * 4)`），补全 `diary_path` / `tldr`。
3. 每个 intel 轮输出 `dist/rounds/<cycle_id>.json`（`report_html` + `diaries[].html`），`manifest.json` 只保留元数据与时间线。

**明确不做（本期）**：verify JSON / records 第三 Tab、全文搜索、写入 runtime、git 跟踪 dist。

---

## 4. 实现要点

### 项目结构

```text
tools/evolution-viewer/
├── public/           # index.html, app.js, styles.css
└── dist/             # 构建产物（gitignore）

src/intelligence/evolution-viewer/
├── diary-link.mjs    # 解析 intel cycle 引用
└── build-manifest.mjs

src/cli/commands/
└── intel-viewer.mjs  # build / serve
```

### 关键模块

| 文件 | 职责 |
| --- | --- |
| [`diary-link.mjs`](../../src/intelligence/evolution-viewer/diary-link.mjs) | `parseIntelCycleIdFromDiary`、`execIdFromDiaryFileName` |
| [`build-manifest.mjs`](../../src/intelligence/evolution-viewer/build-manifest.mjs) | 读报告索引、索引日记、marked 转 HTML、写 manifest 与 rounds |
| [`intel-viewer.mjs`](../../src/cli/commands/intel-viewer.mjs) | CLI：`build` / `serve`；复用 subject 解析 |
| [`intel.mjs`](../../src/cli/commands/intel.mjs) | 挂载 `jea intel viewer` 子命令 |
| [`tools/evolution-viewer/public/app.js`](../../tools/evolution-viewer/public/app.js) | 时间线、hash 路由、`#cycle_id` 深链、双栏与多日记下拉 |

### 前端行为（MVP）

- 左侧：时间线（`cycle_id`、时间、TL;DR 截断、是否有日记）。
- 右侧：异步加载 `rounds/<cycle_id>.json`，左栏报告、右栏日记。
- 筛选框：对 `cycle_id` / `tldr` 子串过滤（非全文搜索）。

### CLI 与文档

```bash
jea intel viewer build [--subject NAME] [--limit 50] [--out PATH]
jea intel viewer serve [--port 4173] [--open]

npm run viewer:build -- --subject agentank-tank
npm run viewer:serve
```

[`AGENTS.md`](../../AGENTS.md)「情报与报告」小节已补充上述命令说明。

### 实现细节备忘

- 日记关联正则初版误写成 `cycle[-\s](cycle-…)`，导致 `intel cycle-20260528-132353` 无法匹配；修正为 `intel\s+(cycle-[…])`。
- `package.json` 增加 `marked` 为 `devDependencies`；若 `npm install` 遇 peer 冲突，可用 `--legacy-peer-deps`。

---

## 5. 验证与测试

### 单元测试

```bash
npm test -- test/evolution-viewer-manifest.test.mjs
```

覆盖：日记正文解析、`--limit 1`、绝对路径 `md_path` 报告解析、dist 产物结构（5 项通过）。

### agentank-tank 冒烟

```bash
npm run viewer:build -- --subject agentank-tank
npm run viewer:serve
```

构建结果：50 轮、`tools/evolution-viewer/dist/`。

验收轮次 `cycle-20260528-132353`：

- `manifest.json` 中 `has_diary: true`，关联 `exec-20260528-132631`。
- `rounds/cycle-20260528-132353.json` 含完整 `report_html` 与日记 HTML（含「记忆审计根因修复」等正文）。

浏览器深链：`http://127.0.0.1:4173/#cycle-20260528-132353`。

---

## 6. 后续演化

| 方向 | 说明 |
| --- | --- |
| `jea run` 后可选自动 `viewer build` | 减少手工刷新 dist |
| per-subject 输出到 `runtime/subjects/<ns>/viewer/` | 与主体备份同目录 |
| 增量 build | manifest 记录 content hash，只处理新 index 行与新日记 |
| 第三 Tab | verify JSON、records/meta（注意敏感信息勿打进可分享 dist） |
| 单文件离线版 | 内嵌 manifest，支持 `file://` 只看最近 N 轮 |

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 需要静态页方便对照每轮情报报告与进化日记；两类文件路径深、ID 不同。 |
| 思考 | 报告有 index.jsonl，日记靠正文与 evolution 事件关联；浏览器不能直接读 runtime；文档站方案不适合「按轮双栏」。 |
| 方案 | manifest + 构建时 marked 转 HTML + 单页双栏；默认 50 轮；输出 `tools/evolution-viewer/dist/`。 |
| 执行 | 落地 build-manifest / diary-link / public UI / `jea intel viewer`；测试通过；agentank-tank 冒烟验证目标轮次关联正确。 |
