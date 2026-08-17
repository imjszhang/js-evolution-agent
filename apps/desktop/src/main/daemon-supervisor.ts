import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  markWorkerStopped,
  readWorkerState,
  reconcileWorkerState,
  requestWorkerStop,
  summarizeWorkerState
} from '../../../../src/daemon/daemon-worker-state.mjs'
import {
  readChannelWorkerState,
  repairChannelWorkerState,
  requestChannelWorkerStop,
  safeMarkChannelRoleWorkerStopped,
  summarizeChannelWorkersState
} from '../../../../src/channel/worker-state.mjs'
import { listRegisteredSubjects } from '../../../../src/infra/subjects.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { jeaLogsDir } from '../../../../src/infra/jea-home.mjs'
import { buildJeaRuntimeEnv } from '../../../../src/actions/execution-env.mjs'
import type {
  DaemonSupervisorView,
  DaemonSupervisorMode
} from '../shared/contract'
import { PublicCommandError } from './command-registry'
import type { DesktopEventBus } from './event-bus'
import type { ManagedProcessRegistry } from './managed-process-registry'
import { createDesktopServiceRuntimeContext } from './runtime-context'

export type DaemonDomain = 'all' | 'cycle' | 'channel'
type SpawnDaemon = typeof spawn

const OWNERSHIP_ERROR = 'The daemon is not managed by this client.'
const ATTACHED_START_ERROR = 'An external daemon is already running.'
const LIVE_WORKER_START_ERROR = 'A live worker is still present and cannot be replaced safely.'
const LIVE_REPAIR_ERROR = 'The worker process is still alive and cannot be repaired.'
const UNSAFE_REPAIR_ERROR = 'Worker ownership cannot be established safely.'
const PARTIAL_MANAGED_ERROR = 'A managed daemon already covers part of this domain.'

interface ManagedDaemon {
  subject: string
  ownerToken: string
  child: ChildProcess
  ownedPid: number | null
  domain: DaemonDomain
  startedAt: string
  stopping: boolean
  processGroup: boolean
  logPaths: { stdout: string; stderr: string }
  unregister: () => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function processExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null
}

function domainsOverlap(left: DaemonDomain, right: DaemonDomain): boolean {
  if (left === 'all' || right === 'all') return true
  return left === right
}

function managedKey(subject: string, domain: DaemonDomain): string {
  return `${subject}::${domain}`
}

function registryId(subject: string, domain: DaemonDomain): string {
  return domain === 'all' ? subject : `${subject}:${domain}`
}

export class DaemonSupervisor {
  private readonly managed = new Map<string, ManagedDaemon>()
  private readonly startLocks = new Map<string, Promise<unknown>>()
  private readonly runtimeContext: any

  constructor(
    readonly projectRoot: string,
    private readonly processRegistry: ManagedProcessRegistry,
    private readonly events: DesktopEventBus,
    private readonly spawnImpl: SpawnDaemon = spawn,
    private readonly killGraceMs = 10_000,
    jeaHome: string | undefined = process.env.JEA_HOME,
    private readonly startupTimeoutMs = spawnImpl === spawn ? 10_000 : 0,
    private readonly runtimeExecPath = process.execPath
  ) {
    this.runtimeContext = createDesktopServiceRuntimeContext(projectRoot, jeaHome)
  }

