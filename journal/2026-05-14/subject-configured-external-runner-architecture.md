# 多主体配置化外部动作架构调整

> 日期：2026-05-14
> 项目：js-evolution-agent
> 类型：架构设计 / 功能实现 / 升级迁移
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

本次调整的核心目标，是让 `js-evolution-agent` 从单一主体的固定动作集合，演进为支持多个主体随时切换的配置化架构。

原有实现中，宿主项目的 action 类型、执行器映射和参数白名单主要由代码决定。这样可以快速落地单一场景，但不利于后续接入更多主体：每增加一个主体或外部执行工具，就可能需要修改 `registry`、`handlers` 或专用 runner 文件。

调整后的目标是：

- 主体切换由 CLI 控制。
- 每个主体拥有独立的 runtime namespace。
- 每个主体可以通过自己的配置声明外部 action。
- 宿主代码只保留通用执行协议、安全校验和审计写入。
- 新主体接入时尽量只新增 policy、runtime 配置和外部工具，不修改宿主代码。

---

## 2. 分析过程

排查现有结构后，关键约束主要有三点：

1. action registry 是模型决策和队列检查的白名单来源。
2. action handlers 是执行、回执、情报写入和审计事件的统一入口。
3. subject runtime 已经具备隔离能力，可以自然承载主体级配置。

因此，不能只在文档里描述新动作，也不能只让模型走泛化 `agent_execute`。更稳妥的做法是保留宿主侧统一执行器，但把动作定义、外部工具、命令映射和参数白名单迁移到当前 active subject 的 runtime 配置中。

### 关键发现

| 发现 | 影响 |
| ---- | ---- |
| `policies/active-subject.json` 决定当前主体 | CLI 可以在多个主体间切换 |
| `runtime/subjects/<namespace>/data` 已经隔离 | 可以把主体 action 配置放入 runtime |
| action registry 需要启动时注册 specs | 配置需要能转换成 `ActionTypeSpec` |
| handler 必须保留审计写入 | 配置不能直接绕过 `recordActionReceipt` |
| 外部工具协议可以标准化 | 统一为 Node CLI + JSON stdout |

---

## 3. 方案设计

最终方案是“主体配置 + 通用外部 runner”：

```text
active subject
  └── runtime/subjects/<namespace>/data/config/actions.json
        ├── external_tools
        └── actions[]

registry
  └── load configured actions as ActionTypeSpec

handlers
  └── Proxy dispatch configured actions

configured external runner
  └── node <toolRoot>/<entry> <command> --allowed-param value
```

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| 配置位置 | `runtime/subjects/<namespace>/data/config/actions.json` | 跟随主体 namespace 隔离，不污染全局策略 |
| action 注册 | 基础 action 代码注册，主体 action 配置注册 | 保留稳定核心，同时支持主体扩展 |
| handler 分派 | Proxy 动态分派 configured actions | 避免为每个主体动作新增显式 handler |
| 执行协议 | Node CLI + JSON stdout | 简单、可测试、可审计 |
| 参数传递 | `params.allowed` 白名单 | 防止任意参数或敏感字段被转发 |
| tool 字段 | 必须显式声明，或仅在唯一工具时推断 | 避免主体无关代码中存在默认业务假设 |

---

## 4. 实现要点

### 项目结构

```text
js-evolution-agent/
├── policies/
│   ├── active-subject.json
│   └── subjects/
│       └── <subject>.md
├── runtime/
│   └── subjects/
│       └── <namespace>/
│           └── data/
│               ├── config/
│               │   └── actions.json
│               ├── evolution/
│               ├── goals/
│               └── intelligence/
└── src/
    └── actions/
        ├── configured-actions.mjs
        ├── configured-external-runner.mjs
        ├── handlers.mjs
        └── registry.mjs
```

### 关键模块

| 文件 | 职责 |
| ---- | ---- |
| `src/actions/configured-actions.mjs` | 读取 active subject action 配置，校验 schema，转换为 action spec |
| `src/actions/configured-external-runner.mjs` | 根据配置执行外部 CLI，过滤参数，解析 JSON 输出 |
| `src/actions/registry.mjs` | 注册基础 action，并加载当前主体配置中的 action specs |
| `src/actions/handlers.mjs` | 对 configured action 统一分派，保留回执、审计和情报写入 |
| `runtime/subjects/<namespace>/data/config/actions.json` | 主体级外部工具和 action 声明 |

### 配置示例

```json
{
  "version": 1,
  "external_tools": {
    "example_tool": {
      "root": "D:\\github\\My\\example-tool",
      "entry": "src/cli.mjs"
    }
  },
  "actions": [
    {
      "name": "example_sync_context",
      "tool": "example_tool",
      "command": "sync",
      "description": "Sync context for this subject.",
      "promptHint": "Use this action when the subject needs fresh external context.",
      "defaultRisk": "low",
      "defaultPriority": "high",
      "autoExecutable": true,
      "layer": "probe",
      "params": {
        "allowed": ["limit"]
      }
    }
  ]
}
```

### CLI 使用方式

```powershell
npm run jea -- subject list
npm run jea -- subject show
npm run jea -- subject use js-evolution-agent
npm run jea -- actions list
npm run jea -- actions check
```

主体切换后，`actions list`、`actions check`、`goals`、`data` 和 `run` 都会使用当前 active subject 的 namespace。

---

## 5. 验证与测试

本次验证覆盖了默认主体和配置化主体两类场景。

### 默认主体验证

```powershell
npm run jea -- subject use js-evolution-agent
npm run jea -- subject show
npm run jea -- actions list
npm run jea -- actions check
npm test
```

结果：

- active subject 正确切回 `js-evolution-agent`。
- 默认主体下只暴露基础 actions。
- 队列 action 类型检查通过。
- 测试通过：`121 passed`。

### 配置化能力验证

测试中使用临时 subject runtime 创建独立 `actions.json`，验证：

- 配置 action 可以被读取并转换为 spec。
- 单一 `external_tools` 可以自动推断 `tool`。
- 多工具场景缺少 `tool` 会报配置错误。
- 未配置 action 不暴露 handler。
- `params.allowed` 会过滤未允许参数。
- 外部 runner 测试注入点不依赖当前工作区 active subject。

### 静态检查

```powershell
ReadLints
```

结果：修改文件无 linter errors。

---

## 6. 后续演化

短期可以继续增强以下能力：

- 增加 `jea subject use <name> --init`，切换主体后自动初始化 runtime 目录和默认目标。
- 增加 `jea subject current` 或 `jea subject status`，更快显示当前主体、namespace、配置路径和 action 数量。
- 为 `actions.json` 增加更明确的 JSON schema 或 doctor 检查。
- 在 `actions check` 中区分“基础 actions”和“主体配置 actions”，让调试输出更直观。
- 给外部 runner 增加超时、最大 stdout 限制和更细的错误分类。

长期方向是把主体配置、目标、外部工具和智能体记忆形成稳定的“主体包”结构，使一个主体可以被复制、备份、迁移和复用，而不需要改动宿主代码。
