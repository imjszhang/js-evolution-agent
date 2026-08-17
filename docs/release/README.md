# JEA 0.1.0 发布文档

日期：2026-08-16。这些文件描述 **0.1.0 产品形态与认证门禁**，不是已发布的 GitHub Release 手册。

- 0.1.0 产品是三栏工作区：Subject / 会话、受治理对话、Evolution Inspector，外加 Settings overlay。
- 已退役的七页 Desktop UI（Operations / Todo / Channel / ACP）不是产品形态。
- macOS 包装与托管 CLI 由 #120 交付；GitHub Release 仍由 #122 在认证放行后关闭。

| 文件 | 状态 | 对应 issue |
| --- | --- | --- |
| [0.1.0-certification.md](./0.1.0-certification.md) | in progress | #122 |
| [0.1.1-certification.md](./0.1.1-certification.md) | in progress | #143 |
| [0.1.0-security-debt.md](./0.1.0-security-debt.md) | pending | #77 |
| [RELEASE_NOTES.md](./RELEASE_NOTES.md) | draft | #122 |
| [packaging.md](./packaging.md) | implemented | #120 |
| [installation.md](./installation.md) | implemented | #120, #122 |
| [first-run.md](./first-run.md) | implemented | #121 |
| [conversation.md](./conversation.md) | implemented | #119 |
| [cli.md](./cli.md) | implemented | #120 |
| [web.md](./web.md) | implemented | #118 |
| [evolution.md](./evolution.md) | implemented | #117 |
| [uninstall.md](./uninstall.md) | implemented | #120, #121 |

根 README 已改成三栏产品描述；开发者 checkout 路径仍保留。在 `certification-evidence.json` 的 `status=certified` 之前，不得把仓库写成“0.1.0 已发布”。
