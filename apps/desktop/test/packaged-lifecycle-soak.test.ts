import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeChannelWorkerState } from '../../../src/channel/worker-state.mjs'
import { writeWorkerState, readWorkerState } from '../../../src/daemon/daemon-worker-state.mjs'
import { createRuntimeContext } from '../../../src/infra/jea-home.mjs'
import {
  createSupervisorLease,
  readSupervisorLease,
  renewSupervisorLease,
  removeSupervisorLease
} from '../../../src/product/supervisor-lease.mjs'
import { createWebJeaClient } from '../src/client-api'
import { ClientLifecycleController } from '../src/main/client-lifecycle'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'
import { createWebHost } from '../src/web-host'

/**
 * Isolated #239 packaged-Desktop soak.
 * This environment has no JEA.app / Electron product binary, so the soak is
 * the supervisor + lifecycle + lease + Web-host contract, not a signed .app.
 */

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: Array<NodeJS.Signals | number> = []
  private closed = false
  pid: number

  constructor(pid: number, private readonly closeOnKill = false) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(signal)
    if (this.closeOnKill) {
      queueMicrotask(() => this.close(null, typeof signal === 'string' ? signal : null))
    }
    return true
  }

  close(exitCode: number | null = 0, signalCode: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = exitCode
    this.signalCode = signalCode
    this.emit('close', exitCode, signalCode)
  }
}

const roots: string[] = []
const children: FakeChild[] = []
const hosts: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.close().catch(() => {})
  }
  for (const child of children.splice(0)) child.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function isolatedHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  expect(dir.startsWith(tmpdir())).toBe(true)
  expect(dir).not.toBe(join(homedir(), '.jea'))
  return dir
}

function writeUnreadyJournal(jeaHome: string, dataNamespace: string): void {
  const dataRoot = join(jeaHome, 'subjects', dataNamespace, 'data')
  const genDir = join(dataRoot, 'evolution', 'reactor', 'evidence-index-generations', 'gen-upgrade')
  mkdirSync(genDir, { recursive: true })
  writeFileSync(join(dataRoot, 'evolution', 'reactor', 'evidence-index.json'), JSON.stringify({
    schema_version: 'evidence-index.v3',
    generation: 'gen-upgrade',
    active_directory: 'evidence-index-generations/gen-upgrade',
    journal_size: 4096,
    updated_at: new Date().toISOString()
  }))
  writeFileSync(join(genDir, 'entries.jsonl'), `${'{"evidence_key":"k"}\n'.repeat(80)}`)
  writeFileSync(join(genDir, 'journal-state.json'), JSON.stringify({
    schema_version: 'evidence-journal-state.v1',
    generation: 'gen-upgrade',
    journal_lines: 80,
    unique_evidence_keys: 80
  }))
}

function leasePath(jeaHome: string, dataNamespace: string, domain: 'cycle' | 'channel'): string {
  return join(
    jeaHome,
    'subjects',
    dataNamespace,
    'data',
    'evolution',
    'daemon',
    `desktop-supervisor-${domain}.json`
  )
}

function createDesktop(options: {
  subjects?: Record<string, Record<string, unknown>>
  defaultSubject?: string
  closeOnKill?: boolean
  lifecycleOptions?: ConstructorParameters<typeof ClientLifecycleController>[2]
} = {}) {
  const root = isolatedHome('jea-packaged-soak-src-')
  const jeaHome = isolatedHome('jea-packaged-soak-home-')
  const subjects = options.subjects ?? {
    alpha: {
      policy: 'SUBJECT.md',
      data_namespace: 'alpha-data',
      evolution: { mode: 'continuous' },
      channels: { desktop: { enabled: true, default_session: 'main' } }
    },
    upgrade: {
      policy: 'SUBJECT.md',
      data_namespace: 'upgrade-data',
      evolution: { automation: 'automatic', background: true },
      channels: { desktop: { enabled: true, default_session: 'main' } }
    },
    cli: {
      policy: 'SUBJECT.md',
      data_namespace: 'cli-data',
      evolution: { automation: 'automatic' },
      channels: { desktop: { enabled: true, default_session: 'main' } }
    }
  }
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: options.defaultSubject ?? 'alpha',
    subjects
  }))
  const runtime = createRuntimeContext({ sourceRoot: root, jeaHome })
  const events = new DesktopEventBus()
  const processRegistry = new ManagedProcessRegistry()
  const spawnMock = vi.fn((_command: string, args: readonly string[], spawnOptions?: { env?: Record<string, string> }) => {
    const child = new FakeChild(60_000 + children.length, options.closeOnKill !== false)
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    const subject = String(args[args.indexOf('--subject') + 1] ?? '')
    const domain = String(args[args.indexOf('--domain') + 1] ?? 'all')
    const now = new Date().toISOString()
    if (domain === 'cycle' || domain === 'all') {
      writeWorkerState(runtime, subject, {
        subject,
        worker_id: `cycle-${child.pid}`,
        pid: child.pid,
        status: 'running',
        started_at: now,
        heartbeat_at: now,
        stale_after_ms: 60_000
      })
    }
    if (domain === 'channel' || domain === 'all') {
      writeChannelWorkerState(runtime, subject, {
        subject,
        domain: 'channel',
        schema_version: 2,
        pid: child.pid,
        status: 'running',
        started_at: now,
        heartbeat_at: now,
        coordinator: { pid: child.pid, started_at: now },
        workers: {
          notify: {
            role: 'notify',
            worker_id: `channel-${child.pid}`,
            pid: child.pid,
            status: 'running',
            started_at: now,
            heartbeat_at: now,
            stale_after_ms: 60_000
          }
        }
      })
    }
    expect(spawnOptions?.env?.JEA_HOME).toBe(jeaHome)
    expect(spawnOptions?.env?.JEA_HOME).not.toBe(join(homedir(), '.jea'))
    return child as unknown as ChildProcess
  })
  const supervisor = new DaemonSupervisor(
    root,
    processRegistry,
    events,
    spawnMock as unknown as typeof import('node:child_process').spawn,
    10,
    jeaHome,
    0
  )
  const lifecycle = new ClientLifecycleController(
    supervisor,
    runtime,
    options.lifecycleOptions ?? {}
  )
  return { root, jeaHome, runtime, supervisor, lifecycle, spawnMock, processRegistry }
}

