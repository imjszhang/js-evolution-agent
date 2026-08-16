# Web host（localhost）

本目录是 JEA 0.1.0 localhost Web host 的 owner，对应 issue #118。

## 边界

- 只绑定 loopback（默认 `127.0.0.1`）。禁止静默扩大到 `0.0.0.0`。
- RPC 必须走 `createApplicationCommandHost` / `apps/desktop/src/client-api/owners/`。不要把 `src/intelligence/evolution-viewer/api-core.mjs` 做成第二套业务命令实现。
- Transport adapter 在 `apps/desktop/src/client-api/adapters/web.ts`，与 Electron adapter 暴露同一套 `JeaClient` 方法/参数形状。
- `local-only` 与 `destructive` 必须返回稳定的 `COMMAND_NOT_ALLOWED`，不能做成 no-op。
- token 不得出现在普通日志、status JSON、events、stack traces，或非认证必需的 bootstrap 字段。只有 `jea url` 打印已认证 URL。

## 协议

- `GET /jea/bootstrap`：协议版本、允许/拒绝的命令能力、事件传输元数据。
- `POST /jea/rpc`：已认证 same-origin 应用命令。
- `GET /jea/events`：SSE，支持 `cursor` / `Last-Event-ID` 续传。

## 测试

```bash
npm run test:web-host
npm run test:client-api
```
