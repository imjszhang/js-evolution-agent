# AGENTS.md

本文件是当前项目的 CLI 操作指引，面向本地操作者和自动化代理。项目主命令是 `jea`，推荐在项目根目录执行。

## 基础用法

```powershell
npm install
npm run jea -- help
```

常用入口：

```powershell
npm run jea -- <command>
npm run doctor
npm start
```

安装包 bin 链接可用后，也可以直接使用：

```powershell
jea doctor
jea run --mock
jea data status
```

## 环境与诊断

- `jea doctor`：检查 Node、依赖、`.env`、DeepSeek 配置、权威文档（`policies/authority/CONSTITUTION.md`、`GUIDE.md`）、`oada.config.mjs`，以及 `repolink.config.mjs` 声明的兄弟仓库链接（`jea doctor` 的 Repo Links 段）。
- `jea llm ping`：测试 DeepSeek 连接。
- `jea llm ping --mock`：测试本地 Mock AI 路径。
- `jea policy check`：检查当前主体策略是否包含必需章节（`Subject`）。

真实模型调用依赖 `.env` 中的 `DEEPSEEK_API_KEY`。没有 API key 时，可使用 `--mock` 走本地模拟路径。

## 外部仓库链接（js-repolink）

JEA 通过 [js-repolink](https://github.com/imjszhang/js-repolink) 引用同机器上活跃开发中的兄弟仓库（lane 目标、configured external actions），避免在 `runtime/subjects/registry.json` 中硬编码绝对路径。

| 文件 | 作用 |
| --- | --- |
| `repolink.config.mjs` | 声明链接 id、envVar、entry、preflight、versionProbe（可提交） |
| `.env` | 各链接的绝对路径，如 `AGENTANK_EVOLVER_PATH=D:/github/My/agentank-evolver` |
| `runtime/subjects/registry.json` | 使用 `link:<id>` 引用，如 `"repo": "link:agentank-evolver"` |

常用命令：

```powershell
jea doctor                    # Repo Links 段：ok / unconfigured / path-missing / entry-missing
npx repolink list             # 若全局安装 js-repolink，可独立查看链接状态
npx repolink check --link agentank-evolver
```

`external_tools.<tool>.link` 指向 repolink link id 时，Phase 2 exec 会在运行 configured external action 前做 link preflight；失败返回 `blocked` receipt（`blocked_reason: repo_link_unavailable`），而不是 ENOENT 裸报错。

自动化代理在未确认操作者路径前，不要替其写入 `.env` 中的链接路径；`link:` 引用未配置时 `jea subject check` 会报 `lane.repo_link_unresolved` / `resources.link_unresolved` 诊断。

## 模块文档索引

各子系统的详细操作指引已拆分到模块目录（模块 ownership 与契约规则见 `src/contracts/OWNERSHIP.md`）：

| 模块 | 文档 | 内容 |
| --- | --- | --- |
| 认知管线 | [src/intelligence/AGENTS.md](src/intelligence/AGENTS.md) | 运行演化循环、Agent Loop 管道、情报与报告、操作者输入、目标管理 |
| 执行层 | [src/actions/AGENTS.md](src/actions/AGENTS.md) | Phase 2 exec、人工审批与操作者意图、审计与动作 |
| AI 网关 | [src/ai/AGENTS.md](src/ai/AGENTS.md) | LLM 档案（DeepSeek V4）、KV 缓存约定 |
| Daemon 编排 | [src/daemon/AGENTS.md](src/daemon/AGENTS.md) | Daemon 工作流、step 状态与 checkpoint、批量演化 |
| Channel | [src/channel/AGENTS.md](src/channel/AGENTS.md) | Channel 通道、飞书部署、classifier / presence |

## 运行时数据

运行时数据按 active subject 隔离，默认位于：

```text
runtime/subjects/<data_namespace>/
```

常用命令：

- `jea data status`：查看当前主体运行时数据概况。
- `jea data status --json`：输出机器可读 JSON。
- `jea data init`：创建运行时数据目录，不删除历史。
- `jea data init --all`：创建目标模板并写入初始化情报。
- `jea data backup [--name NAME]`：备份当前主体运行时数据到 `backups/subjects/<data_namespace>/`。
- `jea data reset [--yes]`：删除当前主体本地运行时数据。此命令有破坏性，自动化代理不要在未确认的情况下执行。

## Subject 管理

Subject 决定策略、命名空间和运行时路径。

- `jea subject list`：列出 registry 中的 subjects 与 default subject。
- `jea subject show [--subject NAME]`：显示 subject、core layer、namespace 和 runtime paths；无 `--subject` 时使用 default subject。
- `jea subject init <name> [--use]`：从模板创建新 subject 并写入 registry；`--use` 同时设为 default。
- `jea subject use <name>` / `jea subject default <name>`：更新 `runtime/subjects/registry.json` 中的 default subject。
- `jea subject check [--subject NAME]`：校验 subject policy。
- `jea subject lane status|init [--subject NAME]`：检查或初始化目标仓库 lane。
- `jea run --subject NAME`：显式指定单轮演化主体；`jea evolve` / `jea daemon` 已支持 `--subject` / `--subjects` / `--all`。

`runtime/subjects/registry.json` 是本地 registry，可承载机器可读的 `lane` 与 `resources` 字段；字段形态参考 `policies/subjects.example.json`。主体 Markdown policy 只保留主体语义、安全边界和人工审批规则，不维护 repo、branch、resource root、resource mapping 等机器字段。

创建或切换 subject 后，通常先执行：

```powershell
jea data init --all --subject <name>
```

## 旧脚本（已移除）

以下 npm 脚本已删除，请改用 `jea`：

| 旧命令 | 替代 |
| --- | --- |
| `npm run intel` | `npm run jea -- run --mock`（或 daemon step `intel`） |
| `npm run exec` | Phase 2 由 `jea run` / daemon `exec` step 执行 |
| `npm run decisons` | `jea audit queue` |

底层 engine 源码位于 `src/engine/`（已 vendor；旧 `node_modules/js-evolution-engine` 路径不再使用）。经典 `IntelligencePipeline` / `VerifyPipeline` / GitHub Issues 模式与 PromptBuilder 模板已删除；Phase 1 由宿主 conversational / `agent_loop` 编排，Phase 2 仍走 `ExecutionPipeline` + `verifyActions`。详见 [`src/engine/VENDORED.md`](src/engine/VENDORED.md)。

## 操作建议

- 先运行 `jea doctor`，再运行真实演化。
- 本地验证优先使用 `jea run --mock` 或 `jea daemon work --once --mock`。
- 涉及删除或重置数据的命令，例如 `jea data reset --yes`，必须确认当前 subject 和 namespace。
- 多主体并行时，用 `jea daemon status --all`、`jea daemon doctor --all` 和 `jea daemon inbox --all` 做总览。
- 新 subject 接飞书机器人：先 `jea subject init` + `jea data init --all`，再 `jea channel feishu setup --subject NAME --write-env --init-subject-config`，然后 `jea daemon start --domain channel`，最后在飞书私聊 `JEA BIND <口令>`；用 `jea channel events` 验收收消息与 ingest。
- 自动化脚本需要结构化输出时，优先使用带 `--json` 的命令。
- 反应器化迁移（Phase 1–2）：证据流读侧 `jea intel stream --reconcile`；认知影子双跑 `jea reactor shadow run|compare`（不写真实决策队列）。隔离 mock canary：`npm run reactor:canary`。详见 [src/intelligence/AGENTS.md](src/intelligence/AGENTS.md)「证据流与反应器影子」。
- 发布/基线校准等人工作业：先读最新 evolution diary 与 verify report，再用 `jea intel brief put` 提交意图，然后 `jea daemon enqueue --type run_cycle` 或 `jea run`；用 `jea intel brief list` / `processed` 确认 brief 是否已被消费。
- 已确认的领域口径或术语定义（非待验证命题）：用 `jea intel fact put` 写入一次性种子；待核实或单轮优先级调整仍用 `jea intel brief put`。系统打开的 operator question 用 `jea intel question list` 查看，答复后 `question resolve`。
- 长期稳定约束写 `human_guidance.md` 的 `## Current`；一次性核实请求不要写进 guidance，改用 brief。
- 调整演化方向用 `jea goals update`；不要手改 `standing_memory.json` 或直接写 `pending_decisions.json`。
