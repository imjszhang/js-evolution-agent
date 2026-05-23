# Subject Repo Lane：让一个主体在独立分支上持续进化

> 日期：2026-05-23
> 项目：js-evolution-agent
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

这次讨论一开始不是一个普通的“帮我自动改 GitHub 项目”的需求。

真正的问题是：`js-evolution-agent` 里已经有 subject、runtime、daemon、agent action 和 worktree 机制，但这些能力主要围绕宿主项目和主体本地数据运转。用户希望设定一个主体后，让系统去实际使用、测试、改进另一个已经 clone 到本地的 GitHub 项目，例如 `agentank-tank` 对应的 `agentank-evolver`。

第一版思路曾倾向于“每轮从 main 开 PR”。用户指出这不符合他的预期：他要的是一条长期存在的独立进化分支。主体在这条分支上运行、测试、学习、改进；每次具体改动再从这条分支派生 worktree 或 PR。

随后又补充了一个关键约束：同一个仓库可能在不同设备上用不同分支同时进化，所以分支和 PR 不能互相冲突。

这把问题收缩成一个更基础的模型：

```text
Subject + Repo + Lane
```

- `Subject`：谁在进化，例如 `agentank-tank`。
- `Repo`：本地已 clone 的目标项目，例如 `D:\github\My\agentank-evolver`。
- `Lane`：当前设备或进化通道对应的长期分支，例如 `jea/agentank-tank/local`。

## 2. 分析过程

阅读当前项目后，发现系统已经有几块可复用基础：

- `src/cli/utils/subjects.mjs` 已支持主体 policy、active subject 和 runtime namespace。
- `src/cli/commands/evolve.mjs`、`src/cli/commands/daemon.mjs` 已支持多轮演化和 daemon 任务。
- `src/actions/agent-run-spec.mjs` 已有 `primary_cwd_kind`、权限 profile 和执行根预检。
- `src/actions/resource-registry.mjs` 已能通过 `resource_scope` 把 action 目标映射到不同 root。
- `src/actions/worktree-manager.mjs` 已有 `core_apply` 专用 worktree 创建能力。

缺口也很明确：

- subject policy 还不能结构化声明目标 repo、base branch、lane、测试命令。
- `core_apply` 的 worktree 默认从宿主 repo 的 `HEAD` 派生，而不是从目标 repo 的 lane 分支派生。
- `agent_run` 缺少一个明确的 `target_repo` scope。
- 缺少“检查 lane 状态、运行目标项目测试、记录结果”的动作。
- 缺少显式初始化 lane 的入口。如果 subject 已配置 lane 但分支还不存在，普通进化应提前失败，而不是跑到某个 action 才失败。
- GitHub PR 只能作为后续增强，不能一开始就成为本地闭环的前提。
- 二次检查中又发现一个执行语义问题：`subject lane init` 创建了 lane 分支，但不会把目标仓库主目录 checkout 到 lane。如果 `lane_observe`、`lane_verify` 继续直接在目标仓库主目录运行命令，那么主目录停在 `main` 时，证据实际来自 `main`，而不是 lane。

这里真正需要避免的是“把所有东西做成一个大动作”。如果一个动作既负责判断 repo、创建分支、调用 agent、跑测试、push、开 PR，它会很快变成不可审查的黑盒。

所以最终方案选择把能力拆成几个小的、可记录 receipt 的动作。

## 3. 方案设计

最终采用的模型很简单：

```text
main
  └── jea/<subject>/<lane>
        └── jea/<subject>/<lane>/work/<cycle-or-task>
```

日常自动进化只围绕 lane 发生：

1. 在 lane 上观察和测试目标项目。
2. 从 lane 派生 work 分支和 worktree。
3. agent 只在 worktree 中修改。
4. 验证通过后，再回流 lane 或开 PR 到 lane。
5. `main` 只作为稳定源头和后续人工晋升目标。

### 关键决策

