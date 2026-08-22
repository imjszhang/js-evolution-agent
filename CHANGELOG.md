# Changelog

## 0.2.0 — 2026-08-22

版本与发布接线升级到 0.2.0（[#178](https://github.com/imjszhang/js-evolution-agent/issues/178)）。

### 发布

- 统一根、Desktop、共享 App、打包 host、CLI、Client API、About、ACP 与构建元数据版本。
- strict preflight 覆盖 package/lockfile/runtime/builder 全部产品版本触点。
- macOS arm64 workflow 与 Release asset 接线改用 0.2.0 产物名。
- 继续保持 ad-hoc 签名、未公证、publish fail-closed 与 #77 精确 audit baseline。

## 0.1.0 — 2026-08-18

JEA 的第一个产品版本。[GitHub Release v0.1.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.1.0) 已发布（[#122](https://github.com/imjszhang/js-evolution-agent/issues/122) 已关闭）。

### 产品

- 三栏工作区：Subject / 本地会话、受治理 Channel 对话、Evolution Inspector。
- Settings overlay：JEA Home、默认 Subject、CLI 安装、外观、About。
- localhost Web 与 Electron 共用同一 React 源。
- macOS arm64 包装与托管 `jea` 启动器。

### 安全

- Web 默认 loopback；token 只出现在 `jea url`。
- #77 仍是未到期的精确 audit-baseline 例外，阻断在例外失配时发布。

### 不在本版本

- Intel / Windows / Linux 安装包、自动更新、远程 Web、npm 发布。
