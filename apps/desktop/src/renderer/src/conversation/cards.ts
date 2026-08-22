import type {
  EvolutionObservability,
  ServiceStatus,
  SetupReadiness,
  SubjectReadiness,
  SubjectRecord
} from '../../../client-api/types'
import type { ConversationErrorView } from './errors'
import type { WorkspaceMessage } from './history'
import { deriveConversationRecovery, type ChannelServiceStartState } from './recovery'

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
  | 'starting'
  | 'attached'
  | 'ready'

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

function isCycleOnlyAttention(kind: string): boolean {
  return /reactor|evidence|cycle|daemon_task/i.test(kind)
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
  subjectReadiness?: SubjectReadiness | null
  observability: EvolutionObservability | null
  records: WorkspaceMessage[]
  error: ConversationErrorView | null
  stale?: boolean
  channelReasons?: readonly string[]
  serviceStartState?: ChannelServiceStartState
}): ConversationCard[] {
  const cards: ConversationCard[] = []
  const seen = new Set<string>()
  const push = (card: ConversationCard | null) => {
    if (!card || seen.has(card.id)) return
    seen.add(card.id)
    cards.push(card)
  }
  const recovery = deriveConversationRecovery({
    subjectReadiness: input.subjectReadiness ?? null,
    desktopChannelEnabled: input.subject?.desktopChannelEnabled !== false,
    serviceStartState: input.serviceStartState ?? 'idle',
    channelReasons: input.channelReasons
  })

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

  if (recovery.kind === 'stopped') {
    push({
      id: 'status:channel_stopped',
      kind: 'offline',
      title: 'Channel is stopped',
      body: 'Start Channel to recover the governed local conversation. Cycle health is not required.',
      tone: 'warn',
      source: 'readiness'
    })
  }

  if (recovery.kind === 'blocked') {
    push({
      id: 'status:channel_blocked',
      kind: 'blocked',
      title: 'Channel is blocked',
      body: recovery.blockedReasons.join('\n') || 'Channel projection reported a blocked state.',
      tone: 'error',
      source: 'readiness'
    })
  }

  if (recovery.kind === 'starting') {
    push({
      id: 'status:channel_starting',
      kind: 'starting',
      title: 'Channel is starting',
      body: 'Waiting for a fresh Channel role. Cycle is not started by this action.',
      tone: 'info',
      source: 'readiness'
    })
  }

  if (recovery.kind === 'attached') {
    push({
      id: 'status:channel_attached',
      kind: 'attached',
      title: 'Channel is attached',
      body: 'An external Channel process is already running. The product will observe it and will not start or stop it.',
      tone: 'info',
      source: 'readiness'
    })
  }

  if (recovery.kind === 'stale' || input.error?.kind === 'channel_stale') {
    push({
      id: 'status:channel_stale',
      kind: 'stale',
      title: 'Channel is stale',
      body: input.error?.kind === 'channel_stale'
        ? input.error.message
        : 'Channel heartbeat is stale. Do not start a second Channel process.',
      tone: 'warn',
      source: input.error?.kind === 'channel_stale' ? 'error' : 'readiness'
    })
  }

  if (recovery.kind === 'zombie') {
    push({
      id: 'status:channel_zombie',
      kind: 'daemon_unhealthy',
      title: 'Channel process is dead',
      body: 'Repair worker state instead of starting a new Channel.',
      tone: 'error',
      source: 'readiness'
    })
  }

  if (recovery.kind === 'web_native') {
    push({
      id: 'status:web_native',
      kind: 'web_rejected',
      title: 'Start Channel is Desktop-only',
      body: 'This host cannot start Channel. Open the Desktop app to recover the local conversation.',
      tone: 'warn',
      source: 'readiness'
    })
  }

  if (input.error?.kind === 'early_exit' || input.error?.kind === 'startup_timeout' || input.error?.kind === 'channel_attached') {
    push({
      id: `status:${input.error.kind}`,
      kind: input.error.kind === 'channel_attached' ? 'attached' : 'daemon_unhealthy',
      title: input.error.kind === 'early_exit'
        ? 'Channel exited before ready'
        : input.error.kind === 'startup_timeout'
          ? 'Channel startup timed out'
          : 'Channel is attached',
      body: input.error.message,
      tone: input.error.kind === 'channel_attached' ? 'info' : 'error',
      source: 'error'
    })
  }

  if (
    input.readiness?.model.mode === 'unset'
    || input.subjectReadiness?.model.mode === 'unset'
    || input.error?.kind === 'model_unavailable'
    || recovery.kind === 'model_blocked'
  ) {
    push({
      id: 'status:model',
      kind: 'model_unavailable',
      title: 'Model is unavailable',
      body: 'No model is configured. Mock mode can still run the governed Channel pipeline; a live model is not required.',
      tone: 'warn',
      source: 'readiness'
    })
  }

  for (const [index, item] of (input.observability?.attention.items ?? []).entries()) {
    if (!item.title || isCycleOnlyAttention(item.kind)) continue
    push({
      id: `attention:${index}:${item.kind}`,
      kind: 'blocked',
      title: item.title,
      body: item.summary,
      tone: item.severity === 'critical' ? 'error' : 'warn',
      source: 'observability'
    })
  }

  for (const record of input.records) {
    push(messageCard(record))
  }

  return cards
}
