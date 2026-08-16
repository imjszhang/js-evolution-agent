# macOS 包装决策（0.1.0 / #120）

状态：**implemented**。日期：2026-08-16。

## 冻结字段

| 项 | 值 |
| --- | --- |
| 产品名 | `JEA` |
| Bundle identifier | `com.imjszhang.jea` |
| 可执行文件 | `JEA.app/Contents/MacOS/JEA` |
| 最低 macOS | 13.0 |
| 架构 | Apple Silicon `arm64` only |
| 产物名 | `JEA-0.1.0-macos-arm64.dmg` / `.zip` |
| 签名策略 | ad-hoc（`codesign --sign -`）。未公证。可用 `CSC_NAME` 覆盖为 Developer ID。 |
| 打包 source root | `JEA.app/Contents/Resources/app` |
| `jea start` 启动的服务 | localhost Web host（`<JEA_HOME>/web-host/`） |

## 布局

Electron 主进程仍从 `apps/desktop/out/main` 用 `../../../../src` 解析 JEA 模块。安装包把仓库根布局复现到 `Contents/Resources/app`，因此同一相对路径在 checkout 与 packaged 下都成立。

托管 CLI 启动器写到 `~/.local/bin/jea`，以 `ELECTRON_RUN_AS_NODE=1` 调用应用内 Electron，再执行 `src/cli/jea.mjs`。只覆盖带 `# jea-managed-launcher 1` 标记的文件。

## 构建

```bash
npm run desktop:stage
npm run desktop:package
```

`desktop:package` 仅在 darwin arm64 上产出 DMG/ZIP；Linux CI 跑分阶扫描与启动器单测。
