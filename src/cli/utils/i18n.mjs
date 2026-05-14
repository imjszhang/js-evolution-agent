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
            intent: '将宿主数据写入限制在 js-evolution-agent 主体命名空间内，并明确 agent 读路径隔离需要单独工具层能力。',
            good_signal: '数据写入命令仅作用于当前主体的运行时数据命名空间，敏感读取只记录脱敏元数据。',
            bad_signal: '任何命令试图修改引擎包、文档快照或密钥，或将密钥明文写入持久化证据。',
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

## Subject

\`js-evolution-agent\` 是本项目的受控自演化宿主。

## Core Layer

- 操作者信任、可审查性与可回滚性
- 本地主体数据完整性
- 外部核心包与 Cyber-Taoist 文档不在本阶段修改范围内

## Allowed First-Phase Actions

- 读取和分析上下文。
- 记录观测、评审、回执和探针提案。
- 排队有边界的后续决策。

## Off-Limits Without Human Approval

- 修改核心包或外部文档。
- 创建提交、推送分支或打开拉取请求。
- 运行破坏性命令、大规模重写或项目树外写入。
- 执行非记录性质的 \`core\` 层动作。

## Probe Requirements

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`
`,
      subjectTemplate: `# {subject} 项目指导

Generated: {generatedAt}

Template: {template}

## Subject

\`{subject}\` 是本循环观察其存续、边界、失败与演化的实体。

## Core Layer

- 操作者信任、可审查性与可回滚性
- 法务、身份与访问连续性
- 此主体的数据完整性
- 将此列表替换为绝不能消亡的最小功能集合

## Allowed First-Phase Actions

- 读取和分析上下文。
- 记录观测、评审、回执和探针提案。
- 排队有边界的后续决策。

## Off-Limits Without Human Approval

- 创建提交、推送分支或打开拉取请求。
- 运行破坏性命令、大规模重写或项目树外写入。
- 执行非记录性质的 \`core\` 层动作。

## Probe Requirements

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`
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
            intent: 'Keep host data writes bounded to the active js-evolution-agent subject namespace, and treat agent read isolation as a separate provider/tool capability.',
            good_signal: 'Data write commands only touch the active subject runtime data namespace, and sensitive reads persist redacted metadata only.',
            bad_signal: 'Any command attempts to modify engine packages, docs snapshots, or secrets, or persists plaintext secrets as evidence.',
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

## Subject

\`js-evolution-agent\` is this project's controlled self-evolution host.

## Core Layer

- operator trust, reviewability, and rollback
- local subject data integrity
- external core packages and Cyber-Taoist documents are out of scope for this phase

## Allowed First-Phase Actions

- Read and analyze context.
- Record observations, reviews, receipts, and probe proposals.
- Queue bounded follow-up decisions.

## Off-Limits Without Human Approval

- Modifying core packages or external documents.
- Creating commits, pushing branches, or opening pull requests.
- Running destructive commands, broad rewrites, or writing outside the project tree.
- Executing non-record \`core\` layer actions.

## Probe Requirements

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`
`,
      subjectTemplate: `# {subject} Project Guidance

Generated: {generatedAt}

Template: {template}

## Subject

\`{subject}\` is the entity whose survival, boundary, failure, and evolution this loop observes.

## Core Layer

- operator trust, reviewability, and rollback
- legal, identity, and access continuity
- data integrity for this subject
- replace this list with the minimum functions that must not die

## Allowed First-Phase Actions

- Read and analyze context.
- Record observations, reviews, receipts, and probe proposals.
- Queue bounded follow-up decisions.

## Off-Limits Without Human Approval

- Creating commits, pushing branches, or opening pull requests.
- Running destructive commands, broad rewrites, or writing outside the configured project tree.
- Executing non-record \`core\` layer actions.

## Probe Requirements

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`
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
