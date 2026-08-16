export type Locale = 'en' | 'zh'

export const LOCALE_STORAGE_KEY = 'jea.locale'

export const messages = {
  en: {
    appName: 'JEA',
    appTagline: 'Governed evolution workspace',
    skipToConversation: 'Skip to conversation',
    subjectList: 'Subjects and sessions',
    subjects: 'Subjects',
    sessions: 'Sessions',
    noSubjects: 'No subjects yet',
    noSessions: 'No local sessions',
    conversation: 'Conversation',
    conversationPlaceholder: 'Conversation will be provided by the Channel workspace.',
    evolutionInspector: 'Evolution Inspector',
    evolutionPlaceholder: 'Cycle status and reports will appear here.',
    collapseInspector: 'Collapse Evolution Inspector',
    expandInspector: 'Expand Evolution Inspector',
    resizeLeft: 'Resize subject column',
    resizeRight: 'Resize Evolution Inspector',
    serviceStatus: 'Service status',
    statusOnline: 'Online',
    statusOffline: 'Offline',
    statusDegraded: 'Degraded',
    openSettings: 'Open Settings',
    closeSettings: 'Close Settings',
    settings: 'Settings',
    settingsDescription: 'Appearance, language, and product information. Setup forms arrive in a later wave.',
    appearance: 'Appearance',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    language: 'Language',
    languageEnglish: 'English',
    languageChinese: '简体中文',
    productInfo: 'Product',
    productVersion: 'JEA 0.1.0 workspace shell',
    settingsSlotHint: 'Setup and runtime settings register through the settings slot.',
    loadingTitle: 'Loading workspace',
    loadingBody: 'Preparing the JEA workspace.',
    emptyTitle: 'Nothing to show yet',
    emptyBody: 'Create or select a Subject to begin a governed conversation.',
    offlineTitle: 'Workspace is offline',
    offlineBody: 'The local JEA service is unreachable. Feature data is not requested from the host.',
    errorTitle: 'Workspace failed to load',
    errorBody: 'The shell could not prepare the workspace. Retry or open Settings.',
    retry: 'Retry',
    defaultSubject: 'default'
  },
  zh: {
    appName: 'JEA',
    appTagline: '受治理的演化工作区',
    skipToConversation: '跳到对话',
    subjectList: '主体与会话',
    subjects: '主体',
    sessions: '会话',
    noSubjects: '还没有主体',
    noSessions: '还没有本地会话',
    conversation: '对话',
    conversationPlaceholder: '对话将由 Channel 工作区提供。',
    evolutionInspector: '演化检查器',
    evolutionPlaceholder: '周期状态与报告将显示在这里。',
    collapseInspector: '收起演化检查器',
    expandInspector: '展开演化检查器',
    resizeLeft: '调整主体栏宽度',
    resizeRight: '调整演化检查器宽度',
    serviceStatus: '服务状态',
    statusOnline: '在线',
    statusOffline: '离线',
    statusDegraded: '降级',
    openSettings: '打开设置',
    closeSettings: '关闭设置',
    settings: '设置',
    settingsDescription: '外观、语言与产品信息。完整设置表单由后续 Wave 注册。',
    appearance: '外观',
    themeSystem: '跟随系统',
    themeLight: '浅色',
    themeDark: '深色',
    language: '语言',
    languageEnglish: 'English',
    languageChinese: '简体中文',
    productInfo: '产品',
    productVersion: 'JEA 0.1.0 工作区壳层',
    settingsSlotHint: '安装与运行时设置通过 settings 插槽注册。',
    loadingTitle: '正在加载工作区',
    loadingBody: '正在准备 JEA 工作区。',
    emptyTitle: '还没有内容',
    emptyBody: '创建或选择一个主体，开始受治理的对话。',
    offlineTitle: '工作区离线',
    offlineBody: '本地 JEA 服务不可达。壳层不会向宿主请求功能数据。',
    errorTitle: '工作区加载失败',
    errorBody: '壳层无法准备工作区。请重试或打开设置。',
    retry: '重试',
    defaultSubject: '默认'
  }
} as const

export type MessageKey = keyof typeof messages.en

export function parseStoredLocale(value: string | null | undefined): Locale | null {
  if (value === 'en' || value === 'zh') return value
  return null
}

export function localeFromLanguage(language: string | null | undefined): Locale {
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function resolveLocale(
  stored: string | null | undefined,
  language: string | null | undefined
): Locale {
  return parseStoredLocale(stored) ?? localeFromLanguage(language)
}

export function t(locale: Locale, key: MessageKey): string {
  return messages[locale][key]
}
