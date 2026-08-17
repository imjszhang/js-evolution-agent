import type { EvolutionObservability, ServiceStatus, SetupReadiness, SubjectRecord } from '../../../client-api/types'
import type { ConversationErrorView } from './errors'
import type { WorkspaceMessage } from './history'

export type ConversationCardKind =
  | 'operator_question'
  | 'cycle_completed'
  | 'cycle_failed'
  | 'blocked'
  | 'offline'
  | 'stale'
  | 'desktop_disabled'
  | 'daemon_unhealthy'
  | 'model_unavailable'
  | 'web_rejected'
  | 'permission'
  | 'status'

export interface ConversationCard {
  id: string
  kind: ConversationCardKind
  title: string
  body: string
  tone: 'info' | 'warn' | 'error' | 'success'
  source: 'message' | 'service' | 'readiness' | 'observability' | 'error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function cardKindFromMessage(record: WorkspaceMessage): ConversationCardKind | null {
  const metadata = isRecord(record.metadata) ? record.metadata : {}
  const card = isRecord(record.card) ? record.card : isRecord(metadata.card) ? metadata.card : {}
  const raw = text(metadata.kind) || text(metadata.card_kind) || text(card.kind) || text(record.content_type)
  const normalized = raw.toLowerCase().replace(/-/g, '_')
  if (normalized === 'operator_question' || normalized === 'question') return 'operator_question'
  if (normalized === 'cycle_completed' || normalized === 'cycle-completed') return 'cycle_completed'
  if (normalized === 'cycle_failed' || normalized === 'cycle-failed') return 'cycle_failed'
  if (normalized === 'blocked' || normalized === 'blocker') return 'blocked'
  if (normalized === 'permission' || normalized === 'permission_required') return 'permission'
  if (normalized === 'card' && text(card.title)) return 'status'
  return null
}

function messageCard(record: WorkspaceMessage): ConversationCard | null {
  const kind = cardKindFromMessage(record)
  if (!kind) return null
  const metadata = isRecord(record.metadata) ? record.metadata : {}
  const card = isRecord(record.card) ? record.card : isRecord(metadata.card) ? metadata.card : {}
  const title = text(card.title) || text(metadata.title) || kind.replace(/_/g, ' ')
  const body = text(card.body) || text(record.content)
  return {
    id: `message:${record.id}`,
    kind,
    title,
    body,
    tone: kind === 'cycle_completed' ? 'success' : kind === 'operator_question' ? 'info' : 'warn',
    source: 'message'
  }
}

export function deriveInlineCards(input: {
  subject: SubjectRecord | null
  service: ServiceStatus | null
  readiness: SetupReadiness | null
  observability: EvolutionObservability | null
  records: WorkspaceMessage[]
  error: ConversationErrorView | null
  stale?: boolean
}): ConversationCard[] {
  const cards: ConversationCard[] = []
  const seen = new Set<string>()
  const push = (card: ConversationCard | null) => {
    if (!card || seen.has(card.id)) return
    seen.add(card.id)
    cards.push(card)
  }

  if (input.subject && !input.subject.desktopChannelEnabled) {
    push({
      id: 'status:desktop_disabled',
      kind: 'desktop_disabled',
      title: 'Desktop Channel is disabled',
      body: 'This Subject does not enable channels.desktop. Conversation stays on the governed Channel path and will not silently change registry configuration.',
      tone: 'warn',
      source: 'service'
    })
  }

  if (input.error?.kind === 'web_rejected') {
    push({
      id: 'status:web_rejected',
      kind: 'web_rejected',
      title: 'Web capability rejected',
      body: input.error.message,
      tone: 'error',
      source: 'error'
    })
  }

  if (input.error?.kind === 'desktop_disabled') {
    push({
      id: 'error:desktop_disabled',
      kind: 'desktop_disabled',
      title: 'Desktop Channel is disabled',
      body: input.error.message,
      tone: 'warn',
      source: 'error'
    })
  }

  if (input.stale || input.error?.kind === 'unavailable' && /stale|offline/i.test(input.error.message)) {
    push({
      id: 'status:stale',
      kind: 'stale',
      title: 'Projection is stale',
      body: 'Live status updates stopped. The last green reading is no longer trusted.',
      tone: 'warn',
      source: 'service'
    })
  }

  const health = input.service?.health ?? ''
  const stopped = !input.service?.pid && (input.service?.mode === 'none' || input.service?.mode === 'stopped')
  const unhealthy = /unhealthy|error|failed|offline|stale/i.test(health) || Boolean(input.service?.detail)
  if (input.service && (stopped || unhealthy || input.error?.kind === 'daemon_unhealthy' || input.error?.kind === 'unavailable')) {
    push({
      id: 'status:daemon',
      kind: stopped ? 'offline' : 'daemon_unhealthy',
      title: stopped ? 'Channel daemon is stopped' : 'Channel daemon is unhealthy',
      body: input.service.detail || input.error?.message || 'The local channel service is not ready.',
      tone: stopped ? 'warn' : 'error',
      source: 'service'
    })
  }

  if (input.readiness?.model.mode === 'unset' || input.error?.kind === 'model_unavailable') {
    push({
      id: 'status:model',
      kind: 'model_unavailable',
      title: 'Model is unavailable',
      body: 'No model is configured. Mock mode can still run the governed Channel pipeline; a live model is not required.',
      tone: 'warn',
      source: 'readiness'
    })
  }

  const blockers = Array.isArray(input.observability?.attention?.blockers)
    ? input.observability.attention.blockers
    : []
  for (const [index, blocker] of blockers.entries()) {
    if (typeof blocker !== 'string' || !blocker.trim()) continue
    push({
      id: `blocker:${index}:${blocker}`,
      kind: 'blocked',
      title: 'Blocked',
      body: blocker,
      tone: 'warn',
      source: 'observability'
    })
  }

  const cycleStatus = text(input.observability?.attention?.cycle_status)
  if (cycleStatus === 'completed' || cycleStatus === 'closed') {
    push({
      id: 'status:cycle_completed',
      kind: 'cycle_completed',
      title: 'Cycle completed',
      body: text(input.observability?.attention?.tldr) || 'The latest evolution cycle finished.',
      tone: 'success',
      source: 'observability'
    })
  }
  if (cycleStatus === 'failed' || cycleStatus === 'error') {
    push({
      id: 'status:cycle_failed',
      kind: 'cycle_failed',
      title: 'Cycle failed',
      body: text(input.observability?.attention?.tldr) || 'The latest evolution cycle failed.',
      tone: 'error',
      source: 'observability'
    })
  }

  for (const record of input.records) {
    push(messageCard(record))
  }

  return cards
}
