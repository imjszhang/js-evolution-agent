# Policy 结构化：把机器字段从 Markdown 解析里解耦

> 日期：2026-05-27  
> 项目：js-evolution-agent  
> 类型：架构设计 / 迁移落地 / 验证复盘  
> 来源：Cursor Agent 对话

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [现状分析](#2-现状分析)
3. [目标边界](#3-目标边界)
4. [方案设计](#4-方案设计)
5. [迁移步骤](#5-迁移步骤)
6. [验证策略](#6-验证策略)
7. [后续演化](#7-后续演化)

---

## 1. 背景与动机

Subject Registry 迁移解决了一个问题：主体不再依赖全局 `active-subject.json`，而是通过 `policies/subjects.json` 注册，并在运行时显式选择。

但还有第二个问题需要继续处理。

迁移前，机器仍然从 `policies/subjects/*.md` 里解析关键运行字段：

- `Subject Repo Lane`
- `Runtime Boundary Model`
- `resource_scope`
- `Resource mapping`
- `Test Command` / `Run Command`

这些字段不是单纯给人看的说明。它们会影响 lane 门禁、外部 repo 路径、资源寻址、安全边界和 action 执行上下文。

真正的问题不是 Markdown 能不能解析。

真正的问题是：**机器安全边界不应该依赖自然语言排版稳定性。**

Markdown 适合承载主体愿景、边界解释、操作原则和 AI prompt context；但 repo、lane、resource scope 这类字段更适合放在结构化配置里。

本轮后续已经把这件事从设计推进到落地：`agentank-tank` 的 lane/resources 已进入 `policies/subjects.json`，代码优先读取结构化字段，`subject check` 能诊断冲突，而 `agentank-tank.md` 已清理为更纯粹的主体 policy。

---

## 2. 现状分析

### 2.1 起点：registry 很薄

起点时，`policies/subjects.json` 只承担主体索引职责：

```json
{
  "default_subject": "agentank-tank",
  "subjects": {
    "agentank-tank": {
      "policy": "subjects/agentank-tank.md",
      "data_namespace": "agentank-tank"
    }
  }
}
```

这很好。它没有把所有 policy 文本都吞进去，也没有变成一个笨重的总配置文件。

但它还不能表达机器运行边界。

落地后，`agentank-tank` 的 registry entry 已扩展出两块机器配置：

| 字段组 | 内容 |
| --- | --- |
| `lane` | repo、base branch、lane branch、work branch prefix、test/run command、GitHub repo |
| `resources` | external roots 与 resource mapping rules |

### 2.2 起点：机器字段来自 Markdown

迁移前，`policies/subjects/agentank-tank.md` 中，机器会读取这些段落：

```text
## Runtime Boundary Model

- Subject runtime: `D:\github\My\js-evolution-agent\runtime\subjects\agentank-tank`，使用 `resource_scope=subject_runtime`。
- Target repo: `D:\github\My\agentank-evolver`，使用 `resource_scope=target_repo`。
- Legacy alias: `D:\github\My\agentank-evolver` 也使用 `resource_scope=agentank_evolver`，兼容现有 configured actions。
- Resource mapping: `data/candidates/**`、`data/scores/**`、... 属于 `agentank_evolver`。
- Git lane: 长期进化在 `jea/agentank-tank/local`；单轮 work 分支在 `jea/agentank-tank/work/*`。

## Subject Repo Lane

- Repo: `D:\github\My\agentank-evolver`
- Base Branch: `main`
- Lane: `jea/agentank-tank/local`
- Test Command: `npm test`
- Run Command: `npm run sync`
- GitHub Repo: `imjszhang/agentank-evolver`
```

对应解析集中在 `src/cli/utils/subjects.mjs`：

| 函数 | 当前职责 |
| --- | --- |
| `parseSubjectExternalRoots()` | 从包含 `resource_scope=` 的 Markdown 行里提取外部 root |
| `parseSubjectResourceRules()` | 从 `Resource mapping` / `属于` / `resource_kind` 等文本里提取资源规则 |
| `parseSubjectRepoLane()` | 从 key-value 风格 Markdown 行里提取 repo、lane、test command、GitHub repo |

这些解析已经比较克制，但仍然依赖文本格式。

落地后，这些 Markdown 机器字段已经不再是 `agentank-tank` 的事实来源：

- `Subject Repo Lane` 小节已删除。
- `Probe Requirements` 小节已删除。
- 具体 repo path、lane branch、resource mapping、test/run command 已从 Markdown 移除。
- `Runtime Boundary Model` 只保留 secrets、审批和越界写入等主体级安全原则。

### 2.3 主要脆弱点

| 脆弱点 | 影响 |
| --- | --- |
| 人改标题或行文 | 机器可能读不到 repo/lane/resource rules |
| 同一字段散落在多个段落 | 冲突时不清楚谁优先 |
| 路径和 scope 夹在自然语言里 | 校验难、错误提示不精确 |
| resource mapping 用中文语义触发 | 对文案改写敏感 |
| 安全边界来自 prompt 文本 | 写入型动作不应只靠自然语言约束 |

---

## 3. 目标边界

这次结构化不应该把 policy 全部 JSON 化。

应保留两类材料的边界：

| 材料 | 归属 | 原因 |
| --- | --- | --- |
| 主体使命、价值观、禁止事项说明、prompt guidance | Markdown policy | 给人和 AI 读，自然语言更合适 |
| repo、lane、branch prefix、resource roots、resource rules、默认命令 | structured config | 给机器执行和校验，必须稳定 |

一句话：**Markdown 继续做语义权威；结构化字段承接机器事实。**

最终边界比最初设计更收敛：`agentank-tank.md` 不再承担 repo/lane/resource mapping 的说明入口，机器字段唯一事实来源是 `policies/subjects.json`。Markdown 只保留主体身份、行为边界、安全原则和 AI 需要理解的语义。

---

## 4. 方案设计

### 4.1 第一阶段：先扩展 registry entry

建议先在 `policies/subjects.json` 的 subject entry 里增加可选字段，而不是立刻引入 sidecar 文件。

理由：

- 当前 subject 数量少，配置体积可控。
- registry 已经是 subject 解析入口，放在这里最直观。
- sidecar 会增加一次文件寻址和同步成本，适合以后字段膨胀时再拆。

建议 schema 草案：

```json
{
  "default_subject": "agentank-tank",
  "subjects": {
    "agentank-tank": {
      "policy": "subjects/agentank-tank.md",
      "data_namespace": "agentank-tank",
      "lane": {
        "repo": "D:\\github\\My\\agentank-evolver",
        "base_branch": "main",
        "lane_branch": "jea/agentank-tank/local",
        "work_branch_prefix": "jea/agentank-tank/work",
        "test_command": "npm test",
        "run_command": "npm run sync",
        "github_repo": "imjszhang/agentank-evolver"
      },
      "resources": {
        "roots": {
          "target_repo": "D:\\github\\My\\agentank-evolver",
          "agentank_evolver": "D:\\github\\My\\agentank-evolver"
        },
        "rules": [
          {
            "kind": "agentank_evolver_candidates",
            "scope": "agentank_evolver",
            "patterns": ["data/candidates/**"]
          },
          {
            "kind": "agentank_evolver_scores",
            "scope": "agentank_evolver",
            "patterns": ["data/scores/**"]
          }
        ]
      }
    }
  }
}
```

字段命名建议保持接近当前返回对象，但在 JSON 里使用 snake_case，避免和 JS 内部 camelCase 强绑定。

实际已落地：

- `subjects.agentank-tank.lane`
- `subjects.agentank-tank.resources.roots`
- `subjects.agentank-tank.resources.rules`

`resources.rules` 当前覆盖：

- `data/candidates/**`
- `data/scores/**`
- `data/simulations/**`
- `data/config/actions.json`
- `src/strategy/**`
- `src/cli.mjs`

### 4.2 优先级规则

迁移期必须允许新旧两套来源并存。

建议解析优先级：

```text
structured fields in subjects.json
  -> future sidecar JSON（如果以后引入）
  -> Markdown parsed fields
  -> default value / explicit error
```

具体规则：

| 字段 | 优先级 | 缺失策略 |
| --- | --- | --- |
| `lane.repo` | structured > markdown | 缺失则 `configured=false` |
| `lane.base_branch` | structured > markdown > `main` | 默认 `main` |
| `lane.lane_branch` | structured > markdown > `jea/<subject>/local` | 默认 subject lane |
| `lane.work_branch_prefix` | structured > markdown > `jea/<subject>/work` | 默认 work prefix |
| `resources.roots` | structured > markdown | 可为空，但写入外部 scope 时必须存在 |
| `resources.rules` | structured > markdown | 可为空；越界动作应失败或要求审批 |

实现上新增了组合 resolver：

| 函数 | 行为 |
| --- | --- |
| `resolveSubjectRepoLane()` | 优先读取 `config.lane`；缺失字段回退到 Markdown 解析与默认值 |
| `resolveSubjectExternalRoots()` | Markdown roots + structured roots 合并，structured 覆盖同名 scope |
| `resolveSubjectResourceRules()` | structured rules 存在时优先使用；否则回退到 Markdown rules |

主要调用点已切换到新 resolver：

- `oada.config.mjs`
- `src/cli/utils/subject-lane-guard.mjs`
- `src/cli/commands/subject.mjs`

### 4.3 冲突检测

结构化字段存在时，应以结构化字段为准。

但如果 Markdown 里仍有对应字段，且两边不一致，不应该静默吞掉。

建议在 `jea subject check` 或 `jea doctor` 中给 warning：

```text
[warn] subject agentank-tank lane.repo differs:
  structured: D:\github\My\agentank-evolver
  markdown:   D:\github\My\other-repo
  using structured value
```

冲突等级建议：

| 冲突 | 等级 | 处理 |
| --- | --- | --- |
| lane repo 不一致 | warning 或 error | 写入型动作建议 error |
| lane branch 不一致 | warning | 使用 structured |
| resource root 不一致 | error | 可能导致越界写入 |
| resource rules 不一致 | warning | 使用 structured；提示清理 Markdown |
| test/run command 不一致 | warning | 使用 structured |

实际已落地到 `diagnoseSubjectRuntimeConfig()`，并接入 `jea subject check`：

- JSON 输出新增 `diagnostics` 与 `runtime_ok`
- error 级诊断会让 `ok: false`
- 当前 `agentank-tank` 检查结果为 `diagnostics: []`

### 4.4 Sidecar 的触发条件

不建议第一阶段就拆 sidecar。

但可以预留形态：

```json
{
  "subjects": {
    "agentank-tank": {
      "policy": "subjects/agentank-tank.md",
      "data_namespace": "agentank-tank",
      "runtime": "subjects/agentank-tank.runtime.json"
    }
  }
}
```

触发 sidecar 的条件：

- 每个 subject 的结构化字段超过 80-120 行。
- resource rules 变成多组复杂 allow/deny 规则。
- 不同 subject 需要共享 runtime schema 模板。
- 需要让非技术操作者只编辑 Markdown，而把机器配置交给工具维护。

---

## 5. 迁移步骤

### 5.1 只读支持

已完成。resolver 支持读取结构化字段；没有结构化字段时，当前 Markdown fallback 行为保持不变。

关键实现：

- `normalizeRegistryEntry()` 保留 registry entry 的扩展字段，不再丢掉 `lane/resources`
- 新增 `resolveSubjectRepoLane()`、`resolveSubjectExternalRoots()`、`resolveSubjectResourceRules()`
- 原 `parseSubject*` 函数仍保留，作为 fallback 与诊断比较来源

### 5.2 写入本地 registry

已完成。为 `agentank-tank` 写入第一批结构化字段：

| 字段组 | 来源 |
| --- | --- |
| `lane.*` | `Subject Repo Lane` |
| `resources.roots.*` | `Runtime Boundary Model` 中的 `resource_scope=` |
| `resources.rules[]` | `Resource mapping` |

这一步之后，Markdown 不再是首选机器来源。

### 5.3 CLI 校验

已完成 `jea subject check` 扩展：

- 校验 structured schema。
- 校验 repo path 是否存在。
- 校验 lane branch / branch prefix 格式。
- 校验 `resources.rules[].scope` 是否能在 `resources.roots` 找到 root。
- 对 structured 与 Markdown 的差异给 warning / error。

当前暂未接入 `jea doctor`，留作后续演化。

### 5.4 文档去重

已完成。`policies/subjects/agentank-tank.md` 已从 55 行收敛为 37 行，去掉机器字段，只保留主体语义和安全边界：

```text
## Runtime Boundary Model

- Secrets: `AGENTANK_TANK_KEY`、Authorization header、`.env` 内容不得打印、落盘或进入 git。
- 资源 root、lane、分支、验证命令和 resource mapping 属于结构化主体配置，不在本文维护。
- `params.cwd` 必须匹配结构化 resource root。
- PR 只能指向本主体 lane，不得直接指向 `main`。
- 越界写入、敏感读取、核心层修改必须先获得人类审批。
```

这样 Markdown 不再承担机器配置职责，减少「同一事实写两遍」。

---

## 6. 验证策略

### 6.1 单元测试

已覆盖：

- 只有 Markdown 时，结果与当前行为一致。
- structured + Markdown 一致时，结果稳定。
- structured + Markdown 冲突时，使用 structured，并产生诊断。
- `resources.rules[].scope` 找不到 root 时，subject check 报错。
- Windows 路径与 POSIX 路径都能被正常解析。

相关测试位于 `test/cli.test.mjs`，全量测试当前为 **272 tests passed**。

### 6.2 Smoke 测试

```powershell
jea subject check --subject agentank-tank
jea subject lane status --subject agentank-tank
jea data status --subject agentank-tank
npm run jea -- subject show --subject agentank-tank --json
npm run jea -- subject lane status --subject agentank-tank --json
npm test
```

已验证：

- `subject check`：`ok: true`，`diagnostics: []`，`runtime_ok: true`
- `subject show`：仍从 `subjects.json` 输出 `repoLane`
- `subject lane status`：`ok: true`
- `npm test`：272 passed
- `ReadLints`：无诊断

---

## 7. 后续演化

| 方向 | 说明 |
| --- | --- |
| schema version | 在 `subjects.json` 增加 `schema_version`，方便未来迁移 |
| allow/deny resource model | 从 pattern mapping 进化到明确的读写权限模型 |
| subject init 模板 | `jea subject init` 自动生成最小结构化 runtime 字段 |
| doctor 分级 | 将 `diagnoseSubjectRuntimeConfig()` 接入 `jea doctor`，写入型动作遇到 error 直接拒绝 |
| sidecar 拆分 | 当 registry entry 过大时，引入 `*.runtime.json` |
| 其他 subject 迁移 | 对 `js-evolution-agent` 或新 subject 复用同一结构化字段模型 |

---

## 附：本轮问题—思考—方案—执行对照

| 阶段 | 内容 |
| --- | --- |
| 问题 | `Subject Repo Lane`、resource scope 等机器字段仍由 Markdown 解析，安全边界依赖文本格式 |
| 思考 | Markdown 适合 AI 与人类阅读；repo/lane/resource roots 适合结构化、可校验、可诊断的机器配置 |
| 方案 | 第一阶段扩展 `subjects.json` entry，结构化字段优先，Markdown 保留 fallback；冲突通过 `subject check` 报告 |
| 执行 | 已落地只读 resolver、写入 `agentank-tank` 结构化 `lane/resources`、接入 `subject check` 诊断，并将 `agentank-tank.md` 清理为主体语义文档 |
