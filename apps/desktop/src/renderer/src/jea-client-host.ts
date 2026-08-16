import { createElectronJeaClient, type JeaClient } from '../../client-api'

export function createDesktopJeaClient(): JeaClient | null {
  const bridge = typeof window === 'undefined' ? null : window.jea
  if (!bridge || typeof bridge.invoke !== 'function' || typeof bridge.subscribe !== 'function') {
    return null
  }
  return createElectronJeaClient({
    invoke: (command, payload) => bridge.invoke(command as Parameters<typeof bridge.invoke>[0], payload),
    subscribe: (listener) => bridge.subscribe(listener)
  })
}
