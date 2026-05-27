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
            intent: '在当前 provider 不提供硬读写隔离的前提下，用 agent 行为协议、审批、审计、脱敏与 death boundary 降低运行时边界风险，并把硬隔离保留为未来外部沙箱能力。',
            good_signal: 'agent 默认只读写当前主体相关上下文和运行时数据；越界、敏感或核心层动作先审批并留下审计回执；敏感读取只记录脱敏元数据。',
            bad_signal: 'agent 未经审批读取或写入无关/敏感/核心路径，修改引擎包、文档快照或密钥，或将密钥明文写入持久化证据。',
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

## Runtime Boundary Model

- 当前 provider 下，读/写路径边界是 agent 行为协议与宿主预检约束，不是文件系统级硬隔离。
- agent 不应主动读取密钥、凭据、无关路径或 \`archives\` 内容；若因探针需要触达敏感目标，只能记录可访问性与脱敏元数据。
- agent 不应主动写入当前主体运行时数据命名空间之外的路径；任何越界写入、核心层修改或破坏性操作都必须先获得人类审批并留下审计回执。
- \`boundary\` 与 \`death_boundary\` 是操作契约；只有在 cwd、worktree、容器、ACL 或 provider enforcement 支撑时，才能声明为硬安全边界。

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

## Subject Repo Lane

- Repo: \`D:\\path\\to\\{subject}\`
- Base Branch: \`main\`
- Lane: \`jea/{subject}/local\`
- Work Branch Prefix: \`jea/{subject}/work\` (optional; must not nest under Lane)
- Test Command: \`npm test\`
- Run Command: \`npm start\`

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
            intent: 'Reduce runtime boundary risk through agent conduct rules, approval, audit, redaction, and death boundaries while the current provider lacks hard read/write isolation; keep hard isolation as a future external sandbox capability.',
            good_signal: 'The agent reads and writes only relevant subject context and runtime data by default; out-of-bounds, sensitive, or core-layer actions are approved and audited first; sensitive reads persist redacted metadata only.',
            bad_signal: 'The agent reads or writes unrelated, sensitive, or core paths without approval; modifies engine packages, docs snapshots, or secrets; or persists plaintext secrets as evidence.',
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

## Runtime Boundary Model

- In the current provider, read/write path boundaries are agent conduct rules and host preflight constraints, not filesystem-level hard isolation.
- The agent should not intentionally read secrets, credentials, unrelated paths, or \`archives\` content; probes that touch sensitive targets may record accessibility and redacted metadata only.
- The agent should not intentionally write outside the active subject runtime data namespace; out-of-bounds writes, core changes, or destructive operations require human approval and audit receipts first.
- \`boundary\` and \`death_boundary\` are operating contracts; they are hard security boundaries only when backed by cwd, worktree, container, ACL, or provider enforcement.

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

## Subject Repo Lane

- Repo: \`D:\\path\\to\\{subject}\`
- Base Branch: \`main\`
- Lane: \`jea/{subject}/local\`
- Work Branch Prefix: \`jea/{subject}/work\` (optional; must not nest under Lane)
- Test Command: \`npm test\`
- Run Command: \`npm start\`

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
