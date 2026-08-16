# 产品打包与 CLI 启动器

本目录是 JEA 0.1.0 macOS 产品身份、启动器与打包路径的 owner，对应 issue #120。

## 冻结决策

| 项 | 值 |
| --- | --- |
| 产品名 | `JEA` |
| Bundle ID | `com.imjszhang.jea` |
| 最低 macOS | 13.0 |
| 产物 | `JEA-0.1.0-macos-arm64.dmg` / `.zip` |
| 签名 | ad-hoc（未公证）；可用 `CSC_NAME` 覆盖 |
| `jea start` | 只启动 localhost Web host |
| 持久状态 | `<JEA_HOME>/web-host/` |

## 边界

- 不要在此复制 Subject policy、审批或演化决策。
- 启动器只允许覆盖带 `# jea-managed-launcher 1` 标记的文件。
- 打包后的 source root 是 `JEA.app/Contents/Resources/app`，布局与仓库根相同，以便 `apps/desktop/out/main` 的 `../../../../src` 解析继续成立。

## 常用命令

```bash
npm run desktop:stage
npm run desktop:package   # 仅 darwin arm64
npm run test:packaging
```
