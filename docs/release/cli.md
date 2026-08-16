# CLI（0.1.0 草稿）

状态：**draft / pending**。依赖 [#120](https://github.com/imjszhang/js-evolution-agent/issues/120) 打包 CLI 与 headless 生命周期。

## 提纲

1. 从 Settings 安装托管 `jea` 启动器（预期位置 `~/.local/bin`，以 #120 为准）。
2. 打包 CLI 使用应用自带的 Electron / Node runtime，不要求机器预装 Node.js。
3. 验证 `jea --version` 与根 package / Desktop / About 一致。
4. 保留现有域命令：`doctor`、`run`、`daemon`、`channel`、`intel`、`subject` 等。
5. 新产品生命周期命令（#118 / #120）：
   - `jea start --no-open`
   - `jea status --json`
   - `jea url`（唯一允许打印已认证 URL 的命令）
   - `jea stop`
6. 卸载启动器与删除应用是不同操作；JEA Home 默认保留。见 [uninstall.md](./uninstall.md)。

从源码执行 `npm run jea --` 仍是开发路径，不是 0.1.0 安装文档的主路径。
