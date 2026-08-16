# Client API（JeaClient）

本目录是 JEA 0.1.0 统一 Client API 与应用命令层的 owner，对应 issue #116。

## 边界

- Renderer / 未来共享 React 特性只能依赖本目录导出的 `JeaClient` 与公开类型。
- Transport adapter（`adapters/electron.ts`、`adapters/memory.ts`）不得包含领域决策，也不得直接写运行时文件。
- 应用命令 owner（`owners/`、`host.ts`）调用现有 JEA 领域 API；不要在此复制治理、审批或 Subject policy。
- 不要把 `src/intelligence/evolution-viewer/api-core.mjs` 做成第二套业务命令实现。
- 0.1.0 产品目录是最小子集：Subject、本地会话/消息、必要 Evolution 读、服务状态/控制与开轮、Setup/Settings、CLI 状态。ACP 与高级 CLI 不进入本目录。

## 协议

- 协议标识：`jea.client`
- 协议版本：`JEA_CLIENT_PROTOCOL_VERSION`（当前 `1.0.0`）
- 机器可读目录：`catalog.ts` / `catalog.json`
- 能力级别：`readonly` | `write` | `local-only` | `destructive`
- `local-only` 与 `destructive` 对 Web 不可用；0.1.0 产品目录不含 destructive 命令。

## 测试

```bash
npm run test:client-api
```

根目录 `npm test` 与 `npm run desktop:test` 也会收集 `apps/desktop/test/client-api/`。
