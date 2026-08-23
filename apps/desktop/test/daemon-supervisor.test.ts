import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../../../src/infra/jea-home.mjs'
import {
  readWorkerState,
  workerStatePath
} from '../../../src/daemon/daemon-worker-state.mjs'
import { readChannelWorkerState, writeChannelWorkerState } from '../../../src/channel/worker-state.mjs'
import { PublicCommandError } from '../src/main/command-registry'
import {
  createSupervisorLease,
  readSupervisorLease
} from '../../../src/product/supervisor-lease.mjs'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: Array<NodeJS.Signals | number> = []
  private closed = false
  pid: number

  constructor(
    pid: number,
    private readonly closeOnKill = false
  ) {
    super()
    this.pid = pid
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

function createProjectRoot(): { root: string; jeaHome: string; context: ReturnType<typeof createRuntimeContext> } {
  const root = mkdtempSync(join(tmpdir(), 'jea-daemon-supervisor-'))
  roots.push(root)
  const jeaHome = join(root, 'runtime')
  const subjectsDir = join(jeaHome, 'subjects')
  mkdirSync(subjectsDir, { recursive: true })
  writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' },
      beta: { policy: 'SUBJECT.md', data_namespace: 'beta-data' }
    }
  }))
  const context = createRuntimeContext({ sourceRoot: root, jeaHome })
  return { root, jeaHome, context }
}

