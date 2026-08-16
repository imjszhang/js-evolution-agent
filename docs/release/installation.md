# 安装（0.1.0 草稿）

状态：**draft / pending**。依赖 [#120](https://github.com/imjszhang/js-evolution-agent/issues/120) 的 macOS arm64 包装。  
这不是已发布说明，也不描述当前仓库里的七页 Desktop 开发客户端。

## 适用范围

- 平台：macOS Apple Silicon（`arm64`）only
- 产物（#120 完成后）：`JEA-0.1.0-macos-arm64.dmg` 或 `.zip`，外加 `SHA256SUMS`
- 不在 0.1.0 范围：Intel macOS、Windows、Linux 安装包、自动更新、npm 发布

## 提纲（待 #120 填实）

1. 从 GitHub Release 选择 arm64 产物，并对照 `SHA256SUMS`。
2. 按 #120 选定的签名 / 公证策略处理 Gatekeeper 与首次打开。
3. 将 `JEA.app` 放到 `/Applications`（或文档化的等价位置）。
4. 首次启动不要求源码 checkout，也不要求机器上已安装 Node.js。
5. 用户数据在 JEA Home（默认 `~/.jea`），不在应用包内。应用包不得包含 `.env`、开发者绝对路径或用户 runtime。

开发者从源码运行 Desktop（`npm run desktop:dev`）不是 0.1.0 安装路径。
