import type {
  DesktopCommand,
  JeaBridge,
  JeaEventEnvelope
} from '../shared/contract'

export type InvokeTransport = (
  command: DesktopCommand,
  payload?: Record<string, unknown>
) => Promise<unknown>

export type EventTransport = (
  listener: (event: JeaEventEnvelope) => void
) => () => void

export function createJeaBridge(
  transport: InvokeTransport,
  eventTransport: EventTransport = () => () => {}
): Readonly<JeaBridge> {
  return Object.freeze({
    invoke<T = unknown>(command: DesktopCommand, payload?: Record<string, unknown>): Promise<T> {
      return transport(command, payload) as Promise<T>
    },
    subscribe(listener: (event: JeaEventEnvelope) => void): () => void {
      if (typeof listener !== 'function') return () => {}
      return eventTransport(listener)
    }
  })
}
