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
