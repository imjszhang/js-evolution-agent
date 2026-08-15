import type {
  DesktopCommand,
  InvokeResponse,
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

export function unwrapInvokeResponse<T>(response: InvokeResponse<T>): T {
  if (response.ok) return response.value
  const error = new Error(response.error.message) as Error & { code: string }
  error.name = 'PublicCommandError'
  error.code = response.error.code
  throw error
}

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
