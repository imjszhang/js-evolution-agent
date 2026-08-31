import { resolveDesktopConfig } from '../../../../src/channel/adapters/desktop/config.mjs'
import {
  readChannelWorkerState,
  summarizeChannelWorkersState
} from '../../../../src/channel/worker-state.mjs'
import {
  readWorkerState,
  summarizeWorkerState
} from '../../../../src/daemon/daemon-worker-state.mjs'
import {
  getSubjectEntry,
  listRegisteredSubjects,
  readSubjectsRegistry
} from '../../../../src/infra/subjects.mjs'
import {
  resolveAutomationPolicy,
  resolveAutomationPolicyFromEntry
} from '../../../../src/product/automation-policy.mjs'
import { planClientLifecycle } from '../../../../src/product/client-lifecycle-plan.mjs'
import { inspectControlPlaneReadiness } from '../../../../src/evolution/reactor/control-plane-readiness.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { readActivationLedgerStore } from '../../../../src/daemon/activation-ledger-read.mjs'
import type { DaemonDomain, DaemonSupervisor } from './daemon-supervisor'

export interface ClientLifecycleActionResult {
  subject: string
  domain: 'cycle' | 'channel'
  action: 'ensure' | 'attach' | 'start' | 'stop' | 'skip'
  outcome: 'managed' | 'attached' | 'started' | 'stopped' | 'skipped' | 'blocked'
  reason: string | null
}

export interface ClientLifecycleResult {
  subject: string | null
  previous: string | null
  reason: string
  actions: ClientLifecycleActionResult[]
}

export interface ClientLifecyclePort {
  reconcile(input: {
    subject: string
    previous?: string | null
    reason?: string
  }): Promise<ClientLifecycleResult>
  reconcileStartup(): Promise<ClientLifecycleResult>
}

function desktopEnabled(runtime: { sourceRoot: string; jeaHome: string }, subject: string): boolean {
  try {
    return resolveDesktopConfig(runtime, subject).enabled === true
  } catch {
    return Boolean(
      (getSubjectEntry(runtime, subject) as { channels?: { desktop?: { enabled?: boolean } } } | null)
        ?.channels?.desktop?.enabled
    )
  }
}

export class ClientLifecycleController implements ClientLifecyclePort {
  constructor(
    private readonly supervisor: DaemonSupervisor,
    private readonly runtime: { sourceRoot: string; jeaHome: string },
    private readonly previousSupervisorOptions: {
      maxWaitMs?: number
      pollMs?: number
      wait?: (ms: number) => Promise<void>
    } = {}
  ) {}

  async reconcileStartup(): Promise<ClientLifecycleResult> {
    const registry = readSubjectsRegistry(this.runtime)
    const active = typeof registry.default_subject === 'string' && registry.default_subject.trim()
      ? registry.default_subject.trim()
      : listRegisteredSubjects(this.runtime)[0] ?? null
    if (!active) {
      return { subject: null, previous: null, reason: 'startup', actions: [] }
    }
    return this.reconcile({ subject: active, reason: 'startup' })
  }

  async reconcile({
    subject,
    previous = null,
    reason = 'reconcile'
  }: {
    subject: string
    previous?: string | null
    reason?: string
  }): Promise<ClientLifecycleResult> {
    const names = new Set(listRegisteredSubjects(this.runtime))
    if (!names.has(subject)) {
      return { subject, previous, reason, actions: [] }
    }
    const plan = planClientLifecycle({
      activeSubject: subject,
      previousSubject: previous && names.has(previous) ? previous : null,
      reason,
      subjects: [...names].map((name) => this.snapshot(name))
    })
    const actions: ClientLifecycleActionResult[] = []
    for (const step of plan.actions) {
      actions.push(await this.execute(step))
    }
    return {
      subject,
      previous: plan.previous_subject,
      reason,
      actions
    }
  }

