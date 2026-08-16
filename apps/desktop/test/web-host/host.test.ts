import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebJeaClient, PublicClientError } from '../../src/client-api'
import {
  createWebHost,
  startWebHostService,
  stopWebHostService,
  webHostStatusView
} from '../../src/web-host'

const TOKEN = 'a'.repeat(32) + 'web-host-test-token'
const hosts: Array<{ close(): Promise<void> }> = []
const homes: string[] = []

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop()
    await host?.close().catch(() => {})
  }
  delete process.env.JEA_HOME
})

function tempHome() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-web-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-web-home-'))
  homes.push(jeaHome)
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { data_namespace: 'alpha-data' },
      beta: { data_namespace: 'beta-data' }
    }
  }))
  return { sourceRoot, jeaHome }
}

async function startHost(overrides: Record<string, unknown> = {}) {
  const { sourceRoot, jeaHome } = tempHome()
  process.env.JEA_HOME = jeaHome
  const logs: string[] = []
  const host = await createWebHost({
    sourceRoot,
    jeaHome,
    token: TOKEN,
    port: 0,
    logger: {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message)
    },
    ...overrides
  })
  hosts.push(host)
  return { host, sourceRoot, jeaHome, logs }
}

function headers(token?: string, extra: Record<string, string> = {}) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  }
}

