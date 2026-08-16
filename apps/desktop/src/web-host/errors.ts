export const WEB_HOST_ERROR_CODES = [
  'WEB_HOST_PORT_OCCUPIED',
  'WEB_HOST_PORT_INVALID',
  'WEB_HOST_BIND_NOT_LOOPBACK',
  'WEB_HOST_ALREADY_RUNNING',
  'WEB_HOST_NOT_RUNNING'
] as const

export type WebHostErrorCode = (typeof WEB_HOST_ERROR_CODES)[number]

export class WebHostError extends Error {
  readonly code: WebHostErrorCode
  readonly address?: string
  readonly port?: number

  constructor(code: WebHostErrorCode, message: string, extras: { address?: string; port?: number } = {}) {
    super(message)
    this.name = 'WebHostError'
    this.code = code
    this.address = extras.address
    this.port = extras.port
  }
}

export function isWebHostError(error: unknown): error is WebHostError {
  return error instanceof WebHostError
    || Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'WebHostError')
}
