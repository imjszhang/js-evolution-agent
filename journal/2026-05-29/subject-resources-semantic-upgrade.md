# Subject Resources 语义升级：把 root 路径改成可解释的资源对象

> 日期：2026-05-29  
> 项目：js-evolution-agent  
> 类型：架构设计 / 功能实现 / 升级迁移  
> 来源：Cursor Agent 对话（从“封装资源即遗传”到 subject resources 结构重定义）

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

这次讨论从一个更高层的问题开始：如果在 Cyber-Taoist 框架里给主体预先配置 MCP、数据库、工具、文档、模型和数据集，这些东西到底算什么？

最初的判断是：它们不是普通配置，而是主体继承的初始 R。也就是说，上层主体把已经验证过的生存经验传给下层主体。问题不在于“能不能给”，而在于“给了之后主体怎么知道它仍然可信、坏了怎么退”。

但落到当前系统时，真正卡住的不是哲学概念。

真正的问题是：`policies/subjects.json` 里的 `resources` 仍然主要表达 **外部 root 路径和路径规则**。例如 `roots.target_repo` 直接存 `D:\github\My\agentank-evolver`。这能让系统找到目录，却说不清：

- 这个 repo 对主体来说是什么资源；
- 为什么现在可信；
- 失效时退到哪里；
- 文档类资源如 `docs/agent-guide.md` 应该挂在哪里。

如果继续在旧结构旁边塞 `notes`，会变成补丁。用户最后明确收束为一个更干净的方向：**调整原来 `resources` 字段的含义，把 `roots` 和 `target_repo` 也作为资源体系的一部分。**

---

## 2. 分析过程

### 2.1 第一版方案为什么不够

第一版实现思路是保留旧结构，在 `resources.notes` 里给 `agentank_guide` 补 `note/fallback`。这个方案改动小，但语义不稳：

```json
"resources": {
  "roots": {
    "target_repo": "D:\\github\\My\\agentank-evolver"
  },
  "notes": {
    "agentank_guide": {
      "scope": "agentank_evolver",
      "path": "docs/agent-guide.md"
    }
  }
}
```

它的问题是：`resources` 里同时出现“路径根”“说明”“文件定位”三种职责。`agent-guide.md` 明明是一个主体依赖的文档资源，却被迫挂成某个 root 的附属说明。

这说明旧抽象没有回答第一性问题：**资源到底是什么？**

### 2.2 最终抽象

最终选择把 `resources` 拆成两层语义：

| 层 | 职责 |
| --- | --- |
| `resources.items` | 定义资源对象本身：`kind / handle / note / fallback` |
| `resources.roots` | 定义哪些资源暴露为边界 root；值从路径改为资源 id |
| `resources.aliases` | root scope 或资源 id 的别名 |
| `resources.rules` | 路径边界规则，只引用 root scope / alias，不定义资源 |

这使 `target_repo` 从一个裸路径变成一个 `repo` 资源，`agentank_guide` 从一个“说明项”变成一个 `document` 资源。

### 2.3 被否定的备选

| 备选 | 为何不选 |
| --- | --- |
| 继续使用 `resources.notes` | 只是给旧结构打补丁，资源定义与说明职责混在一起 |
| 把 `agent-guide.md` 放进 `resources.roots` | `roots` 表达边界根，不应存单个文件资源 |
| 删除 `roots`，只从 `items` 推导 | 丢失“哪些资源可作为路径边界”的显式配置 |
| 保留向后兼容旧 `roots` 路径语义 | 用户明确要求不用考虑兼容，直接调整相关结构 |

---

## 3. 方案设计

最终配置形态如下：

```json
"resources": {
  "items": {
    "target_repo": {
      "kind": "repo",
      "handle": "D:\\github\\My\\agentank-evolver",
      "note": "AgenTank evolver repository used as this subject's target lane and source of domain files.",
      "fallback": "Pause lane writes and inspect the repository manually."
    },
    "agentank_guide": {
      "kind": "document",
      "handle": "target_repo:docs/agent-guide.md",
      "note": "AgenTank agent guide used as domain/API guidance; trusted when the file exists and its downloaded date is acceptable for the current lane.",
      "fallback": "Treat it as stale context and fall back to the live guide URL, direct API inspection, or operator review."
    }
  },
  "roots": {
    "target_repo": "target_repo"
  },
  "aliases": {
    "agentank_evolver": "target_repo"
  },
  "rules": [
    {
      "kind": "agentank_evolver",
      "scope": "agentank_evolver",
      "patterns": ["data/**", "src/strategy/**", "src/cli.mjs"]
    }
  ]
}
```

### 关键决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 资源定义入口 | `resources.items` | 统一 repo、document、未来 MCP/数据库/LLM 等资源 |
| root 语义 | `scope -> resource_id` | root 是边界暴露，不是资源路径本身 |
| 文档资源定位 | `target_repo:docs/agent-guide.md` | 表达“相对于某资源”的文件依赖 |
| root 可引用类型 | `repo` / `root` | 只有本地路径型资源能作为路径边界 |
| note/fallback | 对 `repo/root/document` 给 warning | 先做轻量治理，不阻塞配置落地 |
| Windows 路径 | 特判 `D:\...` | 避免误判为 `resource_id:path` |

