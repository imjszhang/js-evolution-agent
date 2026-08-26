import type { ComponentType, ReactNode } from 'react'

export const FEATURE_SLOT_IDS = [
  'subjectList',
  'conversation',
  'evolutionInspector',
  'serviceStatus',
  'settings',
  'workspaceHeader'
] as const

export type FeatureSlotId = (typeof FEATURE_SLOT_IDS)[number]

export interface FixtureSubject {
  id: string
  name: string
  namespace?: string
  isDefault?: boolean
}

export interface FixtureSession {
  id: string
  title: string
  subjectId: string
}

export type ServiceStatusKind = 'online' | 'offline' | 'degraded'

export interface ShellDomainReadiness {
  state: string
  reasons: string[]
}

export interface ShellRemediationAction {
  id: string
  allowed: boolean
  capability: 'readonly' | 'write' | 'local-only'
}

export interface ShellSubjectReadiness {
  subject: string
  generated_at: string
  web_host: ShellDomainReadiness
  cycle: ShellDomainReadiness
  channel: ShellDomainReadiness
  model: ShellDomainReadiness & { mode: 'deepseek' | 'mock' | 'unset' }
  conversation: ShellDomainReadiness
  reasons: string[]
  allowed_actions: string[]
  actions: ShellRemediationAction[]
  automation?: {
    mode: 'automatic' | 'paused'
    intent: 'running' | 'paused' | 'listening' | 'queued' | 'catching_up' | 'paused_budget' | 'waiting_approval' | 'blocked' | 'stalled' | 'starting'
    mapped_from?: string
    diagnostic?: string | null
    background?: boolean
    remaining_evidence?: number | null
    blocker?: string | null
  }
  product_actions?: ShellRemediationAction[]
  reactor_progress?: import('../features/client-types').ReactorProgressProjection | null
  llm_budget?: {
    schema?: string
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
  } | null
}

/**
 * Wave 1 host adapters. This is not a JeaClient catalog.
 * Feature teams inject their own clients through slot props after #116 lands.
 */
export interface ShellAdapters {
  subjects?: FixtureSubject[]
  sessions?: FixtureSession[]
  selectedSubjectId?: string | null
  selectedSessionId?: string | null
  selectedCycleId?: string | null
  serviceStatus?: ServiceStatusKind
  subjectReadiness?: ShellSubjectReadiness | null
  hostKind?: 'electron' | 'web'
  onSelectSubject?(subjectId: string): void
  onSelectSession?(sessionId: string): void
  onSelectCycle?(cycleId: string): void
  onRetry?(): void
}

export interface FeatureSlotProps {
  adapters: ShellAdapters
  slotId: FeatureSlotId
}

export type FeatureSlotComponent = ComponentType<FeatureSlotProps>

export interface FeatureModule {
  id: string
  slots: Partial<Record<FeatureSlotId, FeatureSlotComponent>>
}

export interface FeatureRegistry {
  register(module: FeatureModule): () => void
  resolve(slotId: FeatureSlotId): FeatureSlotComponent | null
  list(): FeatureModule[]
  clear(): void
}

export interface SlotRenderProps {
  slotId: FeatureSlotId
  adapters: ShellAdapters
  fallback?: ReactNode
}