describe('localhost Web host', () => {
  it('binds 127.0.0.1 and honors the requested free port', async () => {
    const { host } = await startHost()
    const address = host.server.address()
    expect(address).toMatchObject({ address: '127.0.0.1', port: host.port })
    expect(host.port).toBeGreaterThan(0)
    expect(host.origin).toBe(`http://127.0.0.1:${host.port}`)
  })

  it('rejects wildcard and non-loopback binds without listening', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    await expect(createWebHost({ sourceRoot, jeaHome, address: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      name: 'WebHostError',
      code: 'WEB_HOST_BIND_NOT_LOOPBACK'
    })
    await expect(createWebHost({ sourceRoot, jeaHome, address: '192.168.1.10', port: 0 })).rejects.toMatchObject({
      code: 'WEB_HOST_BIND_NOT_LOOPBACK'
    })
  })

  it('returns stable errors for invalid and occupied ports', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    await expect(createWebHost({ sourceRoot, jeaHome, port: 70000 })).rejects.toMatchObject({
      code: 'WEB_HOST_PORT_INVALID'
    })
    await expect(createWebHost({ sourceRoot, jeaHome, port: -1 })).rejects.toMatchObject({
      code: 'WEB_HOST_PORT_INVALID'
    })

    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const occupied = (blocker.address() as { port: number }).port
    await expect(createWebHost({ sourceRoot, jeaHome, port: occupied })).rejects.toMatchObject({
      code: 'WEB_HOST_PORT_OCCUPIED',
      port: occupied
    })
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })

  it('returns bootstrap metadata without a token field', async () => {
    const { host } = await startHost()
    const response = await fetch(`${host.origin}/jea/bootstrap`, { headers: headers(TOKEN) })
    expect(response.ok).toBe(true)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      protocol: 'jea.client',
      version: '1.0.0',
      host: 'web',
      bind: { address: '127.0.0.1', port: host.port }
    })
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    expect(body).not.toHaveProperty('token')
    expect(body).not.toHaveProperty('access_token')
    const commands = body.commands as { allowed: Array<{ name: string; capability: string }>; rejected: Array<{ name: string }> }
    expect(commands.allowed.some((item) => item.name === 'subject.list' && item.capability === 'readonly')).toBe(true)
    expect(commands.allowed.some((item) => item.name === 'conversation.sendMessage' && item.capability === 'write')).toBe(true)
    expect(commands.rejected.map((item) => item.name)).toEqual(expect.arrayContaining([
      'service.start',
      'service.stop',
      'setup.confirmHome',
      'cli.install',
      'cli.uninstall'
    ]))
    expect(body.events).toMatchObject({
      transport: 'sse',
      path: '/jea/events',
      cursor_param: 'cursor',
      id_header: 'Last-Event-ID'
    })
  })

  it('rejects unauthenticated and invalid-token RPC and events', async () => {
    const { host } = await startHost()
    const missing = await fetch(`${host.origin}/jea/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'protocol.get', payload: {} })
    })
    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_NOT_ALLOWED', message: 'Authentication is required.' }
    })

    const invalid = await fetch(`${host.origin}/jea/events`, {
      headers: headers('definitely-not-the-token')
    })
    expect(invalid.status).toBe(401)
    const invalidBody = await invalid.json() as { error: { message: string } }
    expect(invalidBody.error.message).toBe('Authentication token is invalid.')
    expect(JSON.stringify(invalidBody)).not.toContain(TOKEN)
  })

  it('rejects local-only commands with a stable capability error', async () => {
    const { host } = await startHost()
    const client = createWebJeaClient({ baseUrl: host.origin, token: TOKEN })
    const error = await client.startService('alpha').catch((caught) => caught)
    expect(error).toBeInstanceOf(PublicClientError)
    expect(error).toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available on the Web host.'
    })

    const raw = await fetch(`${host.origin}/jea/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(TOKEN) },
      body: JSON.stringify({ command: 'setup.confirmHome', payload: { path: '/tmp' } })
    })
    await expect(raw.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_NOT_ALLOWED', message: 'Command is not available on the Web host.' }
    })
  })

  it('resumes events from a cursor, fills the gap, and does not duplicate', async () => {
    const { host } = await startHost()
    host.publish({ type: 'subject.changed', payload: { subject: 'alpha', reason: 'one' } })
    host.publish({ type: 'subject.changed', payload: { subject: 'alpha', reason: 'two' } })
    const first = host.publish({ type: 'conversation.updated', payload: { subject: 'alpha', session_id: 'main' } })

    const received: Array<{ seq: number; type: string }> = []
    const client = createWebJeaClient({ baseUrl: host.origin, token: TOKEN })
    const stop = client.subscribe((event) => {
      received.push({ seq: Number((event as { seq?: number }).seq), type: event.type })
    })
    await viWaitFor(() => received.length > 0)
    stop()

    host.publish({ type: 'settings.changed', payload: { theme: 'dark' } })
    const late = host.publish({ type: 'evolution.updated', payload: { subject: 'alpha' } })
    const second: Array<{ seq: number; type: string }> = []
    const seen = new Set<number>()
    const stop2 = client.subscribe((event) => {
      const seq = Number((event as { seq?: number }).seq)
      if (seen.has(seq)) throw new Error(`duplicate seq ${seq}`)
      seen.add(seq)
      second.push({ seq, type: event.type })
    })
    await viWaitFor(() => second.some((item) => item.seq === late.seq))
    expect(second.map((item) => item.type)).toEqual(expect.arrayContaining(['settings.changed', 'evolution.updated']))
    expect(second.every((item) => item.seq > first.seq)).toBe(true)
    expect(new Set(second.map((item) => item.seq)).size).toBe(second.length)
    stop2()
  })

  it('closes RPC/event connections, watchers, and the listening socket on shutdown', async () => {
    let stopped = false
    const { host } = await startHost({
      watcher: { start() {}, stop() { stopped = true } }
    })
    const origin = host.origin
    const events = await fetch(`${origin}/jea/events`, { headers: headers(TOKEN) })
    expect(events.ok).toBe(true)
    await host.close()
    expect(stopped).toBe(true)
    expect(host.server.listening).toBe(false)
    await expect(fetch(`${origin}/jea/bootstrap`, { headers: headers(TOKEN) })).rejects.toThrow()
  })

  it('never leaks the token through logs, status, events, errors, or bootstrap', async () => {
    const { host, logs, jeaHome } = await startHost()
    const bootstrap = await (await fetch(`${host.origin}/jea/bootstrap`, { headers: headers(TOKEN) })).json()
    const failed = await (await fetch(`${host.origin}/jea/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}-nope` },
      body: JSON.stringify({ command: 'subject.list' })
    })).json()
    host.publish({ type: 'service.status', payload: { subject: 'alpha', token: TOKEN, detail: `url=${host.authenticatedUrl}` } })
    const status = host.status()
    const persisted = webHostStatusView(jeaHome)
    const dumped = JSON.stringify({ bootstrap, failed, status, persisted, logs, event: host.events.replayFrom(0) })
    expect(dumped).not.toContain(TOKEN)
    expect(dumped).not.toMatch(/access_token=(?!\[REDACTED_SECRET\])[^"&\s]+/)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('rejects arbitrary CORS origins and does not advertise *', async () => {
    const { host } = await startHost()
    const response = await fetch(`${host.origin}/jea/bootstrap`, {
      headers: { ...headers(TOKEN), Origin: 'https://evil.example' }
    })
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
    const allowed = await fetch(`${host.origin}/jea/bootstrap`, {
      headers: { ...headers(TOKEN), Origin: host.origin }
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('serves shared renderer assets with a host bootstrap marker and no token', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const assetDir = join(sourceRoot, 'dist')
    mkdirSync(assetDir, { recursive: true })
    writeFileSync(join(assetDir, 'index.html'), '<!doctype html><html><head></head><body>JeaApp shell</body></html>')
    const host = await createWebHost({ sourceRoot, jeaHome, token: TOKEN, port: 0, assetDir })
    hosts.push(host)
    const page = await fetch(host.origin)
    const html = await page.text()
    expect(html).toContain('name="jea-host"')
    expect(html).toContain('JeaApp shell')
    expect(html).not.toContain(TOKEN)
  })

  it('starts headless without Electron and records loopback status without a token', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    process.env.JEA_HOME = jeaHome
    const host = await startWebHostService({ sourceRoot, jeaHome, token: TOKEN, port: 0 })
    hosts.push(host)
    expect(host.status()).toMatchObject({ running: true, headless: true, bind: { address: '127.0.0.1' } })
    expect(JSON.stringify(webHostStatusView(jeaHome))).not.toContain(TOKEN)
    await stopWebHostService(jeaHome, host)
    expect(webHostStatusView(jeaHome)).toMatchObject({ running: false })
  })
})

async function viWaitFor(assert: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (assert()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for event transport.')
}
