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
import { dirname, join } from 'node:path'
import {
  markWorkerStopped,
  readWorkerState,
  requestWorkerStop,
  summarizeWorkerState
} from '../../../../src/daemon/daemon-worker-state.mjs'
import {
  readChannelWorkerState,
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

type DaemonDomain = 'all' | 'cycle' | 'channel'
type SpawnDaemon = typeof spawn

interface ManagedDaemon {
  subject: string
  ownerToken: string
  child: ChildProcess
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

export class DaemonSupervisor {
  private readonly managed = new Map<string, ManagedDaemon>()
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
    const entry = this.managed.get(subject)
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

    if (entry && !processExited(entry.child)) {
      return {
        subject,
        mode: entry.stopping ? 'stopping' : 'managed',
        pid: entry.child.pid ?? null,
        domain: entry.domain,
        heartbeat_at: cycle.heartbeat_at ?? channelHeartbeat,
        started_at: entry.startedAt,
        log_paths: entry.logPaths,
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
    if (!['all', 'cycle', 'channel'].includes(domain)) {
      throw new PublicCommandError('INVALID_REQUEST', 'Invalid daemon domain.')
    }
    if (this.managed.has(subject)) {
      throw new PublicCommandError('CONFLICT', 'A managed daemon is already running.')
    }
    const cycle = summarizeWorkerState(readWorkerState(this.runtimeContext, subject))
    const channel = summarizeChannelWorkersState(
      readChannelWorkerState(this.runtimeContext, subject)
    )
    const cycleConflict = domain !== 'channel' && (cycle.running || cycle.stale)
    const channelConflict = domain !== 'cycle'
      && (channel.running_count > 0 || channel.stale_count > 0)
    if (cycleConflict || channelConflict) {
      throw new PublicCommandError('CONFLICT', 'An external daemon is already running.')
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

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    let unregister: () => void
    try {
      unregister = this.processRegistry.register({
        kind: 'daemon',
        id: subject,
        pid: child.pid ?? null,
        cleanup: async () => {
          await this.stop(subject, 'app_quit')
        }
      })
    } catch (error) {
      await this.terminateChild(child, processGroup)
      throw error
    }
    const entry: ManagedDaemon = {
      subject,
      ownerToken,
      child,
      domain,
      startedAt,
      stopping: false,
      processGroup,
      logPaths,
      unregister
    }
    this.managed.set(subject, entry)
    child.once('close', () => {
      if (this.managed.get(subject)?.ownerToken === ownerToken) {
        this.managed.delete(subject)
        unregister()
        this.removeDiagnostic(subject, ownerToken)
        this.events.publish({
          type: 'daemon_managed_stopped',
          subject,
          payload: { pid: child.pid ?? null }
        })
      }
    })
    try {
      this.writeDiagnostic(entry)
    } catch (error) {
      if (this.managed.get(subject)?.ownerToken === ownerToken) {
        this.managed.delete(subject)
      }
      unregister()
      this.removeDiagnostic(subject, ownerToken)
      await this.terminateChild(child, processGroup)
      throw error
    }
    try {
      await this.waitForStartup(entry)
    } catch (error) {
      if (this.managed.get(subject)?.ownerToken === ownerToken) {
        this.managed.delete(subject)
      }
      unregister()
      this.removeDiagnostic(subject, ownerToken)
      if (!processExited(child)) await this.terminateChild(child, processGroup)
      throw error
    }
    this.events.publish({
      type: 'daemon_managed_started',
      subject,
      payload: { pid: child.pid ?? null, domain }
    })
    return this.get(subject)
  }

  private async waitForStartup(entry: ManagedDaemon): Promise<void> {
    if (this.startupTimeoutMs <= 0) return
    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() < deadline) {
      if (processExited(entry.child)) {
        throw new PublicCommandError(
          'OPERATION_FAILED',
          'The JEA daemon exited before becoming ready. Check the JEA daemon logs.'
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
      'The JEA daemon did not become ready before the startup deadline. Check the JEA daemon logs.'
    )
  }

  async stop(subject: string, reason = 'operator'): Promise<DaemonSupervisorView> {
    this.assertSubject(subject)
    const entry = this.managed.get(subject)
    if (!entry || processExited(entry.child)) {
      throw new PublicCommandError('CONFLICT', 'The daemon is not managed by this client.')
    }
    if (entry.stopping) return this.get(subject)
    entry.stopping = true
    this.writeDiagnostic(entry)

    if (entry.domain !== 'channel') requestWorkerStop(this.runtimeContext, subject)
    if (entry.domain !== 'cycle') requestChannelWorkerStop(this.runtimeContext, subject)
    await this.terminateChild(entry.child, entry.processGroup)
    if (entry.domain !== 'channel') {
      markWorkerStopped(this.runtimeContext, subject, {
        stop_reason: `desktop_${reason}`
      })
    }
    if (entry.domain !== 'cycle') {
      const channelState = readChannelWorkerState(this.runtimeContext, subject)
      for (const [role, worker] of Object.entries(channelState?.workers ?? {})) {
        const status = worker && typeof worker === 'object' && 'status' in worker
          ? String((worker as { status?: unknown }).status ?? '')
          : ''
        if (status !== 'running' && status !== 'stopping') continue
        safeMarkChannelRoleWorkerStopped(this.runtimeContext, subject, role, {
          stop_reason: `desktop_${reason}`
        })
      }
    }
    this.events.publish({
      type: 'daemon_managed_stop_requested',
      subject,
      payload: { reason }
    })
    return this.get(subject)
  }

  private diagnosticPath(subject: string): string {
    const runtime = runtimeForSubject(this.runtimeContext, subject)
    return join(runtime.evolutionDir, 'daemon', 'desktop-supervisor.json')
  }

  private async terminateChild(child: ChildProcess, processGroup = false): Promise<void> {
    if (processExited(child)) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    this.signalChild(child, 'SIGTERM', processGroup)
    const exited = await Promise.race([
      closed.then(() => true),
      delay(this.killGraceMs).then(() => false)
    ])
    if (!exited && !processExited(child)) {
      this.signalChild(child, 'SIGKILL', processGroup)
      await Promise.race([closed, delay(this.killGraceMs)])
    }
  }

  private signalChild(
    child: ChildProcess,
    signal: NodeJS.Signals,
    processGroup: boolean
  ): void {
    if (processGroup && child.pid) {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {
        // Injected test children and already-exited groups fall back to the direct handle.
      }
    }
    child.kill(signal)
  }

  private writeDiagnostic(entry: ManagedDaemon): void {
    const path = this.diagnosticPath(entry.subject)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      supervisor: 'jea-desktop',
      owner_token: entry.ownerToken,
      pid: entry.child.pid ?? null,
      domain: entry.domain,
      started_at: entry.startedAt,
      stopping: entry.stopping,
      updated_at: new Date().toISOString()
    }, null, 2), 'utf8')
  }

  private removeDiagnostic(subject: string, ownerToken: string): void {
    const path = this.diagnosticPath(subject)
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (record?.owner_token === ownerToken) rmSync(path, { force: true })
    } catch {
      // Missing or invalid diagnostic metadata is non-authoritative.
    }
  }

  private assertSubject(subject: string): void {
    if (!subject || !listRegisteredSubjects(this.runtimeContext).includes(subject)) {
      throw new PublicCommandError('NOT_FOUND', 'Requested subject is unavailable.')
    }
  }
}
