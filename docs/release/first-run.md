# 首次运行（0.1.0）

状态：**implemented / #121**。认证入口见 [0.1.0-certification.md](./0.1.0-certification.md) 第 2 节。

干净安装与 Cloud/CI 必须使用临时 `JEA_HOME`，不得写真实 `~/.jea` 或仓库 `runtime/`。

## 产品旅程

1. 空 JEA Home 进入最小 Setup，而不是空工作区或崩溃。
2. 确认 / 解析 JEA Home（必须可写）。Web 宿主只展示当前 Home，不提供原生选目录。
3. 检测已有有效 Subject，或创建第一个 Subject，并在初始化成功后设为默认。
4. 通过既有领域 API 初始化运行时数据（`setup.initData` ≈ `data init` 的 goals + seed，不调用会写半成品默认主体的 `ensureSubjectsRegistry`）。
5. 新 Subject 写入最小安全的 `channels.desktop` + presence，以便本地受治理对话可用。
6. 已有 Subject 若未启用 desktop Channel，必须先看到影响说明，再显式启用；启用是校验后的原子写，不改飞书或其他 Channel 字段。
7. 无 `DEEPSEEK_API_KEY` 时以 mock 完成 Setup，不阻断。密钥不会出现在 UI、日志或 readiness JSON。
8. 中断或失败的 Setup 可从当前就绪检查恢复，不会再写第二个默认 Subject。
9. Setup 完成后进入三栏工作区。Conversation / Evolution 业务 UI 由 #119 / #117 填充；本波次只保证工作区按 readiness 可进入。

## Settings（0.1.0）

Settings 是 #115 的 Radix overlay。#121 只注册 `settings` 插槽内容：

- General — 语言、主题、默认 Subject（`settings.set`）
- Runtime — JEA Home、模型 / 服务就绪，无密钥
- Command Line — `installed` / `onPath` / `pathHint`；仅在 `supported` 时调用 install/uninstall；Web 显示 native-only
- About — 应用 / CLI 版本、数据位置、许可证与文档链接

Renderer 不直接写 registry / runtime JSON，也不提供 reset、迁移、原始编辑、审批绕过或任意环境变量编辑。