  get(subject: string): DaemonSupervisorView {
    this.assertSubject(subject)
    const entries = this.managedEntriesFor(subject)
    const cycleRaw = readWorkerState(this.runtimeContext, subject)
    const cycle = summarizeWorkerState(cycleRaw)
    const channelRaw = readChannelWorkerState(this.runtimeContext, subject)
    const channel = summarizeChannelWorkersState(channelRaw)
    const channelPid = Number(channelRaw?.coordinator?.pid ?? channelRaw?.pid) || null
    const channelHeartbeat = channel.roles
      .map((role: Record<string, any>) => role.heartbeat_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? channelRaw?.heartbeat_at ?? null

    if (entries.length > 0) {
      const primary = entries.find((entry) => entry.domain === 'all') ?? entries[0]
      const hasCycle = entries.some((entry) => entry.domain === 'cycle' || entry.domain === 'all')
      const hasChannel = entries.some((entry) => entry.domain === 'channel' || entry.domain === 'all')
      const domain = primary.domain === 'all' || (hasCycle && hasChannel) ? 'all' : primary.domain
      return {
        subject,
        mode: entries.every((entry) => entry.stopping) ? 'stopping' : 'managed',
        pid: primary.child.pid ?? primary.ownedPid,
        domain,
        heartbeat_at: cycle.heartbeat_at ?? channelHeartbeat,
        started_at: primary.startedAt,
        log_paths: primary.logPaths,
        detail: null
      }
    }

    let mode: DaemonSupervisorMode = 'none'
    if (cycle.running || channel.running_count > 0) mode = 'attached'
    else if (cycle.stale || channel.stale_count > 0) mode = 'stale'
    else if (cycle.zombie || channel.zombie_count > 0) mode = 'zombie'

    return {
      subject,
      mode,
      pid: cycle.pid ?? channelPid,
      domain: null,
      heartbeat_at: cycle.heartbeat_at ?? channelHeartbeat,
      started_at: cycleRaw?.started_at ?? channelRaw?.coordinator?.started_at ?? null,
      log_paths: null,
      detail: mode === 'attached' ? 'Daemon is externally managed.' : null
    }
  }

  async start(subject: string, {
    domain = 'all'
  }: { domain?: DaemonDomain } = {}): Promise<DaemonSupervisorView> {
    this.assertSubject(subject)
    this.assertDomain(domain)
    return this.withStartLock(subject, () => this.startLocked(subject, domain))
  }

  async repair(subject: string, {
    domain = 'all'
  }: { domain?: DaemonDomain } = {}): Promise<DaemonSupervisorView> {
    this.assertSubject(subject)
    this.assertDomain(domain)
    if (this.coveringManaged(subject, domain) || this.overlappingManaged(subject, domain)) {
      throw new PublicCommandError('CONFLICT', 'A managed daemon is already running.')
    }
    const cycleNeeded = domain !== 'channel'
    const channelNeeded = domain !== 'cycle'
    if (cycleNeeded) {
      const result = reconcileWorkerState(this.runtimeContext, subject)
      if (result.blocked) {
        throw new PublicCommandError(
          'CONFLICT',
          result.reason === 'pid_alive' ? LIVE_REPAIR_ERROR : UNSAFE_REPAIR_ERROR
        )
      }
    }
    if (channelNeeded) {
      const result = repairChannelWorkerState(this.runtimeContext, subject)
      if (result.blocked) {
        throw new PublicCommandError(
          'CONFLICT',
          result.reason === 'pid_alive' ? LIVE_REPAIR_ERROR : UNSAFE_REPAIR_ERROR
        )
      }
    }
    return this.get(subject)
  }

  async stop(subject: string, reason = 'operator', {
    domain
  }: { domain?: DaemonDomain } = {}): Promise<DaemonSupervisorView> {
    this.assertSubject(subject)
    if (domain) this.assertDomain(domain)
    const entries = domain
      ? [this.managed.get(managedKey(subject, domain))].filter((entry): entry is ManagedDaemon => (
        Boolean(entry && !processExited(entry.child))
      ))
      : this.managedEntriesFor(subject)
    if (entries.length === 0) {
      throw new PublicCommandError('CONFLICT', OWNERSHIP_ERROR)
    }
    for (const entry of entries) {
      await this.stopEntry(entry, reason)
    }
    return this.get(subject)
  }

  private async startLocked(subject: string, domain: DaemonDomain): Promise<DaemonSupervisorView> {
    const covered = this.coveringManaged(subject, domain)
    if (covered) return this.get(subject)
    if (this.overlappingManaged(subject, domain)) {
      throw new PublicCommandError('CONFLICT', PARTIAL_MANAGED_ERROR)
    }

    const cycle = summarizeWorkerState(readWorkerState(this.runtimeContext, subject))
    const channel = summarizeChannelWorkersState(
      readChannelWorkerState(this.runtimeContext, subject)
    )
    if (domain !== 'channel' && cycle.running) {
      throw new PublicCommandError('CONFLICT', ATTACHED_START_ERROR)
    }
    if (domain !== 'cycle' && channel.running_count > 0) {
      throw new PublicCommandError('CONFLICT', ATTACHED_START_ERROR)
    }
    if (domain !== 'channel' && cycle.stale) {
      throw new PublicCommandError('CONFLICT', LIVE_WORKER_START_ERROR)
    }
    if (domain !== 'cycle' && channel.stale_count > 0) {
      throw new PublicCommandError('CONFLICT', LIVE_WORKER_START_ERROR)
    }
    if (domain !== 'channel' && cycle.zombie) {
      const repaired = reconcileWorkerState(this.runtimeContext, subject)
      if (repaired.blocked) {
        throw new PublicCommandError('CONFLICT', LIVE_REPAIR_ERROR)
      }
    }
    if (domain !== 'cycle' && channel.zombie_count > 0) {
      const repaired = repairChannelWorkerState(this.runtimeContext, subject)
      if (repaired.blocked) {
        throw new PublicCommandError('CONFLICT', LIVE_REPAIR_ERROR)
      }
    }

    const ownerToken = randomUUID()
    const startedAt = new Date().toISOString()
    const processGroup = process.platform !== 'win32' && this.spawnImpl === spawn
    const logDir = jeaLogsDir(this.runtimeContext)
    mkdirSync(logDir, { recursive: true })
    const slug = subject.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const logPaths = {
      stdout: join(logDir, `daemon-${slug}.desktop.stdout.log`),
      stderr: join(logDir, `daemon-${slug}.desktop.stderr.log`)
    }
    let stdoutFd: number | null = null
    let stderrFd: number | null = null
    try {
      stdoutFd = openSync(logPaths.stdout, 'a', 0o600)
      stderrFd = openSync(logPaths.stderr, 'a', 0o600)
      chmodSync(logPaths.stdout, 0o600)
      chmodSync(logPaths.stderr, 0o600)
    } catch (error) {
      if (stdoutFd != null) closeSync(stdoutFd)
      if (stderrFd != null) closeSync(stderrFd)
      throw error
    }
    if (stdoutFd == null || stderrFd == null) {
      throw new Error('daemon_log_open_failed')
    }
    const cliPath = join(this.projectRoot, 'src', 'cli', 'jea.mjs')
    const subjectRoot = runtimeForSubject(this.runtimeContext, subject).runtimeRoot
    const effectiveEnv = buildJeaRuntimeEnv(this.runtimeContext.jeaHome, {
      baseEnv: process.env,
      subjectRoot
    }).env
    let child: ChildProcess
    try {
      child = this.spawnImpl(this.runtimeExecPath, [
        '--preserve-symlinks',
        cliPath,
        'daemon',
        'start',
        '--subject',
        subject,
        '--domain',
        domain
      ], {
        cwd: this.projectRoot,
        env: {
          ...effectiveEnv,
          ELECTRON_RUN_AS_NODE: '1',
          JEA_PROJECT_ROOT: this.projectRoot,
          JEA_HOME: this.runtimeContext.jeaHome
        },
        windowsHide: true,
        detached: processGroup,
        stdio: ['ignore', stdoutFd, stderrFd]
      })
    } catch (error) {
      closeSync(stdoutFd)
      closeSync(stderrFd)
      throw error
    }
    closeSync(stdoutFd)
    closeSync(stderrFd)

    await new Promise<void>((resolvePromise, reject) => {
      child.once('spawn', resolvePromise)
      child.once('error', reject)
    })

    const ownedPid = child.pid ?? null
    let unregister: () => void
    try {
      unregister = this.processRegistry.register({
        kind: 'daemon',
        id: registryId(subject, domain),
        pid: ownedPid,
        cleanup: async () => {
          await this.stop(subject, 'app_quit', { domain })
        }
      })
    } catch (error) {
      await this.terminateChild(child, processGroup, ownedPid)
      throw error
    }
    const entry: ManagedDaemon = {
      subject,
      ownerToken,
      child,
      ownedPid,
      domain,
      startedAt,
      stopping: false,
      processGroup,
      logPaths,
      unregister
    }
    this.managed.set(managedKey(subject, domain), entry)
    child.once('close', () => {
      if (this.managed.get(managedKey(subject, domain))?.ownerToken === ownerToken) {
        this.managed.delete(managedKey(subject, domain))
        unregister()
        this.removeDiagnostic(subject, domain, ownerToken)
        this.events.publish({
          type: 'daemon_managed_stopped',
          subject,
          payload: { pid: ownedPid, domain }
        })
      }
    })
    try {
      this.writeDiagnostic(entry)
    } catch (error) {
      if (this.managed.get(managedKey(subject, domain))?.ownerToken === ownerToken) {
        this.managed.delete(managedKey(subject, domain))
      }
      unregister()
      this.removeDiagnostic(subject, domain, ownerToken)
      await this.terminateChild(child, processGroup, ownedPid)
      throw error
    }
    try {
      await this.waitForStartup(entry)
    } catch (error) {
      if (this.managed.get(managedKey(subject, domain))?.ownerToken === ownerToken) {
        this.managed.delete(managedKey(subject, domain))
      }
      unregister()
      this.removeDiagnostic(subject, domain, ownerToken)
      if (!processExited(child)) await this.terminateChild(child, processGroup, ownedPid)
      throw error
    }
    this.events.publish({
      type: 'daemon_managed_started',
      subject,
      payload: { pid: ownedPid, domain }
    })
    return this.get(subject)
  }

  private async waitForStartup(entry: ManagedDaemon): Promise<void> {
    if (this.startupTimeoutMs <= 0) return
    const deadline = Date.now() + this.startupTimeoutMs
    const logHint = this.redactLogPath(entry.logPaths.stderr)
    while (Date.now() < deadline) {
      if (processExited(entry.child)) {
        throw new PublicCommandError(
          'OPERATION_FAILED',
          `The JEA daemon exited before becoming ready. See ${logHint}.`
        )
      }
      const cycle = summarizeWorkerState(readWorkerState(this.runtimeContext, entry.subject))
      const channel = summarizeChannelWorkersState(
        readChannelWorkerState(this.runtimeContext, entry.subject)
      )
      const cycleReady = entry.domain === 'channel' || cycle.running
      const channelReady = entry.domain === 'cycle' || channel.running_count > 0
      if (cycleReady && channelReady) return
      await delay(50)
    }
    throw new PublicCommandError(
      'OPERATION_FAILED',
      `The JEA daemon did not become ready before the startup timeout. See ${logHint}.`
    )
  }

  private async stopEntry(entry: ManagedDaemon, reason: string): Promise<void> {
    const pid = entry.child.pid ?? null
    if (entry.ownedPid == null || pid == null || pid !== entry.ownedPid) {
      throw new PublicCommandError('CONFLICT', OWNERSHIP_ERROR)
    }
    if (entry.stopping) return
    entry.stopping = true
    this.writeDiagnostic(entry)

    if (entry.domain !== 'channel') requestWorkerStop(this.runtimeContext, entry.subject)
    if (entry.domain !== 'cycle') requestChannelWorkerStop(this.runtimeContext, entry.subject)
    await this.terminateChild(entry.child, entry.processGroup, entry.ownedPid)
    if (entry.domain !== 'channel') {
      markWorkerStopped(this.runtimeContext, entry.subject, {
        stop_reason: `desktop_${reason}`
      })
    }
    if (entry.domain !== 'cycle') {
      const channelState = readChannelWorkerState(this.runtimeContext, entry.subject)
      for (const [role, worker] of Object.entries(channelState?.workers ?? {})) {
        const status = worker && typeof worker === 'object' && 'status' in worker
          ? String((worker as { status?: unknown }).status ?? '')
          : ''
        if (status !== 'running' && status !== 'stopping') continue
        safeMarkChannelRoleWorkerStopped(this.runtimeContext, entry.subject, role, {
          stop_reason: `desktop_${reason}`
        })
      }
    }
    this.events.publish({
      type: 'daemon_managed_stop_requested',
      subject: entry.subject,
      payload: { reason }
    })
  }

  private diagnosticPath(subject: string, domain: DaemonDomain): string {
    const runtime = runtimeForSubject(this.runtimeContext, subject)
    const suffix = domain === 'all' ? '' : `-${domain}`
    return join(runtime.evolutionDir, 'daemon', `desktop-supervisor${suffix}.json`)
  }

  private async terminateChild(
    child: ChildProcess,
    processGroup = false,
    ownedPid: number | null = child.pid ?? null
  ): Promise<void> {
    if (processExited(child)) return
    const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
    this.signalChild(child, 'SIGTERM', processGroup, ownedPid)
    const exited = await Promise.race([
      closed.then(() => true),
      delay(this.killGraceMs).then(() => false)
    ])
    if (!exited && !processExited(child)) {
      this.signalChild(child, 'SIGKILL', processGroup, ownedPid)
      await Promise.race([closed, delay(this.killGraceMs)])
    }
  }

  private signalChild(
    child: ChildProcess,
    signal: NodeJS.Signals,
    processGroup: boolean,
    ownedPid: number | null
  ): void {
    if (processExited(child)) return
    const pid = child.pid ?? null
    if (ownedPid == null || pid == null || pid !== ownedPid) return
    if (processGroup) {
      try {
        process.kill(-ownedPid, signal)
        return
      } catch {
        // Injected test children and already-exited groups fall back to the direct handle.
      }
    }
    child.kill(signal)
  }

  private writeDiagnostic(entry: ManagedDaemon): void {
    const path = this.diagnosticPath(entry.subject, entry.domain)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      supervisor: 'jea-desktop',
      owner_token: entry.ownerToken,
      pid: entry.ownedPid,
      domain: entry.domain,
      started_at: entry.startedAt,
      stopping: entry.stopping,
      updated_at: new Date().toISOString()
    }, null, 2), 'utf8')
  }

  private removeDiagnostic(subject: string, domain: DaemonDomain, ownerToken: string): void {
    const path = this.diagnosticPath(subject, domain)
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (record?.owner_token === ownerToken) rmSync(path, { force: true })
    } catch {
      // Missing or invalid diagnostic metadata is non-authoritative.
    }
  }

  private redactLogPath(absPath: string): string {
    const home = resolve(String(this.runtimeContext.jeaHome))
    const resolved = resolve(absPath)
    if (resolved === home || resolved.startsWith(`${home}${sep}`)) {
      return `<JEA_HOME>/${relative(home, resolved).split(sep).join('/')}`
    }
    return '<JEA_HOME>/logs/daemon.log'
  }

  private managedEntriesFor(subject: string): ManagedDaemon[] {
    return [...this.managed.values()].filter((entry) => (
      entry.subject === subject && !processExited(entry.child)
    ))
  }

  private coveringManaged(subject: string, domain: DaemonDomain): ManagedDaemon | null {
    const entries = this.managedEntriesFor(subject)
    if (domain === 'all') {
      const all = entries.find((entry) => entry.domain === 'all')
      if (all) return all
      const hasCycle = entries.some((entry) => entry.domain === 'cycle' || entry.domain === 'all')
      const hasChannel = entries.some((entry) => entry.domain === 'channel' || entry.domain === 'all')
      return hasCycle && hasChannel ? entries[0] ?? null : null
    }
    return entries.find((entry) => entry.domain === domain || entry.domain === 'all') ?? null
  }

  private overlappingManaged(subject: string, domain: DaemonDomain): boolean {
    return this.managedEntriesFor(subject).some((entry) => domainsOverlap(entry.domain, domain))
  }

  private async withStartLock<T>(subject: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.startLocks.get(subject) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(fn)
    this.startLocks.set(subject, run)
    try {
      return await run
    } finally {
      if (this.startLocks.get(subject) === run) this.startLocks.delete(subject)
    }
  }

  private assertDomain(domain: DaemonDomain): void {
    if (!['all', 'cycle', 'channel'].includes(domain)) {
      throw new PublicCommandError('INVALID_REQUEST', 'Invalid daemon domain.')
    }
  }

  private assertSubject(subject: string): void {
    if (!subject || !listRegisteredSubjects(this.runtimeContext).includes(subject)) {
      throw new PublicCommandError('NOT_FOUND', 'Requested subject is unavailable.')
    }
  }
}
