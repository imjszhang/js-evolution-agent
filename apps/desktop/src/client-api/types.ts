import type { ClientApiCommandName, ClientApiEventName, PublicErrorCode } from './protocol'

export interface InvokeRequest {
  command: string
  payload?: unknown
}

export type InvokeResponse<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: PublicErrorCode; message: string } }

export interface JeaEventEnvelope {
  type: ClientApiEventName | string
  ts: string
  subject?: string
  session_id?: string
  payload: Record<string, unknown>
}

export interface ProtocolInfo {
  protocol: 'jea.client'
  version: string
  commands: ClientApiCommandName[]
  events: string[]
}

export interface SubjectSummary {
  name: string
  namespace: string
  isDefault: boolean
}

export interface SubjectRecord extends SubjectSummary {
  selected: boolean
  desktopChannelEnabled: boolean
}

export interface ConversationSessionSummary {
  session_id: string
  target: string
  message_count: number
  last_message_at: string | null
}

export interface ConversationMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | string
  direction: 'inbound' | 'outbound' | string
  content: string
  created_at: string
  offset: number
  message_id?: string | null
}

export interface ConversationPage {
  schema_version: number
  subject: string
  session_id: string
  records: ConversationMessage[]
  offset: number
  next_offset: number
  total: number
}

export interface ConversationSendResult {
  subject: string
  session_id: string
  message_id: string
  session_created: boolean
  duplicate: boolean
}

export interface EvolutionCycleSummary {
  cycle_id: string
  generated_at: string | null
  tldr: string | null
  has_diary: boolean
  status?: string | null
}

export interface EvolutionCycleList {
  subject: string
  namespace: string
  round_count: number
  cycles: EvolutionCycleSummary[]
}

export interface EvolutionStepView {
  status: string
  updated_at: string | null
  error: string | null
}

export interface EvolutionCycleDetail {
  subject: string
  cycle_id: string
  cycle_status: string | null
  opened_at: string | null
  closed_at: string | null
  has_report: boolean
  steps: Record<string, EvolutionStepView>
  blockers: string[]
}

export interface EvolutionRoundDetail {
  subject: string
  cycle_id: string
  report: {
    available: boolean
    tldr: string | null
  }
  diary: {
    available: boolean
    items: Array<{ exec_id: string; tldr: string | null }>
  }
  verify: {
    available: boolean
    semantic_status: string | null
    verified_count: number | null
    pending_count: number | null
  }
  receipts: {
    count: number
  }
  blockers: string[]
}

export interface EvolutionObservability {
  subject: string
  attention: Record<string, unknown>
  open_cycles: number
}

export interface ServiceStatus {
  subject: string
  mode: string
  pid: number | null
  domain: 'all' | 'cycle' | 'channel' | null
  heartbeat_at: string | null
  started_at: string | null
  health: string | null
  detail: string | null
}

export interface CycleRequestResult {
  subject: string
  cycle_start_request: Record<string, unknown> | null
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

export interface CliStatus {
  installed: boolean
  onPath: boolean
  pathHint: string
  supported: boolean
  detail: string | null
}

export interface CatalogAvailability {
  electron: boolean
  web: boolean
}

export interface CatalogCommandEntry {
  name: ClientApiCommandName
  group: 'protocol' | 'subject' | 'conversation' | 'evolution' | 'service' | 'setup' | 'settings' | 'cli'
  capability: 'readonly' | 'write' | 'local-only' | 'destructive'
  availability: CatalogAvailability
  request: Record<string, unknown>
  response: Record<string, unknown>
  errors: PublicErrorCode[]
}

export interface CatalogEventEntry {
  name: ClientApiEventName
  payload: Record<string, unknown>
}

export interface ClientApiCatalog {
  protocol: 'jea.client'
  version: string
  capabilities: Array<'readonly' | 'write' | 'local-only' | 'destructive'>
  errors: PublicErrorCode[]
  commands: CatalogCommandEntry[]
  events: CatalogEventEntry[]
}