---

## 4. 实现要点

### 4.1 配置示例

[`policies/subjects.example.json`](../../policies/subjects.example.json) 更新为新版结构：

- `resources.items.target_repo` 定义 `repo` 资源；
- `resources.roots.target_repo` 指向资源 id `target_repo`；
- `resources.aliases.target_project` 仍指向 root scope / resource id；
- `resources.rules` 继续只表达路径边界。

当前本地 `agentank-tank` subject registry 也已按同样语义组织：`target_repo` 是 repo 资源，`agentank_guide` 是 document 资源。

### 4.2 资源解析

主实现位于 [`src/cli/utils/subjects.mjs`](../../src/cli/utils/subjects.mjs)。

| 函数 | 职责 |
| --- | --- |
| `normalizeStructuredResourceItems` | 归一化 `resources.items`，保留 `kind / handle / note / fallback` |
| `parseRelativeResourceHandle` | 识别 `resource_id:relative/path` 形式，同时避开 Windows 盘符 |
| `resolveRootScopeToPath` | 读取 `roots.<scope> -> resource_id`，再从 `items[resource_id].handle` 得到本地路径 |
| `normalizeStructuredResourceRoots` | 输出既有 OADA runtime 需要的 `{ scope: path }` roots 映射 |
| `diagnoseStructuredResourceItems` | 诊断缺说明、悬空 handle 前缀、无效 root 引用 |

关键链路：

```text
resources.items[target_repo].handle
        ↑
resources.roots[target_repo] = "target_repo"
        ↑
rules.scope = "target_repo" 或 alias
```

### 4.3 诊断规则

`diagnoseSubjectRuntimeConfig` 现在会额外检查资源对象：

| 诊断 | 含义 |
| --- | --- |
| `resources.item_note_missing` | `repo/root/document` 缺少 `note` |
| `resources.item_fallback_missing` | `repo/root/document` 缺少 `fallback` |
| `resources.item_handle_prefix_missing` | `document` 等相对 handle 指向不存在的资源前缀 |
| `resources.root_resource_missing` | `roots` 指向不存在的资源 |
| `resources.root_resource_kind_invalid` | `roots` 指向了非 `repo/root` 资源 |
| `resources.root_resource_handle_invalid` | root 资源不是本地路径 handle |

旧的 `resources.rule_scope_missing_root` 仍保留，用于判断 `rules.scope` 是否能解析到 root scope 或 alias。

### 4.4 测试

[`test/cli.test.mjs`](../../test/cli.test.mjs) 更新了旧 `roots` 路径语义测试，并新增资源对象相关覆盖：

- registry 保留 `resources.items`；
- `resolveSubjectExternalRoots` 能通过 `roots` 引用解析到本地路径；
- alias 能解析到同一 root path；
- 缺 `note/fallback` 给 warning；
- 文档 handle 前缀不存在给 warning；
- Windows 路径不会被误判为 `resource_id:path`。

---

## 5. 验证与测试

执行命令：

```powershell
cd d:\github\My\js-evolution-agent
npm test
npm run jea -- subject check --subject agentank-tank --json
```

结果：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 9 files passed，**329** tests passed |
| `jea subject check --subject agentank-tank --json` | `ok: true`，`diagnostics: []` |

同时检查：

- `ReadLints` 未发现相关文件 linter error；
- `rg` 未发现旧 `resources.roots.<id>` 直接路径语义残留；
- `git diff --stat` 显示本轮 tracked 变更集中在 `policies/subjects.example.json`、`src/cli/utils/subjects.mjs`、`test/cli.test.mjs`。

---

## 6. 后续演化

| 项 | 建议 |
| --- | --- |
| 文档化 resource schema | 在 `AGENTS.md` 或 policies README 中补一段 `items/roots/aliases/rules` 语义说明 |
| 运行时可见性 | 后续可在 intel report 中展示简短 Resource Summary，但本轮刻意不做 |
| receipt 证据链 | 下一步再考虑 `resources_used`，让资源使用进入 action receipt |
| 更多资源类型 | MCP、LLM、数据库、凭据能力都可以进入 `resources.items`，但应逐个验证 |
| 动态健康 | 暂不做 health score / 半衰期 / 自动 fallback；先让静态语义稳定 |

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 封装工具、MCP、数据库、文档等是否都应视为主体资源，以及是否需要说明 |
| 思考 | 第一性原理下资源要回答“能用什么、为什么可信、坏了退到哪里”；旧 `roots` 只能回答路径 |
| 方案 | `resources.items` 定义资源对象，`roots` 改为 root scope 到资源 id 的引用 |
| 执行 | 更新资源解析、诊断、示例配置与 CLI 测试；`npm test` 329 passed，subject check 通过 |
