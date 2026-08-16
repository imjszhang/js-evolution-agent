import { JEA_CLIENT_PROTOCOL_VERSION } from '../protocol'
import { PublicClientError, isPublicClientError } from '../errors'
import { createTypedJeaClient, type JeaClient, type JeaClientTransport } from '../jea-client'
import type { InvokeRequest, InvokeResponse, JeaEventEnvelope } from '../types'

export interface ElectronClientTransport {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: JeaEventEnvelope) => void): () => void
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'ok' in value) {
    const response = value as InvokeResponse
    if (response.ok) return response.value
    throw new PublicClientError(response.error.code, response.error.message)
  }
  return value
}

export function createElectronJeaClient(transport: ElectronClientTransport): JeaClient {
  const clientTransport: JeaClientTransport = {
    async invoke(request: InvokeRequest) {
      try {
        return unwrap(await transport.invoke(request.command, request.payload as Record<string, unknown> | undefined))
      } catch (error) {
        if (isPublicClientError(error)) {
          throw new PublicClientError(error.code, error.message)
        }
        throw new PublicClientError('OPERATION_FAILED', 'Unable to complete the requested operation.')
      }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      return transport.subscribe(listener)
    }
  }
  return createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, clientTransport)
}
