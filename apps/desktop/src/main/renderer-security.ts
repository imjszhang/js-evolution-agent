const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function resolveDevRendererUrl(value: string | undefined): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('ELECTRON_RENDERER_URL must be a valid URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password) {
    throw new Error('ELECTRON_RENDERER_URL must use an unauthenticated loopback HTTP URL.')
  }
  return url.href
}

export function isTrustedRendererLocation(
  currentUrl: string,
  {
    devRendererUrl,
    productionRendererUrl
  }: {
    devRendererUrl: string | null
    productionRendererUrl: string
  }
): boolean {
  try {
    const current = new URL(currentUrl)
    if (devRendererUrl) {
      return current.origin === new URL(devRendererUrl).origin
    }
    return current.href === new URL(productionRendererUrl).href
  } catch {
    return false
  }
}