| 决策 | 选择 | 理由 |
| ---- | ---- | ---- |
| 长期分支 | `jea/<subject>/<lane>` | 让每个主体/设备拥有独立时间线，避免跨设备互相抢分支 |
| 单轮改动 | `jea/<subject>/<lane>/work/*` | 每次改动可审查、可测试、可回滚 |
| 资源根 | `target_repo` scope | 不再把目标项目混同于宿主 `source_root` |
| lane 初始化 | 显式 `jea subject lane init` | 防止普通 `evolve` 悄悄创建分支；需要操作者明确建立长期进化线 |
| 启动前检查 | 配置了 lane 但未初始化则提前失败 | 避免一轮进化跑到中途才在 `lane_observe`、`core_apply` 或 PR 阶段失败 |
| lane 命令执行目录 | 固定 lane worktree | `lane_observe`、`lane_verify` 不依赖主目录当前分支，避免 `main` 与 lane 分叉后证据错位 |
| GitHub PR | 作为显式动作 | 本地闭环先稳定，push/PR 不成为默认副作用 |
| 兼容旧配置 | 保留 `agentank_evolver` alias | `agentank-tank` 已有 configured actions 可能仍引用旧 scope |

## 4. 实现要点

### 项目结构

```text
js-evolution-agent/
├── src/actions/
│   ├── lane-manager.mjs
│   ├── worktree-manager.mjs
│   ├── handlers.mjs
│   ├── registry.mjs
│   └── resource-registry.mjs
├── src/cli/
│   ├── commands/subject.mjs
│   └── utils/
│       ├── subject-lane-guard.mjs
│       └── subjects.mjs
├── policies/
│   ├── project-guidance.md
│   ├── templates/project.md
│   └── subjects/agentank-tank.md
└── test/
    ├── actions.test.mjs
    └── cli.test.mjs
```

### 关键模块

| 文件 | 职责 |
| ---- | ---- |
| `src/cli/utils/subjects.mjs` | 新增 `parseSubjectRepoLane`，从 policy 中解析 `Repo`、`Base Branch`、`Lane`、`Test Command`、`Run Command`、`GitHub Repo` |
| `src/cli/utils/subject-lane-guard.mjs` | 在执行进化前检查已配置 lane 是否可用，并给出初始化提示 |
| `src/cli/commands/subject.mjs` | `subject show --json` 输出 repo lane 信息；新增 `subject lane status/init` |
| `src/actions/lane-manager.mjs` | 新增 lane 状态检查、显式初始化、work 分支命名、lane 命令运行、lane 专用 worktree、GitHub lane PR 创建 |
| `src/actions/worktree-manager.mjs` | 抽出 `createBranchWorktree`，支持指定 `repoRoot`、`baseBranch`、`workBranchPrefix` |
| `src/actions/resource-registry.mjs` | 新增 `target_repo` 与 `lane_worktree` scope |
| `src/actions/handlers.mjs` | 注册 `lane_status`、`lane_observe`、`lane_verify`、`github_open_lane_pr` 处理逻辑，并让 `core_apply` 在配置了 subject repo lane 时从 lane 创建 worktree |
| `src/actions/registry.mjs` | 注册新增动作类型，让 analyze/decide 能选择这些能力 |
| `src/cli/commands/run.mjs`、`src/cli/commands/evolve.mjs`、`src/cli/commands/daemon.mjs` | 在真正执行进化前调用 lane guard；状态类和排队类命令不受影响 |
| `oada.config.mjs` | 把 subject repo lane 注入 host context，并把目标 repo 暴露为 `externalRoots.target_repo` |
| `policies/subjects/agentank-tank.md` | 配置 `agentank-tank` 的目标 repo、lane、测试命令、运行命令和 GitHub repo |

`agentank-tank` 的 policy 最终采用了简化后的边界写法：

```markdown
## Subject Repo Lane

- Repo: `D:\github\My\agentank-evolver`
- Base Branch: `main`
- Lane: `jea/agentank-tank/local`
- Test Command: `npm test`
- Run Command: `npm run sync`
- GitHub Repo: `imjszhang/agentank-evolver`
```

`Runtime Boundary Model` 也被压缩为更结构化的短版：只保留 secrets、subject runtime、target repo、legacy alias、resource mapping、git lane 和 safety 规则。机器解析仍能得到 `target_repo`、`agentank_evolver` 和资源映射。

显式初始化命令如下：

```powershell
npm run jea -- subject lane status
npm run jea -- subject lane init
npm run jea -- subject lane init --push
```

其中 `init` 只创建本地 lane；`--push` 才推送到 `origin`。普通 `run/evolve/daemon work/start` 不会自动创建 lane。

