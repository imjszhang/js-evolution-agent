# JEA 0.1.0 发布文档

日期：2026-08-18。这些文件描述 **0.1.0 产品形态、认证门禁与已发布 Release**。

- 产品 Release：[v0.1.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.1.0)，tag 指向 `3ec2a59`。
- 0.1.0 产品是三栏工作区：Subject / 会话、受治理对话、Evolution Inspector，外加 Settings overlay。
- 已退役的七页 Desktop UI（Operations / Todo / Channel / ACP）不是产品形态。
- macOS 包装与托管 CLI 由 #120 交付；[#122](https://github.com/imjszhang/js-evolution-agent/issues/122) 与 [#114](https://github.com/imjszhang/js-evolution-agent/issues/114) 已关闭。

| 文件 | 状态 | 对应 issue |
| --- | --- | --- |
| [0.1.0-certification.md](./0.1.0-certification.md) | released | #122 |
| [certification-record.md](./certification-record.md) | released | #122 |
| [0.1.1-certification.md](./0.1.1-certification.md) | wave complete；不是独立版本 | #143 / #136 |
| [0.1.0-security-debt.md](./0.1.0-security-debt.md) | pending | #77 |
| [RELEASE_NOTES.md](./RELEASE_NOTES.md) | published | #122 |
| [packaging.md](./packaging.md) | implemented | #120 |
| [installation.md](./installation.md) | published | #120, #122 |
| [first-run.md](./first-run.md) | implemented | #121 |
| [conversation.md](./conversation.md) | implemented | #119 |
| [cli.md](./cli.md) | implemented | #120 |
| [web.md](./web.md) | implemented | #118 |
| [evolution.md](./evolution.md) | implemented | #117 |
| [uninstall.md](./uninstall.md) | implemented | #120, #121 |

根 README 描述三栏产品；开发者 checkout 路径仍保留。`v0.1.1` 不是下一步产品号，不要把 `PRODUCT_VERSION` / `RELEASE_VERSION` 改成 `0.1.1`。
