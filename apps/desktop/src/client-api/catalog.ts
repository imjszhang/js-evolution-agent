import {
  CAPABILITY_LEVELS,
  CLIENT_API_COMMANDS,
  CLIENT_API_EVENTS,
  JEA_CLIENT_PROTOCOL_ID,
  JEA_CLIENT_PROTOCOL_VERSION,
  PUBLIC_ERROR_CODES,
  type CapabilityLevel,
  type ClientApiCommandName
} from './protocol'
import type { CatalogCommandEntry, CatalogEventEntry, ClientApiCatalog } from './types'

const COMMON_READ_ERRORS = ['INVALID_REQUEST', 'NOT_FOUND', 'OPERATION_FAILED'] as const
const COMMON_WRITE_ERRORS = ['INVALID_REQUEST', 'NOT_FOUND', 'CONFLICT', 'OPERATION_FAILED'] as const
const LOCAL_ERRORS = ['COMMAND_NOT_ALLOWED', 'INVALID_REQUEST', 'NOT_FOUND', 'CONFLICT', 'UNAVAILABLE', 'OPERATION_FAILED'] as const

function both(): { electron: true; web: true } {
  return { electron: true, web: true }
}

function electronOnly(): { electron: true; web: false } {
  return { electron: true, web: false }
}

function command(
  name: ClientApiCommandName,
  group: CatalogCommandEntry['group'],
  capability: CapabilityLevel,
  availability: CatalogCommandEntry['availability'],
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  errors: readonly CatalogCommandEntry['errors'][number][]
): CatalogCommandEntry {
  return {
    name,
    group,
    capability,
    availability,
    request,
    response,
    errors: [...errors]
  }
}

export const CLIENT_API_COMMAND_CATALOG: CatalogCommandEntry[] = [
  command('protocol.get', 'protocol', 'readonly', both(), {}, { protocol: 'string', version: 'string' }, ['OPERATION_FAILED']),
  command('subject.list', 'subject', 'readonly', both(), {}, { subjects: 'SubjectSummary[]' }, COMMON_READ_ERRORS),
  command('subject.get', 'subject', 'readonly', both(), { subject: 'string' }, { subject: 'SubjectRecord' }, COMMON_READ_ERRORS),
  command('subject.select', 'subject', 'write', both(), { subject: 'string' }, { subject: 'SubjectRecord' }, COMMON_WRITE_ERRORS),
  command('subject.setDefault', 'subject', 'write', both(), { subject: 'string' }, { subject: 'SubjectRecord' }, COMMON_WRITE_ERRORS),
  command(
    'conversation.listSessions',
    'conversation',
    'readonly',
    both(),
    { subject: 'string' },
    { sessions: 'ConversationSessionSummary[]' },
    COMMON_READ_ERRORS
  ),
  command(
    'conversation.createSession',
    'conversation',
    'write',
    both(),
    { subject: 'string', sessionId: 'string?' },
    { session: 'ConversationSessionSummary' },
    COMMON_WRITE_ERRORS
  ),
  command(
    'conversation.readMessages',
    'conversation',
    'readonly',
    both(),
    { subject: 'string', sessionId: 'string', offset: 'number?', limit: 'number?', tail: 'number?' },
    { page: 'ConversationPage' },
    COMMON_READ_ERRORS
  ),
  command(
    'conversation.sendMessage',
    'conversation',
    'write',
    both(),
    { subject: 'string', sessionId: 'string?', text: 'string', messageId: 'string?' },
    { result: 'ConversationSendResult' },
    COMMON_WRITE_ERRORS
  ),
  command(
    'evolution.listCycles',
    'evolution',
    'readonly',
    both(),
    { subject: 'string', limit: 'number?' },
    { list: 'EvolutionCycleList' },
    COMMON_READ_ERRORS
  ),
  command(
    'evolution.getCycle',
    'evolution',
    'readonly',
    both(),
    { subject: 'string', cycleId: 'string' },
    { cycle: 'EvolutionCycleDetail' },
    COMMON_READ_ERRORS
  ),
  command(
    'evolution.getRound',
    'evolution',
    'readonly',
    both(),
    { subject: 'string', cycleId: 'string' },
    { round: 'EvolutionRoundDetail' },
    COMMON_READ_ERRORS
  ),
  command(
    'evolution.getObservability',
    'evolution',
    'readonly',
    both(),
    { subject: 'string' },
    { observability: 'EvolutionObservability' },
    COMMON_READ_ERRORS
  ),
  command('service.getStatus', 'service', 'readonly', both(), { subject: 'string' }, { status: 'ServiceStatus' }, COMMON_READ_ERRORS),
  command(
    'service.getReadiness',
    'service',
    'readonly',
    both(),
    { subject: 'string' },
    { readiness: 'SubjectReadiness' },
    COMMON_READ_ERRORS
  ),
  command(
    'service.start',
    'service',
    'local-only',
    electronOnly(),
    { subject: 'string', domain: 'all|cycle|channel?' },
    { status: 'ServiceStatus' },
    LOCAL_ERRORS
  ),
  command('service.stop', 'service', 'local-only', electronOnly(), { subject: 'string' }, { status: 'ServiceStatus' }, LOCAL_ERRORS),
  command(
    'service.requestCycle',
    'service',
    'write',
    both(),
    { subject: 'string', note: 'string?' },
    { result: 'CycleRequestResult' },
    COMMON_WRITE_ERRORS
  ),
  command('setup.getReadiness', 'setup', 'readonly', both(), { subject: 'string?' }, { readiness: 'SetupReadiness' }, COMMON_READ_ERRORS),
  command(
    'setup.confirmHome',
    'setup',
    'local-only',
    electronOnly(),
    { path: 'string?' },
    { home: 'SetupHomeResult' },
    LOCAL_ERRORS
  ),
  command(
    'setup.createSubject',
    'setup',
    'write',
    both(),
    { name: 'string', enableDesktopChannel: 'boolean?' },
    { subject: 'SetupSubjectResult' },
    COMMON_WRITE_ERRORS
  ),
  command('setup.initData', 'setup', 'write', both(), { subject: 'string' }, { initialized: 'boolean' }, COMMON_WRITE_ERRORS),
  command(
    'setup.enableDesktopChannel',
    'setup',
    'write',
    both(),
    { subject: 'string' },
    { subject: 'SetupSubjectResult' },
    COMMON_WRITE_ERRORS
  ),
  command('settings.get', 'settings', 'readonly', both(), {}, { settings: 'SettingsView' }, COMMON_READ_ERRORS),
  command('settings.set', 'settings', 'write', both(), { language: 'string?', theme: 'string?', defaultSubject: 'string?' }, { settings: 'SettingsView' }, COMMON_WRITE_ERRORS),
  command(
    'settings.exportDiagnostics',
    'settings',
    'readonly',
    both(),
    { subject: 'string?', redactPaths: 'boolean?' },
    { report: 'DiagnosticReport' },
    COMMON_READ_ERRORS
  ),
  command('cli.getStatus', 'cli', 'readonly', both(), {}, { status: 'CliStatus' }, COMMON_READ_ERRORS),
  command('cli.install', 'cli', 'local-only', electronOnly(), {}, { status: 'CliStatus' }, LOCAL_ERRORS),
  command('cli.uninstall', 'cli', 'local-only', electronOnly(), {}, { status: 'CliStatus' }, LOCAL_ERRORS)
]

