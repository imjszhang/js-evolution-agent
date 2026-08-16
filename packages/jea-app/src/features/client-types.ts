/**
 * Browser-safe mirror of the Wave 1 JeaClient setup/settings/cli surface.
 * Do not invent commands here; keep field names aligned with
 * `apps/desktop/src/client-api/types.ts`.
 */

export interface CliStatus {
  installed: boolean
  onPath: boolean
  pathHint: string
  supported: boolean
  detail: string | null
}

export interface SetupReadiness {
  jeaHome: {
    path: string
    source: string
    writable: boolean
  }
  subjects: {
    count: number
    defaultSubject: string | null
    names: string[]
  }
  model: {
    configured: boolean
    mode: 'deepseek' | 'mock' | 'unset'
  }
  data: {
    initialized: boolean
  }
  conversation: {
    desktopChannelEnabled: boolean
    subject: string | null
  }
  conversationReady: boolean
  cli: CliStatus
}

export interface SetupHomeResult {
  path: string
  source: string
  writable: boolean
}

export interface SetupSubjectResult {
  name: string
  created: boolean
  skipped: boolean
  desktopChannelEnabled: boolean
}

export interface SettingsView {
  language: 'zh-CN' | 'en'
  theme: 'system' | 'light' | 'dark'
  defaultSubject: string | null
  appVersion: string
  cliVersion: string
}

export interface SettingsPatch {
  language?: 'zh-CN' | 'en'
  theme?: 'system' | 'light' | 'dark'
  defaultSubject?: string
}

export interface SubjectSummary {
  name: string
  namespace: string
  isDefault: boolean
}

export interface PublicCommandErrorShape {
  name: 'PublicCommandError'
  code: string
  message: string
}

export interface SetupSettingsClient {
  getReadiness(subject?: string): Promise<SetupReadiness>
  confirmHome(path?: string): Promise<SetupHomeResult>
  createSubject(name: string, options?: { enableDesktopChannel?: boolean }): Promise<SetupSubjectResult>
  initData(subject: string): Promise<{ subject: string; initialized: boolean }>
  enableDesktopChannel(subject: string): Promise<SetupSubjectResult>
  getSettings(): Promise<SettingsView>
  setSettings(patch: SettingsPatch): Promise<SettingsView>
  getCliStatus(): Promise<CliStatus>
  installCli(): Promise<CliStatus>
  uninstallCli(): Promise<CliStatus>
  listSubjects(): Promise<SubjectSummary[]>
  setDefaultSubject?(subject: string): Promise<unknown>
}

export type ProductHostKind = 'electron' | 'web'

export const DOCS_HOME_URL = 'https://github.com/imjszhang/js-evolution-agent#readme'
export const LICENSE_URL = 'https://github.com/imjszhang/js-evolution-agent/blob/main/LICENSE'
export const FIRST_RUN_DOCS_URL = 'https://github.com/imjszhang/js-evolution-agent/blob/main/docs/release/first-run.md'

export function isPublicCommandError(error: unknown): error is PublicCommandErrorShape {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  return candidate.name === 'PublicCommandError'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
}

export function publicErrorMessage(error: unknown, fallback: string): string {
  if (isPublicCommandError(error)) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function languageToLocale(language: SettingsView['language'] | string | null | undefined): 'en' | 'zh' {
  return language === 'en' ? 'en' : 'zh'
}

export function localeToLanguage(locale: 'en' | 'zh'): SettingsView['language'] {
  return locale === 'en' ? 'en' : 'zh-CN'
}
