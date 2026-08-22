import { JEA_CLIENT_PROTOCOL_VERSION } from '../../../client-api/protocol'
import { PublicClientError } from '../../../client-api/errors'
import { createTypedJeaClient, type JeaClient } from '../../../client-api/jea-client'
import type {
  ConversationMessage,
  ConversationSessionSummary,
  EvolutionObservability,
  JeaEventEnvelope,
  RemediationAction,
  ServiceStatus,
  SetupReadiness,
  SubjectReadiness,
  SubjectReadinessActionId,
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
  subjectReadiness?: Partial<SubjectReadiness>
  observability?: Partial<EvolutionObservability>
  hostKind?: 'electron' | 'web'
  channelReasons?: string[]
}

function remediationActions(
  allowed: SubjectReadinessActionId[],
  hostKind: 'electron' | 'web'
): { allowed_actions: SubjectReadinessActionId[]; actions: RemediationAction[] } {
  const ids: SubjectReadinessActionId[] = [
    'start_channel',
    'start_cycle',
    'process_cycle_once',
    'repair_worker_state',
    'stop_managed',
    'open_desktop',
    'none'
  ]
  const capability: Record<SubjectReadinessActionId, RemediationAction['capability']> = {
    start_channel: 'local-only',
    start_cycle: 'local-only',
    process_cycle_once: 'write',
    repair_worker_state: 'local-only',
    stop_managed: 'local-only',
    open_desktop: 'readonly',
    none: 'readonly'
  }
  const needed = new Set(allowed)
  if (hostKind === 'web' && [...needed].some((id) => capability[id] === 'local-only')) {
    needed.add('open_desktop')
  }
  const actions = ids.map((id) => {
    const local = capability[id] === 'local-only'
    const allowedNow = needed.has(id) && (hostKind === 'electron' || !local || id === 'open_desktop')
    return {
      id,
      allowed: id === 'open_desktop' ? hostKind === 'web' && [...needed].some((item) => capability[item] === 'local-only') : allowedNow,
      capability: capability[id]
    }
  })
  let allowed_actions = actions.filter((entry) => entry.allowed).map((entry) => entry.id)
  if (allowed_actions.length === 0) {
    const none = actions.find((entry) => entry.id === 'none')
    if (none) none.allowed = true
    allowed_actions = ['none']
  }
  return { allowed_actions, actions }
}

