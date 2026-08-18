import { createHash } from 'node:crypto'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { createRuntimeWatcher } from '../../../../src/intelligence/evolution-viewer/runtime-watch.mjs'
import { redactPublicValue } from '../client-api/redact'
import type { SubjectSnapshot, TodoSnapshot } from '../shared/contract'
import type { DesktopEventBus } from './event-bus'
import type { ChannelService } from './channel-service'
import type { OpsService } from './operations'
import type { TodoService } from './todo-service'
import { createDesktopServiceRuntimeContext } from './runtime-context'

interface RuntimeWatcher {
  start(): void
  stop(): void
  notify(reason?: string): void
  getWatchedPaths?(): string[]
}

export interface ProjectionWatcherFactoryOptions {
  runtimeRoot: string
  projectRoot: string
  subjectMeta: { subject: string; namespace: string }
  watchSubjectsJson: boolean
  includeOperator: boolean
  includeDesktopSessions: boolean
  debounceMs?: number
  onRuntimeChange: (event: { reason: string }) => void
}

type WatcherFactory = (options: ProjectionWatcherFactoryOptions) => RuntimeWatcher

export interface ProjectionWatchStatus {
  subject: string | null
  watching: boolean
  watcherCount: number
  watchedPathCount: number
  generation: number
  revision: number
}

const SENSITIVE_KEY = /(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|authorization|owner[_-]?token|web[_-]?token)/i
const MESSAGE_CONTENT_KEY = /^(content|text|body|message|prompt|messages)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function publicPayload(value: Record<string, unknown>): Record<string, unknown> {
  return redactPublicValue(stripUnsafeFields(value)) as Record<string, unknown>
}

function stripUnsafeFields(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => stripUnsafeFields(item, seen))
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_KEY.test(key) && !MESSAGE_CONTENT_KEY.test(key))
    .map(([key, child]) => [key, stripUnsafeFields(child, seen)])
  return Object.fromEntries(entries)
}

function publicServiceView(subject: string, snapshot: SubjectSnapshot | undefined): Record<string, unknown> {
  const supervisor: Record<string, unknown> = isRecord(snapshot?.supervisor)
    ? snapshot.supervisor as Record<string, unknown>
    : {}
  const daemon: Record<string, unknown> = isRecord(snapshot?.daemon) ? snapshot.daemon : {}
  const worker: Record<string, unknown> = isRecord(daemon.worker) ? daemon.worker : {}
  const health: Record<string, unknown> = isRecord(daemon.health) ? daemon.health : {}
  return {
    subject,
    mode: asString(supervisor.mode) ?? (asBoolean(worker.running) ? 'attached' : 'none'),
    pid: asNumber(supervisor.pid) ?? asNumber(worker.pid),
    domain: asString(supervisor.domain),
    heartbeat_at: asString(supervisor.heartbeat_at) ?? asString(worker.heartbeat_at),
    started_at: asString(supervisor.started_at) ?? asString(worker.started_at),
    health: asString(supervisor.mode) === 'stale' ? 'stale' : asString(health.status),
    detail: asString(supervisor.detail) ?? (health.ok === false ? 'Service is unhealthy.' : null)
  }
}

function publicEvolutionView(
  subject: string,
  snapshot: SubjectSnapshot | undefined,
  todo: TodoSnapshot | undefined
): Record<string, unknown> {
  const observability = isRecord(snapshot?.observability) ? snapshot.observability : {}
  const attention = isRecord(observability.attention) ? observability.attention : {}
  const daemon = isRecord(snapshot?.daemon) ? snapshot.daemon : {}
  const tasks = isRecord(daemon.tasks) && isRecord(daemon.tasks.counts) ? daemon.tasks.counts : {}
  const todoAttention = isRecord(todo?.attention) ? todo.attention : {}
  return {
    subject,
    open_cycles: asNumber(observability.open_cycles) ?? 0,
    attention_count: asNumber(attention.count) ?? 0,
    cycle_id: asString(attention.cycle_id),
    cycle_status: asString(attention.cycle_status),
    backlog_count: asNumber(tasks.pending) ?? asNumber(todoAttention.pending_count) ?? 0,
    health: asString(isRecord(daemon.health) ? daemon.health.status : null)
  }
}

