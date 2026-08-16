# 0.1.0 认证记录（未放行）

日期：2026-08-16。`status` 不是 `certified`。禁止据此创建 `v0.1.0` tag 或 GitHub Release。

## 已核实

- PR #130 已合入，#120 已关闭。
- `npm run release:preflight -- --strict`：根 / Desktop / CLI / Client API / About 均为 `0.1.0`。
- 本机产物：`JEA-0.1.0-macos-arm64.dmg`（145M）、`.zip`（125M）、`SHA256SUMS`、`RELEASE_NOTES.md`。
- `release-package-smoke`：`smoked`。
- `release-artifact-scan --root dist/release/stage`：`clean`（无 `.env` / 凭据 / 开发者路径）。
- `codesign --verify --deep --strict`：adhoc。
- 隔离 `JEA_HOME`：`jea --version`、`subject init`、`data init`、打包 CLI `--version` 通过；未写 `~/.jea`。
- #77 baseline 仍精确、未过期（2026-11-15）。

## 未放行原因

- 未创建 GitHub Release。
- 无独立 Node 的干净机器旅程未跑。
- checkout 上 `jea start` 仍受 Node `--experimental-strip-types` 限制（TypeScript parameter properties），不能当作干净安装放行证据。
- #122 保持 OPEN。
