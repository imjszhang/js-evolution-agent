import type { InvokeRequest, OpsCommand } from '../shared/contract'
import { OPS_COMMANDS } from '../shared/contract'
import { OpsService } from './operations'

const ALLOWED = new Set<string>(OPS_COMMANDS)
const MUTATION_HINT = /(?:^|[.:_-])(write|set|put|create|update|delete|remove|reset|start|stop|retry|cancel|ack|enqueue|run|exec|destroy)(?:$|[.:_-])/i

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

export function createCommandRegistry(service = new OpsService()) {
  const handlers: Record<OpsCommand, (payload: Record<string, unknown>) => unknown> = {
    'ops.listSubjects': () => service.listSubjects(),
    'ops.getDaemon': (payload) => service.getDaemon(subjectFrom(payload, true)!),
    'ops.getObservability': (payload) => service.getObservability(subjectFrom(payload, true)!),
    'ops.refresh': (payload) => service.refresh(subjectFrom(payload, false))
  }

  return async function invoke(request: InvokeRequest): Promise<unknown> {
    const command = typeof request?.command === 'string' ? request.command.trim() : ''
    if (MUTATION_HINT.test(command)) {
      throw new PublicCommandError('READ_ONLY_VIOLATION', 'This client only permits read-only operations.')
    }
    if (!ALLOWED.has(command)) {
      throw new PublicCommandError('COMMAND_NOT_ALLOWED', 'Command is not available.')
    }

    try {
      return await handlers[command as OpsCommand](payloadObject(request.payload))
    } catch (error) {
      if (error instanceof PublicCommandError) throw error
      throw new PublicCommandError('OPERATION_FAILED', 'Unable to read JEA operational state.')
    }
  }
}
