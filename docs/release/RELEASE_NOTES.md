# JEA 0.1.0

日期：2026-08-18。这是已发布 GitHub Release [v0.1.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.1.0) 的说明。tag 指向 `3ec2a59`。

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

- 官方构建：[run 32117407472](https://github.com/imjszhang/js-evolution-agent/actions/runs/32117407472)。package smoke、打包恢复矩阵、打包 CLI 旅程、15 秒 launch smoke、分阶扫描通过。
- 官方 dispatch 跳过 30 分钟 soak（`soak=false`）。本机在 `ee41a1f` 上跑过 30 分钟打包 soak。
- 这是操作者明确放行，不是 `publish-guard` 对官方 CI 证据给出 `certified` 后的自动发版。
- 产物由 `Attach Release Assets` workflow 从官方 artifact 挂到 Release，不经本机中转。

## 已知限制 / 明确延期

- 不提供 Intel macOS、Windows、Linux 安装包。
- 不提供自动更新、远程 Web、npm CLI 发布。
- 聊天文本不是 hard approval，不能生成 `approval_granted`。
- 遗留 Evolution Viewer 与七页 Desktop 页面不是 0.1.0 主产品形态。
- 无源码、无独立 Node 的干净机器安装未作为单独门禁再跑一遍。
- 不要把产品号改成 `0.1.1`。
