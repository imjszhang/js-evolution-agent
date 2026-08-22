import type { JeaClient } from '../../../client-api/jea-client'
import type {
  ConversationSendResult,
  ConversationSessionSummary,
  ConversationPipelineState,
  EvolutionObservability,
  JeaEventEnvelope,
  ServiceStatus,
  SetupReadiness,
  SubjectReadiness,
  SubjectRecord,
  SubjectSummary
} from '../../../client-api/types'
import { deriveInlineCards, type ConversationCard } from './cards'
import { resolveDraftAttempt, type DraftAttempt } from './draft'
import { classifyClientError, type ConversationErrorView } from './errors'
import {
  eventSessionId,
  eventSubject,
  isConversationEvent,
  isEventForContext,
  isEvolutionEvent,
  isServiceEvent,
  isStaleProjectionEvent,
  isSubjectEvent
} from './events'
import { hasAssistantAfter, mergeRecords, type WorkspaceMessage } from './history'
import { type ChannelServiceStartState } from './recovery'
import type { ProjectionWatchPort } from './watch'

export type ConversationSendState = 'idle' | 'pending' | 'sent' | 'failed'
export type { ChannelServiceStartState }

export interface ConversationWorkspaceSnapshot {
  subjects: SubjectSummary[]
  subject: SubjectRecord | null
  sessions: ConversationSessionSummary[]
  sessionId: string | null
  records: WorkspaceMessage[]
  draft: string
  sendState: ConversationSendState
  serviceStartState: ChannelServiceStartState
  waiting: boolean
  pipelineState: ConversationPipelineState | null
  lastSend: ConversationSendResult | null
  error: ConversationErrorView | null
  service: ServiceStatus | null
  readiness: SetupReadiness | null
  subjectReadiness: SubjectReadiness | null
  channelReasons: string[]
  observability: EvolutionObservability | null
  stale: boolean
  cards: ConversationCard[]
  loading: boolean
  lastDraftId: string | null
}

const DEFAULT_SESSION = 'main'