function publicChannelView(subject: string, channel: unknown): Record<string, unknown> {
  const snapshot = isRecord(channel) ? channel : {}
  const projection = isRecord(snapshot.projection) ? snapshot.projection : {}
  const worker = isRecord(projection.worker) ? projection.worker : {}
  const health = isRecord(projection.health) ? projection.health : {}
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  const status = asString(worker.status) ?? asString(health.status)
  const running = asBoolean(worker.running) || status === 'running'
  const blocked = asBoolean(worker.blocked)
    || asBoolean(projection.blocked)
    || status === 'blocked'
    || asString(health.status) === 'blocked'
  const reasons = Array.isArray(health.reasons)
    ? health.reasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  return {
    subject,
    running,
    blocked,
    stopped: !running && !blocked,
    health: blocked ? 'blocked' : running ? 'running' : (status ?? 'stopped'),
    reasons,
    session_count: sessions.length
  }
}

function fingerprintValue(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value ?? null)).digest('hex')
}

function mergePartitions(current: string[] | undefined, incoming: string[] | undefined): string[] {
  const next = new Set([...(current ?? []), ...(incoming ?? [])])
  if (next.size === 0 || next.has('all')) return ['all']
  return [...next]
}

type PartitionFingerprints = {
  service: string
  evolution: string
  todo: string
  channel: string
}

export class ProjectionWatcher {
  private activeSubject: string | null = null
  private watcher: RuntimeWatcher | null = null
  private revision = 0
  private watchGeneration = 0
  private refreshInFlight = false
  private refreshDirty = false
  private pendingReason = 'watch'
  private pendingPartitions: string[] = []
  private lastFingerprints: PartitionFingerprints | null = null
  private readonly runtimeContext: any
  private readonly debounceMs: number

  constructor(
    private readonly projectRoot: string,
    private readonly ops: OpsService,
    private readonly todo: TodoService,
    private readonly channel: ChannelService,
    private readonly events: DesktopEventBus,
    private readonly watcherFactory: WatcherFactory = createRuntimeWatcher as unknown as WatcherFactory,
    jeaHome: string | undefined = process.env.JEA_HOME,
    options: { debounceMs?: number } = {}
  ) {
    this.runtimeContext = createDesktopServiceRuntimeContext(projectRoot, jeaHome)
    this.debounceMs = options.debounceMs ?? 1000
  }

  status(): ProjectionWatchStatus {
    return {
      subject: this.activeSubject,
      watching: Boolean(this.watcher),
      watcherCount: this.watcher ? 1 : 0,
      watchedPathCount: this.watcher?.getWatchedPaths?.().length ?? 0,
      generation: this.watchGeneration,
      revision: this.revision
    }
  }

  watch(subject: string): { subject: string; watching: true } {
    this.ops.refresh(subject)
    if (this.activeSubject === subject && this.watcher) {
      return { subject, watching: true }
    }
    this.stop()
    const runtime = runtimeForSubject(this.runtimeContext, subject)
    const generation = ++this.watchGeneration
    this.activeSubject = subject
    try {
      this.watcher = this.watcherFactory({
        runtimeRoot: runtime.runtimeRoot,
        projectRoot: this.projectRoot,
        subjectMeta: { subject, namespace: runtime.dataNamespace },
        watchSubjectsJson: false,
        includeOperator: true,
        includeDesktopSessions: true,
        debounceMs: this.debounceMs,
        onRuntimeChange: ({ reason, partitions }: { reason: string; partitions?: string[] }) => {
          this.publish(subject, reason, generation, partitions)
        }
      })
      this.watcher.start()
    } catch {
      this.watcher = null
      this.publishFailure(subject, 'watch_failed', generation)
    }
    return { subject, watching: true }
  }

  refresh(): void {
    this.watcher?.notify('manual')
  }

  stop(): { stopped: boolean } {
    const stopped = Boolean(this.watcher)
    try {
      this.watcher?.stop()
    } catch {
      // Watcher stop must remain idempotent during workspace/app teardown.
    }
    this.watcher = null
    this.activeSubject = null
    this.refreshInFlight = false
    this.refreshDirty = false
    this.pendingPartitions = []
    this.lastFingerprints = null
    this.watchGeneration += 1
    this.revision += 1
    return { stopped }
  }