export const CLIENT_API_EVENT_CATALOG: CatalogEventEntry[] = [
  { name: 'client.hello', payload: { version: 'string' } },
  { name: 'subject.changed', payload: { subject: 'string', reason: 'string' } },
  { name: 'conversation.updated', payload: { subject: 'string', session_id: 'string' } },
  { name: 'evolution.updated', payload: { subject: 'string', cycle_id: 'string?' } },
  { name: 'service.status', payload: { subject: 'string', mode: 'string' } },
  { name: 'setup.readiness', payload: { ready: 'boolean' } },
  { name: 'settings.changed', payload: { language: 'string?', theme: 'string?' } },
  { name: 'cli.status', payload: { installed: 'boolean', onPath: 'boolean' } }
]

export const JEA_CLIENT_CATALOG: ClientApiCatalog = {
  protocol: JEA_CLIENT_PROTOCOL_ID,
  version: JEA_CLIENT_PROTOCOL_VERSION,
  capabilities: [...CAPABILITY_LEVELS],
  errors: [...PUBLIC_ERROR_CODES],
  commands: CLIENT_API_COMMAND_CATALOG,
  events: CLIENT_API_EVENT_CATALOG
}

export function catalogCommand(name: string): CatalogCommandEntry | undefined {
  return CLIENT_API_COMMAND_CATALOG.find((entry) => entry.name === name)
}

export function isWebAllowedCommand(name: string): boolean {
  const entry = catalogCommand(name)
  return Boolean(
    entry
    && entry.availability.web
    && (entry.capability === 'readonly' || entry.capability === 'write')
  )
}

export function isClientApiCommand(name: string): name is ClientApiCommandName {
  return (CLIENT_API_COMMANDS as readonly string[]).includes(name)
}

export function serializeClientApiCatalog(): ClientApiCatalog {
  return JSON.parse(JSON.stringify(JEA_CLIENT_CATALOG)) as ClientApiCatalog
}

export function assertCatalogComplete(
  registeredCommands: readonly string[],
  { requireCapability = true }: { requireCapability?: boolean } = {}
): void {
  const catalogNames = new Set(CLIENT_API_COMMAND_CATALOG.map((entry) => entry.name))
  const registered = new Set(registeredCommands)

  for (const name of CLIENT_API_COMMANDS) {
    if (!catalogNames.has(name)) {
      throw new Error(`Client API command ${name} is missing from the catalog.`)
    }
  }

  for (const entry of CLIENT_API_COMMAND_CATALOG) {
    if (requireCapability && !CAPABILITY_LEVELS.includes(entry.capability)) {
      throw new Error(`Client API command ${entry.name} is missing a capability classification.`)
    }
    if (!entry.availability || typeof entry.availability.electron !== 'boolean' || typeof entry.availability.web !== 'boolean') {
      throw new Error(`Client API command ${entry.name} is missing Electron/Web availability.`)
    }
    if (entry.capability === 'local-only' && entry.availability.web) {
      throw new Error(`Client API command ${entry.name} is local-only but marked available on Web.`)
    }
    if (entry.capability === 'destructive' && (entry.availability.electron || entry.availability.web)) {
      throw new Error(`Client API command ${entry.name} is destructive and must not be product-available.`)
    }
  }

  for (const name of registered) {
    if (!catalogNames.has(name as ClientApiCommandName)) {
      throw new Error(`Registered command ${name} is missing catalog registration.`)
    }
  }

  for (const name of catalogNames) {
    if (!registered.has(name)) {
      throw new Error(`Catalog command ${name} has no registered application handler.`)
    }
  }

  const eventNames = new Set(CLIENT_API_EVENT_CATALOG.map((entry) => entry.name))
  for (const name of CLIENT_API_EVENTS) {
    if (!eventNames.has(name)) {
      throw new Error(`Client API event ${name} is missing from the catalog.`)
    }
  }
}
