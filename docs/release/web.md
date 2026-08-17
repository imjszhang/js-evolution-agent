# Web（0.1.0）

状态：**implemented / #118**。日期：2026-08-17。localhost Web host 见 [#118](https://github.com/imjszhang/js-evolution-agent/issues/118)。0.1.1 聚合状态见 [#141](https://github.com/imjszhang/js-evolution-agent/issues/141)。

## 产品边界

- 目标：localhost only。远程 / 多用户 Web 不在 0.1.0 范围。
- Electron 与 Web 应加载同一套 React 三栏工作区（#115），而不是现在的独立 Viewer 页面。
- 遗留 Evolution Viewer（`jea intel viewer serve`）仍是开发 / 高级读取入口，不是 0.1.0 主产品。

## 提纲

1. 默认只绑定 loopback（`127.0.0.1`）。`0.0.0.0` 会被拒绝，不会静默扩大。
2. 拒绝缺失或无效认证（RPC / events / bootstrap）。
3. 拒绝 local-only / 破坏性命令；只允许目录里 `availability.web === true` 且 capability 为 `readonly` 或 `write` 的命令。
4. token 不得出现在普通日志、status JSON、events 或错误里；只有 `jea url` 打印已认证 URL。
5. 与 Electron 的能力差异必须写清（哪些命令 Web 不可用）。

## 生命周期

```text
jea start --no-open [--port 8788]
jea status --json
jea product status --json --subject NAME
jea url
jea stop
```

`jea status --json` 仍只报告 Web host。Subject / Cycle / Channel 就绪请用 `jea product status` 或 Client API `service.getReadiness`。Web 可读取就绪状态，但不能执行 start / stop / repair；这些动作返回 `COMMAND_NOT_ALLOWED`，UI 会指向 Desktop / CLI。

- `GET /jea/bootstrap`：协议版本、允许/拒绝的命令能力、事件传输元数据（不含 token）。
- `POST /jea/rpc`：已认证 same-origin 应用命令。
- `GET /jea/events`：SSE，支持 `cursor` / `Last-Event-ID` 续传。
