import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readWorkerState,
  workerStatePath
} from '../../../src/daemon/daemon-worker-state.mjs'
import { readChannelWorkerState, writeChannelWorkerState } from '../../../src/channel/worker-state.mjs'
import { PublicCommandError } from '../src/main/command-registry'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: Array<NodeJS.Signals | number> = []
  private closed = false

  constructor(
    readonly pid: number,
    private readonly closeOnKill = false
  ) {
    super()
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(signal)
    if (this.closeOnKill) {
      queueMicrotask(() => {
        this.close(null, typeof signal === 'string' ? signal : null)
      })
    }
    return true
  }

  close(
    exitCode: number | null = 0,
    signalCode: NodeJS.Signals | null = null
  ): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = exitCode
    this.signalCode = signalCode
    this.emit('close', exitCode, signalCode)
  }
}

const roots: string[] = []
const children: FakeChild[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jea-daemon-supervisor-'))
  roots.push(root)
  const subjectsDir = join(root, 'runtime', 'subjects')
  mkdirSync(subjectsDir, { recursive: true })
  writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' },
      beta: { policy: 'SUBJECT.md', data_namespace: 'beta-data' }
    }
  }))
  return root
}

function writeCycleState(
  root: string,
  subject: string,
  state: Record<string, unknown>
): void {
  const path = workerStatePath(root, subject)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    subject,
    worker_id: `worker-${subject}`,
    status: 'running',
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    stop_requested_at: null,
    stopped_at: null,
    stale_after_ms: 60_000,
    ...state
  }))
}

function createSpawnHarness({ closeOnKill = false } = {}) {
  const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: unknown) => {
    const child = new FakeChild(40_000 + children.length, closeOnKill)
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  })
  return {
    spawnMock,
    spawnImpl: spawnMock as unknown as typeof import('node:child_process').spawn
  }
}

function createSupervisor(root: string, { closeOnKill = false } = {}) {
  const processRegistry = new ManagedProcessRegistry()
  const events = new DesktopEventBus()
  const published: Array<{ type: string; subject?: string; payload: Record<string, unknown> }> = []
  events.subscribe((event) => published.push(event))
  const spawn = createSpawnHarness({ closeOnKill })
  const supervisor = new DaemonSupervisor(
    root,
    processRegistry,
    events,
    spawn.spawnImpl,
    10
  )
  return { supervisor, processRegistry, published, ...spawn }
}

