# policies 目录说明

`policies/` 保存可提交的项目说明与示例 registry，以及每台机器/每个操作者自己的本地主体配置。仓库内通常只有 `README.md` 与 `subjects.example.json`；其余主体相关文件在本地生成且被 `.gitignore` 排除。

## 文件角色

| 路径 | 角色 | 建议 |
| --- | --- | --- |
| `README.md` | 本说明 | 可提交 |
| `authority/` | 跨 subject 共享的 Cyber-Taoist 权威文献（`CONSTITUTION.md`、`GUIDE.md`） | 可提交；见 `authority/README.md` |
| `subjects.example.json` | 可提交的 `subjects.json` 示例 | 新增结构化字段时先更新这里 |
| `subjects.json` | 本地 subject registry | 通常是本地状态；按当前机器路径配置 |
| `subjects/<id>/SUBJECT.md` | 每个 subject 的治理 policy（权威文献） | 描述主体、边界和人工审批规则；进入 `agentContextDocs` |
| `subjects/<id>/SOUL.md` | 每个 subject 的 channel persona（表达） | 人设与对外语气；**不**进入演化权威文献，仅供 channel presence / speech |
| `subjects/<id>.md` | 旧版单文件 policy（兼容） | 仍可读；若与 workspace 并存，优先 `SUBJECT.md` |
| `goals/<name>.json` | 本地 goal 源文件（可选） | `jea goals update --file` 的输入；运行时读 `runtime/.../active_goals.json` |
| `active-subject.json` | 旧版 active subject 状态（若存在） | 仅兼容旧数据；新流程使用 `subjects.json` |

`jea subject init` 的主体 policy 模板来自宿主 i18n 内置文案，**不**依赖 `policies/templates/` 下的文件（该目录当前未纳入仓库）。

## 推荐创建流程

创建新 subject 时，优先使用 CLI：

```powershell
npm run jea -- subject init <name> --use
npm run jea -- data init --all --subject <name>
npm run jea -- subject check --subject <name>
```

这会创建或更新：

- `policies/subjects.json`：注册 subject，并可设置为 default。
- `policies/subjects/<name>/SUBJECT.md` 与 `SOUL.md`：创建主体 workspace。
- `runtime/subjects/<data_namespace>/`：初始化该 subject 的运行时数据。

如果要手工创建，也应按同样顺序：

1. 在 `policies/subjects/<name>/` 下创建 `SUBJECT.md`（治理）与 `SOUL.md`（persona）。
2. 在 `policies/subjects.json` 的 `subjects` 中登记该 subject。
3. 如需要外部目标仓库，补充 `lane` 和 `resources`。
4. 运行 `jea subject check --subject <name>` 校验。
5. 运行 `jea data init --all --subject <name>` 初始化运行时数据（会写入 bootstrap 版 `active_goals.json`）。
6. 按需编写本地 `policies/goals/<name>.json` 并运行 `jea goals update`（见下文「goals 的创建方式」）。

## goals 的创建方式

演化循环**只读** `runtime/subjects/<data_namespace>/data/goals/active_goals.json`。`policies/goals/` 是可选的本地源目录，供 `jea goals update --file` 写入 runtime；直接改 `policies/goals/` 不会自动生效，必须再跑 `goals update`。

`data init --all` 会先写入宿主默认 bootstrap goals；若与主体语义不符，在本地新建 JSON 后更新：

```powershell
# 1. 在 policies/goals/ 下创建 <name>.json（该目录已被 .gitignore，仅本机保留）
# 2. 写入 runtime
npm run jea -- goals update --file policies/goals/<name>.json --reason "初始化主体目标" --subject <name>
npm run jea -- goals show --subject <name>
```

Goal JSON 需包含字段：`id`、`name`、`intent`、`good_signal`、`bad_signal`、`children`（数组，子节点结构相同）。Decide 阶段 action 的 `serves_goal` 应对齐树中的 `id`。

Phase 4.5 在 `status=refine` 且 `confidence=high` 时也可能自动改写 runtime 里的 `active_goals.json`；若需与本地源文件对齐，改完后应手动同步或再次 `goals update`。

## subjects.json 的创建方式

`subjects.json` 的推荐起点是复制 `subjects.example.json`：

```powershell
Copy-Item policies\subjects.example.json policies\subjects.json
```

然后修改：

