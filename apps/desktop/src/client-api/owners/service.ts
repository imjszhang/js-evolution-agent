import { resolveModelReadiness } from '../../../../../src/actions/execution-env.mjs'
import { enqueueCycleStartRequestWithEvent, processCycleOnce } from '../../../../../src/daemon/cycle-dispatch.mjs'
import { readDaemonProjection } from '../../../../../src/daemon/daemon-projection.mjs'
import { setSubjectAutomation } from '../../../../../src/product/automation-policy.mjs'
import { PublicClientError } from '../errors'
import { readSubjectReadiness } from '../readiness'
import { redactPublicValue } from '../redact'
import type {
  AutomationMode,
  AutomationPolicyView,
  ClientHostKind,
  CycleProcessOnceResult,
  CycleRequestResult,
  ServiceStatus,
  SubjectReadiness
} from '../types'
import { requireSubject, subjectRuntime, type ClientRuntimeContext } from './runtime'

export interface ServiceProcessPort {
  get(subject: string): ServiceStatus
  start(subject: string, options?: { domain?: 'all' | 'cycle' | 'channel' }): Promise<ServiceStatus> | ServiceStatus
  ensure?(subject: string, options?: { domain?: 'all' | 'cycle' | 'channel' }): Promise<ServiceStatus> | ServiceStatus
  stop(subject: string): Promise<ServiceStatus> | ServiceStatus
  repair?(
    subject: string,
    options?: { domain?: 'all' | 'cycle' | 'channel' }
  ): Promise<ServiceStatus> | ServiceStatus
}

export interface ClientLifecycleHook {
  reconcile(input: {
    subject: string
    previous?: string | null
    reason?: string
  }): Promise<unknown>
}

export function createProjectionServicePort(runtime: ClientRuntimeContext): ServiceProcessPort {
  return {
    get(subject: string): ServiceStatus {
      const daemon = readDaemonProjection(runtime, subject, { eventLimit: 30, deferRebuild: true })
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
    ensure() {
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

export class ServiceCommandOwner {
  constructor(
    private readonly runtime: ClientRuntimeContext,
    private readonly processPort: ServiceProcessPort,
    private readonly hostKind: ClientHostKind = 'electron',
    private readonly lifecycle: ClientLifecycleHook | null = null
  ) {}

  getReadiness(subject: string): SubjectReadiness {
    const name = requireSubject(this.runtime, subject)
    return redactPublicValue(readSubjectReadiness(this.runtime, name, {
      hostKind: this.hostKind,
      processPort: this.processPort,
      deferRebuild: this.hostKind === 'electron' || this.hostKind === 'web'
    }))
  }

  getStatus(subject: string): ServiceStatus {
    const name = requireSubject(this.runtime, subject)
    const daemon = readDaemonProjection(this.runtime, name, {
      eventLimit: 30,
      deferRebuild: this.hostKind === 'electron' || this.hostKind === 'web'
    })
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

  async start(subject: string, domain: 'all' | 'cycle' | 'channel' | 'evolution' = 'all'): Promise<ServiceStatus> {
    const name = requireSubject(this.runtime, subject)
    const normalized = domain === 'evolution' ? 'cycle' : domain
    if (!['all', 'cycle', 'channel'].includes(normalized)) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid domain is required.')
    }
    await this.processPort.start(name, { domain: normalized })
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

  async processCycleOnce(subject: string): Promise<CycleProcessOnceResult> {
    const name = requireSubject(this.runtime, subject)
    const model = resolveModelReadiness({
      jeaHome: this.runtime.jeaHome,
      subjectRoot: subjectRuntime(this.runtime, name).runtimeRoot
    })
    const result = await processCycleOnce(this.runtime, name, {
      mock: model.mode === 'mock' || process.env.JEA_FORCE_MOCK === '1',
      'skip-investigate': process.env.JEA_REACTOR_SKIP_INVESTIGATE === '1' || model.mode === 'mock'
    })
    return redactPublicValue(result as CycleProcessOnceResult)
  }

  async setAutomation(subject: string, mode: AutomationMode): Promise<AutomationPolicyView> {
    const name = requireSubject(this.runtime, subject)
    if (mode !== 'automatic' && mode !== 'paused') {
      throw new PublicClientError('INVALID_REQUEST', 'Automation mode must be automatic or paused.')
    }
    const written = setSubjectAutomation(this.runtime, name, mode)
    if (this.hostKind === 'electron' && this.lifecycle) {
      try {
        await this.lifecycle.reconcile({ subject: name, reason: 'set_automation' })
      } catch {
        // Readiness projects blocked/retrying; persistence already succeeded.
      }
    }
    const readiness = this.getReadiness(name)
    return redactPublicValue({
      subject: name,
      mode: written.mode as AutomationMode,
      previous: written.previous as AutomationMode,
      changed: Boolean(written.changed),
      mapped_from: readiness.automation?.mapped_from ?? 'automation',
      diagnostic: readiness.automation?.diagnostic ?? null,
      background: readiness.automation?.background ?? false
    })
  }
}
