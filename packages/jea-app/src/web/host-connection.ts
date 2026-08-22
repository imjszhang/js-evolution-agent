import type { ShellViewState } from '../shell/GlobalStates'

export const JEA_HOST_META = 'jea-host'
export const BOOTSTRAP_PATH = '/jea/bootstrap'

export type WebHostConnectionState = 'online' | 'offline'

export function isExplicitWebFixtureMode(hosted: boolean, search = defaultSearch()): boolean {
  return !hosted && new URLSearchParams(search).get('fixture') === '1'
}

export function isJeaWebHosted(doc: Pick<Document, 'querySelector'> | null | undefined = defaultDocument()): boolean {
  return Boolean(doc?.querySelector(`meta[name="${JEA_HOST_META}"]`))
}

export function resolveHostedViewState(options: {
  queryState?: string | null
  hosted: boolean
  connected: boolean | null
}): ShellViewState {
  const query = options.queryState
  if (query === 'ready' || query === 'loading' || query === 'empty' || query === 'offline' || query === 'error') {
    return query
  }
  if (!options.hosted) return 'ready'
  if (options.connected === null) return 'loading'
  return options.connected ? 'ready' : 'offline'
}

export async function fetchWebBootstrap(
  request: typeof fetch = fetch,
  path = BOOTSTRAP_PATH
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await request(path, { headers: { Accept: 'application/json' } })
    const body = await response.json().catch(() => null)
    return { ok: response.ok, status: response.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

function defaultDocument(): Document | null {
  return typeof document === 'undefined' ? null : document
}

function defaultSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}