- `default_subject`：当前默认 subject 名称。
- `subjects.<name>.policy`：治理 policy 路径，通常是 `subjects/<name>/SUBJECT.md`。
- `subjects.<name>.data_namespace`：运行时数据命名空间，通常等于 subject 名。
- `subjects.<name>.lane`：目标仓库、分支和验证命令。
- `subjects.<name>.resources`：外部资源 root、alias 和路径映射。

`subjects.json` 是机器可读 registry。不要把 repo 路径、分支、验证命令、resource mapping 继续塞进 Markdown policy 里。

## lane 字段

`lane` 描述外部目标仓库的受控工作 lane：

```json
"lane": {
  "repo": "D:\\path\\to\\target-project",
  "base_branch": "main",
  "lane_branch": "jea/my-subject/local",
  "work_branch_prefix": "jea/my-subject/work",
  "test_command": "npm test",
  "run_command": "npm start",
  "github_repo": "owner/repo"
}
```

字段含义：

- `repo`：目标仓库本地路径。
- `base_branch`：目标仓库基线分支。
- `lane_branch`：长期进化 lane。
- `work_branch_prefix`：单轮工作分支前缀。
- `test_command`：验证命令。
- `run_command`：观察或同步命令。
- `github_repo`：远端 GitHub 仓库名，格式为 `owner/repo`。

写入型外部项目 action 会优先通过 subject lane 派生 worktree，而不是直接写目标仓库主目录。

## resources 字段

`resources` 用来把 action 中的资源 scope 映射到真实目录，并把相对路径归类到对应资源。

推荐保持简单：

```json
"resources": {
  "roots": {
    "target_repo": "D:\\path\\to\\target-project"
  },
  "aliases": {
    "target_project": "target_repo"
  },
  "rules": [
    {
      "kind": "target_project",
      "scope": "target_project",
      "patterns": [
        "src/**",
        "test/**"
      ]
    }
  ]
}
```

字段含义：

- `roots`：真实 root。一个外部目标仓库通常只需要 `target_repo`。
- `aliases`：业务别名到 root scope 的映射。模型或旧 action 可以继续使用更语义化的 scope，例如 `agentank_evolver`。
- `rules`：相对路径到资源 `kind` / `scope` 的映射。除非确实需要细分门禁或报告分类，优先使用少量宽规则。

`subject_runtime` 和 `source_root` 不需要写进 `roots`：它们由运行时和宿主源码根自动解析。

## subject workspace 的创建方式

`SUBJECT.md` 只写语义和边界，不写机器配置。`SOUL.md` 只写对外人设与表达约束（参考 OpenClaw SOUL 模板结构：Who I Am / Purpose / Operate / What I will not do），**不得**在 SOUL 中声明发布授权、凭据使用或审批放行。

`SUBJECT.md` 建议保留这些章节：

```markdown
# <name> 项目指导

## Subject

描述这个 subject 是谁、要演化什么、什么算有效进展。

## Core Layer

- 不可破坏的信任、凭据、身份、审计或回滚边界。

## Allowed First-Phase Actions

- 第一阶段允许读取、记录、模拟或排队哪些动作。

## Off-Limits Without Human Approval

- 没有人类审批时禁止执行的行为。

## Runtime Boundary Model

- 说明资源 root、lane、命令和 resource mapping 由 `subjects.json` 维护。
- 说明敏感读取、越界写入和核心层修改必须先审批。
```

`SUBJECT.md` 会进入 agent context 作为权威文献；因此应避免写入本地绝对路径、密钥、机器专属分支策略或会频繁变化的运行参数。`SOUL.md` 仅供 channel 表达，不参与 Decide / goals 的治理约束。

不要在 subject policy 中维护 subject-specific action 菜单（例如 `sync/generate/simulate/publish` 等独立 action type）。这类业务能力应通过 `subjects.json` 的 `lane` / `resources` 配置，或 `runtime/subjects/<namespace>/data/config/actions.json` 中的 configured external actions 表达；Intel 阶段默认用 `agent_run` 承载复杂任务，用记录型 action 落证据。

## 提交策略

**仓库内可提交：**

- `policies/README.md`
- `policies/subjects.example.json`

**通常不要提交（已在 `.gitignore` 或应为本地状态）：**

- `policies/subjects.json`
- `policies/subjects/`
- `policies/goals/`
- `policies/active-subject.json`（若仍存在）
- `runtime/`（含各 subject 的 `active_goals.json` 等运行时数据）

提交前建议运行：

```powershell
npm run jea -- subject check --subject <name>
npm test -- test/cli.test.mjs
```
