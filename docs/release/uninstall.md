# 卸载与数据（0.1.0 草稿）

状态：**draft / pending**。依赖 [#120](https://github.com/imjszhang/js-evolution-agent/issues/120)、[#121](https://github.com/imjszhang/js-evolution-agent/issues/121)。

## 必须写清的区别

| 操作 | 删除什么 | 默认是否保留 JEA Home |
| --- | --- | --- |
| 从 Settings 卸载托管 `jea` 启动器 | `~/.local/bin/jea`（以 #120 为准） | 保留 |
| 删除 `JEA.app` | 应用包 | 保留 |
| 删除 JEA Home | `<JEA_HOME>/subjects/<namespace>/` 运行时数据 | 否，这是破坏性操作 |

JEA Home 默认是 `~/.jea`，可用 `JEA_HOME` 覆盖。干净安装认证必须使用临时 Home，不得写真实 `~/.jea` 或仓库 `runtime/`。

`jea data reset --yes` 会删除当前 Subject 的本地运行时数据。自动化代理与卸载文档都必须先确认 Subject / namespace。
