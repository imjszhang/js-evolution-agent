export const JEA_CLIENT_PROTOCOL_VERSION = '1.0.0' as const

export const JEA_CLIENT_PROTOCOL_ID = 'jea.client' as const

export type JeaClientProtocolVersion = typeof JEA_CLIENT_PROTOCOL_VERSION

export const CAPABILITY_LEVELS = ['readonly', 'write', 'local-only', 'destructive'] as const

export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number]

export const PUBLIC_ERROR_CODES = [
  'COMMAND_NOT_ALLOWED',
  'INVALID_REQUEST',
  'OPERATION_FAILED',
  'CONFLICT',
  'NOT_FOUND',
  'UNAVAILABLE'
] as const

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number]

export const CLIENT_API_COMMANDS = [
  'protocol.get',
  'subject.list',
  'subject.get',
  'subject.select',
  'subject.setDefault',
  'conversation.listSessions',
  'conversation.createSession',
  'conversation.readMessages',
  'conversation.sendMessage',
  'evolution.listCycles',
  'evolution.getCycle',
  'evolution.getRound',
  'evolution.getObservability',
  'service.getStatus',
  'service.getReadiness',
  'service.start',
  'service.stop',
  'service.requestCycle',
  'service.processCycleOnce',
  'service.setAutomation',
  'setup.getReadiness',
  'setup.confirmHome',
  'setup.createSubject',
  'setup.initData',
  'setup.enableDesktopChannel',
  'settings.get',
  'settings.set',
  'settings.exportDiagnostics',
  'cli.getStatus',
  'cli.install',
  'cli.uninstall'
] as const

export type ClientApiCommandName = (typeof CLIENT_API_COMMANDS)[number]

export const CLIENT_API_EVENTS = [
  'client.hello',
  'subject.changed',
  'conversation.updated',
  'evolution.updated',
  'service.status',
  'setup.readiness',
  'settings.changed',
  'cli.status'
] as const

export type ClientApiEventName = (typeof CLIENT_API_EVENTS)[number]
