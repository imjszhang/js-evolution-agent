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

- 当前 provider 下，读/写路径边界是 agent 行为协议与宿主预检约束，不是文件系统级硬隔离。
- 资源 root、lane、分支、验证命令和 resource mapping 属于 `policies/subjects.json` 的结构化主体配置，不在本文维护。
- `params.cwd` 必须匹配结构化 resource root；显式 `params.cwd` 不存在时应失败。
- 越界写入、敏感读取、核心层修改必须先获得人类审批。
- PR 只能指向本主体 lane，不得直接指向 `main`。
