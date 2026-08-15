import type { InvokeRequest, OpsCommand } from '../shared/contract'
import { OPS_COMMANDS } from '../shared/contract'
import { OpsService } from './operations'

export type CommandLevel = 'readonly' | 'write' | 'destructive'

export interface CommandDefinition {
  level: CommandLevel
  handler(payload: Record<string, unknown>): unknown
}

export type CommandDefinitions = Record<string, CommandDefinition>

export class PublicCommandError extends Error {
  constructor(
    readonly code: 'COMMAND_NOT_ALLOWED' | 'READ_ONLY_VIOLATION' | 'INVALID_REQUEST' | 'OPERATION_FAILED',
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

function subjectFrom(payload: Record<string, unknown>, required: boolean): string | undefined {
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
  definitions: CommandDefinitions = createOpsCommandDefinitions(service)
) {
  const registered = new Set<string>(OPS_COMMANDS)

  return async function invoke(request: InvokeRequest): Promise<unknown> {
    const command = typeof request?.command === 'string' ? request.command.trim() : ''
    const definition = Object.hasOwn(definitions, command) ? definitions[command] : undefined
    if (!definition || (!registered.has(command) && definition.level === 'readonly')) {
      throw new PublicCommandError('COMMAND_NOT_ALLOWED', 'Command is not available.')
    }
    if (definition.level !== 'readonly') {
      throw new PublicCommandError('READ_ONLY_VIOLATION', 'This client only permits read-only operations.')
    }

    try {
      return await definition.handler(payloadObject(request.payload))
    } catch (error) {
      if (error instanceof PublicCommandError) throw error
      throw new PublicCommandError('OPERATION_FAILED', 'Unable to read JEA operational state.')
    }
  }
}
