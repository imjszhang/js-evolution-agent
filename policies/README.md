# policies 目录说明

`policies/` 保存主体选择、主体 policy、示例 registry 和策略模板。这里的文件分成两类：可提交的项目默认说明与示例，以及每台机器/每个操作者自己的本地主体状态。

## 文件角色

| 路径 | 角色 | 建议 |
| --- | --- | --- |
| `project-guidance.md` | 旧版兼容/default policy 入口 | 保留为兼容文件；新主体不要继续把机器字段写在这里 |
| `subjects.example.json` | 可提交的 `subjects.json` 示例 | 新增结构化字段时先更新这里 |
| `subjects.json` | 本地 subject registry | 通常是本地状态；按当前机器路径配置 |
| `subjects/*.md` | 每个 subject 的语义 policy | 描述主体、边界和人工审批规则 |
| `templates/project.md` | 新 subject policy 模板 | 用于 `jea subject init` 或人工复制 |
| `active-subject.json` | 旧版 active subject 状态 | 仅兼容旧数据；新流程使用 `subjects.json` |

## 推荐创建流程

创建新 subject 时，优先使用 CLI：

```powershell
npm run jea -- subject init <name> --use
npm run jea -- data init --all --subject <name>
npm run jea -- subject check --subject <name>
```

这会创建或更新：

- `policies/subjects.json`：注册 subject，并可设置为 default。
- `policies/subjects/<name>.md`：创建主体 policy。
- `runtime/subjects/<data_namespace>/`：初始化该 subject 的运行时数据。

如果要手工创建，也应按同样顺序：

1. 在 `policies/subjects/` 下创建 `<name>.md`。
2. 在 `policies/subjects.json` 的 `subjects` 中登记该 subject。
3. 如需要外部目标仓库，补充 `lane` 和 `resources`。
4. 运行 `jea subject check --subject <name>` 校验。
5. 运行 `jea data init --all --subject <name>` 初始化运行时数据。

## subjects.json 的创建方式

`subjects.json` 的推荐起点是复制 `subjects.example.json`：

```powershell
Copy-Item policies\subjects.example.json policies\subjects.json
```

然后修改：

- `default_subject`：当前默认 subject 名称。
- `subjects.<name>.policy`：主体 policy 路径，通常是 `subjects/<name>.md`。
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

## subject policy 的创建方式

`subjects/<name>.md` 只写语义和边界，不写机器配置。建议保留这些章节：

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

主体 Markdown policy 会进入 agent context；因此应避免写入本地绝对路径、密钥、机器专属分支策略或会频繁变化的运行参数。

## 提交策略

通常可以提交：

- `policies/README.md`
- `policies/subjects.example.json`
- `policies/project-guidance.md`
- `policies/templates/*.md`

通常不要提交：

- 机器专属的 `policies/subjects.json`
- 旧版本地状态 `policies/active-subject.json`
- 包含操作者私有路径、凭据线索或本地 lane 的 subject policy

提交前建议运行：

```powershell
npm run jea -- subject check --subject <name>
npm test -- test/cli.test.mjs
```