  private isCurrent(subject: string, generation: number): boolean {
    return this.activeSubject === subject && this.watchGeneration === generation && Boolean(this.watcher)
  }

  private publish(
    subject: string,
    reason: string,
    generation: number,
    partitions: string[] = ['all']
  ): void {
    if (!this.isCurrent(subject, generation)) return
    if (this.refreshInFlight) {
      this.refreshDirty = true
      this.pendingReason = reason
      this.pendingPartitions = mergePartitions(this.pendingPartitions, partitions)
      return
    }
    this.refreshInFlight = true
    try {
      this.publishOnce(subject, reason, generation, partitions)
    } finally {
      this.refreshInFlight = false
    }
    if (this.refreshDirty && this.isCurrent(subject, generation)) {
      this.refreshDirty = false
      const followReason = this.pendingReason
      const followPartitions = this.pendingPartitions
      this.pendingPartitions = []
      this.publish(subject, followReason, generation, followPartitions)
    }
  }

  private publishOnce(
    subject: string,
    reason: string,
    generation: number,
    partitions: string[]
  ): void {
    const revision = ++this.revision
    try {
      const snapshot = this.ops.refresh(subject)[0] as SubjectSnapshot | undefined
      const todo = this.todo.get(subject) as TodoSnapshot
      const channel = this.channel.get(subject)
      if (!this.isCurrent(subject, generation)) return
      const service = publicServiceView(subject, snapshot)
      const evolution = publicEvolutionView(subject, snapshot, todo)
      const channelHealth = publicChannelView(subject, channel)
      const todoView = {
        subject: todo.subject,
        questions: todo.questions,
        briefs: todo.briefs,
        facts: todo.facts,
        goals: todo.goals,
        pending_cycle_request: todo.pending_cycle_request,
        attention: todo.attention
      }
      const fingerprints: PartitionFingerprints = {
        service: fingerprintValue(service),
        evolution: fingerprintValue(evolution),
        todo: fingerprintValue(todoView),
        channel: fingerprintValue(channelHealth)
      }
      const previous = this.lastFingerprints
      const first = previous == null
      const serviceChanged = first || fingerprints.service !== previous.service
      const evolutionChanged = first || fingerprints.evolution !== previous.evolution
      const todoChanged = first || fingerprints.todo !== previous.todo
      const channelChanged = first || fingerprints.channel !== previous.channel
      this.lastFingerprints = fingerprints
      if (!first && !serviceChanged && !evolutionChanged && !todoChanged && !channelChanged) {
        this.revision -= 1
        return
      }
      void partitions
      const publishService = serviceChanged
      const publishEvolution = evolutionChanged
      const publishTodo = todoChanged
      const publishChannel = channelChanged
      if (publishService) {
        this.events.publish({
          type: 'projection.ops_updated',
          subject,
          payload: publicPayload({ snapshot: service, reason, revision, evolution })
        })
        this.events.publish({
          type: 'service.status',
          subject,
          payload: publicPayload({ ...service, reason, revision })
        })
      }
      if (publishTodo) {
        this.events.publish({
          type: 'projection.todo_updated',
          subject,
          payload: publicPayload({
            snapshot: todoView,
            reason,
            revision,
            evolution
          })
        })
      }
      if (publishEvolution) {
        this.events.publish({
          type: 'evolution.updated',
          subject,
          payload: publicPayload({
            subject,
            reason,
            revision,
            cycle_id: evolution.cycle_id,
            cycle_status: evolution.cycle_status,
            backlog_count: evolution.backlog_count,
            health: evolution.health
          })
        })
      }
      if (publishChannel) {
        this.events.publish({
          type: 'projection.channel_updated',
          subject,
          payload: publicPayload({ reason, revision, channel: channelHealth })
        })
      }
    } catch {
      this.publishFailure(subject, reason, generation, revision)
    }
  }

  private publishFailure(
    subject: string,
    reason: string,
    generation: number,
    revision = this.revision
  ): void {
    if (this.activeSubject !== subject || this.watchGeneration !== generation) return
    const payload = publicPayload({ reason, revision, stale: true })
    this.events.publish({
      type: 'projection.refresh_failed',
      subject,
      payload
    })
    this.events.publish({
      type: 'evolution.updated',
      subject,
      payload: publicPayload({ subject, reason, revision, stale: true })
    })
  }
}
