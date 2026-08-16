# Web（0.1.0 草稿）

状态：**draft / pending**。依赖 [#118](https://github.com/imjszhang/js-evolution-agent/issues/118) localhost Web host。

## 产品边界

- 目标：localhost only。远程 / 多用户 Web 不在 0.1.0 范围。
- Electron 与 Web 应加载同一套 React 三栏工作区（#115），而不是现在的独立 Viewer 页面。
- 遗留 Evolution Viewer（`jea intel viewer serve`）仍是开发 / 高级读取入口，不是 0.1.0 主产品。

## 提纲

1. 默认只绑定 loopback。
2. 拒绝缺失或无效认证。
3. 拒绝 local-only / 破坏性命令；只允许显式分类的写入。
4. token 不得出现在普通日志、status JSON、events 或错误里；只有 `jea url` 打印已认证 URL。
5. 与 Electron 的能力差异必须写清（哪些命令 Web 不可用）。
