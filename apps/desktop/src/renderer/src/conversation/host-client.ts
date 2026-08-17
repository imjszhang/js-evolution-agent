import { createElectronJeaClient } from '../../../client-api/adapters/electron'
import { createMemoryJeaClient } from '../../../client-api/adapters/memory'
import type { JeaClient } from '../../../client-api/jea-client'
import type { ClientApiCommandName } from '../../../client-api/protocol'
import type { JeaEventEnvelope } from '../../../client-api/types'
import type { ProjectionWatchPort } from './watch'

function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined'
    && Boolean(window.jea)
    && typeof window.jea.invoke === 'function'
    && typeof window.jea.subscribe === 'function'
}

export function createRendererJeaClient(): JeaClient {
  if (!hasDesktopBridge()) {
    return createMemoryJeaClient()
  }
  return createElectronJeaClient({
    invoke: (command, payload) => window.jea.invoke(command as ClientApiCommandName, payload),
    subscribe: (listener: (event: JeaEventEnvelope) => void) => window.jea.subscribe(listener)
  })
}

export function createDesktopProjectionWatchPort(): ProjectionWatchPort | null {
  if (!hasDesktopBridge()) return null
  return {
    watch(subject) {
      return window.jea.invoke('projection.watch', { subject })
    },
    stop() {
      return window.jea.invoke('projection.stop')
    }
  }
}
