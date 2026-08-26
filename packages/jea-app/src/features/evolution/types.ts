/**
 * Consumer contract for the Evolution Inspector.
 * Method names and payloads match JeaClient (#116). This is not a second catalog.
 */

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

export interface EvolutionObservability {
  subject: string
  attention: {
    items?: EvolutionAttentionItem[]
    summary?: Record<string, unknown>
  } & Record<string, unknown>
  open_cycles: number
  evidence_pending_count?: number
  daemon_task_pending_count?: number
  cycle_diagnostics?: {
    recent?: EvolutionCycleDiagnosticSummary[]
  }
  reactor_progress?: import('../client-types').ReactorProgressProjection | null
}

export interface EvolutionEventEnvelope {
  type: string
  ts: string
  subject?: string
  session_id?: string
  payload: Record<string, unknown>
}

export interface EvolutionInspectorClient {
  listCycles(subject: string, limit?: number): Promise<EvolutionCycleList>
  getCycle(subject: string, cycleId: string): Promise<EvolutionCycleDetail>
  getRound(subject: string, cycleId: string): Promise<EvolutionRoundDetail>
  getObservability(subject: string): Promise<EvolutionObservability>
  getReactorProgress?(subject: string): Promise<import('../client-types').ReactorProgressProjection>
  subscribe(listener: (event: EvolutionEventEnvelope) => void): () => void
  processCycleOnce?(subject: string): Promise<unknown>
  requestCycle?(subject: string, note?: string): Promise<unknown>
  startService?(subject: string, domain?: 'all' | 'cycle' | 'channel'): Promise<unknown>
  stopService?(subject: string): Promise<unknown>
  setAutomation?(subject: string, mode: 'automatic' | 'paused'): Promise<unknown>
  getServiceReadiness?(subject: string): Promise<{ allowed_actions?: string[] }>
}

export type CycleKind = 'open' | 'historical'

export interface TimelineCycleView {
  cycle_id: string
  status: string | null
  kind: CycleKind
  time: string | null
  tldr: string | null
  has_diary: boolean
  steps: Array<{ name: string; status: string; error: string | null }>
}

export interface EvolutionInspectorCore {
  subject: string
  namespace: string
  round_count: number
  open_cycles: number
  selected_cycle_id: string | null
  selected_kind: CycleKind | null
  cycle_status: string | null
  verify_available: boolean
  verify_semantic_status: string | null
  verified_count: number | null
  pending_count: number | null
  receipt_count: number
  diary_count: number
  report_available: boolean
  report_tldr: string | null
  blocker_count: number
  blockers: string[]
  step_count: number
  attention_count: number | null
}

export interface EvolutionInspectorSnapshot {
  subject: string | null
  list: EvolutionCycleList | null
  observability: EvolutionObservability | null
  cycles: Record<string, EvolutionCycleDetail | null>
  rounds: Record<string, EvolutionRoundDetail | null>
  selectedCycleId: string | null
  error: string | null
  stale?: boolean
}

export type InspectorSafeState =
  | 'no-subject'
  | 'loading'
  | 'empty'
  | 'error'
  | 'stale'
  | 'offline'
  | 'open'
  | 'historical'
  | 'verify-unavailable'
  | 'malformed'

export const STEP_ORDER = [
  'reactor',
  'agent_loop',
  'intel',
  'intel_report',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary'
] as const
