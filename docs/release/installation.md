# 安装（0.1.0）

状态：**implemented / #120**。日期：2026-08-16。  
这不是已发布 GitHub Release 说明；描述的是 macOS arm64 包装路径。

## 适用范围

- 平台：macOS Apple Silicon（`arm64`）only
- 产物：`JEA-0.1.0-macos-arm64.dmg` 或 `.zip`，外加 `SHA256SUMS`
- 不在 0.1.0 范围：Intel macOS、Windows、Linux 安装包、自动更新、npm 发布

## 安装步骤

1. 从 GitHub Release 选择 arm64 产物，并对照 `SHA256SUMS`。
2. 0.1.0 默认是 **ad-hoc 签名、未公证**。Gatekeeper 会拦截；请在 Finder 中右键 `JEA.app` → 打开。不要把应用放到随机下载目录长期运行。
3. 将 `JEA.app` 放到 `/Applications` 或 `~/Applications`。开发/恢复可用 `JEA_APP_PATH` 指向其他位置。
4. 首次启动不要求源码 checkout，也不要求机器上已安装 Node.js。
5. 用户数据在 JEA Home（默认 `~/.jea`），不在应用包内。应用包不得包含 `.env`、开发者绝对路径或用户 runtime。

开发者从源码运行 Desktop（`npm run desktop:dev`）不是 0.1.0 安装路径。
