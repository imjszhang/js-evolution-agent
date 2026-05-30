# policies/authority — 共享权威文献

本目录存放 **跨 subject 共享** 的 Cyber-Taoist 权威文档，在 Phase 1 intel（report / analyze+decide）中全文注入 AI system prompt。

| 文件 | 角色 |
| --- | --- |
| `CONSTITUTION.md` | Cyber-Taoist 进化学宪章 |
| `GUIDE.md` | Cyber-Taoist 进化学应用指南 |

## 与 `policies/subjects/` 的分工

- **`authority/`**：项目级、可提交、所有 subject 共用。
- **`subjects/<name>.md`**：per-subject 语义 policy（边界、审批规则）；通常本地维护，见仓库 `.gitignore`。

## 覆盖默认路径

默认由 [`oada.config.mjs`](../../oada.config.mjs) 读取本目录。如需临时使用其他目录，设置环境变量 `CYBER_TAOIST_DOCS_DIR`。

演化循环 **不会写入** 这些 Markdown 文件。
