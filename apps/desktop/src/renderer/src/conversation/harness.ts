import { JEA_CLIENT_PROTOCOL_VERSION } from '../../../client-api/protocol'
import { PublicClientError } from '../../../client-api/errors'
import { createTypedJeaClient, type JeaClient } from '../../../client-api/jea-client'
import type {
  ConversationMessage,
  ConversationSessionSummary,
  EvolutionObservability,
  JeaEventEnvelope,
  ServiceStatus,
  SetupReadiness,
  SubjectReadiness,
  SubjectRecord,
  SubjectSummary
} from '../../../client-api/types'

export const TEST_CONVERSATION_SUBJECT = 'alpha'

export interface HarnessSubject extends SubjectRecord {
  sessions?: ConversationSessionSummary[]
  records?: ConversationMessage[]
}

export interface ConversationHarnessOptions {
  subjects?: HarnessSubject[]
  rejectSend?: PublicClientError | null
  rejectStart?: PublicClientError | null
  startDelayMs?: number
  readDelayMs?: number
  service?: Partial<ServiceStatus>
  readiness?: Partial<SetupReadiness>
  observability?: Partial<EvolutionObservability>
}

function nowIso(): string {
  return new Date().toISOString()
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createConversationHarness(options: ConversationHarnessOptions = {}) {
  const subjects: SubjectRecord[] = (options.subjects ?? [
    {
      name: TEST_CONVERSATION_SUBJECT,
      namespace: 'alpha-data',
      isDefault: true,
      selected: true,
      desktopChannelEnabled: true
    },
    {
      name: 'beta',
      namespace: 'beta-data',
      isDefault: false,
      selected: false,
      desktopChannelEnabled: false
    }
  ]).map((item) => ({
    name: item.name,
    namespace: item.namespace,
    isDefault: item.isDefault,
    selected: item.selected,
    desktopChannelEnabled: item.desktopChannelEnabled
  }))

  const sessions = new Map<string, ConversationSessionSummary[]>()
  const records = new Map<string, ConversationMessage[]>()
  for (const subject of options.subjects ?? []) {
    if (subject.sessions) sessions.set(subject.name, clone(subject.sessions))
    if (subject.records) {
      const sessionId = subject.records[0]?.session_id ?? 'main'
      records.set(`${subject.name}:${sessionId}`, clone(subject.records))
    }
  }
  if (!sessions.has(TEST_CONVERSATION_SUBJECT) && subjects.some((item) => item.name === TEST_CONVERSATION_SUBJECT)) {
    sessions.set(TEST_CONVERSATION_SUBJECT, [{
      session_id: 'main',
      target: 'desktop:main',
      message_count: 0,
      last_message_at: null
    }])
  }

  const listeners = new Set<(event: JeaEventEnvelope) => void>()
  const sent: Array<{ subject: string; text: string; sessionId?: string; messageId?: string }> = []
  const enabled: string[] = []
  const started: string[] = []
  const watched: string[] = []
  let watchStops = 0
  let rejectSend = options.rejectSend ?? null
  let readDelayMs = options.readDelayMs ?? 0
  let supportDelayMs = 0
  let selected = subjects.find((item) => item.isDefault)?.name ?? subjects[0]?.name ?? null
  const serviceBySubject = new Map<string, ServiceStatus>()
  const readinessBySubject = new Map<string, SetupReadiness>()
  const observabilityBySubject = new Map<string, EvolutionObservability>()

  const service: ServiceStatus = {
    subject: TEST_CONVERSATION_SUBJECT,
    mode: 'none',
    pid: null,
    domain: null,
    heartbeat_at: null,
    started_at: null,
    health: 'idle',
    detail: null,
    ...options.service
  }

  const readiness: SetupReadiness = {
    jeaHome: { path: '/tmp/jea-conversation-fixture', source: 'fixture', writable: true },
    subjects: {
      count: subjects.length,
      defaultSubject: selected,
      names: subjects.map((item) => item.name)
    },
    model: { configured: false, mode: 'mock' },
    data: { initialized: true },
    conversation: {
      desktopChannelEnabled: subjects.find((item) => item.name === selected)?.desktopChannelEnabled ?? false,
      subject: selected
    },
    cli: {
      installed: false,
      onPath: false,
      pathHint: '~/.local/bin/jea',
      supported: false,
      detail: null
    },
    conversationReady: false,
    ...options.readiness
  }
  readiness.conversationReady = options.readiness?.conversationReady ?? Boolean(
    readiness.jeaHome.writable
    && readiness.subjects.count > 0
    && readiness.subjects.defaultSubject
    && readiness.data.initialized
    && readiness.conversation.desktopChannelEnabled
  )

  const observability: EvolutionObservability = {
    subject: TEST_CONVERSATION_SUBJECT,
    attention: { count: 0, highest_severity: null },
    open_cycles: 0,
    ...options.observability
  }

  function key(subject: string, sessionId: string): string {
    return `${subject}:${sessionId}`
  }

  function emit(type: string, subject?: string, sessionId?: string, payload: Record<string, unknown> = {}): void {
    const event: JeaEventEnvelope = {
      type,
      ts: nowIso(),
      subject,
      session_id: sessionId,
      payload
    }
    for (const listener of listeners) listener(event)
  }

  function requireSubject(name: string): SubjectRecord {
    const record = subjects.find((item) => item.name === name)
    if (!record) throw new PublicClientError('NOT_FOUND', 'Requested subject is unavailable.')
    return record
  }

  const client: JeaClient = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
    async invoke(request) {
      const command = request.command
      const payload = (request.payload ?? {}) as Record<string, unknown>
      const subject = typeof payload.subject === 'string' ? payload.subject : selected ?? TEST_CONVERSATION_SUBJECT

      if (command === 'subject.list') return subjects.map(({ selected: _selected, desktopChannelEnabled: _enabled, ...summary }) => summary as SubjectSummary)
      if (command === 'subject.get' || command === 'subject.select' || command === 'subject.setDefault') {
        const record = requireSubject(String(payload.subject ?? ''))
        if (command !== 'subject.get') selected = record.name
        return { ...record, selected: selected === record.name }
      }
      if (command === 'conversation.listSessions') {
        requireSubject(subject)
        return sessions.get(subject) ?? []
      }
      if (command === 'conversation.createSession') {
        requireSubject(subject)
        const sessionId = String(payload.sessionId ?? `local-${Date.now()}`)
        const created: ConversationSessionSummary = {
          session_id: sessionId,
          target: `desktop:${sessionId}`,
          message_count: 0,
          last_message_at: null
        }
        const current = sessions.get(subject) ?? []
        if (!current.some((item) => item.session_id === sessionId)) {
          sessions.set(subject, [...current, created])
        }
        return created
      }
      if (command === 'conversation.readMessages') {
        requireSubject(subject)
        const sessionId = String(payload.sessionId ?? '')
        if (readDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, readDelayMs))
        }
        const page = records.get(key(subject, sessionId)) ?? []
        return {
          schema_version: 1,
          subject,
          session_id: sessionId,
          records: page,
          offset: 0,
          next_offset: page.length,
          total: page.length
        }
      }
      if (command === 'conversation.sendMessage') {
        if (rejectSend) throw rejectSend
        const record = requireSubject(subject)
        if (!record.desktopChannelEnabled) {
          throw new PublicClientError('CONFLICT', 'Desktop Channel is disabled for this subject.')
        }
        const text = String(payload.text ?? '').trim()
        const sessionId = String(payload.sessionId ?? 'main')
        const messageId = String(payload.messageId ?? `harness-${Date.now()}`)
        sent.push({ subject, text, sessionId, messageId })
        const existing = records.get(key(subject, sessionId)) ?? []
        const duplicate = existing.some((item) => item.message_id === messageId)
        if (!duplicate) {
          existing.push({
            id: `inbound:${messageId}`,
            session_id: sessionId,
            role: 'user',
            direction: 'inbound',
            content: text,
            created_at: nowIso(),
            offset: existing.length,
            message_id: messageId
          })
          records.set(key(subject, sessionId), existing)
        }
        emit('conversation.updated', subject, sessionId, { subject, session_id: sessionId })
        return {
          subject,
          session_id: sessionId,
          message_id: messageId,
          session_created: existing.length === 1,
          duplicate
        }
      }
      if (command === 'service.getReadiness') {
        requireSubject(subject)
        return {
          subject,
          generated_at: nowIso(),
          web_host: { state: 'stopped', reasons: ['web_host_stopped'] },
          cycle: { state: 'stopped', reasons: ['cycle_stopped'] },
          channel: { state: 'stopped', reasons: ['channel_stopped'] },
          model: { state: 'running', mode: 'mock', reasons: ['model_mock'] },
          conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] },
          reasons: ['web_host_stopped', 'cycle_stopped', 'channel_stopped', 'model_mock', 'conversation_blocked_channel'],
          allowed_actions: ['start_channel', 'start_cycle'],
          actions: []
        } satisfies SubjectReadiness
      }
      if (command === 'service.processCycleOnce') {
        requireSubject(subject)
        emit('evolution.updated', subject, undefined, { subject })
        return {
          subject,
          status: 'idle',
          reason: 'no_pending_evidence',
          scanned: { scanned: true, enqueued_count: 0 },
          backlog: { before: 0, after: 0 },
          health: { before: { health: 'idle' }, after: { health: 'idle' } },
          claim: null,
          checkpoint: null,
          events: [],
          channel: { before: { pid: null }, after: { pid: null }, unchanged: true },
          work: null
        }
      }
      if (command === 'service.getStatus') {
        if (supportDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, supportDelayMs))
        }
        return { ...(serviceBySubject.get(subject) ?? service), subject }
      }
      if (command === 'service.start') {
        if (options.startDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.startDelayMs))
        }
        if (options.rejectStart) throw options.rejectStart
        started.push(subject)
        service.mode = 'attached'
        service.pid = 4242
        service.domain = payload.domain === 'cycle' || payload.domain === 'all' || payload.domain === 'channel'
          ? payload.domain
          : 'channel'
        service.health = 'ok'
        service.detail = null
        emit('service.status', subject, undefined, { subject, mode: service.mode })
        return { ...service, subject }
      }
      if (command === 'setup.getReadiness') {
        if (supportDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, supportDelayMs))
        }
        const current = readinessBySubject.get(subject) ?? readiness
        return {
          ...current,
          conversation: {
            desktopChannelEnabled: requireSubject(subject).desktopChannelEnabled,
            subject
          }
        }
      }
      if (command === 'setup.enableDesktopChannel') {
        const record = requireSubject(subject)
        record.desktopChannelEnabled = true
        enabled.push(subject)
        emit('subject.changed', subject, undefined, { subject, reason: 'desktop_channel_enabled' })
        return {
          name: subject,
          created: false,
          skipped: false,
          desktopChannelEnabled: true
        }
      }
      if (command === 'evolution.getObservability') {
        if (supportDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, supportDelayMs))
        }
        return { ...(observabilityBySubject.get(subject) ?? observability), subject }
      }
      if (command === 'protocol.get') {
        return {
          protocol: 'jea.client',
          version: JEA_CLIENT_PROTOCOL_VERSION,
          commands: [],
          events: ['conversation.updated', 'subject.changed', 'service.status']
        }
      }
      throw new PublicClientError('COMMAND_NOT_ALLOWED', 'Command is not available.')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })

  const projectionWatch = {
    watch(subject: string) {
      watched.push(subject)
      return { subject, watching: true as const }
    },
    stop() {
      watchStops += 1
      return { stopped: true }
    }
  }

  return {
    client,
    sent,
    enabled,
    started,
    watched,
    get watchStops() { return watchStops },
    projectionWatch,
    emit,
    setRejectSend(error: PublicClientError | null) {
      rejectSend = error
    },
    setReadDelay(ms: number) {
      readDelayMs = ms
    },
    setSupportDelay(ms: number) {
      supportDelayMs = ms
    },
    setSupport(subject: string, next: {
      service?: Partial<ServiceStatus>
      readiness?: Partial<SetupReadiness>
      observability?: Partial<EvolutionObservability>
    }) {
      if (next.service) {
        serviceBySubject.set(subject, { ...service, ...next.service, subject })
      }
      if (next.readiness) {
        readinessBySubject.set(subject, { ...readiness, ...next.readiness })
      }
      if (next.observability) {
        observabilityBySubject.set(subject, { ...observability, ...next.observability, subject })
      }
    },
    appendAssistant(subject: string, sessionId: string, content: string, extras: Partial<ConversationMessage> = {}) {
      const existing = records.get(key(subject, sessionId)) ?? []
      existing.push({
        id: extras.id ?? `outbound:${existing.length}`,
        session_id: sessionId,
        role: 'assistant',
        direction: 'outbound',
        content,
        created_at: extras.created_at ?? nowIso(),
        offset: extras.offset ?? existing.length,
        message_id: extras.message_id ?? null,
        ...extras
      })
      records.set(key(subject, sessionId), existing)
      emit('conversation.updated', subject, sessionId, { subject, session_id: sessionId })
    },
    records
  }
}
