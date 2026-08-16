import {
  CLIENT_API_COMMAND_CATALOG,
  CLIENT_API_EVENT_CATALOG,
  JEA_CLIENT_PROTOCOL_ID,
  JEA_CLIENT_PROTOCOL_VERSION,
  isWebAllowedCommand
} from '../client-api'

export interface WebHostBootstrap {
  protocol: typeof JEA_CLIENT_PROTOCOL_ID
  version: typeof JEA_CLIENT_PROTOCOL_VERSION
  host: 'web'
  bind: { address: string; port: number }
  commands: {
    allowed: Array<{ name: string; group: string; capability: 'readonly' | 'write' }>
    rejected: Array<{ name: string; capability: string; reason: 'COMMAND_NOT_ALLOWED' }>
  }
  events: {
    transport: 'sse'
    path: '/jea/events'
    cursor_param: 'cursor'
    id_header: 'Last-Event-ID'
    names: string[]
  }
}

export function createWebHostBootstrap(bind: { address: string; port: number }): WebHostBootstrap {
  const allowed = CLIENT_API_COMMAND_CATALOG
    .filter((entry) => isWebAllowedCommand(entry.name))
    .map((entry) => ({
      name: entry.name,
      group: entry.group,
      capability: entry.capability as 'readonly' | 'write'
    }))
  const rejected = CLIENT_API_COMMAND_CATALOG
    .filter((entry) => !isWebAllowedCommand(entry.name))
    .map((entry) => ({
      name: entry.name,
      capability: entry.capability,
      reason: 'COMMAND_NOT_ALLOWED' as const
    }))

  return {
    protocol: JEA_CLIENT_PROTOCOL_ID,
    version: JEA_CLIENT_PROTOCOL_VERSION,
    host: 'web',
    bind,
    commands: { allowed, rejected },
    events: {
      transport: 'sse',
      path: '/jea/events',
      cursor_param: 'cursor',
      id_header: 'Last-Event-ID',
      names: CLIENT_API_EVENT_CATALOG.map((entry) => entry.name)
    }
  }
}
