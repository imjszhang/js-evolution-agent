import type { ServiceProcessPort } from '../client-api/owners/service'
import type { ServiceStatus } from '../client-api/types'
import type { DaemonSupervisorView } from '../shared/contract'
import type { DaemonSupervisor } from './daemon-supervisor'

function toServiceStatus(view: DaemonSupervisorView): ServiceStatus {
  return {
    subject: view.subject,
    mode: view.mode,
    pid: view.pid,
    domain: view.domain,
    heartbeat_at: view.heartbeat_at,
    started_at: view.started_at,
    health: null,
    detail: view.detail ?? null,
    supervisor_lease: view.supervisor_lease ?? null,
    supervisor_leases: view.supervisor_leases ?? []
  }
}

export function createDaemonServiceProcessPort(daemon: DaemonSupervisor): ServiceProcessPort {
  return {
    get(subject) {
      return toServiceStatus(daemon.get(subject))
    },
    async start(subject, options) {
      return toServiceStatus(await daemon.start(subject, options))
    },
    async ensure(subject, options) {
      return toServiceStatus(await daemon.ensure(subject, options))
    },
    async stop(subject) {
      return toServiceStatus(await daemon.stop(subject))
    },
    async repair(subject, options) {
      return toServiceStatus(await daemon.repair(subject, options))
    }
  }
}
