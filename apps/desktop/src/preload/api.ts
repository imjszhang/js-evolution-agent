import type { JeaBridge, OpsCommand } from '../shared/contract'

export type InvokeTransport = (command: OpsCommand, payload?: Record<string, unknown>) => Promise<unknown>

export function createJeaBridge(transport: InvokeTransport): Readonly<JeaBridge> {
  return Object.freeze({
    invoke<T = unknown>(command: OpsCommand, payload?: Record<string, unknown>): Promise<T> {
      return transport(command, payload) as Promise<T>
    }
  })
}
