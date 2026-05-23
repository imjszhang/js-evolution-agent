# js-evolution-agent Project Guidance

Generated: 2026-05-11T12:10:27.8975990+08:00

## Subject

`js-evolution-agent` is this project's controlled self-evolution host.

## Core Layer

- operator trust, reviewability, and rollback
- local subject data integrity
- external core packages and Cyber-Taoist documents are out of scope for this phase

## Allowed First-Phase Actions

- Read and analyze context.
- Record observations, reviews, receipts, and probe proposals.
- Queue bounded follow-up decisions.

## Off-Limits Without Human Approval

- Modifying core packages or external documents.
- Creating commits, pushing branches, or opening pull requests.
- Running destructive commands, broad rewrites, or writing outside the project tree.
- Executing non-record `core` layer actions.

## Runtime Boundary Model

- Host source: `D:\github\My\js-evolution-agent`，使用 `resource_scope=source_root`。
- Subject runtime: `D:\github\My\js-evolution-agent\runtime\subjects\<subject-name>`，使用 `resource_scope=subject_runtime`。
- Target repo: 如果主体绑定外部仓库，在主体 policy 的 `Subject Repo Lane` 中声明 `Repo`，并使用 `resource_scope=target_repo`。
- Git lane: 自动代码改进应从主体 lane 派生 `work/*` 分支和 worktree；验证通过前不得直接改写 lane，且不得直接指向 `main`。
- Safety: `params.cwd` 必须匹配资源 root；显式 `params.cwd` 不存在时应失败；越界写入、敏感读取、核心层修改必须先获得人类审批。

## Subject Repo Lane

- Repo: `D:\path\to\target-project`
- Base Branch: `main`
- Lane: `jea/js-evolution-agent/local`
- Test Command: `npm test`
- Run Command: `npm start`
- GitHub Repo: `owner/repo`

## Probe Requirements

- `hypothesis`
- `success_signal`
- `failure_signal`
- `death_boundary`
