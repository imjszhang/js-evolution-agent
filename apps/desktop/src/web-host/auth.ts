import { randomBytes, timingSafeEqual } from 'node:crypto'

export const WEB_HOST_COOKIE = 'jea_web_session'
export const WEB_HOST_TOKEN_QUERY = 'access_token'

export function generateWebHostToken(): string {
  return randomBytes(32).toString('hex')
}

export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (!provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function readBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim())
  return match?.[1]
}

export function readCookieToken(header: string | string[] | undefined, name = WEB_HOST_COOKIE): string | undefined {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  for (const part of value.split(';')) {
    const [rawKey, ...rest] = part.split('=')
    if (rawKey?.trim() === name) return rest.join('=').trim()
  }
  return undefined
}

export function sessionCookie(token: string): string {
  return `${WEB_HOST_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
}

export function extractRequestToken(
  headers: { authorization?: string | string[]; cookie?: string | string[] },
  queryToken?: string
): string | undefined {
  return readBearerToken(headers.authorization)
    ?? readCookieToken(headers.cookie)
    ?? (queryToken && queryToken.trim() ? queryToken.trim() : undefined)
}
