import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendDesktopSessionRecord } from '../../../../src/channel/adapters/desktop/index.mjs'
import { runChannelClassifierTask } from '../../../../src/channel/classifier.mjs'
import { runChannelPresenceTask } from '../../../../src/channel/presence.mjs'
import { runChannelNotifyTask } from '../../../../src/channel/tasks.mjs'
import { writeChannelWorkerState, summarizeChannelWorkersState, readChannelWorkerState } from '../../../../src/channel/worker-state.mjs'
import { readWorkerState } from '../../../../src/daemon/daemon-worker-state.mjs'
import {
  createApplicationCommandHost,
  createTypedJeaClient,
  createWebJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION,
  PublicClientError
} from '../../src/client-api'
import type { JeaEventEnvelope } from '../../src/client-api/types'
import type { ServiceProcessPort } from '../../src/client-api/owners/service'
import { ChannelService } from '../../src/main/channel-service'
import { DesktopEventBus } from '../../src/main/event-bus'
import { ProjectionWatcher } from '../../src/main/projection-watcher'
import { ConversationWorkspaceModel } from '../../src/renderer/src/conversation/model'
import { createWebHost } from '../../src/web-host'

const homes: string[] = []
const hosts: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.close().catch(() => {})
  }
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

function writeTestSubjectHome(): { sourceRoot: string; jeaHome: string } {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-conversation-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-conversation-home-'))
  homes.push(jeaHome)
  const namespace = join(jeaHome, 'subjects', 'alpha-data')
  mkdirSync(namespace, { recursive: true })
  writeFileSync(join(namespace, 'SUBJECT.md'), [
    '# alpha',
    '',
    '## Subject',
    'Conversation test subject with desktop Channel enabled.',
    '',
    '## Persona',
    'Concise operator-facing replies. Do not grant approvals.',
    ''
  ].join('\n'), 'utf8')
  writeFileSync(join(namespace, 'SOUL.md'), '# soul\nConcise.\n', 'utf8')
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        policy: 'SUBJECT.md',
        channels: {
          desktop: { enabled: true, default_session: 'main' },
          classifier: { enabled: true, mode: 'deterministic', batch_size: 20 },
          presence: {
            enabled: true,
            planner: 'deterministic',
            default_transport: 'desktop',
            default_target: 'desktop:main'
          }
        }
      }
    }
  }, null, 2))
  return { sourceRoot, jeaHome }
}

