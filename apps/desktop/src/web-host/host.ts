import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebHostError } from './errors'
import { isAllowedWebOrigin, parseWebHostPort, resolveWebHostAddress } from './bind'
import {
  extractRequestToken,
  generateWebHostToken,
  sessionCookie,
  tokensMatch,
  WEB_HOST_TOKEN_QUERY
} from './auth'
import { createWebHostBootstrap, type WebHostBootstrap } from './bootstrap'
import { formatSseEvent, WebHostEventLog, type SequencedJeaEvent } from './events'
import { createWebHostProjectionBridge, type WebHostProjectionBridge } from './projection-bridge'
import { redactWebHostText, redactWebHostValue } from './redact'
import { readHostAsset, resolveAppAssetDir } from './static-assets'
import { createApplicationCommandHost, isWebAllowedCommand, publicErrorShape, toPublicClientError } from '../client-api'
import { PublicClientError } from '../client-api/errors'
import type { ApplicationCommandHost } from '../client-api/host'
import type { InvokeRequest, JeaEventEnvelope } from '../client-api/types'

export interface WebHostWatcher {
  start(): void
  stop(): void
}

export interface WebHostLogger {
  info(message: string): void
  error(message: string): void
}

export interface WebHostOptions {
  sourceRoot: string
  jeaHome?: string
  token?: string
  address?: string
  port?: number
  assetDir?: string
  commandHost?: ApplicationCommandHost
  invoke?(request: InvokeRequest): Promise<unknown>
  watcher?: WebHostWatcher
  logger?: WebHostLogger
  eventLimit?: number
}

export interface JeaWebHost {
  readonly address: string
  readonly port: number
  readonly token: string
  readonly origin: string
  readonly authenticatedUrl: string
  readonly server: Server
  readonly events: WebHostEventLog
  bootstrap(): WebHostBootstrap
  status(): Record<string, unknown>
  publish(event: Omit<JeaEventEnvelope, 'ts'> & { ts?: string }): SequencedJeaEvent
  close(): Promise<void>
}

const AUTH_REQUIRED = new PublicClientError('COMMAND_NOT_ALLOWED', 'Authentication is required.')
const AUTH_INVALID = new PublicClientError('COMMAND_NOT_ALLOWED', 'Authentication token is invalid.')
const CAPABILITY_DENIED = new PublicClientError('COMMAND_NOT_ALLOWED', 'Command is not available on the Web host.')
const ORIGIN_DENIED = new PublicClientError('COMMAND_NOT_ALLOWED', 'Cross-origin requests are not allowed.')

const WRITE_EVENTS: Record<string, (payload: Record<string, unknown>, result: unknown) => Omit<JeaEventEnvelope, 'ts'>> = {
  'subject.select': (payload) => ({
    type: 'subject.changed',
    subject: String(payload.subject ?? ''),
    payload: { subject: payload.subject, reason: 'select' }
  }),
  'subject.setDefault': (payload) => ({
    type: 'subject.changed',
    subject: String(payload.subject ?? ''),
    payload: { subject: payload.subject, reason: 'default' }
  }),
  'conversation.createSession': (payload, result) => ({
    type: 'conversation.updated',
    subject: String(payload.subject ?? ''),
    session_id: String((result as { session_id?: string } | null)?.session_id ?? payload.sessionId ?? ''),
    payload: { subject: payload.subject, session_id: (result as { session_id?: string } | null)?.session_id ?? payload.sessionId }
  }),
  'conversation.sendMessage': (payload, result) => ({
    type: 'conversation.updated',
    subject: String(payload.subject ?? ''),
    session_id: String((result as { session_id?: string } | null)?.session_id ?? payload.sessionId ?? ''),
    payload: { subject: payload.subject, session_id: (result as { session_id?: string } | null)?.session_id ?? payload.sessionId }
  }),
  'service.requestCycle': (payload) => ({
    type: 'evolution.updated',
    subject: String(payload.subject ?? ''),
    payload: { subject: payload.subject }
  }),
  'service.processCycleOnce': (payload) => ({
    type: 'evolution.updated',
    subject: String(payload.subject ?? ''),
    payload: { subject: payload.subject }
  }),
  'settings.set': () => ({
    type: 'settings.changed',
    payload: {}
  }),
  'setup.createSubject': () => ({ type: 'setup.readiness', payload: { ready: true } }),
  'setup.initData': () => ({ type: 'setup.readiness', payload: { ready: true } }),
  'setup.enableDesktopChannel': () => ({ type: 'setup.readiness', payload: { ready: true } })
}