describe('DaemonSupervisor', () => {
  it('moves a subject from none to a client-managed daemon using injected spawn', async () => {
    const root = createProjectRoot()
    const { supervisor, processRegistry, published, spawnMock } = createSupervisor(root)

    expect(supervisor.get('alpha')).toMatchObject({
      subject: 'alpha',
      mode: 'none',
      pid: null
    })

    const result = await supervisor.start('alpha', { domain: 'cycle' })

    expect(result).toMatchObject({
      subject: 'alpha',
      mode: 'managed',
      pid: 40_000,
      domain: 'cycle'
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        '--preserve-symlinks',
        join(root, 'src', 'cli', 'jea.mjs'),
        'daemon',
        'start',
        '--subject',
        'alpha',
        '--domain',
        'cycle'
      ],
      expect.objectContaining({
        cwd: root,
        detached: false,
        windowsHide: true,
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          JEA_PROJECT_ROOT: root
        })
      })
    )
    expect(processRegistry.get('daemon', 'alpha')).toMatchObject({
      kind: 'daemon',
      id: 'alpha',
      pid: 40_000
    })
    expect(published).toContainEqual(expect.objectContaining({
      type: 'daemon_managed_started',
      subject: 'alpha',
      payload: { pid: 40_000, domain: 'cycle' }
    }))
  })

  it('rejects duplicate managed starts and conflicts with an external daemon', async () => {
    const root = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)

    await supervisor.start('alpha')
    await expect(supervisor.start('alpha')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A managed daemon is already running.'
    })

    writeCycleState(root, 'beta', { pid: process.pid })
    expect(supervisor.get('beta').mode).toBe('attached')
    await expect(supervisor.start('beta')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'An external daemon is already running.'
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('does not stop an attached daemon owned outside the desktop client', async () => {
    const root = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(root, 'alpha', { pid: process.pid })

    expect(supervisor.get('alpha')).toMatchObject({
      mode: 'attached',
      pid: process.pid,
      detail: 'Daemon is externally managed.'
    })
    await expect(supervisor.stop('alpha')).rejects.toEqual(
      expect.objectContaining<Partial<PublicCommandError>>({
        code: 'CONFLICT',
        message: 'The daemon is not managed by this client.'
      })
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(readWorkerState(root, 'alpha')).toMatchObject({
      status: 'running',
      stop_requested_at: null
    })
  })

  it('falls back to safe channel stop only for roles still running after the child exits', async () => {
    const root = createProjectRoot()
    const { supervisor } = createSupervisor(root, { closeOnKill: true })
    await supervisor.start('alpha', { domain: 'channel' })
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      workers: {
        notify: {
          role: 'notify',
          status: 'stopped',
          stopped_at: new Date().toISOString()
        },
        presence: {
          role: 'presence',
          status: 'running',
          heartbeat_at: new Date().toISOString()
        }
      }
    })

    await expect(supervisor.stop('alpha', 'operator_test')).resolves.toMatchObject({
      mode: 'none'
    })
    expect(readChannelWorkerState(root, 'alpha')?.workers.presence.status).toBe('stopped')
    expect(readChannelWorkerState(root, 'alpha')?.workers.notify.status).toBe('stopped')
  })

  it('stops a managed daemon without starting a real process', async () => {
    const root = createProjectRoot()
    const { supervisor, processRegistry, published } = createSupervisor(root, {
      closeOnKill: true
    })

    await supervisor.start('alpha')
    const child = children.at(-1)!
    const result = await supervisor.stop('alpha', 'operator_test')

    expect(child.kills).toEqual(['SIGTERM'])
    expect(result.mode).toBe('none')
    expect(processRegistry.get('daemon', 'alpha')).toBeNull()
    expect(readWorkerState(root, 'alpha')).toMatchObject({
      status: 'stopped',
      stop_requested_at: expect.any(String)
    })
    expect(published).toContainEqual(expect.objectContaining({
      type: 'daemon_managed_stop_requested',
      subject: 'alpha',
      payload: { reason: 'operator_test' }
    }))
  })

  it('projects stale and zombie worker-state independently of ownership', async () => {
    const root = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)

    writeCycleState(root, 'alpha', {
      pid: process.pid,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1
    })
    writeCycleState(root, 'beta', {
      pid: 999_999_999,
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000
    })

    expect(supervisor.get('alpha')).toMatchObject({
      subject: 'alpha',
      mode: 'stale',
      pid: process.pid
    })
    expect(supervisor.get('beta')).toMatchObject({
      subject: 'beta',
      mode: 'zombie',
      pid: 999_999_999
    })
    await expect(supervisor.start('alpha')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'An external daemon is already running.'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not let a stale domain hide another attached worker', async () => {
    const root = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(root, 'alpha', {
      pid: 999_999_999,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1
    })
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      coordinator: null,
      workers: {
        dispatch: {
          role: 'dispatch',
          worker_id: 'channel-dispatch',
          pid: process.pid,
          status: 'running',
          started_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
          stale_after_ms: 60_000
        }
      }
    })

    expect(supervisor.get('alpha').mode).toBe('attached')
    await expect(supervisor.start('alpha', { domain: 'all' })).rejects.toMatchObject({
      code: 'CONFLICT'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('terminates a spawned daemon when process ownership registration fails', async () => {
    const root = createProjectRoot()
    const { supervisor, processRegistry } = createSupervisor(root, {
      closeOnKill: true
    })
    await processRegistry.shutdownAll('preexisting_shutdown')

    await expect(supervisor.start('alpha')).rejects.toThrow(
      'process_registry_shutting_down'
    )

    expect(children.at(-1)?.kills).toEqual(['SIGTERM'])
    expect(supervisor.get('alpha').mode).toBe('none')
    expect(processRegistry.list()).toEqual([])
  })

  it('process-registry shutdown cleans up managed daemons but leaves attached state alone', async () => {
    const root = createProjectRoot()
    const { supervisor, processRegistry, published } = createSupervisor(root, {
      closeOnKill: true
    })
    writeCycleState(root, 'beta', { pid: process.pid })
    await supervisor.start('alpha')
    const managedChild = children.at(-1)!

    await processRegistry.shutdownAll('app_quit')

    expect(managedChild.kills).toEqual(['SIGTERM'])
    expect(supervisor.get('alpha').mode).toBe('none')
    expect(processRegistry.list()).toEqual([])
    expect(supervisor.get('beta').mode).toBe('attached')
    expect(readWorkerState(root, 'beta')).toMatchObject({
      status: 'running',
      stop_requested_at: null
    })
    expect(published).toContainEqual(expect.objectContaining({
      type: 'daemon_managed_stop_requested',
      subject: 'alpha',
      payload: { reason: 'app_quit' }
    }))
  })
})

describe('ManagedProcessRegistry', () => {
  it('makes reentrant shutdown calls wait for the same cleanup work', async () => {
    const registry = new ManagedProcessRegistry()
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    registry.register({
      kind: 'daemon',
      id: 'alpha',
      pid: 42,
      cleanup: async () => cleanup
    })

    const first = registry.shutdownAll('app_quit')
    let secondFinished = false
    const second = registry.shutdownAll('app_quit').then(() => {
      secondFinished = true
    })
    await Promise.resolve()
    expect(secondFinished).toBe(false)

    releaseCleanup()
    await Promise.all([first, second])
    expect(secondFinished).toBe(true)
    expect(registry.list()).toEqual([])
  })
})
