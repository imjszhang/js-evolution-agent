import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopEventBus } from '../src/main/event-bus'
import { ProjectionWatcher } from '../src/main/projection-watcher'

function projectRoot(subjects = ['alpha', 'beta']): string {
  const root = mkdtempSync(join(tmpdir(), 'jea-desktop-projection-'))
  const registrySubjects = Object.fromEntries(subjects.map((name) => [name, { data_namespace: `${name}-data` }]))
  mkdirSync(join(root, 'runtime', 'subjects'), { recursive: true })
  for (const name of subjects) {
    mkdirSync(join(root, 'runtime', 'subjects', `${name}-data`, 'data', 'evolution'), { recursive: true })
    mkdirSync(join(root, 'runtime', 'subjects', `${name}-data`, 'data', 'channel'), { recursive: true })
  }
  writeFileSync(join(root, 'runtime', 'subjects', 'registry.json'), JSON.stringify({
    default_subject: subjects[0],
    subjects: registrySubjects
  }))
  return root
}

function fdCount(): number | null {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return null
  }
}

describe('ProjectionWatcher', () => {
  it('publishes typed ops and todo snapshots and stops prior subject watchers', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    const stop = vi.fn()
    const callbackRef: { current?: (event: { reason: string }) => void } = {}
    const watcherFactory = vi.fn((options: any) => {
      callbackRef.current = options.onRuntimeChange
      return { start: vi.fn(), stop, notify: vi.fn(), getWatchedPaths: () => ['/tmp/watch'] }
    })
    const ops = {
      refresh: vi.fn(() => [{
        subject: { name: 'alpha', namespace: 'alpha-data', isDefault: true },
        daemon: { worker: { running: true, pid: 11 }, health: { status: 'healthy', ok: true }, tasks: { counts: { pending: 2 } } },
        observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 1 }, open_cycles: 0 }
      }])
    }
    const todo = {
      get: vi.fn(() => ({
        subject: 'alpha',
        questions: [],
        briefs: [],
        facts: [],
        goals: null,
        pending_cycle_request: null,
        attention: {}
      }))
    }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      todo as any,
      { get: vi.fn(() => ({ subject: 'alpha', projection: { worker: { running: true } }, sessions: [], inbound: {} })) } as any,
      events,
      watcherFactory as any
    )

    expect(projection.watch('alpha')).toEqual({ subject: 'alpha', watching: true })
    expect(projection.status()).toMatchObject({ subject: 'alpha', watching: true, watcherCount: 1 })
    callbackRef.current?.({ reason: 'watch' })
    expect(published).toEqual([
      'projection.ops_updated',
      'service.status',
      'projection.todo_updated',
      'evolution.updated',
      'projection.channel_updated'
    ])
    expect(ops.refresh).toHaveBeenCalledTimes(2)
    expect(projection.stop()).toEqual({ stopped: true })
    expect(stop).toHaveBeenCalledOnce()
    expect(projection.status().watcherCount).toBe(0)
  })

  it('publishes a safe failure event when rebuilding a projection fails', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    events.subscribe((event) => published.push({ type: event.type, payload: event.payload }))
    const callbackRef: { current?: (event: { reason: string }) => void } = {}
    const ops = {
      refresh: vi.fn()
        .mockReturnValueOnce([{ subject: { name: 'alpha' } }])
        .mockImplementationOnce(() => { throw new Error('DEEPSEEK_API_KEY=sk-secret owner_token=abc') })
    }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      { get: vi.fn() } as any,
      { get: vi.fn() } as any,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    callbackRef.current?.({ reason: 'reconcile' })
    expect(published.map((item) => item.type)).toEqual(['projection.refresh_failed', 'evolution.updated'])
    const dumped = JSON.stringify(published)
    expect(dumped).not.toContain('sk-secret')
    expect(dumped).not.toContain('owner_token')
    expect(dumped).not.toContain('DEEPSEEK_API_KEY')
    expect(published[0]?.payload).toMatchObject({ stale: true, reason: 'reconcile' })
  })

  it('retargets the previous watch before a new subject can apply and ignores late events', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: Array<{ type: string; subject?: string }> = []
    events.subscribe((event) => published.push({ type: event.type, subject: event.subject }))
    const callbacks = new Map<string, (event: { reason: string }) => void>()
    const stops: string[] = []
    const watcherFactory = vi.fn((options: any) => {
      const subject = options.subjectMeta.subject
      callbacks.set(subject, options.onRuntimeChange)
      return {
        start: vi.fn(),
        stop: vi.fn(() => { stops.push(subject) }),
        notify: vi.fn()
      }
    })
    const ops = {
      refresh: vi.fn((subject: string) => [{
        subject: { name: subject },
        daemon: {},
        observability: { attention: { cycle_status: subject === 'alpha' ? 'failed' : 'completed' } }
      }])
    }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      { get: vi.fn((subject: string) => ({ subject, questions: [], briefs: [], facts: [], goals: null, pending_cycle_request: null, attention: {} })) } as any,
      { get: vi.fn((subject: string) => ({ subject, projection: {}, sessions: [], inbound: {} })) } as any,
      events,
      watcherFactory as any
    )

    projection.watch('alpha')
    projection.watch('beta')
    expect(stops).toEqual(['alpha'])
    expect(projection.status()).toMatchObject({ subject: 'beta', watcherCount: 1 })
    const before = published.length
    callbacks.get('alpha')?.({ reason: 'late' })
    expect(published.slice(before)).toEqual([])
    callbacks.get('beta')?.({ reason: 'watch' })
    expect(published.slice(before).some((item) => item.type === 'evolution.updated' && item.subject === 'beta')).toBe(true)
  })

  it('keeps one watcher after ten subject switches and does not grow file handles', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const live: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
    const watcherFactory = vi.fn(() => {
      const handle = { start: vi.fn(), stop: vi.fn(), notify: vi.fn(), getWatchedPaths: () => ['a'] }
      live.push(handle)
      return handle
    })
    const ops = { refresh: vi.fn((subject: string) => [{ subject: { name: subject }, daemon: {}, observability: {} }]) }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      { get: vi.fn((subject: string) => ({ subject, questions: [], briefs: [], facts: [], goals: null, pending_cycle_request: null, attention: {} })) } as any,
      { get: vi.fn((subject: string) => ({ subject, projection: {}, sessions: [], inbound: {} })) } as any,
      events,
      watcherFactory as any
    )

    projection.watch('alpha')
    const baseline = { watchers: projection.status().watcherCount, fds: fdCount() }
    for (let index = 0; index < 10; index += 1) {
      projection.watch(index % 2 === 0 ? 'beta' : 'alpha')
    }
    const final = { watchers: projection.status().watcherCount, fds: fdCount() }
    expect(final.watchers).toBe(1)
    expect(final.watchers).toBe(baseline.watchers)
    expect(live.filter((item) => item.stop.mock.calls.length === 0)).toHaveLength(1)
    if (baseline.fds != null && final.fds != null) {
      expect(final.fds).toBeLessThanOrEqual(baseline.fds + 2)
    }
    projection.stop()
    expect(projection.status().watcherCount).toBe(0)
  })

  it('omits secrets and conversation message content from live event payloads', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: unknown[] = []
    events.subscribe((event) => published.push(event))
    const callbackRef: { current?: (event: { reason: string }) => void } = {}
    const projection = new ProjectionWatcher(
      root,
      {
        refresh: vi.fn(() => [{
          subject: { name: 'alpha' },
          daemon: { health: { status: 'healthy' }, api_key: 'sk-live', owner_token: 'own' },
          observability: { attention: { cycle_status: 'completed' } }
        }])
      } as any,
      {
        get: vi.fn(() => ({
          subject: 'alpha',
          questions: [{ id: 'q1', question: 'Need a decision?' }],
          briefs: [],
          facts: [],
          goals: null,
          pending_cycle_request: null,
          attention: {},
          access_token: 'web-token'
        }))
      } as any,
      {
        get: vi.fn(() => ({
          subject: 'alpha',
          projection: { worker: { running: false, blocked: true } },
          sessions: [],
          inbound: { processed: [{ content: 'secret user message', text: 'hello' }] }
        }))
      } as any,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    callbackRef.current?.({ reason: 'watch' })
    const dumped = JSON.stringify(published)
    expect(dumped).not.toContain('sk-live')
    expect(dumped).not.toContain('own')
    expect(dumped).not.toContain('web-token')
    expect(dumped).not.toContain('secret user message')
    expect(dumped).not.toMatch(/"content":"hello"/)
    expect(published.some((event: any) => event.type === 'evolution.updated' && event.payload.cycle_status === 'completed')).toBe(true)
    expect(published.some((event: any) => event.type === 'projection.channel_updated' && event.payload.channel.blocked === true)).toBe(true)
  })

  it('does not republish when public snapshots are unchanged', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    const callbackRef: { current?: (event: { reason: string }) => void } = {}
    const projection = new ProjectionWatcher(
      root,
      {
        refresh: vi.fn(() => [{
          subject: { name: 'alpha' },
          daemon: { worker: { running: true, pid: 11 }, health: { status: 'healthy', ok: true }, tasks: { counts: { pending: 0 } } },
          observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 1 }, open_cycles: 0 }
        }])
      } as any,
      { get: vi.fn(() => ({ subject: 'alpha', questions: [], briefs: [], facts: [], goals: null, pending_cycle_request: null, attention: {} })) } as any,
      { get: vi.fn(() => ({ subject: 'alpha', projection: { worker: { running: true } }, sessions: [], inbound: {} })) } as any,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    callbackRef.current?.({ reason: 'watch' })
    const afterFirst = published.length
    expect(afterFirst).toBe(5)
    callbackRef.current?.({ reason: 'watch' })
    expect(published.length).toBe(afterFirst)
  })

  it('publishes only service/channel events when those snapshots change', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: Array<{ type: string; revision?: number }> = []
    events.subscribe((event) => published.push({
      type: event.type,
      revision: typeof event.payload?.revision === 'number' ? event.payload.revision : undefined
    }))
    const callbackRef: { current?: (event: { reason: string; partitions?: string[] }) => void } = {}
    let heartbeat = 't1'
    const projection = new ProjectionWatcher(
      root,
      {
        refresh: vi.fn(() => [{
          subject: { name: 'alpha' },
          daemon: {
            worker: { running: true, pid: 11, heartbeat_at: heartbeat },
            health: { status: 'healthy', ok: true },
            tasks: { counts: { pending: 2 } }
          },
          observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 1 }, open_cycles: 0 }
        }])
      } as any,
      { get: vi.fn(() => ({ subject: 'alpha', questions: [], briefs: [], facts: [], goals: null, pending_cycle_request: null, attention: {} })) } as any,
      { get: vi.fn(() => ({ subject: 'alpha', projection: { worker: { running: true, heartbeat_at: heartbeat } }, sessions: [], inbound: {} })) } as any,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    callbackRef.current?.({ reason: 'watch', partitions: ['service'] })
    published.length = 0
    heartbeat = 't2'
    callbackRef.current?.({ reason: 'watch', partitions: ['service'] })
    expect(published.map((item) => item.type)).toEqual([
      'projection.ops_updated',
      'service.status'
    ])
    expect(new Set(published.map((item) => item.revision)).size).toBe(1)
  })

  it('publishes a channel update when only the channel snapshot changes', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    const callbackRef: { current?: (event: { reason: string; partitions?: string[] }) => void } = {}
    let channelSessionCount = 0
    const opsRefresh = vi.fn(() => [{
      subject: { name: 'alpha' },
      daemon: {
        worker: { running: true, pid: 11, heartbeat_at: 'cycle-t1' },
        health: { status: 'healthy', ok: true },
        tasks: { counts: { pending: 0 } }
      },
      observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 1 }, open_cycles: 0 }
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
    const projection = new ProjectionWatcher(
      root,
      { refresh: opsRefresh } as any,
      { get: todoGet } as any,
      {
        get: vi.fn(() => ({
          subject: 'alpha',
          projection: { worker: { running: true } },
          sessions: Array.from({ length: channelSessionCount }, (_, index) => ({ session_id: `session-${index}` })),
          inbound: {}
        }))
      } as any,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    callbackRef.current?.({ reason: 'watch', partitions: ['channel'] })
    published.length = 0
    const opsCalls = opsRefresh.mock.calls.length
    const todoCalls = todoGet.mock.calls.length

    channelSessionCount = 1
    callbackRef.current?.({ reason: 'watch', partitions: ['channel'] })

    expect(published).toEqual(['projection.channel_updated'])
    expect(opsRefresh).toHaveBeenCalledTimes(opsCalls)
    expect(todoGet).toHaveBeenCalledTimes(todoCalls)
  })

  it('single-flights a burst and follows up once when refresh dirties itself', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    const callbackRef: { current?: (event: { reason: string }) => void } = {}
    let refreshCount = 0
    const ops = {
      refresh: vi.fn(() => {
        refreshCount += 1
        if (refreshCount === 2) {
          callbackRef.current?.({ reason: 'nested' })
          callbackRef.current?.({ reason: 'nested' })
        }
        return [{
          subject: { name: 'alpha' },
          daemon: {
            worker: { running: true, pid: refreshCount },
            health: { status: 'healthy', ok: true },
            tasks: { counts: { pending: 0 } }
          },
          observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 1 }, open_cycles: 0 }
        }]
      })
    }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      { get: vi.fn(() => ({ subject: 'alpha', questions: [], briefs: [], facts: [], goals: null, pending_cycle_request: null, attention: {} })) } as any,
      { get: vi.fn(() => ({ subject: 'alpha', projection: { worker: { running: true } }, sessions: [], inbound: {} })) } as any,
      events,
      ((options: any) => {
        callbackRef.current = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    expect(refreshCount).toBe(1)
    callbackRef.current?.({ reason: 'watch' })
    expect(refreshCount).toBe(3)
    expect(published.filter((type) => type === 'service.status').length).toBe(2)
  })

  it('publishes a follow-up after a deferred projection rebuild', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    const rebuild = { current: null as null | ((event: { subject: string }) => void) }
    let pid = 11
    const projection = new ProjectionWatcher(
      root,
      {
        refresh: vi.fn(() => [{
          subject: { name: 'alpha' },
          daemon: {
            worker: { running: true, pid },
            health: { status: 'healthy', ok: true },
            tasks: { counts: { pending: 0 } }
          },
          observability: { attention: { cycle_status: 'completed', cycle_id: 'c1', count: 1 }, open_cycles: 0 }
        }])
      } as any,
      { get: vi.fn(() => ({ subject: 'alpha', questions: [], briefs: [], facts: [], goals: null, pending_cycle_request: null, attention: {} })) } as any,
      { get: vi.fn(() => ({ subject: 'alpha', projection: { worker: { running: true } }, sessions: [], inbound: {} })) } as any,
      events,
      ((options: any) => {
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any,
      undefined,
      {
        onRebuild: (listener) => {
          rebuild.current = listener
          return () => {
            if (rebuild.current === listener) rebuild.current = null
          }
        }
      }
    )
    projection.watch('alpha')
    published.length = 0
    pid = 12
    rebuild.current?.({ subject: 'alpha' })
    expect(published).toContain('service.status')
    expect(published).toContain('evolution.updated')
  })
})
