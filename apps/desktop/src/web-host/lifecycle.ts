import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebHostError } from './errors'
import { DEFAULT_WEB_HOST_PORT, parseWebHostPort, resolveWebHostAddress } from './bind'
import { generateWebHostToken } from './auth'
import { createWebHost, type JeaWebHost, type WebHostOptions } from './host'
import { redactWebHostValue } from './redact'

export interface WebHostState {
  running: boolean
  pid: number | null
  bind: { address: string; port: number }
  protocol: 'jea.client'
  version: string
  headless: true
  started_at?: string
}

export interface WebHostServiceOptions extends WebHostOptions {
  jeaHome: string
}

export function webHostStateDir(jeaHome: string): string {
  return join(jeaHome, 'web-host')
}

export function webHostStatePath(jeaHome: string): string {
  return join(webHostStateDir(jeaHome), 'state.json')
}

export function webHostTokenPath(jeaHome: string): string {
  return join(webHostStateDir(jeaHome), 'session')
}

export function readWebHostState(jeaHome: string): WebHostState | null {
  const path = webHostStatePath(jeaHome)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WebHostState
    return redactWebHostValue(parsed)
  } catch {
    return null
  }
}

export function readWebHostToken(jeaHome: string): string | null {
  const path = webHostTokenPath(jeaHome)
  if (!existsSync(path)) return null
  const token = readFileSync(path, 'utf8').trim()
  return token || null
}

export function writeWebHostState(jeaHome: string, state: WebHostState, token?: string): void {
  mkdirSync(webHostStateDir(jeaHome), { recursive: true })
  writeFileSync(webHostStatePath(jeaHome), `${JSON.stringify(redactWebHostValue(state, token), null, 2)}\n`)
}

export function writeWebHostToken(jeaHome: string, token: string): void {
  mkdirSync(webHostStateDir(jeaHome), { recursive: true })
  const path = webHostTokenPath(jeaHome)
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best-effort on filesystems that ignore mode.
  }
}

export function clearWebHostState(jeaHome: string): void {
  rmSync(webHostStateDir(jeaHome), { recursive: true, force: true })
}

export function authenticatedWebUrl(state: Pick<WebHostState, 'bind'>, token: string): string {
  return `http://${state.bind.address}:${state.bind.port}/?access_token=${token}`
}

export function webHostStatusView(jeaHome: string): Record<string, unknown> {
  const state = readWebHostState(jeaHome)
  if (!state) {
    return { running: false, bind: null, pid: null }
  }
  return redactWebHostValue({
    running: processAlive(state.pid),
    pid: state.pid,
    bind: state.bind,
    protocol: state.protocol,
    version: state.version,
    headless: true,
    started_at: state.started_at ?? null
  })
}

export function printAuthenticatedUrl(jeaHome: string): string {
  const state = readWebHostState(jeaHome)
  const token = readWebHostToken(jeaHome)
  if (!state || !token || !processAlive(state.pid)) {
    throw new WebHostError('WEB_HOST_NOT_RUNNING', 'The localhost Web host is not running.')
  }
  return authenticatedWebUrl(state, token)
}

export async function startWebHostService(options: WebHostServiceOptions): Promise<JeaWebHost> {
  const existing = readWebHostState(options.jeaHome)
  if (existing && processAlive(existing.pid) && existing.pid !== process.pid) {
    throw new WebHostError(
      'WEB_HOST_ALREADY_RUNNING',
      `The localhost Web host is already running on ${existing.bind.address}:${existing.bind.port}.`,
      existing.bind
    )
  }
  const token = options.token ?? readWebHostToken(options.jeaHome) ?? generateWebHostToken()
  const host = await createWebHost({ ...options, token })
  writeWebHostToken(options.jeaHome, token)
  writeWebHostState(options.jeaHome, {
    running: true,
    pid: process.pid,
    bind: { address: host.address, port: host.port },
    protocol: 'jea.client',
    version: host.bootstrap().version,
    headless: true,
    started_at: new Date().toISOString()
  }, token)
  return host
}

export async function stopWebHostService(jeaHome: string, host?: JeaWebHost): Promise<void> {
  if (host) await host.close()
  const state = readWebHostState(jeaHome)
  if (state?.pid && state.pid !== process.pid && processAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM')
    } catch {
      // Process may have already exited.
    }
  }
  clearWebHostState(jeaHome)
}

function processAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function resolveListenOptions(flags: { host?: string; port?: unknown } = {}) {
  return {
    address: resolveWebHostAddress(typeof flags.host === 'string' ? flags.host : undefined),
    port: parseWebHostPort(flags.port ?? DEFAULT_WEB_HOST_PORT)
  }
}