### Lane 命令执行修正

初始化完成后，目标仓库主目录仍可能停在 `main`。这本身不应成为问题：主目录是人的稳定工作区，自动进化应该在明确的 lane / worktree 边界内发生。

为避免 `lane_observe`、`lane_verify` 在主目录停留 `main` 时误测 `main`，后续修正把 lane 命令执行目录改为固定 lane worktree：

```text
<gitRoot>/.worktrees/js-evolution-agent/lane/<sanitized-lane>
```

`runLaneCommand` 现在会先通过 `ensureLaneWorktree` 创建或复用这个 checkout，并校验：

- worktree 当前分支必须是配置的 lane。
- worktree 必须干净；如果 dirty，直接失败，不自动清理。
- evidence 会记录 `checkoutKind`、`executionRoot`、`commit`、`worktreeCreated`、`worktreeReused`。

同时，`checkLaneStatus` 对系统内部 `.worktrees/js-evolution-agent` 做了排除，避免系统自己创建的 lane worktree 让目标仓库主目录被误判为 dirty。`core_apply` 的行为不变：它仍然从 lane 派生每轮独立 worktree，而不是复用 lane 命令 worktree。

## 5. 验证与测试

运行完整测试：

```powershell
npm test
```

结果：

```text
Test Files  4 passed (4)
Tests       225 passed (225)
```

新增和覆盖的验证点包括：

- subject policy 能解析 `Subject Repo Lane`。
- lane work branch 命名能保留 subject/lane 隔离。
- 缺失 repo 会被 `lane_status` 判定为不可用。
- `initializeLane` 能从 `main` 创建缺失 lane，且重复运行保持幂等。
- 配置了 repo lane 但 lane 不存在时，`run/evolve/daemon` 执行入口会提前失败并提示 `jea subject lane init`。
- `agent_run` 可以通过 `primary_cwd_kind=target_repo` 解析到目标 repo。
- `runLaneCommand` 在主目录仍停留 `main` 时，会在 lane 专用 worktree 中执行命令。
- lane 专用 worktree 首次运行会创建，后续运行会复用。
- lane 专用 worktree dirty 时，`runLaneCommand` 会失败并返回清晰错误，不会继续执行测试或同步命令。
- 简化后的 `agentank-tank` policy 仍能解析出：
  - `repoLane.repoRoot = D:\github\My\agentank-evolver`
  - `externalRoots.target_repo = D:\github\My\agentank-evolver`
  - `externalRoots.agentank_evolver = D:\github\My\agentank-evolver`
  - 6 条 `agentank_evolver` 资源映射规则

还使用 `ReadLints` 检查了新增/修改文件，没有 linter errors。

## 6. 后续演化

第一步已经让系统具备了“主体绑定目标仓库和独立 lane”的基础能力。后续可以继续把闭环做实：

1. 在 daemon/evolve 每轮开始时自动插入 `lane_status` 或 `lane_observe`，把目标仓库状态变成常规证据；其中 `lane_observe` 已可稳定运行在 lane 专用 worktree。
2. 为 `github_open_lane_pr` 增加更完整的 PR body 模板，包含 diff summary、测试结果、风险和回滚方式。
3. 增加 `github_watch_lane_pr` 和 `github_repair_lane_pr`，处理 CI 失败和 review comment。
4. 当本地闭环稳定后，再设计 `lane -> main` 的 promotion PR，但不要自动合并。
5. 为不同设备生成更好的默认 lane id，例如结合主机名和 repo path hash。

---

## 附：本轮对话问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | 用户希望设定主体后，自动进化一个本地已 clone 的 GitHub 项目，并且进化发生在独立分支上 |
| 思考 | 传统“每轮从 main 开 PR”不符合长期进化；多设备并行要求分支和 PR 不冲突；主目录不应决定自动证据来自哪个分支 |
| 方案 | 抽象为 `Subject + Repo + Lane`，每个主体/设备拥有长期 lane，每次改动从 lane 派生 work 分支；lane observe/verify 使用固定 lane worktree |
| 执行 | 新增 repo lane 解析、lane manager、target repo scope、lane 动作、worktree 泛化、显式 lane init、启动前 guard；随后补充 lane 专用 worktree 执行修正，并更新 agentank policy 与测试 |