function writeCycleState(
  context: ReturnType<typeof createRuntimeContext>,
  subject: string,
  state: Record<string, unknown>
): void {
  const path = workerStatePath(context, subject)
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

function writeHistoryFixtures(context: ReturnType<typeof createRuntimeContext>, subject: string) {
  const cycleQueue = join(context.jeaHome, 'subjects', `${subject}-data`, 'data', 'evolution', 'tasks', 'pending_tasks.json')
  const channelQueue = join(context.jeaHome, 'subjects', `${subject}-data`, 'data', 'channel', 'tasks', 'pending_tasks.json')
  const evidence = join(context.jeaHome, 'subjects', `${subject}-data`, 'data', 'intelligence', 'evidence.jsonl')
  const checkpoint = join(context.jeaHome, 'subjects', `${subject}-data`, 'data', 'evolution', 'cycle-state', 'cycle-1.json')
  const receipt = join(context.jeaHome, 'subjects', `${subject}-data`, 'data', 'evolution', 'receipts', 'r-1.json')
  const message = join(context.jeaHome, 'subjects', `${subject}-data`, 'data', 'channel', 'desktop', 'sessions', 'main.jsonl')
  const files = {
    cycleQueue: { tasks: [{ task_id: 'cycle-1', type: 'cognitive_reaction', status: 'pending' }], updated_at: '2026-01-01T00:00:00.000Z' },
    channelQueue: { tasks: [{ task_id: 'channel-1', type: 'channel_classifier', status: 'pending' }], updated_at: '2026-01-01T00:00:00.000Z' },
    evidence: '{"id":"ev-1"}\n',
    checkpoint: { cycle_id: 'cycle-1', status: 'open' },
    receipt: { receipt_id: 'r-1' },
    message: '{"id":"m-1","content":"hello"}\n'
  }
  mkdirSync(dirname(cycleQueue), { recursive: true })
  mkdirSync(dirname(channelQueue), { recursive: true })
  mkdirSync(dirname(evidence), { recursive: true })
  mkdirSync(dirname(checkpoint), { recursive: true })
  mkdirSync(dirname(receipt), { recursive: true })
  mkdirSync(dirname(message), { recursive: true })
  writeFileSync(cycleQueue, JSON.stringify(files.cycleQueue))
  writeFileSync(channelQueue, JSON.stringify(files.channelQueue))
  writeFileSync(evidence, files.evidence)
  writeFileSync(checkpoint, JSON.stringify(files.checkpoint))
  writeFileSync(receipt, JSON.stringify(files.receipt))
  writeFileSync(message, files.message)
  return {
    cycleQueue,
    channelQueue,
    evidence,
    checkpoint,
    receipt,
    message,
    checksums: {
      cycleQueue: readFileSync(cycleQueue, 'utf8'),
      channelQueue: readFileSync(channelQueue, 'utf8'),
      evidence: readFileSync(evidence, 'utf8'),
      checkpoint: readFileSync(checkpoint, 'utf8'),
      receipt: readFileSync(receipt, 'utf8'),
      message: readFileSync(message, 'utf8')
    }
  }
}

function expectHistoryUnchanged(
  fixtures: ReturnType<typeof writeHistoryFixtures>
): void {
  expect(readFileSync(fixtures.cycleQueue, 'utf8')).toBe(fixtures.checksums.cycleQueue)
  expect(readFileSync(fixtures.channelQueue, 'utf8')).toBe(fixtures.checksums.channelQueue)
  expect(readFileSync(fixtures.evidence, 'utf8')).toBe(fixtures.checksums.evidence)
  expect(readFileSync(fixtures.checkpoint, 'utf8')).toBe(fixtures.checksums.checkpoint)
  expect(readFileSync(fixtures.receipt, 'utf8')).toBe(fixtures.checksums.receipt)
  expect(readFileSync(fixtures.message, 'utf8')).toBe(fixtures.checksums.message)
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

function createSupervisor(
  root: string,
  {
    closeOnKill = false,
    startupTimeoutMs,
    killGraceMs = 10,
    processRegistry = new ManagedProcessRegistry(),
    leaseTtlMs,
    leaseRenewMs
  }: {
    closeOnKill?: boolean
    startupTimeoutMs?: number
    killGraceMs?: number
    processRegistry?: ManagedProcessRegistry
    leaseTtlMs?: number
    leaseRenewMs?: number
  } = {}
) {
  const events = new DesktopEventBus()
  const published: Array<{ type: string; subject?: string; payload: Record<string, unknown> }> = []
  events.subscribe((event) => published.push(event))
  const spawn = createSpawnHarness({ closeOnKill })
  const supervisor = new DaemonSupervisor(
    root,
    processRegistry,
    events,
    spawn.spawnImpl,
    killGraceMs,
    join(root, 'runtime'),
    startupTimeoutMs,
    process.execPath,
    { ttlMs: leaseTtlMs, renewMs: leaseRenewMs }
  )
  return { supervisor, processRegistry, published, ...spawn }
}

describe('DaemonSupervisor', () => {
  it('renews a private v2 lease and never exposes its owner token', async () => {
    const { root } = createProjectRoot()
    const { supervisor, published, spawnMock } = createSupervisor(root, {
      leaseTtlMs: 100,
      leaseRenewMs: 10
    })
    const path = join(
      root,
      'runtime',
      'subjects',
      'alpha-data',
      'data',
      'evolution',
      'daemon',
      'desktop-supervisor-cycle.json'
    )

    const view = await supervisor.start('alpha', { domain: 'cycle' })
    const initial = readSupervisorLease(path)
    expect(initial).toMatchObject({
      schema_version: 2,
      supervisor: 'jea-desktop',
      subject: 'alpha',
      domain: 'cycle',
      lease_ttl_ms: 100,
      lease_renew_ms: 10,
      managed_worker_pid: 40_000
    })
    expect(initial.owner_token).toEqual(expect.any(String))
    expect(JSON.stringify(view)).not.toContain(initial.owner_token)
    expect(JSON.stringify(published)).not.toContain(initial.owner_token)
    const childEnv = (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> })?.env
    expect(childEnv).toMatchObject({
      JEA_DESKTOP_SUPERVISOR_LEASE_REQUIRED: '1',
      JEA_DESKTOP_SUPERVISOR_LEASE_RECORD: path
    })
    expect(JSON.stringify(childEnv)).not.toContain(initial.owner_token)
    expect(childEnv).not.toHaveProperty('JEA_DESKTOP_SUPERVISOR_OWNER_TOKEN')

    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(Date.parse(readSupervisorLease(path).lease_renewed_at))
      .toBeGreaterThan(Date.parse(initial.lease_renewed_at))

    children.at(-1)!.close()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(existsSync(path)).toBe(false)
  })

  it('does not adopt or renew a live worker owned by a previous Desktop instance', async () => {
    const { root, context } = createProjectRoot()
    const path = join(
      root,
      'runtime',
      'subjects',
      'alpha-data',
      'data',
      'evolution',
      'daemon',
      'desktop-supervisor-cycle.json'
    )
    writeCycleState(context, 'alpha', {
      pid: process.pid,
      supervisor: {
        kind: 'jea-desktop',
        required: true,
        domain: 'cycle',
        lease_status: 'active'
      }
    })
    createSupervisorLease(path, {
      ownerToken: 'previous-owner',
      subject: 'alpha',
      domain: 'cycle',
      managedWorkerPid: process.pid,
      ttlMs: 30_000,
      renewMs: 5_000
    })
    const before = readSupervisorLease(path)
    const { supervisor, spawnMock } = createSupervisor(root)

    expect(supervisor.get('alpha')).toMatchObject({
      mode: 'attached',
      supervisor_lease: {
        required: true,
        status: 'active',
        domain: 'cycle'
      },
      detail: 'Desktop-managed daemon belongs to a previous supervisor instance.'
    })
    await expect(supervisor.ensure('alpha', { domain: 'cycle' })).resolves.toMatchObject({
      mode: 'attached'
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(readSupervisorLease(path).owner_token).toBe('previous-owner')
    expect(readSupervisorLease(path).lease_renewed_at).toBe(before.lease_renewed_at)
  })

  it('moves a subject from none to a client-managed daemon using injected spawn', async () => {
    const { root } = createProjectRoot()
    writeFileSync(join(root, 'runtime', '.env'), [
      'DEEPSEEK_API_KEY=home-key',
      'JEA_PROJECT_ROOT=/must-not-win'
    ].join('\n'))
    const subjectRoot = join(root, 'runtime', 'subjects', 'alpha-data')
    mkdirSync(subjectRoot, { recursive: true })
    writeFileSync(join(subjectRoot, '.env'), 'DEEPSEEK_API_KEY=subject-key\n')
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
          JEA_PROJECT_ROOT: root,
          JEA_HOME: join(root, 'runtime'),
          DEEPSEEK_API_KEY: 'subject-key'
        })
      })
    )
    expect(processRegistry.get('daemon', 'alpha:cycle')).toMatchObject({
      kind: 'daemon',
      id: 'alpha:cycle',
      pid: 40_000
    })
    expect(published).toContainEqual(expect.objectContaining({
      type: 'daemon_managed_started',
      subject: 'alpha',
      payload: { pid: 40_000, domain: 'cycle' }
    }))
  })

  it('returns current status for a repeated managed start and coalesces concurrent starts', async () => {
    const { root } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)

    const [first, second] = await Promise.all([
      supervisor.start('alpha', { domain: 'cycle' }),
      supervisor.start('alpha', { domain: 'cycle' })
    ])
    const third = await supervisor.start('alpha', { domain: 'cycle' })

    expect(first).toMatchObject({ mode: 'managed', domain: 'cycle', pid: 40_000 })
    expect(second).toMatchObject({ mode: 'managed', domain: 'cycle', pid: 40_000 })
    expect(third).toMatchObject({ mode: 'managed', domain: 'cycle', pid: 40_000 })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('starts independent cycle and channel workers without duplicating either domain', async () => {
    const { root } = createProjectRoot()
    const { supervisor, spawnMock, processRegistry } = createSupervisor(root)

    await supervisor.start('alpha', { domain: 'cycle' })
    await supervisor.start('alpha', { domain: 'channel' })

    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(processRegistry.get('daemon', 'alpha:cycle')?.pid).toBe(40_000)
    expect(processRegistry.get('daemon', 'alpha:channel')?.pid).toBe(40_001)
    expect(supervisor.get('alpha')).toMatchObject({
      mode: 'managed',
      domain: 'all',
      supervisor_leases: expect.arrayContaining([
        expect.objectContaining({ domain: 'cycle', status: 'active' }),
        expect.objectContaining({ domain: 'channel', status: 'active' })
      ])
    })
    await expect(supervisor.start('alpha', { domain: 'all' })).resolves.toMatchObject({
      mode: 'managed',
      domain: 'all'
    })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('does not start or adopt a fresh external daemon', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(context, 'beta', { pid: process.pid })

    expect(supervisor.get('beta').mode).toBe('attached')
    await expect(supervisor.start('beta')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'An external daemon is already running.'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not stop an attached daemon owned outside the desktop client', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(context, 'alpha', { pid: process.pid })
    const killSpy = vi.spyOn(process, 'kill')

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
    expect(killSpy.mock.calls.filter(([, signal]) => signal && signal !== 0)).toEqual([])
    expect(readWorkerState(context, 'alpha')).toMatchObject({
      status: 'running',
      stop_requested_at: null
    })
    killSpy.mockRestore()
  })

  it('refuses to signal a child whose pid no longer matches the owned handle', async () => {
    const { root } = createProjectRoot()
    const { supervisor } = createSupervisor(root)
    const killSpy = vi.spyOn(process, 'kill')
    await supervisor.start('alpha')
    const child = children.at(-1)!
    child.pid = process.pid

    await expect(supervisor.stop('alpha')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The daemon is not managed by this client.'
    })
    expect(child.kills).toEqual([])
    expect(killSpy.mock.calls.filter(([, signal]) => signal && signal !== 0)).toEqual([])
    killSpy.mockRestore()
  })

  it('falls back to safe channel stop only for roles still running after the child exits', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor } = createSupervisor(root, { closeOnKill: true })
    await supervisor.start('alpha', { domain: 'channel' })
    writeChannelWorkerState(context, 'alpha', {
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
    expect(readChannelWorkerState(context, 'alpha')?.workers.presence.status).toBe('stopped')
    expect(readChannelWorkerState(context, 'alpha')?.workers.notify.status).toBe('stopped')
  })

  it('stops a managed daemon without starting a real process', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, processRegistry, published } = createSupervisor(root, {
      closeOnKill: true
    })

    await supervisor.start('alpha')
    const child = children.at(-1)!
    const result = await supervisor.stop('alpha', 'operator_test')

    expect(child.kills).toEqual(['SIGTERM'])
    expect(result.mode).toBe('none')
    expect(processRegistry.get('daemon', 'alpha')).toBeNull()
    expect(readWorkerState(context, 'alpha')).toMatchObject({
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
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)

    writeCycleState(context, 'alpha', {
      pid: process.pid,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1
    })
    writeCycleState(context, 'beta', {
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
      message: 'A live worker is still present and cannot be replaced safely.'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not let a stale domain hide another attached worker', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(context, 'alpha', {
      pid: 999_999_999,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1
    })
    writeChannelWorkerState(context, 'alpha', {
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

  it('repairs a dead-PID worker without deleting queued work or history', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    const history = writeHistoryFixtures(context, 'alpha')
    writeCycleState(context, 'alpha', { pid: 999_999_991 })
    writeChannelWorkerState(context, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: 999_999_992,
      status: 'running',
      workers: {
        notify: {
          role: 'notify',
          pid: 999_999_992,
          status: 'running',
          heartbeat_at: new Date().toISOString(),
          stale_after_ms: 60_000
        }
      }
    })

    expect(supervisor.get('alpha').mode).toBe('zombie')
    await expect(supervisor.repair('alpha', { domain: 'cycle' })).resolves.toMatchObject({
      mode: 'zombie'
    })
    expect(readWorkerState(context, 'alpha')?.status).toBe('stopped')
    expect(readChannelWorkerState(context, 'alpha')?.workers.notify.status).toBe('running')
    expectHistoryUnchanged(history)

    await expect(supervisor.repair('alpha', { domain: 'channel' })).resolves.toMatchObject({
      mode: 'none'
    })
    expect(readChannelWorkerState(context, 'alpha')?.workers.notify.status).toBe('stopped')
    expect(readWorkerState(context, 'alpha')?.status).toBe('stopped')
    expectHistoryUnchanged(history)

    const started = await supervisor.start('alpha', { domain: 'cycle' })
    expect(started.mode).toBe('managed')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expectHistoryUnchanged(history)
  })

  it('rejects repair when a pid is still alive', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor } = createSupervisor(root)
    writeCycleState(context, 'alpha', { pid: process.pid })
    const history = writeHistoryFixtures(context, 'alpha')

    await expect(supervisor.repair('alpha', { domain: 'cycle' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The worker process is still alive and cannot be repaired.'
    })
    expect(readWorkerState(context, 'alpha')).toMatchObject({
      status: 'running',
      pid: process.pid
    })
    expectHistoryUnchanged(history)
  })

  it('keeps cycle and channel repair isolated from each other', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor } = createSupervisor(root)
    writeCycleState(context, 'alpha', { pid: 999_999_993 })
    writeChannelWorkerState(context, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: process.pid,
      status: 'running',
      workers: {
        agent: {
          role: 'agent',
          pid: process.pid,
          status: 'running',
          heartbeat_at: new Date().toISOString(),
          stale_after_ms: 60_000
        }
      }
    })
    const beforeChannel = JSON.stringify(readChannelWorkerState(context, 'alpha'))
    const beforeCycle = JSON.stringify(readWorkerState(context, 'alpha'))

    await supervisor.repair('alpha', { domain: 'cycle' })
    expect(readWorkerState(context, 'alpha')?.status).toBe('stopped')
    expect(JSON.stringify(readChannelWorkerState(context, 'alpha'))).toBe(beforeChannel)

    await expect(supervisor.repair('alpha', { domain: 'channel' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The worker process is still alive and cannot be repaired.'
    })
    expect(JSON.stringify(readChannelWorkerState(context, 'alpha'))).toBe(beforeChannel)
    expect(readWorkerState(context, 'alpha')?.status).toBe('stopped')
    expect(JSON.stringify(readWorkerState(context, 'alpha'))).not.toBe(beforeCycle)
  })

  it('does not repair cycle when domain=all is blocked by a live channel pid', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor } = createSupervisor(root)
    writeCycleState(context, 'alpha', { pid: 999_999_994 })
    writeChannelWorkerState(context, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: process.pid,
      status: 'running',
      workers: {
        agent: {
          role: 'agent',
          pid: process.pid,
          status: 'running',
          heartbeat_at: new Date().toISOString(),
          stale_after_ms: 60_000
        }
      }
    })
    const beforeCycle = JSON.stringify(readWorkerState(context, 'alpha'))
    const beforeChannel = JSON.stringify(readChannelWorkerState(context, 'alpha'))

    await expect(supervisor.repair('alpha', { domain: 'all' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The worker process is still alive and cannot be repaired.'
    })
    expect(JSON.stringify(readWorkerState(context, 'alpha'))).toBe(beforeCycle)
    expect(JSON.stringify(readChannelWorkerState(context, 'alpha'))).toBe(beforeChannel)
  })

  it('reports a redacted log path when a managed daemon exits before ready', async () => {
    const { root, jeaHome } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root, { startupTimeoutMs: 200 })
    spawnMock.mockImplementationOnce(() => {
      const child = new FakeChild(41_000, false)
      children.push(child)
      queueMicrotask(() => {
        child.emit('spawn')
        child.close(1, null)
      })
      return child as unknown as ChildProcess
    })

    const error = await supervisor.start('alpha', { domain: 'cycle' }).catch((caught) => caught)
    expect(error).toMatchObject({
      code: 'OPERATION_FAILED',
      message: expect.stringMatching(
        /exited before becoming ready\. See <JEA_HOME>\/logs\/daemon-alpha\.desktop\.stderr\.log\.$/
      )
    })
    expect(String((error as Error).message)).not.toContain(jeaHome)
  })

  it('terminates a managed daemon that misses the startup timeout', async () => {
    const { root } = createProjectRoot()
    const { supervisor } = createSupervisor(root, {
      startupTimeoutMs: 120,
      closeOnKill: true
    })

    await expect(supervisor.start('alpha', { domain: 'cycle' })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      message: expect.stringMatching(
        /did not become ready before the startup timeout\. See <JEA_HOME>\/logs\/daemon-alpha\.desktop\.stderr\.log\.$/
      )
    })
    expect(children.at(-1)?.kills).toEqual(['SIGTERM'])
    expect(supervisor.get('alpha').mode).toBe('none')
  })

  it('terminates a spawned daemon when process ownership registration fails', async () => {
    const { root } = createProjectRoot()
    const processRegistry = new ManagedProcessRegistry()
    const { supervisor } = createSupervisor(root, {
      closeOnKill: true,
      processRegistry
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
    const { root, context } = createProjectRoot()
    const { supervisor, processRegistry, published } = createSupervisor(root, {
      closeOnKill: true
    })
    writeCycleState(context, 'beta', { pid: process.pid })
    await supervisor.start('alpha')
    const managedChild = children.at(-1)!

    await processRegistry.shutdownAll('app_quit')

    expect(managedChild.kills).toEqual(['SIGTERM'])
    expect(supervisor.get('alpha').mode).toBe('none')
    expect(processRegistry.list()).toEqual([])
    expect(supervisor.get('beta').mode).toBe('attached')
    expect(readWorkerState(context, 'beta')).toMatchObject({
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

  it('bounds app-quit cleanup to the shutdown deadline', async () => {
    const registry = new ManagedProcessRegistry(20)
    registry.register({
      kind: 'daemon',
      id: 'alpha',
      pid: 7,
      cleanup: () => new Promise(() => undefined)
    })

    const started = Date.now()
    await registry.shutdownAll('app_quit')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(registry.list()).toEqual([])
  })
})

describe('DaemonSupervisor.ensure', () => {
  it('starts exactly one managed Cycle when none is running', async () => {
    const { root } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    const first = await supervisor.ensure('alpha', { domain: 'cycle' })
    const second = await supervisor.ensure('alpha', { domain: 'cycle' })
    expect(first).toMatchObject({ mode: 'managed', domain: 'cycle', pid: 40_000 })
    expect(second).toMatchObject({ mode: 'managed', domain: 'cycle', pid: 40_000 })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('attaches an external Cycle without starting or stopping a duplicate', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(context, 'alpha', { pid: process.pid })
    const view = await supervisor.ensure('alpha', { domain: 'cycle' })
    expect(view).toMatchObject({ mode: 'attached', pid: process.pid })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(readWorkerState(context, 'alpha')).toMatchObject({
      status: 'running',
      stop_requested_at: null,
      pid: process.pid
    })
  })

  it('attaches an external stale Cycle without spawning a second worker', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(context, 'alpha', {
      pid: process.pid,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1
    })
    const view = await supervisor.ensure('alpha', { domain: 'cycle' })
    expect(view).toMatchObject({ mode: 'stale', pid: process.pid })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(readWorkerState(context, 'alpha')).toMatchObject({
      status: 'running',
      pid: process.pid
    })
  })

  it('repairs an unowned zombie Cycle then starts a managed worker', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root)
    writeCycleState(context, 'alpha', { pid: 999_999_995 })
    const view = await supervisor.ensure('alpha', { domain: 'cycle' })
    expect(view).toMatchObject({ mode: 'managed', domain: 'cycle' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(readWorkerState(context, 'alpha')?.status).not.toBe('running')
  })

  it('stops an owned stale Cycle then starts a replacement', async () => {
    const { root, context } = createProjectRoot()
    const { supervisor, spawnMock } = createSupervisor(root, { closeOnKill: true })
    const first = await supervisor.ensure('alpha', { domain: 'cycle' })
    expect(first).toMatchObject({ mode: 'managed', pid: 40_000 })
    writeCycleState(context, 'alpha', {
      pid: process.pid,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1
    })
    const second = await supervisor.ensure('alpha', { domain: 'cycle' })
    expect(second).toMatchObject({ mode: 'managed', domain: 'cycle', pid: 40_001 })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
