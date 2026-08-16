import { createElectronJeaClient } from '../../client-api/adapters/electron'
import type { JeaClient } from '../../client-api/jea-client'
import type { ClientApiCommandName } from '../../client-api/protocol'
import type { DesktopCommand } from '../../shared/contract'

export function createDesktopRendererClient(): JeaClient | null {
  const bridge = globalThis.window === undefined ? null : globalThis.window.jea
  if (!bridge) return null
  return createElectronJeaClient({
    invoke: (command, payload) => bridge.invoke(command as ClientApiCommandName | DesktopCommand, payload),
    subscribe: (listener) => bridge.subscribe(listener)
  })
}
