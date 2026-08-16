# 首次运行（0.1.0 草稿）

状态：**draft / pending**。依赖 [#121](https://github.com/imjszhang/js-evolution-agent/issues/121) Setup / Settings。  
不要把当前 Desktop 的多页切换写成产品首次体验。

## 提纲

1. 启动后进入最小 Setup，而不是手改 `registry.json`。
2. 选择或创建 JEA Home；干净安装应能使用临时 / 空目录。
3. 初始化一个 Subject，并明确说明是否启用 desktop Channel。
4. 已有 Subject 若缺少 desktop Channel，不得被静默改写；UI 必须给出显式启用动作与影响说明。
5. 模型路径：无 `DEEPSEEK_API_KEY` 时可走 mock；真实模型需要操作者自行配置，且密钥不得写入发布产物。
6. Setup 完成后进入三栏工作区，而不是 Operations / Todo / Channel / ACP 七页布局。

认证入口见 [0.1.0-certification.md](./0.1.0-certification.md) 第 2 节。
