# Evolution Viewer 可观测性（P0）

## 变更摘要

- 新增 `src/intelligence/evolution-viewer/observability-projection.mjs`：聚合 daemon/channel/operator brief，输出 `attention`、`cycle_diagnostics`、`channel_diagnostics`、`operator_inputs`。
- Viewer API：`GET /api/subjects/:subject/observability`、`GET /api/observability`；`/api/subjects` 摘要含 `attention`；cycle detail 附加 `diagnostics` 与 `observability_attention`。
- 前端：Attention Overview 面板、Channel Presence 折叠详情、Cycle 诊断区与任务 error 列；`live-state.js` 增加 `observabilityFingerprint()`。

## 验收

```powershell
npm test -- test/evolution-viewer-live.test.mjs test/evolution-viewer-live-state.test.mjs
npm run jea -- intel viewer serve --subject agentank-tank
```

人工：多 subject 卡片显示关注数；active subject 顶部待关注列表；Channel 折叠区可见 reactor / pending speech；open cycle 详情可见诊断块。
