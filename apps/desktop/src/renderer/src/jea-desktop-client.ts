import { createElectronJeaClient } from '../../client-api/adapters/electron'
import type { JeaClient } from '../../client-api/jea-client'

export function createDesktopRendererClient(): JeaClient | null {
  const bridge = globalThis.window === undefined ? null : globalThis.window.jea
  if (!bridge) return null
  return createElectronJeaClient({
    invoke: (command, payload) => bridge.invoke(command, payload),
    subscribe: (listener) => bridge.subscribe(listener)
  })
}