export function fixtureSubjectReadiness(
  subject: string,
  patch: Partial<SubjectReadiness> = {},
  hostKind: 'electron' | 'web' = 'electron'
): SubjectReadiness {
  const channel = patch.channel ?? { state: 'attached', reasons: ['channel_attached'] }
  const cycle = patch.cycle ?? { state: 'stopped', reasons: ['cycle_stopped'] }
  const conversation = patch.conversation ?? { state: 'running', reasons: ['conversation_ready'] }
  const model = patch.model ?? { state: 'running', mode: 'mock', reasons: ['model_mock'] }
  const needed: SubjectReadinessActionId[] = []
  if (channel.state === 'stopped' || channel.state === 'blocked') needed.push('start_channel')
  if (channel.state === 'stale' || channel.state === 'zombie' || cycle.state === 'stale' || cycle.state === 'zombie') {
    needed.push('repair_worker_state')
  }
  if (cycle.state === 'stalled' || cycle.reasons.includes('reactor_backlog_stalled')) needed.push('process_cycle_once')
  else if (cycle.state === 'stopped' || cycle.state === 'blocked') needed.push('start_cycle')
  const { allowed_actions, actions } = remediationActions(patch.allowed_actions ?? needed, hostKind)
  return {
    subject,
    generated_at: nowIso(),
    web_host: patch.web_host ?? { state: 'stopped', reasons: ['web_host_stopped'] },
    cycle,
    channel,
    model,
    conversation,
    reasons: patch.reasons ?? [
      ...cycle.reasons,
      ...channel.reasons,
      ...model.reasons,
      ...conversation.reasons
    ],
    allowed_actions,
    actions
  }
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
  const pipelines = new Map<string, {
    status: 'idle' | 'pending' | 'failed' | 'delivered'
    message_id: string | null
    pending_count: number
    failed_count: number
    last_error: string | null
  }>()
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
  const startedDomains: Array<'all' | 'cycle' | 'channel'> = []
  const watched: string[] = []
  const hostKind = options.hostKind ?? 'electron'
  let watchStops = 0
  let rejectSend = options.rejectSend ?? null
  let readDelayMs = options.readDelayMs ?? 0
  let supportDelayMs = 0
  let selected = subjects.find((item) => item.isDefault)?.name ?? subjects[0]?.name ?? null
  const serviceBySubject = new Map<string, ServiceStatus>()
  const readinessBySubject = new Map<string, SetupReadiness>()
  const subjectReadinessBySubject = new Map<string, SubjectReadiness>()
  const observabilityBySubject = new Map<string, EvolutionObservability>()

  const service: ServiceStatus = {
    subject: TEST_CONVERSATION_SUBJECT,
    mode: 'attached',
    pid: 4242,
    domain: 'channel',
    heartbeat_at: nowIso(),
    started_at: nowIso(),
    health: 'ok',
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
    attention: { items: [], summary: { count: 0, highest_severity: null } },
    open_cycles: 0,
    evidence_pending_count: 0,
    daemon_task_pending_count: 0,
    ...options.observability
  }

  const stoppedService = !service.pid && (service.mode === 'none' || service.mode === 'stopped')
  const defaultSubjectReadiness = fixtureSubjectReadiness(
    TEST_CONVERSATION_SUBJECT,
    options.subjectReadiness ?? (stoppedService
      ? {
        channel: { state: 'stopped', reasons: ['channel_stopped'] },
        conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
      }
      : {
        channel: { state: service.mode === 'managed' ? 'running' : 'attached', reasons: [service.mode === 'managed' ? 'channel_running' : 'channel_attached'] },
        conversation: { state: 'running', reasons: ['conversation_ready'] }
      }),
    hostKind
  )

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

  const commandCounts = new Map<string, number>()

  const client: JeaClient = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
    async invoke(request) {
      const command = request.command
      commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1)
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
          total: page.length,
          channel_health: {
            status: defaultSubjectReadiness.channel.state === 'blocked' ? 'blocked' : (service.mode === 'none' ? 'idle' : 'healthy'),
            ok: defaultSubjectReadiness.channel.state !== 'blocked',
            reasons: options.channelReasons ?? []
          },
          pipeline_state: pipelines.get(key(subject, sessionId)) ?? {
            status: 'idle',
            message_id: null,
            pending_count: 0,
            failed_count: 0,
            last_error: null
          }
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
        pipelines.set(key(subject, sessionId), {
          status: 'pending',
          message_id: messageId,
          pending_count: 1,
          failed_count: 0,
          last_error: null
        })
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
        const domain = payload.domain === 'cycle' || payload.domain === 'channel' || payload.domain === 'all'
          ? payload.domain
          : 'all'
        started.push(subject)
        startedDomains.push(domain)
        service.mode = domain === 'cycle' ? 'attached' : 'managed'
        service.pid = 4242
        service.domain = domain
        service.health = 'ok'
        service.detail = null
        const next = fixtureSubjectReadiness(subject, {
          channel: domain === 'cycle'
            ? defaultSubjectReadiness.channel
            : { state: 'running', reasons: ['channel_running'] },
          conversation: domain === 'cycle'
            ? defaultSubjectReadiness.conversation
            : { state: 'running', reasons: ['conversation_ready'] },
          cycle: domain === 'channel'
            ? defaultSubjectReadiness.cycle
            : { state: 'running', reasons: ['cycle_running'] }
        }, hostKind)
        subjectReadinessBySubject.set(subject, next)
        Object.assign(defaultSubjectReadiness, next)
        emit('service.status', subject, undefined, { subject, mode: service.mode, domain: service.domain })
        return { ...service, subject }
      }
      if (command === 'service.getReadiness') {
        if (supportDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, supportDelayMs))
        }
        return {
          ...(subjectReadinessBySubject.get(subject) ?? defaultSubjectReadiness),
          subject
        }
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
    startedDomains,
    watched,
    get watchStops() { return watchStops },
    projectionWatch,
    emit,
    commandCount(command: string): number {
      return commandCounts.get(command) ?? 0
    },
    setRejectSend(error: PublicClientError | null) {
      rejectSend = error
    },
    setReadDelay(ms: number) {
      readDelayMs = ms
    },
    setSessions(subject: string, next: ConversationSessionSummary[]) {
      sessions.set(subject, clone(next))
    },
    setSupportDelay(ms: number) {
      supportDelayMs = ms
    },
    setSupport(subject: string, next: {
      service?: Partial<ServiceStatus>
      readiness?: Partial<SetupReadiness>
      subjectReadiness?: Partial<SubjectReadiness>
      observability?: Partial<EvolutionObservability>
    }) {
      if (next.service) {
        serviceBySubject.set(subject, { ...service, ...next.service, subject })
      }
      if (next.readiness) {
        readinessBySubject.set(subject, { ...readiness, ...next.readiness })
      }
      if (next.subjectReadiness) {
        subjectReadinessBySubject.set(subject, fixtureSubjectReadiness(subject, next.subjectReadiness, hostKind))
      }
      if (next.observability) {
        observabilityBySubject.set(subject, { ...observability, ...next.observability, subject })
      }
    },
    appendAssistant(
      subject: string,
      sessionId: string,
      content: string,
      extras: Partial<ConversationMessage> = {},
      notify = true
    ) {
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
      const currentPipeline = pipelines.get(key(subject, sessionId))
      pipelines.set(key(subject, sessionId), {
        status: 'delivered',
        message_id: extras.message_id ?? currentPipeline?.message_id ?? null,
        pending_count: 0,
        failed_count: 0,
        last_error: null
      })
      if (notify) emit('conversation.updated', subject, sessionId, { subject, session_id: sessionId })
    },
    records
  }
}
