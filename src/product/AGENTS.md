# 产品打包与 CLI 启动器

本目录是 JEA 0.3.0 macOS 产品身份、启动器与打包路径的 owner。已发布产品是 [v0.3.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.3.0)。

## 冻结决策

| 项 | 值 |
| --- | --- |
| 产品名 | `JEA` |
| Bundle ID | `com.imjszhang.jea` |
| 最低 macOS | 13.0 |
| 产物 | `JEA-0.3.0-macos-arm64.dmg` / `.zip`（接线中；官方 soak / attach 仍待操作者） |
| 签名 | ad-hoc（未公证）；可用 `CSC_NAME` 覆盖 |
| `jea start` | 只启动 localhost Web host |
| `jea status` | 只报告 Web host bind/pid（不含 token） |
| `jea product status` / `jea readiness` | 聚合 Subject 就绪，复用 `service.getReadiness` 码 |
| 持久状态 | `<JEA_HOME>/web-host/` |
| 构建溯源 | 打包写入不可变 `build-metadata.json`（版本、完整 SHA、时间、platform/arch、dirty） |
| 诊断落盘 | `<JEA_HOME>/diagnostics/`（进程失败摘要与 daemon 启动失败；不含密钥或对话正文） |

发布打包与 publish 门禁拒绝 dirty provenance。`settings.exportDiagnostics` 导出脱敏机器可读报告；就绪状态消费现有 `setup.getReadiness` / `service.getReadiness` / 投影，不另建 readiness 命令目录（#138）。CLI 聚合入口是 `jea product status`（#141）。

`rule_llm_budget_exhausted` 是预期操作者状态。`service.getReadiness` / `jea product status` 的加法字段 `llm_budget` 给出 used/remaining tokens 与估算 spend；恢复命令是 `jea llm budget`，不是新手改 runtime JSON。Channel 与 Cycle 共用账本，Desktop 只解释现有 blocker，不另建产品面。

## 边界

- 不要在此复制 Subject policy、审批或演化决策。
- 启动器只允许覆盖带 `# jea-managed-launcher 1` 标记的文件。
- 打包后的 source root 是 `JEA.app/Contents/Resources/app`，布局与仓库根相同，以便 `apps/desktop/out/main` 的 `../../../../src` 解析继续成立。

## 常用命令

```bash
npm run desktop:stage
npm run desktop:package   # 仅 darwin arm64
npm run test:packaging
npm run release:preflight -- --strict
npm run release:journey            # 隔离 JEA_HOME，不写 ~/.jea
npm run release:recovery-matrix    # 有界恢复矩阵（Linux 可用 --bounded）
npm run release:recovery-soak      # 仅发布用 30 分钟 soak，勿进 PR required
npm run audit:control-plane -- --json   # 隔离 temp JEA_HOME；默认含 tiny baseline
npm run release:certification-evidence
```
