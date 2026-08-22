# JEA 0.2.0

日期：2026-08-22。候选版本：`v0.2.0`；在认证完成和操作者放行前不得创建 tag 或 GitHub Release。

## 已交付

- macOS Apple Silicon（`arm64`）应用：`JEA.app`，source root 在 `Contents/Resources/app`。
- 同一套 React 三栏工作区：Subject / 本地会话、受治理对话、Evolution Inspector，外加 Settings overlay。
- localhost Web host 与 Electron 共用 renderer；默认只绑定 loopback。
- 托管 CLI：Settings 安装 `~/.local/bin/jea`，用应用内 Electron（`ELECTRON_RUN_AS_NODE=1`）执行，不要求机器预装 Node.js。
- 生命周期：`jea --version`、`jea start --no-open`、`jea status --json`、`jea url`、`jea stop`。

## 签名与安全基线

- 签名策略：ad-hoc（`codesign --sign -`），**未公证**。Gatekeeper 会拦截，需右键打开。
- #77 仍开放：`undici` 三条 GHSA 作为精确、未过期（2026-11-15）、`fixAvailable=false` 的 audit-baseline 例外。`npm run audit:ci` 必须留在发布路径。

## 认证口径

- 候选构建必须通过 package smoke、打包恢复矩阵、打包 CLI 旅程、launch smoke 与分阶扫描。
- 30 分钟 soak 是 release-only 门禁，不进入 PR required checks。
- `publish-guard` 不自动发版；认证证据完整后仍需操作者明确放行。
- 放行后由 `Attach Release Assets` workflow 从官方 artifact 挂到既有 Release，不经本机中转。

## 已知限制 / 明确延期

- 不提供 Intel macOS、Windows、Linux 安装包。
- 不提供自动更新、远程 Web、npm CLI 发布。
- 聊天文本不是 hard approval，不能生成 `approval_granted`。
- 遗留 Evolution Viewer 与七页 Desktop 页面不是 0.2.0 主产品形态。
- 无源码、无独立 Node 的干净机器安装未作为单独门禁再跑一遍。

## 0.2.0 发布接线

- 根、Desktop、共享 App、host、lockfile、资源版本、Client API、About、builder、release scripts、产品身份与 ACP client identity 统一为 `0.2.0`。
- strict version preflight 覆盖所有上述触点。
- 官方产物名为 `JEA-0.2.0-macos-arm64.dmg` 与 `JEA-0.2.0-macos-arm64.zip`。
- 仍仅支持 macOS Apple Silicon；ad-hoc 签名、未公证。
- publish guard 继续 fail-closed；#77 精确 audit baseline 继续留在认证路径。
