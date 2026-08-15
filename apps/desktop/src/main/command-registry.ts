import type {
  DesktopCommand,
  InvokeRequest,
  InvokeResponse,
  OpsCommand,
  PublicErrorCode
} from '../shared/contract'
import { DESKTOP_COMMANDS } from '../shared/contract'
import { toIpcValue } from './ipc-value'
import { OpsService } from './operations'

export type CommandLevel = 'readonly' | 'write' | 'process' | 'destructive'

export interface CommandDefinition {
  level: CommandLevel
  handler(payload: Record<string, unknown>): unknown | Promise<unknown>
}

export type CommandDefinitions = Record<string, CommandDefinition>

export class PublicCommandError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PublicCommandError'
  }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (payload == null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PublicCommandError('INVALID_REQUEST', 'Invalid operation request.')
  }
  return payload as Record<string, unknown>
}

export function subjectFrom(
  payload: Record<string, unknown>,
  required: boolean
): string | undefined {
  const value = payload.subject
  if (value == null && !required) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new PublicCommandError('INVALID_REQUEST', 'A subject is required.')
  }
  return value.trim()
}

export function createOpsCommandDefinitions(service: OpsService): Record<OpsCommand, CommandDefinition> {
  return {
    'ops.listSubjects': { level: 'readonly', handler: () => service.listSubjects() },
    'ops.getDaemon': {
      level: 'readonly',
      handler: (payload) => service.getDaemon(subjectFrom(payload, true)!)
    },
    'ops.getObservability': {
      level: 'readonly',
      handler: (payload) => service.getObservability(subjectFrom(payload, true)!)
    },
    'ops.refresh': {
      level: 'readonly',
      handler: (payload) => service.refresh(subjectFrom(payload, false))
    }
  }
}

export function createCommandRegistry(
  service = new OpsService(),
  definitions: CommandDefinitions = createOpsCommandDefinitions(service),
  allowedCommands: readonly string[] = DESKTOP_COMMANDS
) {
  const registered = new Set<string>(allowedCommands)

  return async function invoke(request: InvokeRequest): Promise<unknown> {
    const command = typeof request?.command === 'string' ? request.command.trim() : ''
    const definition = Object.hasOwn(definitions, command) ? definitions[command] : undefined
    if (!definition || !registered.has(command) || definition.level === 'destructive') {
      throw new PublicCommandError('COMMAND_NOT_ALLOWED', 'Command is not available.')
    }

    try {
      return await definition.handler(payloadObject(request.payload))
    } catch (error) {
      if (error instanceof PublicCommandError) throw error
      const message = definition.level === 'readonly'
        ? 'Unable to read JEA operational state.'
        : 'Unable to complete the requested operation.'
      throw new PublicCommandError('OPERATION_FAILED', message)
    }
  }
}

export function commandIsKnown(command: string): command is DesktopCommand {
  return (DESKTOP_COMMANDS as readonly string[]).includes(command)
}

export async function invokeForIpc(
  invoke: (request: InvokeRequest) => Promise<unknown>,
  request: InvokeRequest
): Promise<InvokeResponse> {
  try {
    return { ok: true, value: toIpcValue(await invoke(request)) }
  } catch (error) {
    const publicError = error instanceof PublicCommandError
      ? error
      : new PublicCommandError('OPERATION_FAILED', 'Unable to complete the requested operation.')
    return {
      ok: false,
      error: {
        code: publicError.code,
        message: publicError.message
      }
    }
  }
}
