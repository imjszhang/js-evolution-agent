import type { ClientApiCommandName, ClientApiEventName, PublicErrorCode } from './protocol'
import type { SUBJECT_READINESS_REASON_CODES } from '../../../../src/product/subject-readiness.mjs'

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

export interface ChannelProjectionHealth {
  status: string
  ok: boolean
  reasons: string[]
}

export interface ConversationPipelineState {
  status: 'idle' | 'pending' | 'failed' | 'delivered'
  message_id: string | null
  pending_count: number
  failed_count: number
  last_error: string | null
}

export interface ConversationPage {
  schema_version: number
  subject: string
  session_id: string
  records: ConversationMessage[]
  offset: number
  next_offset: number
  total: number
  channel_health?: ChannelProjectionHealth
  pipeline_state?: ConversationPipelineState
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

export interface EvolutionCycleDiagnosticSummary {
  cycle_id: string
  status: string | null
}

export interface EvolutionAttentionItem {
  severity: string
  kind: string
  status: string
  category: string
  blocking: boolean
  title: string
  summary: string
}

export interface ReactorLaneCounts {
  ready: number
  claimed: number
  deferred: number
  blocked: number
  handled_total: number
  open_total?: number
}

export interface ReactorProgressProjection {
  schema_version: string
  subject: string | null
  projection_generation: string | number
  projected_at: string
  freshness: {
    as_of: string
    status: 'fresh' | 'stale' | 'reconciling' | 'degraded' | 'unknown'
    stale_after_ms?: number
    reason?: string
  }
  worker_liveness: {
    alive: boolean
    heartbeat_at?: string
  }
  activity?: {
    current_task?: { id: string; type?: string; lane?: 'realtime' | 'replay' }
    current_claim?: { claim_id?: string; reactor?: string; lane?: 'realtime' | 'replay' }
    current_batch?: { batch_id?: string; candidate_id?: string }
    current_stage?: string
    last_progress_at?: string
  }
  limits?: {
    replay_batch_limit?: number
    replay_wall_clock_ms?: number
    token_reserve?: number
    spend_allowance?: number
  }
  stop_reason?: {
    class: string
    code: string
    detail?: string
  }
  scheduler_state?:
    | 'listening'
    | 'queued'
    | 'running'
    | 'catching_up'
    | 'paused_budget'
    | 'blocked'
    | 'waiting_approval'
    | 'stalled'
  reactors: Record<string, { realtime: ReactorLaneCounts; replay: ReactorLaneCounts }>
  reactor_overlap: {
    additive: false
    note: string
  }
  evidence_authority?: {
    envelope_count?: number
    is_work_count: false
  }
  sources?: Record<string, unknown>
  throughput?: Record<string, unknown>
}

export interface EvolutionObservability {
  subject: string
  attention: {
    items?: EvolutionAttentionItem[]
    summary?: Record<string, unknown>
  } & Record<string, unknown>
  open_cycles: number
  evidence_pending_count?: number | null
  daemon_task_pending_count?: number
  cycle_diagnostics?: {
    recent?: EvolutionCycleDiagnosticSummary[]
  }
  reactor_progress?: ReactorProgressProjection | null
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
  supervisor_lease?: {
    required: boolean
    status: 'active' | 'stopping' | 'expired' | 'missing' | 'owner_mismatch' | 'legacy' | 'lost'
    expires_at: string | null
    domain: 'all' | 'cycle' | 'channel' | null
  } | null
  supervisor_leases?: Array<{
    required: boolean
    status: 'active' | 'stopping' | 'expired' | 'missing' | 'owner_mismatch' | 'legacy' | 'lost'
    expires_at: string | null
    domain: 'all' | 'cycle' | 'channel' | null
  }>
}

export const SUBJECT_READINESS_DOMAIN_STATES = [
  'running',
  'stopped',
  'blocked',
  'stalled',
  'stale',
  'zombie',
  'attached',
  'starting',
  'stopping',
  'unavailable'
] as const

export type SubjectReadinessDomainState = (typeof SUBJECT_READINESS_DOMAIN_STATES)[number]

export const SUBJECT_READINESS_ACTION_IDS = [
  'start_channel',
  'start_cycle',
  'process_cycle_once',
  'repair_worker_state',
  'stop_managed',
  'open_desktop',
  'pause_automatic_evolution',
  'resume_automatic_evolution',
  'check_now',
  'view_blocker',
  'none'
] as const

export type SubjectReadinessActionId = (typeof SUBJECT_READINESS_ACTION_IDS)[number]

export type SubjectReadinessReasonCode = (typeof SUBJECT_READINESS_REASON_CODES)[number]

export type ClientHostKind = 'electron' | 'web'

export const PRODUCT_AUTOMATION_MODES = ['automatic', 'paused'] as const

export type AutomationMode = (typeof PRODUCT_AUTOMATION_MODES)[number]

export const PRODUCT_EVOLUTION_INTENTS = [
  'running',
  'paused',
  'listening',
  'catching_up',
  'waiting_approval',
  'blocked',
  'starting'
] as const

export type ProductEvolutionIntent = (typeof PRODUCT_EVOLUTION_INTENTS)[number]

export interface AutomationView {
  mode: AutomationMode
  intent: ProductEvolutionIntent
  mapped_from: string
  diagnostic: string | null
  background: boolean
  remaining_evidence: number | null
  blocker: string | null
}

export interface LlmBudgetReadinessView {
  schema: 'llm_budget_status.v1'
  period_id: string
  state: 'ok' | 'warn' | 'exhausted'
  used_tokens: number
  remaining_tokens: number
  token_budget: number
  used_spend_usd: number
  remaining_spend_usd: number
  spend_budget_usd: number
  cycle_admission: 'open' | 'parked'
  shared_ledger: true
  blocked_reason: string | null
}

export interface AutomationPolicyView {
  subject: string
  mode: AutomationMode
  previous: AutomationMode
  changed: boolean
  mapped_from: string
  diagnostic: string | null
  background: boolean
}

export interface DomainReadiness {
  state: SubjectReadinessDomainState
  reasons: SubjectReadinessReasonCode[]
}

export interface ModelReadinessView {
  state: SubjectReadinessDomainState
  mode: 'deepseek' | 'mock' | 'unset'
  reasons: SubjectReadinessReasonCode[]
}

export interface ConversationReadinessView {
  state: SubjectReadinessDomainState
  reasons: SubjectReadinessReasonCode[]
}

export interface RemediationAction {
  id: SubjectReadinessActionId
  allowed: boolean
  capability: 'readonly' | 'write' | 'local-only'
}

export interface SubjectReadiness {
  subject: string
  generated_at: string
  web_host: DomainReadiness
  cycle: DomainReadiness
  channel: DomainReadiness
  model: ModelReadinessView
  conversation: ConversationReadinessView
  reasons: SubjectReadinessReasonCode[]
  allowed_actions: SubjectReadinessActionId[]
  actions: RemediationAction[]
  automation?: AutomationView
  product_actions?: RemediationAction[]
  llm_budget?: LlmBudgetReadinessView | null
}

export interface CycleRequestResult {
  subject: string
  cycle_start_request: Record<string, unknown> | null
}

export interface CycleProcessOnceResult {
  subject: string
  status: 'ok' | 'idle' | 'retryable' | 'blocked'
  reason: string
  scanned: {
    scanned: boolean
    enqueued_count: number
  }
  backlog: {
    before: number
    after: number
  }
  health: {
    before: Record<string, unknown>
    after: Record<string, unknown>
  }
  claim: Record<string, unknown> | null
  checkpoint: Record<string, unknown> | null
  events: Array<Record<string, unknown>>
  channel: {
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    unchanged: boolean
  }
  work: Record<string, unknown> | null
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
  commitSha: string | null
  commitShort: string | null
  buildTime: string | null
  platform: string
  architecture: string
  dirty: boolean | null
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
      subject?: string
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