  private snapshot(name: string) {
    const policy = resolveAutomationPolicyFromEntry(getSubjectEntry(this.runtime, name))
      ?? resolveAutomationPolicy(this.runtime, name)
    const cycle = summarizeWorkerState(readWorkerState(this.runtime, name))
    const channel = summarizeChannelWorkersState(readChannelWorkerState(this.runtime, name))
    const supervisor = this.supervisor.get(name)
    const previousOwnerDomains = new Set(
      (supervisor.supervisor_leases ?? [supervisor.supervisor_lease])
        .filter((lease) => lease?.required === true)
        .map((lease) => lease?.domain)
    )
    let controlPlaneReady = true
    let controlPlaneReason: string | null = null
    try {
      const dataRoot = runtimeForSubject(this.runtime, name).dataRoot
      const plane = inspectControlPlaneReadiness({
        dataRoot,
        readLedger: readActivationLedgerStore
      })
      controlPlaneReady = plane.ready === true || plane.fresh_subject === true
      controlPlaneReason = plane.reason ?? null
    } catch {
      controlPlaneReady = false
      controlPlaneReason = 'activation_ledger_unresolved'
    }
    return {
      name,
      automation: policy.mode,
      background: policy.background,
      desktopChannelEnabled: desktopEnabled(this.runtime, name),
      ownedCycle: this.supervisor.owns(name, 'cycle'),
      ownedChannel: this.supervisor.owns(name, 'channel'),
      cycleLive: Boolean(cycle.running),
      channelLive: channel.running_count > 0,
      controlPlaneReady,
      controlPlaneReason,
      previousSupervisorCycle: (
        !this.supervisor.owns(name, 'cycle')
        && (previousOwnerDomains.has('all') || previousOwnerDomains.has('cycle'))
      ),
      previousSupervisorChannel: (
        !this.supervisor.owns(name, 'channel')
        && (previousOwnerDomains.has('all') || previousOwnerDomains.has('channel'))
      )
    }
  }

  private async execute(step: {
    subject: string
    domain: 'cycle' | 'channel'
    action: 'ensure' | 'attach' | 'start' | 'stop' | 'skip'
    reason?: string
  }): Promise<ClientLifecycleActionResult> {
    const reason = step.reason ?? null
    if (step.action === 'skip') {
      return { ...step, outcome: 'skipped', reason }
    }
    if (step.action === 'stop') {
      try {
        await this.supervisor.stop(step.subject, reason ?? 'lifecycle', { domain: step.domain })
        return { ...step, outcome: 'stopped', reason }
      } catch (error) {
        return {
          ...step,
          outcome: this.isOwnershipError(error) ? 'skipped' : 'blocked',
          reason: this.isOwnershipError(error) ? 'not_owned' : reason
        }
      }
    }
    try {
      if (reason === 'previous_supervisor_owner' && this.domainPresent(step.subject, step.domain)) {
        await this.waitForPreviousSupervisor(step.subject, step.domain)
      }
      const beforeOwned = this.supervisor.owns(step.subject, step.domain)
      await this.supervisor.ensure(step.subject, { domain: step.domain as DaemonDomain })
      const afterOwned = this.supervisor.owns(step.subject, step.domain)
      if (afterOwned) {
        return { ...step, outcome: beforeOwned ? 'managed' : 'started', reason }
      }
      if (step.action === 'attach' || this.domainPresent(step.subject, step.domain)) {
        return { ...step, outcome: 'attached', reason }
      }
      return { ...step, outcome: 'blocked', reason }
    } catch (error) {
      if (this.isAttachedError(error)) {
        return { ...step, outcome: 'attached', reason: 'already_running' }
      }
      return { ...step, outcome: 'blocked', reason }
    }
  }

  private async waitForPreviousSupervisor(
    subject: string,
    domain: 'cycle' | 'channel'
  ): Promise<void> {
    const view = this.supervisor.get(subject)
    const lease = (view.supervisor_leases ?? [view.supervisor_lease])
      .find((item) => item?.required && (item.domain === 'all' || item.domain === domain))
    const expiresAt = Date.parse(lease?.expires_at ?? '')
    const configuredMax = Math.max(0, this.previousSupervisorOptions.maxWaitMs ?? 35_000)
    const leaseWait = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - Date.now()) + 5_000
      : configuredMax
    const deadline = Date.now() + Math.min(configuredMax, leaseWait)
    const pollMs = Math.max(1, this.previousSupervisorOptions.pollMs ?? 250)
    const wait = this.previousSupervisorOptions.wait
      ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    while (this.domainPresent(subject, domain) && Date.now() < deadline) {
      await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }

  private domainPresent(subject: string, domain: 'cycle' | 'channel'): boolean {
    if (domain === 'cycle') {
      const cycle = summarizeWorkerState(readWorkerState(this.runtime, subject))
      return Boolean(cycle.running || cycle.stale)
    }
    const channel = summarizeChannelWorkersState(readChannelWorkerState(this.runtime, subject))
    return channel.running_count > 0 || channel.stale_count > 0
  }

  private isOwnershipError(error: unknown): boolean {
    return Boolean(
      error
      && typeof error === 'object'
      && 'message' in error
      && String((error as { message?: unknown }).message).includes('not managed by this client')
    )
  }

  private isAttachedError(error: unknown): boolean {
    return Boolean(
      error
      && typeof error === 'object'
      && 'message' in error
      && String((error as { message?: unknown }).message).includes('already running')
    )
  }
}
