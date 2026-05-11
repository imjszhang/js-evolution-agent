export const DEFAULT_LANGUAGE = 'zh-CN';

const LANGUAGE_ALIASES = new Map([
  ['zh-cn', 'zh-CN'],
  ['en-us', 'en-US'],
]);

const CATALOG = {
  'zh-CN': {
    data: {
      defaultGoals: {
        id: 'bootstrap',
        name: '引导启动 js-evolution-agent',
        intent: '验证受控演化循环、上下文文档与智能体持久化。',
        good_signal: 'Mock 与 DeepSeek 运行完成，动作已校验，智能体已持久化。',
        bad_signal: '循环无法加载上下文、排队动作、执行处理器或写入智能体。',
        children: [
          {
            id: 'safe-runtime',
            name: '安全运行时',
            intent: '将数据操作限制在 js-evolution-agent 内并维护操作者信任。',
            good_signal: '数据命令仅作用于当前主体的运行时数据命名空间。',
            bad_signal: '任何命令试图修改引擎包、文档快照或密钥。',
            children: [],
          },
        ],
      },
      init: {
        heading: '已初始化运行时数据：',
        subject: '主体',
        namespace: '命名空间',
        runtime: '运行时',
        policies: '策略',
        created: '已创建',
        exists: '已存在',
        overwritten: '已覆盖',
        skipped: '已跳过',
        seedObservations: '种子观测',
        seedEvents: '种子事件',
        seedContent: '已为主体初始化运行时数据：{subject}',
      },
    },
    policy: {
      defaultSubjectTemplate: `# js-evolution-agent 项目指导

Generated: {generatedAt}

此文件包含 \`js-evolution-agent\` 的项目本地条款。通用 Cyber-Taoist 原则从 \`CONSTITUTION.md\` 和 \`SKILL.md\` 读取；不要在这里复制或改写它们。

## Subject

此循环的主体是 \`js-evolution-agent\`：一个受控宿主实例，复用 \`js-evolution-engine\`，读取 Cyber-Taoist 上下文，并通过 \`js-intel-store\` 持久化智能体记忆。

## Core Layer

- 源码包 \`js-evolution-engine\` 与 \`js-intel-store\`。
- \`cyber-taoist-docs\` 下的只读 Cyber-Taoist 文档。
- 操作者信任、可审查性与可回滚性。
- \`runtime/subjects/<data_namespace>/data\` 下的本地数据完整性。

## Allowed First-Phase Actions

- 读取项目本地文件和引用的上下文文档。
- 生成观测、探针提案、回顾和本地报告。
- 在当前主体运行时 intelligence 命名空间下写入动作回执、演化事件和评审。
- 在当前主体运行时 evolution 命名空间下排队决策。

## Off-Limits Without Human Approval

- 修改 \`js-evolution-engine\`、\`js-intel-store\` 或 \`cyber-taoist-docs\`。
- 创建提交、推送分支或打开拉取请求。
- 运行破坏性 shell 命令或大规模跨项目重写。
- 写入 \`js-evolution-agent\` 项目树之外的位置。
- 执行超出记录评审请求范围的 \`core\` 层动作。

## Probe Requirements

每个探针必须声明：

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`

如果缺少任何字段，动作应尽早失败，并且不写入外部副作用。
`,
      subjectTemplate: `# {subject} 项目指导

Generated: {generatedAt}

此文件包含 \`{subject}\` 的项目本地条款。通用 Cyber-Taoist 原则从 \`CONSTITUTION.md\` 和 \`SKILL.md\` 读取；不要在这里复制或改写它们。

Template: {template}

## Subject

此循环的主体是 \`{subject}\`：请定义什么会被视为持续存在、交易、失败并演化的实体。

## Core Layer

- 操作者信任、可审查性与可回滚性。
- 法务、身份与访问连续性。
- 此主体的数据完整性。
- 将此列表替换为绝不能消亡的最小功能集合。

## Allowed First-Phase Actions

- 读取项目本地文件和引用的上下文文档。
- 生成观测、探针提案、回顾和本地报告。
- 在主体运行时数据下写入动作回执、演化事件和评审。
- 为通过已注册处理器显式执行而排队决策。

## Off-Limits Without Human Approval

- 创建提交、推送分支或打开拉取请求。
- 运行破坏性 shell 命令或大规模跨项目重写。
- 写入配置的项目树之外的位置。
- 执行超出记录评审请求范围的 \`core\` 层动作。

## Probe Requirements

每个探针必须声明：

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`

如果缺少任何字段，动作应尽早失败，并且不写入外部副作用。
`,
    },
  },
  'en-US': {
    data: {
      defaultGoals: {
        id: 'bootstrap',
        name: 'Bootstrap js-evolution-agent',
        intent: 'Verify the controlled evolution loop, context documents, and intelligence persistence.',
        good_signal: 'Mock and DeepSeek runs complete with verified actions and persisted intelligence.',
        bad_signal: 'The loop cannot load context, queue actions, execute handlers, or write intelligence.',
        children: [
          {
            id: 'safe-runtime',
            name: 'Safe Runtime',
            intent: 'Keep data operations bounded to js-evolution-agent and preserve operator trust.',
            good_signal: 'Data commands only touch the active subject runtime data namespace.',
            bad_signal: 'Any command attempts to modify engine packages, docs snapshots, or secrets.',
            children: [],
          },
        ],
      },
      init: {
        heading: 'Initialized runtime data:',
        subject: 'subject',
        namespace: 'namespace',
        runtime: 'runtime',
        policies: 'policies',
        created: 'created',
        exists: 'exists',
        overwritten: 'overwritten',
        skipped: 'skipped',
        seedObservations: 'seed observations',
        seedEvents: 'seed events',
        seedContent: 'Initialized runtime data for subject: {subject}',
      },
    },
    policy: {
      defaultSubjectTemplate: `# js-evolution-agent Project Guidance

Generated: {generatedAt}

This file contains project-local clauses for \`js-evolution-agent\`. Universal Cyber-Taoist principles are read from \`CONSTITUTION.md\` and \`SKILL.md\`; do not copy or rewrite them here.

## Subject

The subject of this loop is \`js-evolution-agent\`: a controlled host instance that reuses \`js-evolution-engine\`, reads Cyber-Taoist context, and persists intelligence through \`js-intel-store\`.

## Core Layer

- The source packages \`js-evolution-engine\` and \`js-intel-store\`.
- The read-only Cyber-Taoist documents under \`cyber-taoist-docs\`.
- Operator trust, reviewability, and reversibility.
- Local data integrity under \`runtime/subjects/<data_namespace>/data\`.

## Allowed First-Phase Actions

- Read project-local files and referenced context documents.
- Generate observations, probe proposals, retrospectives, and local reports.
- Write action receipts, evolution events, and reviews under the active subject runtime intelligence namespace.
- Queue decisions under the active subject runtime evolution namespace.

## Off-Limits Without Human Approval

- Modifying \`js-evolution-engine\`, \`js-intel-store\`, or \`cyber-taoist-docs\`.
- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or large cross-project rewrites.
- Writing outside the \`js-evolution-agent\` project tree.
- Executing a \`core\` layer action beyond recording a review request.

## Probe Requirements

Every probe must state:

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`

If any field is missing, the action should fail early and write no external side effects.
`,
      subjectTemplate: `# {subject} Project Guidance

Generated: {generatedAt}

This file contains project-local clauses for \`{subject}\`. Universal Cyber-Taoist principles are read from \`CONSTITUTION.md\` and \`SKILL.md\`; do not copy or rewrite them here.

Template: {template}

## Subject

The subject of this loop is \`{subject}\`: define what is treated as the entity that survives, trades, fails, and evolves.

## Core Layer

- Operator trust, reviewability, and reversibility.
- Legal, identity, and access continuity.
- Data integrity for this subject.
- Replace this list with the minimum functions that must not die.

## Allowed First-Phase Actions

- Read project-local files and referenced context documents.
- Generate observations, probe proposals, retrospectives, and local reports.
- Write action receipts, evolution events, and reviews under subject runtime data.
- Queue decisions for explicit execution through registered handlers.

## Off-Limits Without Human Approval

- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or large cross-project rewrites.
- Writing outside the configured project tree.
- Executing a \`core\` layer action beyond recording a review request.

## Probe Requirements

Every probe must state:

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`

If any field is missing, the action should fail early and write no external side effects.
`,
    },
  },
};

export function normalizeLanguage(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_LANGUAGE;
  return LANGUAGE_ALIASES.get(raw.toLowerCase()) || DEFAULT_LANGUAGE;
}

export function getLanguage(env = process.env) {
  return normalizeLanguage(env.JEA_LANGUAGE);
}

function lookup(language, key) {
  return key.split('.').reduce((current, part) => current?.[part], CATALOG[language]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function interpolate(value, params) {
  return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : match
  ));
}

export function t(key, params = {}, language = getLanguage()) {
  const normalized = normalizeLanguage(language);
  const value = lookup(normalized, key) ?? lookup(DEFAULT_LANGUAGE, key);
  if (typeof value !== 'string') return value;
  return interpolate(value, params);
}

export function tObject(key, language = getLanguage()) {
  const normalized = normalizeLanguage(language);
  return clone(lookup(normalized, key) ?? lookup(DEFAULT_LANGUAGE, key));
}
