# Changelog

## 0.3.0 — 2026-08-27

JEA 0.3.0 已作为 [GitHub Release v0.3.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.3.0) 发布（[#208](https://github.com/imjszhang/js-evolution-agent/issues/208)）。闭环门槛仍冻结在 `0.2.0-belief-loop`；新增独立的 `0.3.0-reactor-control-plane` 验收目标。

### 运行时

- 把 evidence 权威与 Reactor 工作分开：Activation Ledger 身份是 `(reactor, evidence_key, activation_policy_version)`；journal rebuild 不创造新工作。
- 统一 Activation Ledger store、router、scheduler、cognitive skip 与 progress projection。
- 产品面不再把 heartbeat + 大量 replay ready 映射成 `catching_up`。
- Channel 与 Cycle 共用同一套 LLM 预算账本（`jea llm budget`）。

### 发布接线

- 统一根、Desktop、共享 App、打包 host、CLI、Client API、About、ACP 与构建元数据版本为 `0.3.0`。
- 新增 `policies/release/control-plane-target-0.3.0.json` 与 `jea audit control-plane` / `npm run audit:control-plane`。
- certification evidence allowlist 增加 `control-plane-audit.json`。
- 官方 `macOS Release` preflight 用 `--out` 写 `control-plane-audit.json`，避免 `npm run` banner 污染 JSON。
- Linux 控制面审计缺少 packaged `build_id` 时，认证证据写入器补齐 provenance，不再误报 `build_mismatch`。
- 不自动打 tag，不自动创建 GitHub Release。

## 0.2.1 — 2026-08-24

JEA 0.2.1 已作为 [GitHub Release v0.2.1](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.2.1) 发布（[#202](https://github.com/imjszhang/js-evolution-agent/issues/202) 已关闭）。闭环门槛仍冻结在 `0.2.0-belief-loop`。

### 产品

- Desktop 打开时按 client lifecycle 自动 attach/启动当前 Subject 的 Cycle（[#189](https://github.com/imjszhang/js-evolution-agent/pull/189)、[#190](https://github.com/imjszhang/js-evolution-agent/pull/190)）。
- Desktop supervisor lease 约束托管 Cycle/Channel，避免无主或过期 worker 继续跑（[#196](https://github.com/imjszhang/js-evolution-agent/pull/196)）。

### 运行时

- 收紧 hot claim 存储，超大 ledger 可流式迁移，避免历史 claims 把 Electron 打到 OOM（[#196](https://github.com/imjszhang/js-evolution-agent/pull/196)）。
- Rule 失败恢复有界：保留 evidence、限制重放/墙钟/失败预算，并处理 split/circuit/quarantine（[#198](https://github.com/imjszhang/js-evolution-agent/pull/198)）。
- 可重建 evidence journal：只读 inspect，停机后 rebuild/compact/rotate，以及显式 backup rollback（[#199](https://github.com/imjszhang/js-evolution-agent/pull/199)）。

### 发布

- Attach Release Assets 工作流先安装锁定依赖再校验资产（[#186](https://github.com/imjszhang/js-evolution-agent/pull/186)）。
- 认证路径允许 Channel coordinator 在同一 PID 上托管全部默认 role（[#205](https://github.com/imjszhang/js-evolution-agent/pull/205)）。
- 统一根、Desktop、共享 App、打包 host、CLI、Client API、About、ACP 与构建元数据版本为 `0.2.1`。

## 0.2.0 — 2026-08-22

JEA 0.2.0 已作为 [GitHub Release v0.2.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.2.0) 发布（[#178](https://github.com/imjszhang/js-evolution-agent/issues/178) 已关闭）。

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