function cycleStarts(spawnMock: { mock: { calls: unknown[][] } }, subject: string): number {
  return spawnMock.mock.calls.filter(([, args]) => (
    Array.isArray(args)
    && args.includes('--domain')
    && args[args.indexOf('--domain') + 1] === 'cycle'
    && args.includes(subject)
  )).length
}

function channelStarts(spawnMock: { mock: { calls: unknown[][] } }, subject: string): number {
  return spawnMock.mock.calls.filter(([, args]) => (
    Array.isArray(args)
    && args.includes('--domain')
    && args[args.indexOf('--domain') + 1] === 'channel'
    && args.includes(subject)
  )).length
}

describe('Packaged JEA.app lifecycle soak (#239)', () => {
  it('starts managed Cycle/Channel only after the control-plane readiness gate', async () => {
    const { lifecycle, spawnMock, jeaHome, supervisor } = createDesktop()
    writeUnreadyJournal(jeaHome, 'upgrade-data')

    const result = await lifecycle.reconcileStartup()
    expect(result.subject).toBe('alpha')
    expect(result.actions.find((item) => item.subject === 'alpha' && item.domain === 'cycle'))
      .toMatchObject({ action: 'ensure', outcome: 'started', reason: 'automatic' })
    expect(result.actions.find((item) => item.subject === 'alpha' && item.domain === 'channel'))
      .toMatchObject({ action: 'ensure', outcome: 'started', reason: 'conversation_enabled' })
    expect(result.actions.find((item) => item.subject === 'upgrade' && item.domain === 'cycle'))
      .toMatchObject({ action: 'skip', outcome: 'skipped' })
    expect(['migration_required', 'activation_ledger_unresolved']).toContain(
      result.actions.find((item) => item.subject === 'upgrade' && item.domain === 'cycle')?.reason
    )
    expect(result.actions.find((item) => item.subject === 'upgrade' && item.domain === 'channel'))
      .toMatchObject({ outcome: 'started', reason: 'conversation_enabled' })
    expect(cycleStarts(spawnMock, 'alpha')).toBe(1)
    expect(channelStarts(spawnMock, 'alpha')).toBe(1)
    expect(cycleStarts(spawnMock, 'upgrade')).toBe(0)
    expect(channelStarts(spawnMock, 'upgrade')).toBe(1)
    expect(supervisor.owns('alpha', 'cycle')).toBe(true)
    expect(supervisor.owns('upgrade', 'cycle')).toBe(false)
    const childEnv = (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> })?.env
    expect(childEnv?.JEA_DESKTOP_SUPERVISOR_LEASE_REQUIRED).toBe('1')
    expect(JSON.stringify(childEnv)).not.toMatch(/owner_token|OWNER_TOKEN/)
  })

  it('safe quit stops only Desktop-owned workers and leaves CLI workers attached', async () => {
    const { lifecycle, supervisor, processRegistry, runtime, spawnMock } = createDesktop({
      closeOnKill: true
    })
    await lifecycle.reconcileStartup()
    const managedCycle = children.find((child) => child.pid === supervisor.get('alpha').pid)
    expect(managedCycle).toBeTruthy()

    writeWorkerState(runtime, 'cli', {
      subject: 'cli',
      worker_id: 'external-cli',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000
    })
    const attached = await supervisor.ensure('cli', { domain: 'cycle' })
    expect(attached.mode).toBe('attached')
    expect(supervisor.owns('cli', 'cycle')).toBe(false)
    const spawnCountAfterAttach = spawnMock.mock.calls.length

    const killSpy = vi.spyOn(process, 'kill')
    await processRegistry.shutdownAll('app_quit')

    expect(managedCycle?.kills).toEqual(['SIGTERM'])
    expect(supervisor.get('alpha').mode).toBe('none')
    expect(supervisor.owns('alpha', 'cycle')).toBe(false)
    expect(processRegistry.list()).toEqual([])
    expect(supervisor.get('cli').mode).toBe('attached')
    const cliState = readWorkerState(runtime, 'cli')
    expect(cliState).toMatchObject({
      status: 'running',
      pid: process.pid
    })
    expect(cliState?.stop_requested_at == null).toBe(true)
    expect(killSpy.mock.calls.filter(([pid, signal]) => (
      pid === process.pid && signal && signal !== 0
    ))).toEqual([])
    expect(spawnMock.mock.calls.length).toBe(spawnCountAfterAttach)
    killSpy.mockRestore()
  })

  it('lease-expiry crash recovery does not take over the old token or spawn a duplicate', async () => {
    const { jeaHome, runtime, supervisor, lifecycle, spawnMock } = createDesktop()
    const path = leasePath(jeaHome, 'alpha-data', 'cycle')
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'orphaned-desktop',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000,
      supervisor: {
        kind: 'jea-desktop',
        required: true,
        domain: 'cycle',
        lease_status: 'active'
      }
    })
    createSupervisorLease(path, {
      ownerToken: 'dead-supervisor-token',
      subject: 'alpha',
      domain: 'cycle',
      managedWorkerPid: process.pid,
      ttlMs: 30_000,
      renewMs: 5_000
    })
    const before = readSupervisorLease(path)

    expect(supervisor.get('alpha')).toMatchObject({
      mode: 'attached',
      detail: 'Desktop-managed daemon belongs to a previous supervisor instance.',
      supervisor_lease: { required: true, domain: 'cycle' }
    })
    await expect(supervisor.start('alpha', { domain: 'cycle' })).rejects.toMatchObject({
      code: 'CONFLICT'
    })
    await expect(supervisor.ensure('alpha', { domain: 'cycle' })).resolves.toMatchObject({
      mode: 'attached'
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(readSupervisorLease(path).owner_token).toBe('dead-supervisor-token')
    expect(readSupervisorLease(path).lease_renewed_at).toBe(before.lease_renewed_at)
    expect(renewSupervisorLease(path, { ownerToken: 'replacement-instance' })).toMatchObject({
      renewed: false,
      reason: 'owner_mismatch'
    })
    expect(removeSupervisorLease(path, 'replacement-instance')).toMatchObject({
      removed: false,
      reason: 'owner_mismatch'
    })
    expect(JSON.stringify(supervisor.get('alpha'))).not.toContain('dead-supervisor-token')

    createSupervisorLease(path, {
      ownerToken: 'dead-supervisor-token',
      subject: 'alpha',
      domain: 'cycle',
      managedWorkerPid: process.pid,
      ttlMs: 1_000,
      renewMs: 200,
      nowMs: Date.now() - 5_000
    })
    const killSpy = vi.spyOn(process, 'kill')
    await expect(supervisor.ensure('alpha', { domain: 'cycle' })).resolves.toMatchObject({
      mode: 'attached'
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(killSpy.mock.calls.filter(([pid, signal]) => (
      pid === process.pid && signal && signal !== 0
    ))).toEqual([])
    killSpy.mockRestore()

    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'orphaned-desktop',
      pid: null,
      status: 'stopped',
      stopped_at: new Date().toISOString(),
      stop_reason: 'supervisor_lease_expired',
      heartbeat_at: new Date().toISOString()
    })
    const recovered = await lifecycle.reconcile({ subject: 'alpha', reason: 'startup' })
    expect(recovered.actions.find((item) => item.domain === 'cycle')).toMatchObject({
      action: 'ensure',
      outcome: 'started'
    })
    expect(cycleStarts(spawnMock, 'alpha')).toBe(1)
    const recoveredLease = readSupervisorLease(path)
    expect(recoveredLease?.owner_token).toEqual(expect.any(String))
    expect(recoveredLease?.owner_token).not.toBe('dead-supervisor-token')
    expect(supervisor.owns('alpha', 'cycle')).toBe(true)
    expect(JSON.stringify(supervisor.get('alpha'))).not.toContain('dead-supervisor-token')
    expect(JSON.stringify(supervisor.get('alpha'))).not.toContain(recoveredLease!.owner_token)
  })

  it('a new instance waits for a previous owner then starts with a new token', async () => {
    let runtimeForWait: ReturnType<typeof createRuntimeContext> | null = null
    const wait = vi.fn(async () => {
      if (!runtimeForWait) return
      writeWorkerState(runtimeForWait, 'alpha', {
        subject: 'alpha',
        worker_id: 'previous-desktop',
        pid: null,
        status: 'stopped',
        stopped_at: new Date().toISOString(),
        stop_reason: 'supervisor_lease_expired',
        heartbeat_at: new Date().toISOString()
      })
    })
    const { jeaHome, runtime, lifecycle, spawnMock, supervisor } = createDesktop({
      lifecycleOptions: { maxWaitMs: 100, pollMs: 1, wait }
    })
    runtimeForWait = runtime
    const path = leasePath(jeaHome, 'alpha-data', 'cycle')
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'previous-desktop',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000,
      supervisor: {
        kind: 'jea-desktop',
        required: true,
        domain: 'cycle',
        lease_status: 'active'
      }
    })
    createSupervisorLease(path, {
      ownerToken: 'old-supervisor-token',
      subject: 'alpha',
      domain: 'cycle',
      managedWorkerPid: process.pid
    })

    const result = await lifecycle.reconcile({ subject: 'alpha', reason: 'startup' })
    expect(result.actions.find((item) => item.domain === 'cycle')).toMatchObject({
      action: 'attach',
      outcome: 'started',
      reason: 'previous_supervisor_owner'
    })
    expect(wait).toHaveBeenCalled()
    expect(cycleStarts(spawnMock, 'alpha')).toBe(1)
    const next = readSupervisorLease(path)
    expect(next.owner_token).not.toBe('old-supervisor-token')
    expect(supervisor.owns('alpha', 'cycle')).toBe(true)
    expect(JSON.stringify(supervisor.get('alpha'))).not.toContain('old-supervisor-token')
    expect(JSON.stringify(supervisor.get('alpha'))).not.toContain(next.owner_token)
  })

  it('Web host stays loopback, does not start workers, and reports attached for CLI workers', async () => {
    const sourceRoot = isolatedHome('jea-packaged-soak-web-src-')
    const jeaHome = isolatedHome('jea-packaged-soak-web-home-')
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
      default_subject: 'alpha',
      subjects: {
        alpha: {
          data_namespace: 'alpha-data',
          evolution: { mode: 'on_demand' },
          channels: { desktop: { enabled: true, default_session: 'main' } }
        }
      }
    }))
    const runtime = createRuntimeContext({ sourceRoot, jeaHome })
    const now = new Date().toISOString()
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'external-cli',
      pid: process.pid,
      status: 'running',
      started_at: now,
      heartbeat_at: now,
      stale_after_ms: 60_000
    })
    writeChannelWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: process.pid,
      status: 'running',
      started_at: now,
      heartbeat_at: now,
      coordinator: { pid: process.pid, started_at: now },
      workers: {
        notify: {
          role: 'notify',
          worker_id: 'external-cli-channel',
          pid: process.pid,
          status: 'running',
          started_at: now,
          heartbeat_at: now,
          stale_after_ms: 60_000
        }
      }
    })
    const token = 'c'.repeat(40)
    const host = await createWebHost({
      sourceRoot,
      jeaHome,
      token,
      port: 0,
      watcher: { start() {}, stop() {} }
    })
    hosts.push(host)
    expect(host.address).toBe('127.0.0.1')
    expect(host.server.address()).toMatchObject({ address: '127.0.0.1', port: host.port })
    await expect(createWebHost({
      sourceRoot,
      jeaHome,
      token: 'd'.repeat(40),
      address: '0.0.0.0',
      port: 0,
      watcher: { start() {}, stop() {} }
    })).rejects.toMatchObject({
      code: 'WEB_HOST_BIND_NOT_LOOPBACK'
    })

    const web = createWebJeaClient({ baseUrl: host.origin, token })
    const status = await web.getServiceStatus('alpha')
    expect(status.mode).toBe('attached')
    expect(status.pid).toBe(process.pid)
    const readiness = await web.getServiceReadiness('alpha')
    expect(readiness.cycle.state).toBe('attached')
    expect(readiness.channel.state).toBe('attached')
    expect(readiness.allowed_actions).not.toContain('start_cycle')
    expect(readiness.allowed_actions).not.toContain('start_channel')
    expect(readiness.allowed_actions).not.toContain('stop_managed')
    expect(readiness.allowed_actions).toEqual(['none'])
    await expect(web.startService('alpha', 'cycle')).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED'
    })
    await expect(web.startService('alpha', 'channel')).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED'
    })
    expect(readWorkerState(runtime, 'alpha')).toMatchObject({
      worker_id: 'external-cli',
      pid: process.pid,
      status: 'running'
    })
  })
})
