import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  inspectWorkerRepair,
  markWorkerStopped,
  readWorkerState,
  reconcileWorkerState,
  requestWorkerStop,
  summarizeWorkerState
} from '../../../../src/daemon/daemon-worker-state.mjs'
import {
  inspectChannelWorkerRepair,
  readChannelWorkerState,
  repairChannelWorkerState,
  requestChannelWorkerStop,
  safeMarkChannelRoleWorkerStopped,
  summarizeChannelWorkersState
} from '../../../../src/channel/worker-state.mjs'
import { listRegisteredSubjects } from '../../../../src/infra/subjects.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { jeaLogsDir } from '../../../../src/infra/jea-home.mjs'
import { recordDaemonStartupFailure } from '../../../../src/product/diagnostics-store.mjs'
import { redactJeaOwnedPath } from '../../../../src/product/path-redact.mjs'
import {
  createSupervisorLease,
  DEFAULT_DESKTOP_SUPERVISOR_LEASE_RENEW_MS,
  DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS,
  inspectSupervisorLease,
  readSupervisorLease,
  removeSupervisorLease,
  renewSupervisorLease
} from '../../../../src/product/supervisor-lease.mjs'
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
  leasePath: string
  leaseTimer: NodeJS.Timeout | null
  leaseStatus: 'active' | 'lost'
  leaseExpiresAt: string | null
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
  private readonly supervisorLeaseTtlMs: number
  private readonly supervisorLeaseRenewMs: number

  constructor(
    readonly projectRoot: string,
    private readonly processRegistry: ManagedProcessRegistry,
    private readonly events: DesktopEventBus,
    private readonly spawnImpl: SpawnDaemon = spawn,
    private readonly killGraceMs = 10_000,
    jeaHome: string | undefined = process.env.JEA_HOME,
    private readonly startupTimeoutMs = spawnImpl === spawn ? 10_000 : 0,
    private readonly runtimeExecPath = process.execPath,
    leaseOptions: { ttlMs?: number; renewMs?: number } = {}
  ) {
    this.runtimeContext = createDesktopServiceRuntimeContext(projectRoot, jeaHome)
    this.supervisorLeaseTtlMs = Math.max(
      1,
      Math.floor(leaseOptions.ttlMs ?? DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS)
    )
    this.supervisorLeaseRenewMs = Math.max(
      1,
      Math.min(
        this.supervisorLeaseTtlMs,
        Math.floor(leaseOptions.renewMs ?? DEFAULT_DESKTOP_SUPERVISOR_LEASE_RENEW_MS)
      )
    )
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
      const supervisorLeases = entries.map((entry) => ({
        required: true,
        status: entry.leaseStatus,
        expires_at: entry.leaseExpiresAt,
        domain: entry.domain
      } as const))
      return {
        subject,
        mode: entries.every((entry) => entry.stopping) ? 'stopping' : 'managed',
        pid: primary.child.pid ?? primary.ownedPid,
        domain,
        heartbeat_at: cycle.heartbeat_at ?? channelHeartbeat,
        started_at: primary.startedAt,
        log_paths: primary.logPaths,
        supervisor_lease: supervisorLeases.find((lease) => lease.domain === primary.domain) ?? null,
        supervisor_leases: supervisorLeases,
        detail: null
      }
    }

    const supervisorLeases = this.observeLeases(subject, cycleRaw, channelRaw)
    const supervisorLease = supervisorLeases[0] ?? null
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
      supervisor_lease: supervisorLease,
      supervisor_leases: supervisorLeases,
      detail: mode === 'attached'
        ? (
            supervisorLease?.required
              ? 'Desktop-managed daemon belongs to a previous supervisor instance.'
              : 'Daemon is externally managed.'
          )
        : null
    }
  }

  async start(subject: string, {
    domain = 'all'
  }: { domain?: DaemonDomain } = {}): Promise<DaemonSupervisorView> {
    this.assertSubject(subject)
    this.assertDomain(domain)
    return this.withStartLock(subject, () => this.startLocked(subject, domain))
  }

  managedDomains(subject: string): DaemonDomain[] {
    this.assertSubject(subject)
    return this.managedEntriesFor(subject).map((entry) => entry.domain)
  }

  owns(subject: string, domain: Exclude<DaemonDomain, 'all'>): boolean {
    return this.coveringManaged(subject, domain) != null
  }

  /**
   * Attach to a fresh worker, restart an owned stale/zombie worker, repair an
   * unowned zombie then start, or attach an external stale worker without spawn.
   */
  async ensure(subject: string, {
    domain = 'cycle'
  }: { domain?: DaemonDomain } = {}): Promise<DaemonSupervisorView> {
    this.assertSubject(subject)
    this.assertDomain(domain)
    return this.withStartLock(subject, () => this.ensureLocked(subject, domain))
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
    const cycleInspection = cycleNeeded
      ? inspectWorkerRepair(readWorkerState(this.runtimeContext, subject))
      : { blocked: false, needed: false, reason: 'skipped' }
    const channelInspection = channelNeeded
      ? inspectChannelWorkerRepair(readChannelWorkerState(this.runtimeContext, subject))
      : { blocked: false, needed: false, reason: 'skipped' }
    if (cycleInspection.blocked || channelInspection.blocked) {
      const reason = cycleInspection.blocked ? cycleInspection.reason : channelInspection.reason
      throw new PublicCommandError(
        'CONFLICT',
        reason === 'pid_alive' ? LIVE_REPAIR_ERROR : UNSAFE_REPAIR_ERROR
      )
    }
    if (cycleNeeded && cycleInspection.needed) {
      const result = reconcileWorkerState(this.runtimeContext, subject)
      if (result.blocked) {
        throw new PublicCommandError(
          'CONFLICT',
          result.reason === 'pid_alive' ? LIVE_REPAIR_ERROR : UNSAFE_REPAIR_ERROR
        )
      }
    }
    if (channelNeeded && channelInspection.needed) {
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

  private domainHealth(
    subject: string,
    domain: Exclude<DaemonDomain, 'all'>
  ): 'fresh' | 'stale' | 'zombie' | 'missing' {
    if (domain === 'cycle') {
      const cycle = summarizeWorkerState(readWorkerState(this.runtimeContext, subject))
      if (cycle.running) return 'fresh'
      if (cycle.zombie) return 'zombie'
      if (cycle.stale) return 'stale'
      return 'missing'
    }
    const channel = summarizeChannelWorkersState(
      readChannelWorkerState(this.runtimeContext, subject)
    )
    if (channel.running_count > 0 && channel.stale_count === 0 && channel.zombie_count === 0) {
      return 'fresh'
    }
    if (channel.zombie_count > 0 && channel.running_count === 0) return 'zombie'
    if (channel.stale_count > 0) return 'stale'
    if (channel.running_count > 0) return 'fresh'
    return 'missing'
  }

  private repairDiskState(subject: string, domain: DaemonDomain): void {
    if (domain !== 'channel') reconcileWorkerState(this.runtimeContext, subject)
    if (domain !== 'cycle') repairChannelWorkerState(this.runtimeContext, subject)
  }

  private async ensureOne(
    subject: string,
    domain: Exclude<DaemonDomain, 'all'>
  ): Promise<DaemonSupervisorView> {
    const health = this.domainHealth(subject, domain)
    const owned = this.coveringManaged(subject, domain)

    if (health === 'fresh') return this.get(subject)

    if (owned && (health === 'stale' || health === 'zombie')) {
      await this.stopEntry(owned, health === 'zombie' ? 'zombie_restart' : 'stale_restart')
      this.repairDiskState(subject, domain)
      return this.startLocked(subject, domain)
    }

    if (health === 'stale') return this.get(subject)

    if (health === 'zombie') {
      this.repairDiskState(subject, domain)
    }
    return this.startLocked(subject, domain)
  }

  private async ensureLocked(subject: string, domain: DaemonDomain): Promise<DaemonSupervisorView> {
    if (domain === 'all') {
      await this.ensureOne(subject, 'cycle')
      await this.ensureOne(subject, 'channel')
      return this.get(subject)
    }
    return this.ensureOne(subject, domain)
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
    delete effectiveEnv.JEA_DESKTOP_SUPERVISOR_OWNER_TOKEN
    const leasePath = this.diagnosticPath(subject, domain)
    let initialLease
    try {
      initialLease = createSupervisorLease(leasePath, {
        ownerToken,
        subject,
        domain,
        managedWorkerPid: null,
        startedAt,
        ttlMs: this.supervisorLeaseTtlMs,
        renewMs: this.supervisorLeaseRenewMs
      })
    } catch (error) {
      closeSync(stdoutFd)
      closeSync(stderrFd)
      throw error
    }
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
          JEA_HOME: this.runtimeContext.jeaHome,
          JEA_DESKTOP_SUPERVISOR_LEASE_REQUIRED: '1',
          JEA_DESKTOP_SUPERVISOR_LEASE_RECORD: leasePath,
          JEA_DESKTOP_SUPERVISOR_SUBJECT: subject,
          JEA_DESKTOP_SUPERVISOR_DOMAIN: domain,
          JEA_DESKTOP_SUPERVISOR_LEASE_TTL_MS: String(this.supervisorLeaseTtlMs),
          JEA_DESKTOP_SUPERVISOR_LEASE_RENEW_MS: String(this.supervisorLeaseRenewMs)
        },
        windowsHide: true,
        detached: processGroup,
        stdio: ['ignore', stdoutFd, stderrFd]
      })
    } catch (error) {
      closeSync(stdoutFd)
      closeSync(stderrFd)
      removeSupervisorLease(leasePath, ownerToken)
      throw error
    }
    closeSync(stdoutFd)
    closeSync(stderrFd)

    try {
      await new Promise<void>((resolvePromise, reject) => {
        child.once('spawn', resolvePromise)
        child.once('error', reject)
      })
    } catch (error) {
      removeSupervisorLease(leasePath, ownerToken)
      throw error
    }

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
      removeSupervisorLease(leasePath, ownerToken)
      this.recordStartupFailure(subject, error, logPaths)
      throw this.withLogPaths(error, logPaths)
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
      leasePath,
      leaseTimer: null,
      leaseStatus: 'active',
      leaseExpiresAt: initialLease.lease_expires_at,
      unregister
    }
    this.managed.set(managedKey(subject, domain), entry)
    child.once('close', () => {
      if (this.managed.get(managedKey(subject, domain))?.ownerToken === ownerToken) {
        this.stopLeaseRenewal(entry)
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
      this.startLeaseRenewal(entry)
    } catch (error) {
      if (this.managed.get(managedKey(subject, domain))?.ownerToken === ownerToken) {
        this.managed.delete(managedKey(subject, domain))
      }
      unregister()
      this.stopLeaseRenewal(entry)
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
      this.stopLeaseRenewal(entry)
      this.removeDiagnostic(subject, domain, ownerToken)
      if (!processExited(child)) await this.terminateChild(child, processGroup, ownedPid)
      this.recordStartupFailure(subject, error, logPaths)
      throw this.withLogPaths(error, logPaths)
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
    this.stopLeaseRenewal(entry)
    try {
      this.writeDiagnostic(entry)
    } catch {
      // The in-memory child handle remains authoritative for explicit stop.
    }

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

  private observeLeases(
    subject: string,
    cycleState: Record<string, any> | null,
    channelState: Record<string, any> | null
  ): NonNullable<DaemonSupervisorView['supervisor_leases']> {
    const cyclePid = Number(cycleState?.pid) || null
    const channelPid = Number(channelState?.coordinator?.pid ?? channelState?.pid) || null
    const candidates: Array<{ domain: DaemonDomain; stateRequired: boolean; pids: Array<number | null> }> = [
      {
        domain: 'all',
        stateRequired: cycleState?.supervisor?.required === true || channelState?.supervisor?.required === true,
        pids: [cyclePid, channelPid]
      },
      {
        domain: 'cycle',
        stateRequired: cycleState?.supervisor?.required === true,
        pids: [cyclePid]
      },
      {
        domain: 'channel',
        stateRequired: channelState?.supervisor?.required === true,
        pids: [channelPid]
      }
    ]
    const observed = candidates.flatMap(({ domain, stateRequired, pids }) => {
      const record = readSupervisorLease(this.diagnosticPath(subject, domain))
      if (!record) return []
      const recordPid = Number(record.managed_worker_pid ?? record.pid) || null
      const pidMatches = recordPid != null && pids.includes(recordPid)
      if (!stateRequired && !pidMatches) return []
      const inspection = inspectSupervisorLease(record, {
        subject,
        domain,
        nowMs: Date.now()
      })
      return [{
        required: inspection.required,
        status: inspection.status,
        expires_at: inspection.expires_at,
        domain
      }]
    })
    return observed.sort((left, right) => {
      const priority = { stopping: 0, active: 1, expired: 2, owner_mismatch: 3, legacy: 4, missing: 5 }
      return (priority[left.status as keyof typeof priority] ?? 9)
        - (priority[right.status as keyof typeof priority] ?? 9)
    })
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
    const result = renewSupervisorLease(entry.leasePath, {
      ownerToken: entry.ownerToken,
      managedWorkerPid: entry.ownedPid,
      stopping: entry.stopping
    })
    if (!result.renewed) {
      entry.leaseStatus = 'lost'
      entry.leaseExpiresAt = result.record?.lease_expires_at ?? null
      throw new Error('desktop_supervisor_lease_lost')
    }
    entry.leaseStatus = 'active'
    entry.leaseExpiresAt = result.record.lease_expires_at
  }

  private removeDiagnostic(subject: string, domain: DaemonDomain, ownerToken: string): void {
    removeSupervisorLease(this.diagnosticPath(subject, domain), ownerToken)
  }

  private startLeaseRenewal(entry: ManagedDaemon): void {
    this.stopLeaseRenewal(entry)
    entry.leaseTimer = setInterval(() => {
      try {
        this.writeDiagnostic(entry)
      } catch {
        this.stopLeaseRenewal(entry)
        this.events.publish({
          type: 'daemon_supervisor_lease_lost',
          subject: entry.subject,
          payload: {
            pid: entry.ownedPid,
            domain: entry.domain,
            reason: 'lease_renew_failed'
          }
        })
      }
    }, this.supervisorLeaseRenewMs)
    entry.leaseTimer.unref?.()
  }

  private stopLeaseRenewal(entry: ManagedDaemon): void {
    if (entry.leaseTimer) clearInterval(entry.leaseTimer)
    entry.leaseTimer = null
  }

  private recordStartupFailure(subject: string, error: unknown, logPaths: { stdout: string; stderr: string }): void {
    const message = error instanceof Error ? error.message : String(error)
    const reason = message.includes('startup deadline') || message.includes('startup timeout')
      ? 'startup_deadline'
      : (message.includes('exited before becoming ready') ? 'exited_before_ready' : 'startup_failed')
    try {
      recordDaemonStartupFailure(this.runtimeContext, { subject, reason, logPaths })
    } catch {
      // Diagnostic persistence must not change start/stop/repair outcomes.
    }
  }

  private withLogPaths(error: unknown, logPaths: { stdout: string; stderr: string }): unknown {
    if (!(error instanceof PublicCommandError)) return error
    const stdout = this.redactLogPath(logPaths.stdout)
    const stderr = this.redactLogPath(logPaths.stderr)
    if (error.message.includes(stdout) || error.message.includes(stderr)) return error
    return new PublicCommandError(
      error.code,
      `${error.message} Logs: ${stdout}, ${stderr}`
    )
  }

  private redactLogPath(absPath: string): string {
    return redactJeaOwnedPath(absPath, this.runtimeContext.jeaHome) || '<JEA_HOME>/logs/daemon.log'
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
