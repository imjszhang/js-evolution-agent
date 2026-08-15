# Security policy

Last updated: 2026-08-15

This repository hosts two operator-facing surfaces:

- **CLI host (`jea`)** — a Node.js evolution host that reads local subject runtime data, talks to optional model providers, and can start long-running daemons.
- **Electron desktop (`apps/desktop`)** — a local operations UI that supervises the same host CLI and subject runtimes.

Please report vulnerabilities that affect either surface.

## Reporting a vulnerability

Open a private [GitHub security advisory](https://github.com/imjszhang/js-evolution-agent/security/advisories/new) for this repository.

If that is not available, email the maintainer listed on the GitHub profile for [imjszhang](https://github.com/imjszhang). Do not file a public issue for an unfixed vulnerability.

Include:

- Affected surface (`jea` CLI, Electron desktop, or both)
- JEA / commit version
- Impact and a minimal reproduction
- Whether secrets, local subject data, or remote systems are exposed

You should receive an acknowledgement within 7 days. Fixes for supported versions are handled in private until a release or public advisory is ready.

## Supported scope

Security updates are accepted for the default branch of this repository.

In scope:

- Unauthorized local data access or secret leakage from the CLI host or desktop app
- Privilege escalation through desktop IPC / command registry
- Supply-chain issues in **direct** production dependencies that we can upgrade
- Workflow or release integrity issues in this repository

Out of scope:

- Unfixed **transitive** advisories that already have an unexpired entry in [`.github/security/audit-baseline.json`](./.github/security/audit-baseline.json) and a tracking issue
- Live model / DeepSeek prompt content (not a vulnerability in this host)
- Local operator actions that require an existing trusted session on the machine
- Issues that only reproduce with `--mock` test fixtures

## Supply-chain audit vs `jea audit`

These are different commands:

| Command | Meaning |
| --- | --- |
| `npm run audit:ci` | Production npm advisory gate. New or expired high/critical findings fail CI. |
| `jea audit queue` | Evolution evidence / decision-queue inspection. Not a dependency scanner. |

Do not copy live vulnerability lists into this policy. Remaining unfixed production advisories are tracked by the audit baseline and its GitHub issue.

## 中文摘要

请通过 GitHub private advisory 报告 CLI 宿主或 Electron 桌面中的漏洞。支持范围是本仓库默认分支。`npm run audit:ci` 是供应链审计；`jea audit` 是演化证据/队列检查，二者不是同一概念。未修复的传递依赖漏洞由 audit baseline 与跟踪 issue 管理，不写进本政策正文。
