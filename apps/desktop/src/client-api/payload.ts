import { PublicClientError } from './errors'

export function payloadObject(payload: unknown): Record<string, unknown> {
  if (payload == null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PublicClientError('INVALID_REQUEST', 'Invalid operation request.')
  }
  return payload as Record<string, unknown>
}

export function stringField(
  payload: Record<string, unknown>,
  key: string,
  { required = true }: { required?: boolean } = {}
): string | undefined {
  const value = payload[key]
  if (value == null && !required) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new PublicClientError('INVALID_REQUEST', `A valid ${key} is required.`)
  }
  return value.trim()
}

export function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value == null) return undefined
  if (typeof value !== 'boolean') {
    throw new PublicClientError('INVALID_REQUEST', `A valid ${key} value is required.`)
  }
  return value
}

export function numberField(
  payload: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  if (payload[key] == null) return fallback
  const value = Number(payload[key])
  if (!Number.isFinite(value) || value < 0) {
    throw new PublicClientError('INVALID_REQUEST', `A valid ${key} is required.`)
  }
  return Math.floor(value)
}
