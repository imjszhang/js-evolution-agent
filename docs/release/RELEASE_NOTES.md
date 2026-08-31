# JEA 0.3.1

日期：2026-08-31。候选补丁，尚未创建 GitHub Release。认证清单见 [0.3.1-certification.md](./0.3.1-certification.md)，对应 [#246](https://github.com/imjszhang/js-evolution-agent/issues/246)。上一产品版是 [v0.3.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.3.0)。

## 本补丁包含

- 控制面生产接线：产品工作只跟 Activation Ledger（#233）。
- Ledger 崩溃安全写入与 mixed-fixture 认证（#241）。
- Ledger v2：有界 hot open work 与 terminal shard（#242）。
- 产品可见的升级 / 迁移状态机（#243）。
- 打包 Desktop lifecycle soak（#240）。
- lucide-react 1.34.0、开发依赖 minor/patch、download-artifact v8、CodeQL Action patch（#193、#234、#195、#194）。

## 已交付（沿用 0.3.0）

- macOS Apple Silicon（`arm64`）应用：`JEA.app`，source root 在 `Contents/Resources/app`。
- 同一套 React 三栏工作区：Subject / 本地会话、受治理对话、Evolution Inspector，外加 Settings overlay。
- localhost Web host 与 Electron 共用 renderer；默认只绑定 loopback。
- 托管 CLI：Settings 安装 `~/.local/bin/jea`，用应用内 Electron（`ELECTRON_RUN_AS_NODE=1`）执行，不要求机器预装 Node.js。
- 生命周期：`jea --version`、`jea start --no-open`、`jea status --json`、`jea url`、`jea stop`。
- 共用 LLM 预算账本：`jea llm budget status|raise|period-open|set-admission`。
- 控制面验收：`jea audit control-plane` / `0.3.0-reactor-control-plane`。

## 签名与安全基线

- 签名策略：ad-hoc（`codesign --sign -`），**未公证**。Gatekeeper 会拦截，需右键打开。
- #77 仍开放：`undici` 三条 GHSA 作为精确、未过期（2026-11-15）、`fixAvailable=false` 的 audit-baseline 例外。`npm run audit:ci` 必须留在发布路径。

## 认证口径

- 候选构建必须通过 package smoke、打包恢复矩阵、打包 CLI 旅程、launch smoke、30 分钟 soak 与分阶扫描。
- 30 分钟 soak 是 release-only 门禁，不进入 PR required checks。
- `publish-guard` 不自动发版；认证证据完整后仍需操作者明确放行。
- 放行后由 `Attach Release Assets` workflow 从官方 artifact 挂到既有 Release，不经本机中转。
- 闭环审计继续使用冻结的 `0.2.0-belief-loop` 目标，不另开 0.3.1 contract。
- 控制面验收继续使用冻结的 `0.3.0-reactor-control-plane` 目标。

## 已知限制 / 明确延期

- 不提供 Intel macOS、Windows、Linux 安装包。
- 不提供自动更新、远程 Web、npm CLI 发布。
- 聊天文本不是 hard approval，不能生成 `approval_granted`。
- Client API protocol 保持 `1.0.0`（additive）。
- Dependabot 生产依赖组（#235 / #244）与未进 main 的 web-host stale-bundle 修复不在本补丁。

## 0.3.1 发布接线

- 根、Desktop、共享 App、host、lockfile、资源版本、Client API、About、builder、release scripts、产品身份与 ACP client identity 统一为 `0.3.1`。
- strict version preflight 覆盖所有上述触点。
- 官方产物名为 `JEA-0.3.1-macos-arm64.dmg` 与 `JEA-0.3.1-macos-arm64.zip`。
- 仍仅支持 macOS Apple Silicon；ad-hoc 签名、未公证。
- publish guard 继续 fail-closed；#77 精确 audit baseline 继续留在认证路径。

---

# JEA 0.3.0

日期：2026-08-27。[GitHub Release v0.3.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.3.0) 已发布，tag 指向已认证提交 `1377a31`。认证清单见 [0.3.0-certification.md](./0.3.0-certification.md)，对应 [#208](https://github.com/imjszhang/js-evolution-agent/issues/208)。上一产品版是 [v0.2.1](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.2.1)。

## 本补丁包含

- 把 evidence 权威与 Reactor 工作分开：Activation Ledger 身份是 `(reactor, evidence_key, activation_policy_version)`，journal rebuild 不再把历史证据伪装成数千 Cognitive 待办。
- 统一 Activation Ledger store、router、scheduler、cognitive skip、progress projection（#226）。
- 产品面不再把 heartbeat + 大量 replay ready 映射成 `catching_up`（#227）。
- 共用 LLM 预算账本：`jea llm budget status|raise|period-open|set-admission`（#220）。Channel 与 Cycle 同一账本。
- 控制面验收：`jea audit control-plane` / `0.3.0-reactor-control-plane`。冻结的 `0.2.0-belief-loop` closure target 字节级不变。
- certification evidence / attach allowlist 增加 `control-plane-audit.json`。

## 已交付（沿用 0.2.1）

- macOS Apple Silicon（`arm64`）应用：`JEA.app`，source root 在 `Contents/Resources/app`。
- 同一套 React 三栏工作区：Subject / 本地会话、受治理对话、Evolution Inspector，外加 Settings overlay。
- localhost Web host 与 Electron 共用 renderer；默认只绑定 loopback。
- 托管 CLI：Settings 安装 `~/.local/bin/jea`，用应用内 Electron（`ELECTRON_RUN_AS_NODE=1`）执行，不要求机器预装 Node.js。
- 生命周期：`jea --version`、`jea start --no-open`、`jea status --json`、`jea url`、`jea stop`。

## 签名与安全基线

- 签名策略：ad-hoc（`codesign --sign -`），**未公证**。Gatekeeper 会拦截，需右键打开。
- #77 仍开放：`undici` 三条 GHSA 作为精确、未过期（2026-11-15）、`fixAvailable=false` 的 audit-baseline 例外。`npm run audit:ci` 必须留在发布路径。

## 认证口径

- 候选构建必须通过 package smoke、打包恢复矩阵、打包 CLI 旅程、launch smoke、30 分钟 soak 与分阶扫描。
- 30 分钟 soak 是 release-only 门禁，不进入 PR required checks。
- `publish-guard` 不自动发版；认证证据完整后仍需操作者明确放行。
- 放行后由 `Attach Release Assets` workflow 从官方 artifact 挂到既有 Release，不经本机中转。
- 闭环审计继续使用冻结的 `0.2.0-belief-loop` 目标，不另开 0.3.0 closure contract。
- 本次认证见 [run 33041434476](https://github.com/imjszhang/js-evolution-agent/actions/runs/33041434476)，资产挂载见 [run 33043939658](https://github.com/imjszhang/js-evolution-agent/actions/runs/33043939658)。

## 已知限制 / 明确延期

- 不提供 Intel macOS、Windows、Linux 安装包。
- 不提供自动更新、远程 Web、npm CLI 发布。
- 聊天文本不是 hard approval，不能生成 `approval_granted`。
- Client API protocol 保持 `1.0.0`（additive）。
- `evaluateClosureTarget` 可能因 `standing_memory.updated_at` 秒级截断把 `memory_freshness` 标成 `stale`（cursor 已是 `current`）。

## 0.3.0 发布接线

- 根、Desktop、共享 App、host、lockfile、资源版本、Client API、About、builder、release scripts、产品身份与 ACP client identity 统一为 `0.3.0`。
- 官方产物名为 `JEA-0.3.0-macos-arm64.dmg` 与 `JEA-0.3.0-macos-arm64.zip`。
- 仍仅支持 macOS Apple Silicon；ad-hoc 签名、未公证。
- publish guard 继续 fail-closed；#77 精确 audit baseline 继续留在认证路径。

---

# JEA 0.2.1

日期：2026-08-24。[GitHub Release v0.2.1](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.2.1) 已发布，tag 指向已认证提交 `1b58a39`。认证清单见 [0.2.1-certification.md](./0.2.1-certification.md)，对应已关闭的 [#202](https://github.com/imjszhang/js-evolution-agent/issues/202)。上一产品版是 [v0.2.0](https://github.com/imjszhang/js-evolution-agent/releases/tag/v0.2.0)。

## 本补丁包含

- Desktop client lifecycle 自动管理当前 Subject 的 Cycle（#189、#190）。
- Desktop supervisor lease，以及有界 claim 存储 / 超大 ledger 流式迁移（#196）。
- Rule 失败恢复预算、circuit / quarantine，以及 LLM budget exhaustion 时保留 evidence（#198）。
- Evidence journal 只读 inspect、停机 rebuild/compact/rotate、显式 backup rollback（#199）。
- Attach workflow 安装锁定依赖后再校验官方资产（#186）。
- 认证路径允许 Channel coordinator 在同一 PID 上托管全部默认 role（#205）。

## 已交付（沿用 0.2.0）

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
- 闭环审计继续使用冻结的 `0.2.0-belief-loop` 目标，不另开 0.2.1 contract。
- 本次认证见 [run 32685878713](https://github.com/imjszhang/js-evolution-agent/actions/runs/32685878713)，资产挂载见 [run 32688240101](https://github.com/imjszhang/js-evolution-agent/actions/runs/32688240101)。

## 已知限制 / 明确延期

- 不提供 Intel macOS、Windows、Linux 安装包。
- 不提供自动更新、远程 Web、npm CLI 发布。
- 聊天文本不是 hard approval，不能生成 `approval_granted`。
- 遗留 Evolution Viewer 与七页 Desktop 页面不是主产品形态。
- #183 Desktop conversation refresh、Dependabot 依赖更新、#201 LLM budget 操作者工作流不在本补丁。

## 0.2.1 发布接线

- 根、Desktop、共享 App、host、lockfile、资源版本、Client API、About、builder、release scripts、产品身份与 ACP client identity 统一为 `0.2.1`。
- strict version preflight 覆盖所有上述触点。
- 官方产物名为 `JEA-0.2.1-macos-arm64.dmg` 与 `JEA-0.2.1-macos-arm64.zip`。
- 仍仅支持 macOS Apple Silicon；ad-hoc 签名、未公证。
- publish guard 继续 fail-closed；#77 精确 audit baseline 继续留在认证路径。