function requestUrl(req: IncomingMessage, port: number): URL {
  return new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
}

function sendJson(res: ServerResponse, status: number, body: unknown, token?: string): void {
  const safe = redactWebHostValue(body, token)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(safe))
}

function publicFailure(error: unknown): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: publicErrorShape(toPublicClientError(error)) }
}

export async function createWebHost(options: WebHostOptions): Promise<JeaWebHost> {
  const address = resolveWebHostAddress(options.address)
  const requestedPort = parseWebHostPort(options.port)
  const token = options.token ?? generateWebHostToken()
  const commandHost = options.commandHost ?? createApplicationCommandHost({
    sourceRoot: options.sourceRoot,
    jeaHome: options.jeaHome,
    hostKind: 'web'
  })
  const invoke = options.invoke ?? ((request: InvokeRequest) => commandHost.invoke(request))
  const events = new WebHostEventLog({ limit: options.eventLimit })
  const projectionBridge: WebHostProjectionBridge | null = options.watcher
    ? null
    : createWebHostProjectionBridge({
      sourceRoot: options.sourceRoot,
      jeaHome: options.jeaHome,
      publish: (event) => events.publish(event)
    })
  const watcher = options.watcher ?? projectionBridge
  const assetDir = resolveAppAssetDir(options.sourceRoot, options.assetDir)
  const sseClients = new Set<ServerResponse>()
  const logger: WebHostLogger = {
    info(message) { options.logger?.info(redactWebHostText(message, token)) },
    error(message) { options.logger?.error(redactWebHostText(message, token)) }
  }

  const authenticate = (req: IncomingMessage, url: URL): PublicClientError | null => {
    const provided = extractRequestToken(
      { authorization: req.headers.authorization, cookie: req.headers.cookie },
      url.searchParams.get(WEB_HOST_TOKEN_QUERY) ?? undefined
    )
    if (!provided) return AUTH_REQUIRED
    if (!tokensMatch(token, provided)) return AUTH_INVALID
    return null
  }

  const rejectOrigin = (req: IncomingMessage, res: ServerResponse, port: number): boolean => {
    const origin = req.headers.origin
    if (isAllowedWebOrigin(origin, port)) return false
    sendJson(res, 403, publicFailure(ORIGIN_DENIED), token)
    return true
  }

  const handleRpc = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const authError = authenticate(req, url)
    if (authError) {
      sendJson(res, 401, publicFailure(authError), token)
      return
    }
    let body: InvokeRequest
    try {
      const raw = await readRequestBody(req)
      body = raw ? JSON.parse(raw) as InvokeRequest : { command: '' }
    } catch {
      sendJson(res, 400, publicFailure(new PublicClientError('INVALID_REQUEST', 'Invalid operation request.')), token)
      return
    }
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (!isWebAllowedCommand(command)) {
      sendJson(res, 200, publicFailure(CAPABILITY_DENIED), token)
      return
    }
    try {
      const value = await invoke({ command, payload: body.payload })
      const payload = (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload))
        ? body.payload as Record<string, unknown>
        : {}
      const eventFactory = WRITE_EVENTS[command]
      if (eventFactory) {
        const published = events.publish(redactWebHostValue(eventFactory(payload, value), token))
        if (published.type === 'subject.changed' && published.subject) {
          projectionBridge?.watch(published.subject)
        }
      }
      sendJson(res, 200, { ok: true, value: redactWebHostValue(value, token) }, token)
    } catch (error) {
      const publicError = toPublicClientError(error)
      logger.error(publicError.message)
      sendJson(res, 200, publicFailure(publicError), token)
    }
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const authError = authenticate(req, url)
    if (authError) {
      sendJson(res, 401, publicFailure(authError), token)
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    const cursor = url.searchParams.get('cursor') ?? req.headers['last-event-id']
    const hello = events.publish({
      type: 'client.hello',
      payload: { version: createWebHostBootstrap({ address, port: hostPort() }).version }
    })
    const replay = events.replayFrom(typeof cursor === 'string' ? cursor : Array.isArray(cursor) ? cursor[0] : cursor)
    const delivered = new Set<number>()
    for (const event of [...replay, hello]) {
      if (delivered.has(event.seq)) continue
      delivered.add(event.seq)
      res.write(formatSseEvent(redactWebHostValue(event, token)))
    }
    const unsubscribe = events.subscribe((event) => {
      if (delivered.has(event.seq)) return
      delivered.add(event.seq)
      res.write(formatSseEvent(redactWebHostValue(event, token)))
    })
    sseClients.add(res)
    req.on('close', () => {
      unsubscribe()
      sseClients.delete(res)
    })
  }

  const handleBootstrap = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const authError = authenticate(req, url)
    if (authError) {
      sendJson(res, 401, publicFailure(authError), token)
      return
    }
    sendJson(res, 200, host.bootstrap(), token)
  }

  const handleStatic = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.searchParams.has(WEB_HOST_TOKEN_QUERY) && tokensMatch(token, url.searchParams.get(WEB_HOST_TOKEN_QUERY) ?? '')) {
      const next = new URL(url.href)
      next.searchParams.delete(WEB_HOST_TOKEN_QUERY)
      res.writeHead(302, {
        Location: `${next.pathname}${next.search}`,
        'Set-Cookie': sessionCookie(token)
      })
      res.end()
      return
    }
    const asset = readHostAsset(assetDir, url.pathname)
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' })
    res.end(asset.body)
  }

  const server = createServer((req, res) => {
    try {
      const url = requestUrl(req, hostPort())
      if (rejectOrigin(req, res, hostPort())) return
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/jea/bootstrap') {
        handleBootstrap(req, res, url)
        return
      }
      if (req.method === 'POST' && url.pathname === '/jea/rpc') {
        void handleRpc(req, res, url)
        return
      }
      if (req.method === 'GET' && url.pathname === '/jea/events') {
        handleEvents(req, res, url)
        return
      }
      if (req.method === 'GET') {
        handleStatic(req, res, url)
        return
      }
      res.writeHead(405)
      res.end()
    } catch (error) {
      logger.error(error instanceof Error ? error.message : 'Web host request failed.')
      sendJson(res, 500, publicFailure(error), token)
    }
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(error.message)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('error', onError)
      if (error.code === 'EADDRINUSE') {
        reject(new WebHostError(
          'WEB_HOST_PORT_OCCUPIED',
          `Port ${requestedPort} is already in use. Choose another port or stop the process that owns it.`,
          { address, port: requestedPort }
        ))
        return
      }
      reject(error)
    }
    server.once('error', onError)
    server.listen(requestedPort, address, () => {
      server.off('error', onError)
      resolve()
    })
  })

  function hostPort(): number {
    const bound = server.address()
    return bound && typeof bound === 'object' ? bound.port : requestedPort
  }

  watcher?.start()
  logger.info(`JEA Web host listening on ${address}:${hostPort()}`)

  const host: JeaWebHost = {
    get address() { return address },
    get port() { return hostPort() },
    token,
    get origin() { return `http://${address}:${hostPort()}` },
    get authenticatedUrl() {
      return `http://${address}:${hostPort()}/?${WEB_HOST_TOKEN_QUERY}=${token}`
    },
    server,
    events,
    bootstrap() {
      return createWebHostBootstrap({ address, port: hostPort() })
    },
    status() {
      return redactWebHostValue({
        running: true,
        bind: { address, port: hostPort() },
        protocol: 'jea.client',
        version: createWebHostBootstrap({ address, port: hostPort() }).version,
        headless: true
      }, token)
    },
    publish(event) {
      return events.publish(redactWebHostValue(event, token))
    },
    async close() {
      watcher?.stop()
      events.close()
      for (const client of sseClients) {
        client.end()
      }
      sseClients.clear()
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  }

  return host
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
