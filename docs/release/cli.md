# CLI（0.1.0）

状态：**implemented / #120**；0.1.1 聚合状态见 [#141](https://github.com/imjszhang/js-evolution-agent/issues/141)。日期：2026-08-17。

## 启动器

1. 从 Settings 安装托管 `jea` 启动器，位置 `~/.local/bin/jea`。
2. 启动器使用应用自带的 Electron（`ELECTRON_RUN_AS_NODE=1`），不要求机器预装 Node.js。
3. 不会自动修改 PATH；Settings 只报告 `installed` / `onPath` / `pathHint`。
4. 升级应用后再执行一次 Install，会把已托管启动器对到当前 app 路径。
5. 不会覆盖或删除不是 JEA 托管的同名文件。

## 版本与域命令

- `jea --version` 与根 package / Desktop / About 同为 `0.1.0`。
- 保留现有域命令：`doctor`、`run`、`daemon`、`channel`、`intel`、`subject` 等。

## 产品生命周期

```bash
jea start --no-open
jea status --json
jea url
jea stop
```

- `start --no-open` 不打开浏览器、不创建窗口、不操作 Dock。已在跑的健康实例会被检测，不会再起一份。Web host 入口是 `apps/desktop/out/web-host/server-main.mjs`（`npm run web-host:build` / `desktop:build`），不再走 Node `--experimental-strip-types`。
- `status --json` 只描述 localhost Web host 的 bind/pid，不含 Web token，也不是 Subject/Cycle/Channel 就绪状态。
- `jea product status --json --subject NAME`（别名 `jea readiness`）输出与 `service.getReadiness` 相同的 state/reason 码：Web host、Cycle、Channel、model、conversation。Subject 解析规则与其它域命令相同。
- 只有 `jea url` 可以打印带 `access_token` 的 URL。
- `stop` 先 SIGTERM，超时后再对**自己拥有的 pid** 做有界 SIGKILL。

从源码执行 `npm run jea --` 仍是开发路径。卸载启动器与删除应用是不同操作；JEA Home 默认保留。见 [uninstall.md](./uninstall.md)。
