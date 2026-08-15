import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  readWorkerState,
  requestWorkerStop,
  summarizeWorkerState
} from '../../../../src/daemon/daemon-worker-state.mjs'
import {
  readChannelWorkerState,
  requestChannelWorkerStop,
  summarizeChannelWorkersState
} from '../../../../src/channel/worker-state.mjs'
import { listRegisteredSubjects } from '../../../../src/infra/subjects.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import type {
  DaemonSupervisorView,
  DaemonSupervisorMode
} from '../shared/contract'
import { PublicCommandError } from './command-registry'
import type { DesktopEventBus } from './event-bus'
import type { ManagedProcessRegistry } from './managed-process-registry'

type DaemonDomain = 'all' | 'cycle' | 'channel'
type SpawnDaemon = typeof spawn

interface ManagedDaemon {
  subject: string
  ownerToken: string
  child: ChildProcess
  domain: DaemonDomain
  startedAt: string
  stopping: boolean
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

  constructor(
    readonly projectRoot: string,
    private readonly processRegistry: ManagedProcessRegistry,
    private readonly events: DesktopEventBus,
    private readonly spawnImpl: SpawnDaemon = spawn,
    private readonly killGraceMs = 5_000
  ) {}

  get(subject: string): DaemonSupervisorView {
    this.assertSubject(subject)
    const entry = this.managed.get(subject)
    const cycleRaw = readWorkerState(this.projectRoot, subject)
    const cycle = summarizeWorkerState(cycleRaw)
    const channelRaw = readChannelWorkerState(this.projectRoot, subject)
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
    if (cycle.zombie || channel.zombie_count > 0) mode = 'zombie'
    else if (cycle.stale || channel.stale_count > 0) mode = 'stale'
    else if (cycle.running || channel.running_count > 0) mode = 'attached'

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
    const current = this.get(subject)
    if (current.mode !== 'none' && current.mode !== 'zombie' && current.mode !== 'stale') {
      throw new PublicCommandError('CONFLICT', 'An external daemon is already running.')
    }

    const ownerToken = randomUUID()
    const startedAt = new Date().toISOString()
    const logDir = join(this.projectRoot, 'runtime', 'logs')
    mkdirSync(logDir, { recursive: true })
    const slug = subject.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const logPaths = {
      stdout: join(logDir, `daemon-${slug}.desktop.stdout.log`),
      stderr: join(logDir, `daemon-${slug}.desktop.stderr.log`)
    }
    const stdoutFd = openSync(logPaths.stdout, 'a')
    const stderrFd = openSync(logPaths.stderr, 'a')
    const cliPath = join(this.projectRoot, 'src', 'cli', 'jea.mjs')
    let child: ChildProcess
    try {
      child = this.spawnImpl(process.execPath, [
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
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          JEA_PROJECT_ROOT: this.projectRoot
        },
        windowsHide: true,
        detached: false,
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

    const unregister = this.processRegistry.register({
      kind: 'daemon',
      id: subject,
      pid: child.pid ?? null,
      cleanup: () => this.stop(subject, 'app_quit')
    })
    const entry: ManagedDaemon = {
      subject,
      ownerToken,
      child,
      domain,
      startedAt,
      stopping: false,
      logPaths,
      unregister
    }
    this.managed.set(subject, entry)
    this.writeDiagnostic(entry)
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
    this.events.publish({
      type: 'daemon_managed_started',
      subject,
      payload: { pid: child.pid ?? null, domain }
    })
    return this.get(subject)
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

    if (entry.domain !== 'channel') requestWorkerStop(this.projectRoot, subject)
    if (entry.domain !== 'cycle') requestChannelWorkerStop(this.projectRoot, subject)
    entry.child.kill('SIGTERM')
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => entry.child.once('close', () => resolve(true))),
      delay(this.killGraceMs).then(() => false)
    ])
    if (!exited && !processExited(entry.child)) {
      entry.child.kill('SIGKILL')
      await Promise.race([
        new Promise<void>((resolve) => entry.child.once('close', () => resolve())),
        delay(this.killGraceMs)
      ])
    }
    this.events.publish({
      type: 'daemon_managed_stop_requested',
      subject,
      payload: { reason }
    })
    return this.get(subject)
  }

  private diagnosticPath(subject: string): string {
    const runtime = runtimeForSubject(this.projectRoot, subject)
    return join(runtime.evolutionDir, 'daemon', 'desktop-supervisor.json')
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
    if (!subject || !listRegisteredSubjects(this.projectRoot).includes(subject)) {
      throw new PublicCommandError('NOT_FOUND', 'Requested subject is unavailable.')
    }
  }
}
