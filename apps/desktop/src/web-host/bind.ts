import { WebHostError } from './errors'

export const DEFAULT_WEB_HOST_ADDRESS = '127.0.0.1'
export const DEFAULT_WEB_HOST_PORT = 8788

const LOOPBACK_ALIASES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const FORBIDDEN_WILDCARDS = new Set(['0.0.0.0', '::', '[::]', '*'])

export function parseWebHostPort(value: unknown): number {
  if (value == null || value === '') return DEFAULT_WEB_HOST_PORT
  const port = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new WebHostError(
      'WEB_HOST_PORT_INVALID',
      `Port ${String(value)} is invalid. Use an integer from 1 to 65535.`,
      { port: Number.isFinite(port) ? port : undefined }
    )
  }
  return port
}

export function resolveWebHostAddress(value: string | undefined): string {
  const address = (value ?? DEFAULT_WEB_HOST_ADDRESS).trim() || DEFAULT_WEB_HOST_ADDRESS
  if (FORBIDDEN_WILDCARDS.has(address)) {
    throw new WebHostError(
      'WEB_HOST_BIND_NOT_LOOPBACK',
      `Refusing to bind ${address}. The Web host is localhost-only and cannot listen on a wildcard address.`,
      { address }
    )
  }
  if (!LOOPBACK_ALIASES.has(address)) {
    throw new WebHostError(
      'WEB_HOST_BIND_NOT_LOOPBACK',
      `Refusing to bind ${address}. The Web host only accepts loopback addresses (127.0.0.1).`,
      { address }
    )
  }
  return address === 'localhost' || address === '::1' || address === '[::1]'
    ? DEFAULT_WEB_HOST_ADDRESS
    : address
}

export function loopbackOrigins(port: number): Set<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`
  ])
}

export function isAllowedWebOrigin(origin: string | null | undefined, port: number): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:') return false
    const originPort = url.port || '80'
    return loopbackOrigins(port).has(`${url.protocol}//${url.hostname}:${originPort}`)
      || (LOOPBACK_ALIASES.has(url.hostname) && Number(originPort) === port)
  } catch {
    return false
  }
}
