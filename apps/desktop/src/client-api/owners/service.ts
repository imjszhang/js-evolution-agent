import { resolveDesktopConfig } from '../../../../../src/channel/adapters/desktop/config.mjs'
import { enqueueCycleStartRequestWithEvent } from '../../../../../src/daemon/cycle-dispatch.mjs'
import { buildDaemonProjection } from '../../../../../src/daemon/daemon-projection.mjs'
import { resolveModelReadiness } from '../../../../../src/actions/execution-env.mjs'
import { getSubjectEntry } from '../../../../../src/infra/subjects.mjs'
import { PublicClientError } from '../errors'
import { observeWebHost, projectSubjectReadiness } from '../readiness'
import { redactPublicValue } from '../redact'
import type { ClientHostKind, CycleRequestResult, ServiceStatus, SubjectReadiness } from '../types'
import { requireSubject, subjectRuntime, type ClientRuntimeContext } from './runtime'

export interface ServiceProcessPort {
  get(subject: string): ServiceStatus
  start(subject: string, options?: { domain?: 'all' | 'cycle' | 'channel' }): Promise<ServiceStatus> | ServiceStatus
  stop(subject: string): Promise<ServiceStatus> | ServiceStatus
  repair?(
    subject: string,
    options?: { domain?: 'all' | 'cycle' | 'channel' }
  ): Promise<ServiceStatus> | ServiceStatus
}

export function createProjectionServicePort(runtime: ClientRuntimeContext): ServiceProcessPort {
  return {
    get(subject: string): ServiceStatus {
      const daemon = buildDaemonProjection(runtime, subject, { eventLimit: 10 })
      return {
        subject,
        mode: daemon.worker?.running ? 'attached' : 'none',
        pid: daemon.worker?.pid ?? null,
        domain: null,
        heartbeat_at: daemon.worker?.heartbeat_at ?? null,
        started_at: daemon.worker?.started_at ?? null,
        health: daemon.health?.status ?? null,
        detail: daemon.health?.ok === false ? 'Service is unhealthy.' : null
      }
    },
    start() {
      throw new PublicClientError('UNAVAILABLE', 'Service process control is not available in this host.')
    },
    stop() {
      throw new PublicClientError('UNAVAILABLE', 'Service process control is not available in this host.')
    },
    repair() {
      throw new PublicClientError('UNAVAILABLE', 'Service process control is not available in this host.')
    }
  }
}

function desktopChannelEnabled(runtime: ClientRuntimeContext, subject: string): boolean {
  try {
    return resolveDesktopConfig(runtime, subject).enabled === true
  } catch {
    const entry = getSubjectEntry(runtime, subject) as { channels?: { desktop?: { enabled?: boolean } } } | null
    return Boolean(entry?.channels?.desktop?.enabled)
  }
}

export class ServiceCommandOwner {
  constructor(
    private readonly runtime: ClientRuntimeContext,
    private readonly processPort: ServiceProcessPort,
    private readonly hostKind: ClientHostKind = 'electron'
  ) {}

  getReadiness(subject: string): SubjectReadiness {
    const name = requireSubject(this.runtime, subject)
    const daemon = buildDaemonProjection(this.runtime, name, { eventLimit: 10 })
    const view = this.processPort.get(name)
    const model = resolveModelReadiness({
      jeaHome: this.runtime.jeaHome,
      subjectRoot: subjectRuntime(this.runtime, name).runtimeRoot
    })
    return redactPublicValue(projectSubjectReadiness({
      subject: name,
      generatedAt: new Date().toISOString(),
      hostKind: this.hostKind,
      webHost: observeWebHost(this.runtime.jeaHome),
      cycleWorker: daemon.worker ?? null,
      cycleHealth: daemon.health ?? null,
      channelWorker: daemon.channel?.worker ?? null,
      channelHealth: daemon.channel?.health ?? null,
      model,
      desktopChannelEnabled: desktopChannelEnabled(this.runtime, name),
      ownership: {
        mode: view.mode ?? null,
        domain: view.domain ?? null
      }
    }))
  }

  getStatus(subject: string): ServiceStatus {
    const name = requireSubject(this.runtime, subject)
    const daemon = buildDaemonProjection(this.runtime, name, { eventLimit: 10 })
    const view = this.processPort.get(name)
    return redactPublicValue({
      subject: name,
      mode: view.mode ?? (daemon.worker?.running ? 'attached' : 'none'),
      pid: view.pid ?? daemon.worker?.pid ?? null,
      domain: view.domain ?? null,
      heartbeat_at: view.heartbeat_at ?? daemon.worker?.heartbeat_at ?? null,
      started_at: view.started_at ?? daemon.worker?.started_at ?? null,
      health: view.health ?? daemon.health?.status ?? null,
      detail: view.detail ?? null
    })
  }

  async start(subject: string, domain: 'all' | 'cycle' | 'channel' = 'all'): Promise<ServiceStatus> {
    const name = requireSubject(this.runtime, subject)
    if (!['all', 'cycle', 'channel'].includes(domain)) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid domain is required.')
    }
    await this.processPort.start(name, { domain })
    return this.getStatus(name)
  }

  async stop(subject: string): Promise<ServiceStatus> {
    const name = requireSubject(this.runtime, subject)
    await this.processPort.stop(name)
    return this.getStatus(name)
  }

  requestCycle(subject: string, note?: string): CycleRequestResult {
    const name = requireSubject(this.runtime, subject)
    const result = enqueueCycleStartRequestWithEvent(this.runtime, name, {
      reason: 'jea_client',
      meta: note?.trim() ? { note: note.trim() } : {}
    })
    return redactPublicValue({
      subject: name,
      cycle_start_request: result.request ?? null
    })
  }
}
