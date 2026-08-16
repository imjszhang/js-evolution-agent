# Evolution（0.1.0 草稿）

状态：**draft / pending**。依赖 [#117](https://github.com/imjszhang/js-evolution-agent/issues/117) 必要 Evolution Inspector。

## 0.1.0 必要子集

Inspector 只保证这些只读能力：

- 当前 / 最近 cycle 状态与时间线
- report / diary / verify
- action receipt / evidence 摘要
- blockers

完整遗留 Viewer 对等、跨 Subject 比较、全部 observability 字段、离线 Viewer 替换都不在 0.1.0 范围。

## 提纲

1. 从三栏工作区打开 cycle 卡片，而不是单独的 Viewer 站点作为主入口。
2. 说明如何从 CLI / 遗留 Viewer 读取更高阶字段（开发期路径）。
3. Inspector 是读取面，不在 UI 里直接写 `pending_decisions.json` 或 `standing_memory.json`。
