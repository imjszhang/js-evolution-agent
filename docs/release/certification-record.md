# 0.1.0 认证记录（已放行）

日期：2026-08-18。GitHub Release：[v0.1.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.1.0)。tag 指向 `3ec2a59`。[#122](https://github.com/imjszhang/js-evolution-agent/issues/122) 与 [#114](https://github.com/imjszhang/js-evolution-agent/issues/114) 已关闭。

这是操作者明确放行，不是 `publish-guard` 对官方 CI 包给出 `status=certified` 之后的自动发版。官方 dispatch 未跑 30 分钟 soak。

## 已核实

- 官方构建：[run 32117407472](https://github.com/imjszhang/js-evolution-agent/actions/runs/32117407472)。`macos-release-0.1.0` 含 DMG、ZIP、SHA256SUMS、smoke / journey / matrix / launch-smoke / evidence / metadata。
- `npm run release:preflight -- --strict`：根 / Desktop / CLI / Client API / About 均为 `0.1.0`。
- 官方路径：package smoke、打包恢复矩阵、打包 CLI 旅程、15 秒 launch smoke、分阶扫描通过。
- 本机 `ee41a1f`：30 分钟打包 soak 通过；同日用该 dir-only `JEA.app` 确认能启动并进入产品界面。
- `codesign --verify --deep --strict`：adhoc，未公证。
- 隔离 `JEA_HOME` 旅程未写 `~/.jea`。
- #77 baseline 仍精确、未过期（2026-11-15）。
- Release 附件由 [Attach Release Assets](../../.github/workflows/release-attach-assets.yml) 从官方 artifact 挂上（#160）。

## 仍挂起（不阻断本次放行）

- 官方 CI 包没有 30 分钟 soak 证据；本机 soak 在 `ee41a1f`，不是 `3ec2a59`。
- 无独立 Node 的干净机器安装未作为单独门禁再跑。
- 未公证。
- [#77](https://github.com/imjszhang/js-evolution-agent/issues/77) 按 baseline 挂到 2026-11-15。
