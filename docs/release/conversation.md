# 对话（0.1.0）

状态：**implemented / #119**。日期：2026-08-16。认证入口见 [0.1.0-certification.md](./0.1.0-certification.md) 第 2 节。

## 产品语义（不得在终稿中写反）

- 对话是 0.1.0 的主操作面，走 Channel classifier / presence / speech 管道。
- 聊天文本 **不是** 直接 hard approval，不能生成 `approval_granted`，不能直接写 decision / memory 文件。
- 不得绕过 SUBJECT 策略与人工审批门。
- 这不是“把 LLM 框嵌进 Desktop”的旁路。

## 提纲

1. 选择 Subject 与本地 session。
2. 发送本地受治理消息。
3. 仅在管道追加助手记录后展示回复。
4. 说明 Feishu 等外部通道与本地 desktop session 的区别（0.1.0 产品旅程以本地会话为准）。
5. 当前仓库里的 Channel 独立页面是开发期 UI，不是 0.1.0 产品形态。
