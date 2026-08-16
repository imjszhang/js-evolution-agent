import { PUBLIC_ERROR_CODES, type PublicErrorCode } from './protocol'

export class PublicClientError extends Error {
  readonly code: PublicErrorCode

  constructor(code: PublicErrorCode, message: string) {
    super(message)
    this.name = 'PublicCommandError'
    this.code = code
  }
}

export function isPublicClientError(error: unknown): error is PublicClientError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  return candidate.name === 'PublicCommandError'
    && typeof candidate.code === 'string'
    && (PUBLIC_ERROR_CODES as readonly string[]).includes(candidate.code)
    && typeof candidate.message === 'string'
}

export function toPublicClientError(
  error: unknown,
  fallback: { code: PublicErrorCode; message: string } = {
    code: 'OPERATION_FAILED',
    message: 'Unable to complete the requested operation.'
  }
): PublicClientError {
  if (error instanceof PublicClientError) return error
  if (isPublicClientError(error)) {
    return new PublicClientError(error.code, error.message)
  }
  return new PublicClientError(fallback.code, fallback.message)
}

export function publicErrorShape(error: PublicClientError): { code: PublicErrorCode; message: string } {
  return { code: error.code, message: error.message }
}
