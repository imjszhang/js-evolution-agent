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
  commitSha?: string | null
  commitShort?: string | null
  buildTime?: string | null
  platform?: string
  architecture?: string
  dirty?: boolean | null
}

export interface OperationalDomainReadiness {
  id: 'web' | 'cycle' | 'channel' | 'model' | 'conversation'
  status: string
  reasons: string[]
}

export interface DiagnosticReport {
  schema_version: 1
  generated_at: string
  product: {
    version: string
    commit: string | null
    commit_short: string | null
    built_at: string | null
    platform: string
    architecture: string
    dirty: boolean | null
    build_id: string | null
  }
  host: {
    jea_home: string
    jea_home_source: string
    subject: string | null
  }
  readiness: {
    source: 'service.getReadiness'
    reservedCommand: 'service.getReadiness'
    web: OperationalDomainReadiness
    cycle: OperationalDomainReadiness
    channel: OperationalDomainReadiness
    model: OperationalDomainReadiness
    conversation: OperationalDomainReadiness
  }
  daemon: {
    log_paths: { stdout: string | null; stderr: string | null } | null
    last_startup_failure: {
      occurred_at: string
      reason: string
      log_paths: { stdout: string; stderr: string }
    } | null
  }
  process_failures: Array<{
    occurred_at: string
    process_type: string
    reason: string
    version: string
    build_id: string | null
  }>
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

export interface DomainReadinessView {
  state: string
  reasons: string[]
}

export interface ModelReadinessView {
  state: string
  mode: 'deepseek' | 'mock' | 'unset'
  reasons: string[]
}

export interface RemediationActionView {
  id: string
  allowed: boolean
  capability: 'readonly' | 'write' | 'local-only'
}

export interface AutomationView {
  mode: 'automatic' | 'paused'
  intent: 'running' | 'paused' | 'listening' | 'catching_up' | 'waiting_approval' | 'blocked' | 'starting'
  mapped_from?: string
  diagnostic?: string | null
  background?: boolean
  remaining_evidence?: number | null
  blocker?: string | null
}

export interface LlmBudgetReadinessView {
  schema?: 'llm_budget_status.v1' | string
  period_id: string
  state: 'ok' | 'warn' | 'exhausted'
  used_tokens: number
  remaining_tokens: number
  token_budget: number
  used_spend_usd: number
  remaining_spend_usd: number
  spend_budget_usd: number
  cycle_admission: 'open' | 'parked'
  shared_ledger?: boolean
  blocked_reason?: string | null
}

export interface SubjectReadiness {
  subject: string
  generated_at: string
  web_host: DomainReadinessView
  cycle: DomainReadinessView
  channel: DomainReadinessView
  model: ModelReadinessView
  conversation: DomainReadinessView
  reasons: string[]
  allowed_actions: string[]
  actions: RemediationActionView[]
  automation?: AutomationView
  product_actions?: RemediationActionView[]
  llm_budget?: LlmBudgetReadinessView | null
}

export interface PublicCommandErrorShape {
  name: 'PublicCommandError'
  code: string
  message: string
}

export interface ProductEventEnvelope {
  type: string
  ts?: string
  subject?: string
  session_id?: string
  payload?: Record<string, unknown>
}

export interface SetupSettingsClient {
  getReadiness(subject?: string): Promise<SetupReadiness>
  confirmHome(path?: string): Promise<SetupHomeResult>
  createSubject(name: string, options?: { enableDesktopChannel?: boolean }): Promise<SetupSubjectResult>
  initData(subject: string): Promise<{ subject: string; initialized: boolean }>
  enableDesktopChannel(subject: string): Promise<SetupSubjectResult>
  getSettings(): Promise<SettingsView>
  setSettings(patch: SettingsPatch): Promise<SettingsView>
  exportDiagnostics?(options?: { subject?: string; redactPaths?: boolean }): Promise<DiagnosticReport>
  getCliStatus(): Promise<CliStatus>
  installCli(): Promise<CliStatus>
  uninstallCli(): Promise<CliStatus>
  listSubjects(): Promise<SubjectSummary[]>
  setDefaultSubject?(subject: string): Promise<unknown>
  getServiceReadiness?(subject: string): Promise<SubjectReadiness>
  listCycles?(subject: string, limit?: number): Promise<import('./evolution/types').EvolutionCycleList>
  getObservability?(subject: string): Promise<import('./evolution/types').EvolutionObservability>
  processCycleOnce?(subject: string): Promise<{ status?: string; reason?: string }>
  startService?(subject: string, domain?: 'all' | 'cycle' | 'channel'): Promise<unknown>
  setAutomation?(subject: string, mode: 'automatic' | 'paused'): Promise<unknown>
  subscribe?(listener: (event: ProductEventEnvelope) => void): () => void
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
