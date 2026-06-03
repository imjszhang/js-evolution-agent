# Evolution Viewer UI 重设计

## 变更

- 双模式：`ops` 运维总览（默认）与 `reading` 轮次阅读（`#cycle-…` 或点击轮次）。
- 顶栏精简：Subject 卡片 + 返回总览；Channel/Attention 从顶栏/侧栏移至 Ops Home 网格。
- 侧栏瘦身：仅「进行中」与「历史轮次+筛选」。
- 阅读区：报告/日记双栏为主；cycle 诊断与任务收拢至右侧 `details` 折叠栏。

## 验收

```powershell
npm test -- test/evolution-viewer-live.test.mjs test/evolution-viewer-live-state.test.mjs
npm run jea -- intel viewer serve --subject agentank-tank
```

- 无 hash 打开 → 运维总览，不自动加载报告。
- 点击 attention（含 cycle_id）或轮次 → 阅读视图。
- 「← 总览」清空 hash 回到 Ops Home。
