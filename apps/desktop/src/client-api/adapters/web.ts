import { JEA_CLIENT_PROTOCOL_VERSION } from '../protocol'
import { isWebAllowedCommand } from '../catalog'
import { PublicClientError, isPublicClientError } from '../errors'
import { createTypedJeaClient, type JeaClient, type JeaClientTransport } from '../jea-client'
import type { InvokeRequest, InvokeResponse, JeaEventEnvelope } from '../types'

export interface WebJeaClientOptions {
  baseUrl: string
  token?: string
  fetch?: typeof fetch
  onConnectionChange?(state: 'online' | 'offline'): void
}

const CAPABILITY_ERROR = 'Command is not available on the Web host.'

function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'ok' in value) {
    const response = value as InvokeResponse
    if (response.ok) return response.value
    throw new PublicClientError(response.error.code, response.error.message)
  }
  return value
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function parseSseBlock(block: string): { id?: string; data?: string } {
  let id: string | undefined
  const dataLines: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  return { id, data: dataLines.length > 0 ? dataLines.join('\n') : undefined }
}

export function createWebCommandTransport(options: WebJeaClientOptions): JeaClientTransport {
  const baseUrl = trimBase(options.baseUrl)
  const request = options.fetch ?? fetch
  const listeners = new Set<(event: JeaEventEnvelope) => void>()
  let closed = false
  let lastCursor: string | null = null
  let seenSeq = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let abort: AbortController | null = null

  const setConnection = (state: 'online' | 'offline') => {
    options.onConnectionChange?.(state)
  }

  const emit = (event: JeaEventEnvelope & { seq?: number; cursor?: string }) => {
    const seq = typeof event.seq === 'number' ? event.seq : Number(event.cursor)
    if (Number.isFinite(seq)) {
      if (seq <= seenSeq) return
      seenSeq = seq
      lastCursor = String(event.cursor ?? seq)
    }
    for (const listener of listeners) listener(event)
  }

  const connectEvents = async () => {
    while (!closed && listeners.size > 0) {
      abort = new AbortController()
      try {
        const url = new URL(`${baseUrl}/jea/events`)
        if (lastCursor) url.searchParams.set('cursor', lastCursor)
        const response = await request(url, {
          headers: {
            Accept: 'text/event-stream',
            ...(lastCursor ? { 'Last-Event-ID': lastCursor } : {}),
            ...authHeaders(options.token)
          },
          signal: abort.signal
        })
        if (response.status === 401) {
          setConnection('offline')
          throw new PublicClientError('COMMAND_NOT_ALLOWED', 'Authentication is required.')
        }
        if (!response.ok || !response.body) {
          setConnection('offline')
          throw new PublicClientError('UNAVAILABLE', 'Event transport is unavailable.')
        }
        setConnection('online')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split(/\r?\n\r?\n/)
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            const parsed = parseSseBlock(part)
            if (!parsed.data) continue
            const event = JSON.parse(parsed.data) as JeaEventEnvelope & { seq?: number; cursor?: string }
            if (parsed.id && event.cursor == null) event.cursor = parsed.id
            emit(event)
          }
        }
        setConnection('offline')
      } catch (error) {
        if (closed || (error instanceof Error && error.name === 'AbortError')) return
        setConnection('offline')
      }
      if (closed || listeners.size === 0) return
      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeout(resolve, 200)
      })
    }
  }

  return {
    async invoke(requestBody: InvokeRequest) {
      const command = typeof requestBody?.command === 'string' ? requestBody.command.trim() : ''
      if (command && !isWebAllowedCommand(command)) {
        throw new PublicClientError('COMMAND_NOT_ALLOWED', CAPABILITY_ERROR)
      }
      try {
        const response = await request(`${baseUrl}/jea/rpc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(options.token)
          },
          body: JSON.stringify({
            command,
            payload: requestBody.payload ?? {}
          })
        })
        const body = await response.json() as unknown
        if (response.status === 401) {
          setConnection('offline')
          const error = (body && typeof body === 'object' && 'error' in body)
            ? (body as InvokeResponse & { ok: false }).error
            : { code: 'COMMAND_NOT_ALLOWED' as const, message: 'Authentication is required.' }
          throw new PublicClientError(error.code, error.message)
        }
        setConnection('online')
        return unwrap(body)
      } catch (error) {
        if (isPublicClientError(error)) {
          throw new PublicClientError(error.code, error.message)
        }
        setConnection('offline')
        throw new PublicClientError('OPERATION_FAILED', 'Unable to complete the requested operation.')
      }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      if (listeners.size === 1) {
        closed = false
        void connectEvents()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          closed = true
          abort?.abort()
          if (reconnectTimer) clearTimeout(reconnectTimer)
        }
      }
    }
  }
}

export function createWebJeaClient(options: WebJeaClientOptions): JeaClient {
  return createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, createWebCommandTransport(options))
}
