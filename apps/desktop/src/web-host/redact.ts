import { redactPublicValue } from '../client-api/redact'
import { WEB_HOST_TOKEN_QUERY } from './auth'

const TOKEN_QUERY = new RegExp(`([?&]${WEB_HOST_TOKEN_QUERY}=)[^&#\\s]+`, 'gi')
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi

export function redactWebHostText(value: string, token?: string): string {
  let next = value
    .replace(TOKEN_QUERY, `$1[REDACTED_SECRET]`)
    .replace(BEARER, 'Bearer [REDACTED_SECRET]')
  if (token && token.length >= 8) {
    next = next.split(token).join('[REDACTED_SECRET]')
  }
  return next
}

export function redactWebHostValue<T>(value: T, token?: string): T {
  const publicValue = redactPublicValue(value)
  return rewrite(publicValue, token) as T
}

function rewrite(value: unknown, token: string | undefined): unknown {
  if (typeof value === 'string') return redactWebHostText(value, token)
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => rewrite(item, token))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, rewrite(child, token)])
  )
}