function waitForModel(
  model: ConversationWorkspaceModel,
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for conversation model state.'))
    }, timeoutMs)
    const unsubscribe = model.subscribe(() => {
      if (!predicate()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

function fileFingerprint(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function governedPaths(jeaHome: string) {
  const root = join(jeaHome, 'subjects', 'alpha-data')
  return {
    registry: join(jeaHome, 'subjects', 'registry.json'),
    pendingDecisions: join(root, 'data', 'evolution', 'pending_decisions.json'),
    standingMemory: join(root, 'data', 'intelligence', 'standing_memory.json')
  }
}

function createChannelOnlyPort(runtime: { sourceRoot: string; jeaHome: string }): {
  port: ServiceProcessPort
  startedDomains: Array<'all' | 'cycle' | 'channel'>
} {
  const startedDomains: Array<'all' | 'cycle' | 'channel'> = []
  const port: ServiceProcessPort = {
    get(subject) {
      const channel = summarizeChannelWorkersState(readChannelWorkerState(runtime, subject))
      const running = channel.running_count > 0
      return {
        subject,
        mode: running ? 'managed' : 'none',
        pid: running ? Number(channel.coordinator?.pid ?? process.pid) : null,
        domain: running ? 'channel' : null,
        heartbeat_at: channel.roles[0]?.heartbeat_at ?? null,
        started_at: channel.roles[0]?.started_at ?? null,
        health: running ? 'ok' : 'idle',
        detail: null
      }
    },
    async start(subject, options) {
      const domain = options?.domain ?? 'all'
      startedDomains.push(domain)
      if (domain !== 'channel') {
        throw new PublicClientError('INVALID_REQUEST', 'This fixture starts only the Channel domain.')
      }
      const now = new Date().toISOString()
      writeChannelWorkerState(runtime, subject, {
        subject,
        domain: 'channel',
        schema_version: 2,
        workers: {
          classifier: {
            role: 'classifier',
            worker_id: 'channel-recovery-classifier',
            pid: process.pid,
            status: 'running',
            started_at: now,
            heartbeat_at: now,
            stale_after_ms: 60_000
          }
        },
        coordinator: { pid: process.pid, started_at: now },
        worker_id: null,
        pid: process.pid,
        status: 'running',
        started_at: now,
        heartbeat_at: now,
        stale_after_ms: 60_000
      })
      return this.get(subject)
    },
    stop() {
      throw new PublicClientError('UNAVAILABLE', 'Stop is not part of this recovery fixture.')
    },
    repair() {
      throw new PublicClientError('UNAVAILABLE', 'Repair is not part of this recovery fixture.')
    }
  }
  return { port, startedDomains }
}

describe('governed local Channel conversation E2E', () => {
  it('sends through JeaClient and persists an assistant record after classifier/presence/speech', async () => {
    const { sourceRoot, jeaHome } = writeTestSubjectHome()
    process.env.JEA_HOME = jeaHome
    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })

    await client.initData('alpha')
    const subject = await client.getSubject('alpha')
    expect(subject.desktopChannelEnabled).toBe(true)

    const model = new ConversationWorkspaceModel(client)
    await model.bootstrap('alpha')
    model.setDraft('同意发布候选')
    await model.send()

    const sent = model.getSnapshot().lastSend
    expect(sent).toMatchObject({
      subject: 'alpha',
      session_id: 'main',
      duplicate: false
    })
    expect(model.getSnapshot().records.every((record) => record.role === 'user')).toBe(true)

    const classified = await runChannelClassifierTask(host.runtime, 'alpha')
    expect(classified.classified).toBeGreaterThan(0)
    const presence = await runChannelPresenceTask(host.runtime, 'alpha')
    expect(presence.plan?.kind ?? presence.skipped).toBeTruthy()
    await runChannelNotifyTask(host.runtime, 'alpha')

    const page = await client.readMessages('alpha', 'main', { tail: 20 })
    expect(page.records[0]).toMatchObject({ role: 'user', content: '同意发布候选' })
    expect(page.records.some((record) => record.role === 'assistant')).toBe(true)
    expect(page.records.filter((record) => record.role === 'assistant')
      .every((record) => record.content.trim().length > 0)).toBe(true)
    expect(JSON.stringify(page)).not.toMatch(/approval_granted/)
  })

  it('refreshes the active conversation after async assistant delivery', async () => {
    const { sourceRoot, jeaHome } = writeTestSubjectHome()
    process.env.JEA_HOME = jeaHome
    const events = new DesktopEventBus()
    const listeners = new Set<(event: JeaEventEnvelope) => void>()
    events.subscribe((event) => {
      for (const listener of listeners) listener(event)
    })
    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
    const published: Array<{ type: string; session_id?: string }> = []
    events.subscribe((event) => published.push({ type: event.type, session_id: event.session_id }))
    const callbackRef: { current?: (event: { reason: string; partitions?: string[] }) => void } = {}
    const opsRefresh = vi.fn(() => [{
      subject: { name: 'alpha' },
      daemon: { worker: { running: true, pid: 11 }, health: { status: 'healthy', ok: true }, tasks: { counts: { pending: 0 } } },
      observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 0 }, open_cycles: 0 }
    }])
    const todoGet = vi.fn(() => ({
      subject: 'alpha',
      questions: [],
      briefs: [],
      facts: [],
      goals: null,
      pending_cycle_request: null,
      attention: {}
    }))
    const channel = new ChannelService(sourceRoot, jeaHome)
    const projection = new ProjectionWatcher(
      sourceRoot,
      { refresh: opsRefresh } as any,
      { get: todoGet } as any,
      channel,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any,
      jeaHome
    )

    await client.initData('alpha')
    const model = new ConversationWorkspaceModel(client)
    await model.bootstrap('alpha')
    model.setDraft('hello from desktop')
    await model.send()
    expect(model.getSnapshot().waiting).toBe(true)
    expect(model.getSnapshot().records.every((record) => record.role === 'user')).toBe(true)
    await client.createSession('alpha', 'other')

    projection.watch('alpha')
    callbackRef.current?.({ reason: 'watch', partitions: ['all'] })
    published.length = 0
    const opsAfterSeed = opsRefresh.mock.calls.length
    const todoAfterSeed = todoGet.mock.calls.length
    const readsAfterSeed = model.getSnapshot().records.length

    appendDesktopSessionRecord(host.runtime, 'alpha', 'main', {
      role: 'assistant',
      direction: 'outbound',
      content: 'async delivered reply'
    })
    appendDesktopSessionRecord(host.runtime, 'alpha', 'other', {
      role: 'assistant',
      direction: 'outbound',
      content: 'reply for another session'
    })
    callbackRef.current?.({ reason: 'watch', partitions: ['conversation'] })

    expect(opsRefresh).toHaveBeenCalledTimes(opsAfterSeed)
    expect(todoGet).toHaveBeenCalledTimes(todoAfterSeed)
    expect(published.map((item) => item.type)).toEqual(['conversation.updated', 'conversation.updated'])
    expect(published.map((item) => item.session_id).sort()).toEqual(['main', 'other'])
    expect(published.some((item) => item.type === 'projection.ops_updated')).toBe(false)
    expect(published.some((item) => item.type === 'evolution.updated')).toBe(false)

    await waitForModel(model, () => (
      model.getSnapshot().records.some((record) => record.content === 'async delivered reply')
      && model.getSnapshot().waiting === false
    ))
    const snapshot = model.getSnapshot()
    expect(snapshot.records.some((record) => record.role === 'assistant')).toBe(true)
    expect(snapshot.records.some((record) => record.content === 'async delivered reply')).toBe(true)
    expect(snapshot.records.some((record) => record.content === 'reply for another session')).toBe(false)
    expect(snapshot.records.every((record) => record.session_id === 'main')).toBe(true)
    expect(snapshot.records.length).toBeGreaterThan(readsAfterSeed)
    expect(JSON.stringify(snapshot.records)).not.toMatch(/approval_granted/)
    projection.stop()
  })

  it('recovers from Channel stopped without starting Cycle or mutating governed files', async () => {
    const { sourceRoot, jeaHome } = writeTestSubjectHome()
    process.env.JEA_HOME = jeaHome
    const { port, startedDomains } = createChannelOnlyPort({ sourceRoot, jeaHome })
    const host = createApplicationCommandHost({
      sourceRoot,
      jeaHome,
      hostKind: 'electron',
      serviceProcess: port
    })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })

    await client.initData('alpha')
    const paths = governedPaths(jeaHome)
    const before = {
      registry: fileFingerprint(paths.registry),
      standingMemory: fileFingerprint(paths.standingMemory)
    }

    const beforeReadiness = await client.getServiceReadiness('alpha')
    expect(beforeReadiness.channel).toEqual({ state: 'stopped', reasons: ['channel_stopped'] })
    expect(beforeReadiness.cycle.state).toBe('stopped')
    expect(beforeReadiness.conversation).toEqual({
      state: 'blocked',
      reasons: ['conversation_blocked_channel']
    })
    expect(beforeReadiness.allowed_actions).toContain('start_channel')

    const model = new ConversationWorkspaceModel(client)
    await model.bootstrap('alpha')
    expect(model.getSnapshot().subjectReadiness?.allowed_actions).toContain('start_channel')
    expect(model.getSnapshot().cards.some((card) => card.kind === 'offline')).toBe(true)

    const startedAt = Date.now()
    await model.startChannelService()
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(startedDomains).toEqual(['channel'])
    expect(model.getSnapshot().service?.domain).toBe('channel')

    const workers = summarizeChannelWorkersState(readChannelWorkerState(host.runtime, 'alpha'))
    expect(workers.fresh_count).toBeGreaterThanOrEqual(1)
    expect(workers.roles.some((role: { role: string; fresh: boolean }) => (
      role.role === 'classifier' && role.fresh
    ))).toBe(true)
    expect(readWorkerState(host.runtime, 'alpha')?.status ?? 'stopped').not.toBe('running')

    const afterStart = await client.getServiceReadiness('alpha')
    expect(afterStart.channel.state).toBe('running')
    expect(afterStart.cycle.state).toBe('stopped')
    expect(afterStart.conversation.state).toBe('running')
    expect(afterStart.allowed_actions).not.toContain('start_channel')

    model.setDraft('同意发布候选')
    const sendStarted = Date.now()
    await model.send()
    expect(model.getSnapshot().records.every((record) => record.role === 'user')).toBe(true)

    const classified = await runChannelClassifierTask(host.runtime, 'alpha')
    expect(classified.classified).toBeGreaterThan(0)
    const presence = await runChannelPresenceTask(host.runtime, 'alpha')
    expect(presence.plan?.kind ?? presence.skipped).toBeTruthy()
    await runChannelNotifyTask(host.runtime, 'alpha')
    expect(Date.now() - sendStarted).toBeLessThan(30_000)

    await model.bootstrap('alpha')
    const snapshot = model.getSnapshot()
    expect(snapshot.records.some((record) => record.role === 'assistant')).toBe(true)
    expect(snapshot.records.filter((record) => record.role === 'assistant')
      .every((record) => record.content.trim().length > 0)).toBe(true)
    expect(snapshot.records.every((record) => record.session_id === 'main')).toBe(true)
    expect(JSON.stringify(snapshot.records)).not.toMatch(/approval_granted/)

    const page = await client.readMessages('alpha', 'main', { tail: 20 })
    expect(page.subject).toBe('alpha')
    expect(page.session_id).toBe('main')
    expect(page.records.some((record) => record.role === 'assistant')).toBe(true)

    expect(fileFingerprint(paths.registry)).toBe(before.registry)
    expect(fileFingerprint(paths.standingMemory)).toBe(before.standingMemory)
    if (existsSync(paths.pendingDecisions)) {
      const decisions = readFileSync(paths.pendingDecisions, 'utf8')
      expect(decisions).not.toMatch(/approval_granted/)
    }
    expect(JSON.stringify(page)).not.toMatch(/approval_granted/)
  })

  it('rejects Channel lifecycle mutation on Web with COMMAND_NOT_ALLOWED', async () => {
    const { sourceRoot, jeaHome } = writeTestSubjectHome()
    process.env.JEA_HOME = jeaHome
    const commandHost = createApplicationCommandHost({ sourceRoot, jeaHome, hostKind: 'web' })
    const token = `${'a'.repeat(32)}conversation-web-token`
    const host = await createWebHost({
      sourceRoot,
      jeaHome,
      token,
      port: 0,
      commandHost
    })
    hosts.push(host)
    const client = createWebJeaClient({ baseUrl: host.origin, token })
    const readiness = await client.getServiceReadiness('alpha')
    expect(readiness.channel.state).toBe('stopped')
    expect(readiness.allowed_actions).toEqual(['open_desktop'])
    await expect(client.startService('alpha', 'channel')).rejects.toMatchObject({
      name: 'PublicCommandError',
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available on the Web host.'
    })
  })
})