function eventRevision(event: JeaEventEnvelope): number | null {
  const value = event.payload?.revision
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function channelReasonsFromPayload(payload: Record<string, unknown> | undefined): string[] | null {
  const channel = payload?.channel
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return null
  const reasons = (channel as { reasons?: unknown }).reasons
  if (!Array.isArray(reasons)) return null
  return reasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function emptySnapshot(): ConversationWorkspaceSnapshot {
  return {
    subjects: [],
    subject: null,
    sessions: [],
    sessionId: null,
    records: [],
    draft: '',
    sendState: 'idle',
    serviceStartState: 'idle',
    waiting: false,
    pipelineState: null,
    lastSend: null,
    error: null,
    service: null,
    readiness: null,
    subjectReadiness: null,
    channelReasons: [],
    observability: null,
    stale: false,
    cards: [],
    loading: true,
    lastDraftId: null
  }
}

export class ConversationWorkspaceModel {
  private refs = 0
  private generation = 0
  private offset = 0
  private draftAttempt: DraftAttempt | null = null
  private unsubscribeEvents: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private snapshot: ConversationWorkspaceSnapshot = emptySnapshot()
  private waitStartedAt: string | null = null
  private selectedName: string | null = null
  private disposed = false
  private lastSupportRevision: number | null = null
  private supportInFlight: Promise<void> | null = null
  private supportQueued: { subject: string; generation: number; revision: number | null } | null = null
  private waitingPoll: ReturnType<typeof setTimeout> | null = null
  private conversationRefreshSequence = 0

  constructor(
    private readonly client: JeaClient,
    private readonly projectionWatch: ProjectionWatchPort | null = null
  ) {
    this.subscribe = this.subscribe.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): ConversationWorkspaceSnapshot {
    return this.snapshot
  }

  retain(): void {
    this.refs += 1
    if (this.refs === 1) {
      this.disposed = false
      void this.bootstrap()
    }
  }

  release(): void {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs === 0) this.dispose()
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    this.clearWaitingPoll()
    void this.releaseWatch()
  }

  setDraft(draft: string): void {
    this.patch({ draft })
  }

  stopWaiting(): void {
    this.waitStartedAt = null
    this.clearWaitingPoll()
    this.patch({ waiting: false })
  }

  async bootstrap(preferredSubject?: string | null): Promise<void> {
    const generation = ++this.generation
    this.patch({ loading: true, error: null })
    try {
      const subjects = await this.client.listSubjects()
      if (!this.isCurrent(generation)) return
      const selectedName = preferredSubject
        && subjects.some((item) => item.name === preferredSubject)
        ? preferredSubject
        : subjects.find((item) => item.isDefault)?.name ?? subjects[0]?.name ?? null
      this.patch({ subjects, loading: false })
      this.watchEvents()
      if (selectedName) await this.selectSubject(selectedName, { generation })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.patch({
        loading: false,
        error: classifyClientError(error, 'Unable to load conversation state.')
      })
    }
  }

  async selectSubject(
    name: string,
    options: { generation?: number } = {}
  ): Promise<void> {
    const generation = options.generation ?? ++this.generation
    this.selectedName = name
    this.offset = 0
    this.draftAttempt = null
    this.waitStartedAt = null
    this.clearWaitingPoll()
    this.lastSupportRevision = null
    this.supportQueued = null
    this.conversationRefreshSequence += 1
    await this.retargetWatch(name, generation)
    if (!this.isCurrent(generation)) return
    this.patch({
      sessionId: DEFAULT_SESSION,
      sessions: [],
      records: [],
      waiting: false,
      pipelineState: null,
      sendState: 'idle',
      serviceStartState: 'idle',
      lastSend: null,
      error: null,
      stale: false,
      service: null,
      readiness: null,
      subjectReadiness: null,
      channelReasons: [],
      observability: null
    })
    try {
      const subject = await this.client.selectSubject(name)
      if (!this.isCurrent(generation)) return
      this.patch({ subject, sessionId: DEFAULT_SESSION, sessions: [] })
      await this.refreshSupport(name, generation)
      if (!this.isCurrent(generation)) return
      await this.refreshConversationSessions(name, generation)
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.patch({ error: classifyClientError(error, 'Unable to load conversation state.') })
    }
  }

  async send(): Promise<void> {
    const subject = this.snapshot.subject?.name
    const sessionId = this.snapshot.sessionId
    const generation = this.generation
    const content = this.snapshot.draft.trim()
    if (!subject || !sessionId || !content || this.snapshot.sendState === 'pending') return
    const attempt = resolveDraftAttempt(this.draftAttempt, { subject, sessionId, content })
    this.draftAttempt = attempt
    this.patch({ sendState: 'pending', error: null, lastDraftId: attempt.id })
    try {
      const result = await this.client.sendMessage(subject, content, {
        sessionId,
        messageId: attempt.id
      })
      if (this.snapshot.subject?.name !== subject || this.snapshot.sessionId !== sessionId) return
      this.draftAttempt = null
      this.waitStartedAt = new Date().toISOString()
      this.patch({
        draft: '',
        sendState: 'sent',
        waiting: true,
        lastSend: result,
        lastDraftId: attempt.id
      })
      await this.readMessages(false)
      if (hasAssistantAfter(this.snapshot.records, this.waitStartedAt)) {
        this.stopWaiting()
      } else {
        this.scheduleWaitingPoll(subject, sessionId, generation)
      }
    } catch (error) {
      if (this.snapshot.subject?.name !== subject || this.snapshot.sessionId !== sessionId) return
      this.patch({
        sendState: 'failed',
        waiting: false,
        pipelineState: null,
        error: classifyClientError(error, 'Unable to send the desktop message.')
      })
    }
  }

  async retry(): Promise<void> {
    if (this.snapshot.sendState !== 'failed') return
    await this.send()
  }

  async enableDesktopChannel(): Promise<void> {
    const subject = this.snapshot.subject?.name
    if (!subject) return
    const generation = this.generation
    try {
      await this.client.enableDesktopChannel(subject)
      if (!this.isCurrent(generation)) return
      await this.selectSubject(subject, { generation })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.patch({ error: classifyClientError(error, 'Unable to enable desktop Channel.') })
    }
  }

  async startChannelService(): Promise<void> {
    const subject = this.snapshot.subject?.name
    if (!subject || this.snapshot.serviceStartState === 'pending') return
    const generation = this.generation
    this.patch({ serviceStartState: 'pending', error: null })
    try {
      await this.client.startService(subject, 'channel')
      if (!this.isCurrent(generation)) return
      await this.refreshSupport(subject, generation)
      if (!this.isCurrent(generation) || this.snapshot.subject?.name !== subject) return
      this.patch({ serviceStartState: 'started', error: null })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.patch({
        serviceStartState: 'failed',
        error: classifyClientError(error, 'Unable to start the channel service.')
      })
    }
  }

  private watchEvents(): void {
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = this.client.subscribe((event) => {
      void this.onEvent(event)
    })
  }

  private async onEvent(event: JeaEventEnvelope): Promise<void> {
    const generation = this.generation
    const subject = this.selectedName ?? this.snapshot.subject?.name ?? null
    if (!isEventForContext(event, subject, null)) return
    if (isStaleProjectionEvent(event)) {
      if (!this.isCurrent(generation) || this.snapshot.subject?.name !== subject) return
      this.patch({ stale: true })
      return
    }
    if (isSubjectEvent(event)) {
      const next = eventSubject(event)
      if (next && next !== subject) {
        await this.selectSubject(next)
        return
      }
      if (subject) await this.refreshSupportCoalesced(subject, generation, eventRevision(event))
      return
    }
    if (event.type === 'projection.channel_updated') {
      const reasons = channelReasonsFromPayload(event.payload)
      if (reasons) this.patch({ channelReasons: reasons })
      if (subject) await this.refreshSupportCoalesced(subject, generation, eventRevision(event))
      return
    }
    if (isConversationEvent(event)) {
      const eventSession = eventSessionId(event)
      await this.refreshConversationSessions(subject, generation, {
        eventSession,
        removed: event.payload?.removed === true
      })
      if (
        this.isCurrent(generation)
        && this.snapshot.waiting
        && hasAssistantAfter(this.snapshot.records, this.waitStartedAt)
      ) {
        this.stopWaiting()
      }
      return
    }
    if ((isServiceEvent(event) || isEvolutionEvent(event)) && subject) {
      await this.refreshSupportCoalesced(subject, generation, eventRevision(event))
    }
  }

  private async refreshConversationSessions(
    subject: string | null,
    generation: number,
    event: { eventSession: string | null; removed: boolean } | null = null
  ): Promise<void> {
    if (!subject) return
    const sequence = ++this.conversationRefreshSequence
    try {
      const listed = await this.client.listSessions(subject)
      if (
        !this.isCurrent(generation)
        || sequence !== this.conversationRefreshSequence
        || this.snapshot.subject?.name !== subject
      ) return
      const sessions = event?.removed && event.eventSession
        ? listed.filter((item) => item.session_id !== event.eventSession)
        : listed
      const currentSession = this.snapshot.sessionId
      if (currentSession && sessions.some((item) => item.session_id === currentSession)) {
        this.patch({ sessions })
        if (!event) {
          await this.readMessages(true, generation)
        } else if (event.eventSession === currentSession && !event.removed) {
          await this.readMessages(false, generation)
        }
        return
      }
      const nextSession = sessions.find((item) => item.session_id === DEFAULT_SESSION)?.session_id
        ?? sessions[0]?.session_id
        ?? (event ? null : DEFAULT_SESSION)
      this.offset = 0
      this.waitStartedAt = null
      this.clearWaitingPoll()
      this.patch({
        sessions,
        sessionId: nextSession,
        records: [],
        waiting: false,
        pipelineState: null,
        lastSend: null
      })
      if (nextSession) await this.readMessages(true, generation)
    } catch (error) {
      if (!this.isCurrent(generation) || sequence !== this.conversationRefreshSequence) return
      if (event?.removed && event.eventSession === this.snapshot.sessionId) {
        this.offset = 0
        this.waitStartedAt = null
        this.clearWaitingPoll()
        this.patch({
          sessions: this.snapshot.sessions.filter((item) => item.session_id !== event.eventSession),
          sessionId: null,
          records: [],
          waiting: false,
          pipelineState: null,
          lastSend: null,
          error: classifyClientError(error, 'Unable to refresh conversation sessions.')
        })
      }
    }
  }

  private async readMessages(reset: boolean, generation = this.generation): Promise<void> {
    const subject = this.snapshot.subject?.name
    const sessionId = this.snapshot.sessionId
    if (!subject || !sessionId) return
    try {
      const page = await this.client.readMessages(subject, sessionId, reset
        ? { tail: 100 }
        : { offset: this.offset, limit: 200 })
      if (
        !this.isCurrent(generation)
        || this.snapshot.subject?.name !== subject
        || this.snapshot.sessionId !== sessionId
        || page.subject !== subject
        || page.session_id !== sessionId
      ) {
        return
      }
      this.offset = reset ? page.next_offset : Math.max(this.offset, page.next_offset)
      const channelReasons = Array.isArray(page.channel_health?.reasons)
        ? page.channel_health.reasons.filter((item) => typeof item === 'string' && item.trim())
        : undefined
      const records = reset
        ? page.records as WorkspaceMessage[]
        : mergeRecords(this.snapshot.records, page.records as WorkspaceMessage[])
      const pipelineState = page.pipeline_state ?? this.snapshot.pipelineState
      const scopedPipeline = !this.snapshot.lastSend
        || !pipelineState?.message_id
        || pipelineState.message_id === this.snapshot.lastSend.message_id
      const waiting = this.snapshot.waiting && scopedPipeline && pipelineState?.status === 'failed'
        ? false
        : this.snapshot.waiting
      this.patch({
        records,
        waiting,
        pipelineState,
        ...(channelReasons ? { channelReasons } : {})
      })
      if (!waiting || hasAssistantAfter(records, this.waitStartedAt)) this.stopWaiting()
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.patch({ error: classifyClientError(error, 'Unable to load conversation state.') })
    }
  }

  private async refreshSupport(subject: string, generation: number): Promise<void> {
    try {
      const [service, readiness, subjectReadiness, observability] = await Promise.all([
        this.client.getServiceStatus(subject),
        this.client.getReadiness(subject),
        this.client.getServiceReadiness(subject),
        this.client.getObservability(subject)
      ])
      if (!this.isCurrent(generation)) return
      if (this.selectedName && this.selectedName !== subject) return
      if (this.snapshot.subject && this.snapshot.subject.name !== subject) return
      this.patch({ service, readiness, subjectReadiness, observability, stale: false })
    } catch {
      // Support reads are best-effort and must not block conversation.
    }
  }

  private async refreshSupportCoalesced(
    subject: string,
    generation: number,
    revision: number | null
  ): Promise<void> {
    if (revision != null && revision === this.lastSupportRevision) return
    if (this.supportInFlight) {
      this.supportQueued = { subject, generation, revision }
      return
    }
    this.supportInFlight = this.refreshSupport(subject, generation)
    try {
      await this.supportInFlight
      if (revision != null) this.lastSupportRevision = revision
    } finally {
      this.supportInFlight = null
    }
    const queued = this.supportQueued
    this.supportQueued = null
    if (!queued) return
    if (queued.revision != null && queued.revision === this.lastSupportRevision) return
    await this.refreshSupportCoalesced(queued.subject, queued.generation, queued.revision)
  }

  private async retargetWatch(subject: string, generation: number): Promise<void> {
    if (!this.projectionWatch) return
    try {
      await this.projectionWatch.watch(subject)
    } catch {
      if (!this.isCurrent(generation)) return
      this.patch({ stale: true })
    }
  }

  private async releaseWatch(): Promise<void> {
    if (!this.projectionWatch) return
    try {
      await this.projectionWatch.stop()
    } catch {
      // Workspace disposal must still complete if the host watch is already gone.
    }
  }

  private scheduleWaitingPoll(subject: string, sessionId: string, generation: number): void {
    this.clearWaitingPoll()
    const started = Date.parse(this.waitStartedAt ?? '')
    if (!Number.isFinite(started) || Date.now() - started >= 30_000) return
    this.waitingPoll = setTimeout(() => {
      this.waitingPoll = null
      if (
        !this.isCurrent(generation)
        || !this.snapshot.waiting
        || this.snapshot.subject?.name !== subject
        || this.snapshot.sessionId !== sessionId
      ) return
      void this.readMessages(false, generation).then(() => {
        if (this.snapshot.waiting) this.scheduleWaitingPoll(subject, sessionId, generation)
      })
    }, 250)
  }

  private clearWaitingPoll(): void {
    if (this.waitingPoll) clearTimeout(this.waitingPoll)
    this.waitingPoll = null
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private patch(partial: Partial<ConversationWorkspaceSnapshot>): void {
    const next = { ...this.snapshot, ...partial }
    next.cards = deriveInlineCards({
      subject: next.subject,
      service: next.service,
      readiness: next.readiness,
      subjectReadiness: next.subjectReadiness,
      observability: next.observability,
      records: next.records,
      error: next.error,
      stale: next.stale,
      channelReasons: next.channelReasons,
      serviceStartState: next.serviceStartState
    })
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
