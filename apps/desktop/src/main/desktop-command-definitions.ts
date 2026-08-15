import type { AcpSessionManager } from './acp-session-manager'
import type { CommandDefinitions } from './command-registry'
import {
  PublicCommandError,
  createOpsCommandDefinitions,
  subjectFrom
} from './command-registry'
import type { DaemonSupervisor } from './daemon-supervisor'
import type { OpsService } from './operations'
import type { TodoService } from './todo-service'

function stringField(
  payload: Record<string, unknown>,
  key: string,
  { required = true }: { required?: boolean } = {}
): string | undefined {
  const value = payload[key]
  if (value == null && !required) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new PublicCommandError('INVALID_REQUEST', `A valid ${key} is required.`)
  }
  return value.trim()
}

function objectField(
  payload: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = payload[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicCommandError('INVALID_REQUEST', `A valid ${key} object is required.`)
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PublicCommandError('INVALID_REQUEST', 'Expected a list of paths.')
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

export function createDesktopCommandDefinitions({
  ops,
  todo,
  daemon,
  acp
}: {
  ops: OpsService
  todo: TodoService
  daemon: DaemonSupervisor
  acp: AcpSessionManager
}): CommandDefinitions {
  return {
    ...createOpsCommandDefinitions(ops),
    'todo.get': {
      level: 'readonly',
      handler: (payload) => todo.get(subjectFrom(payload, true)!)
    },
    'todo.putBrief': {
      level: 'write',
      handler: (payload) => todo.putBrief(
        subjectFrom(payload, true)!,
        objectField(payload, 'brief')
      )
    },
    'todo.putFact': {
      level: 'write',
      handler: (payload) => todo.putFact(
        subjectFrom(payload, true)!,
        objectField(payload, 'fact')
      )
    },
    'todo.resolveQuestion': {
      level: 'write',
      handler: (payload) => todo.resolveQuestion(
        subjectFrom(payload, true)!,
        stringField(payload, 'questionId')!,
        stringField(payload, 'note', { required: false })
      )
    },
    'todo.requestCycle': {
      level: 'write',
      handler: (payload) => todo.requestCycle(
        subjectFrom(payload, true)!,
        stringField(payload, 'note', { required: false })
      )
    },
    'todo.updateGoals': {
      level: 'write',
      handler: (payload) => todo.updateGoals(
        subjectFrom(payload, true)!,
        objectField(payload, 'goals'),
        stringField(payload, 'reason')!,
        Array.isArray(payload.evidenceRefs)
          ? payload.evidenceRefs.filter((item): item is Record<string, unknown> =>
              Boolean(item && typeof item === 'object' && !Array.isArray(item)))
          : [],
        stringField(payload, 'cycle', { required: false }) ?? null
      )
    },
    'daemon.getSupervisor': {
      level: 'readonly',
      handler: (payload) => daemon.get(subjectFrom(payload, true)!)
    },
    'daemon.startManaged': {
      level: 'process',
      handler: (payload) => daemon.start(subjectFrom(payload, true)!, {
        domain: (stringField(payload, 'domain', { required: false }) ?? 'all') as
          'all' | 'cycle' | 'channel'
      })
    },
    'daemon.stopManaged': {
      level: 'process',
      handler: (payload) => daemon.stop(subjectFrom(payload, true)!)
    },
    'acp.listFrameworks': {
      level: 'readonly',
      handler: () => acp.listFrameworks()
    },
    'acp.chooseExecutionRoot': {
      level: 'process',
      handler: () => acp.pickExecutionRoot()
    },
    'acp.listSessions': {
      level: 'readonly',
      handler: () => acp.list()
    },
    'acp.listPermissions': {
      level: 'readonly',
      handler: (payload) => acp.listPermissions(
        stringField(payload, 'sessionId', { required: false })
      )
    },
    'acp.startSession': {
      level: 'process',
      handler: (payload) => acp.start({
        provider: stringField(payload, 'provider')!,
        executionRoot: stringField(payload, 'executionRoot')!,
        permissionProfile: stringField(payload, 'permissionProfile', { required: false }),
        additionalDirectories: stringArray(payload.additionalDirectories)
      })
    },
    'acp.prompt': {
      level: 'process',
      handler: (payload) => acp.prompt(
        stringField(payload, 'sessionId')!,
        stringField(payload, 'text')!
      )
    },
    'acp.cancelSession': {
      level: 'process',
      handler: (payload) => acp.cancel(stringField(payload, 'sessionId')!)
    },
    'acp.closeSession': {
      level: 'process',
      handler: async (payload) => {
        await acp.close(stringField(payload, 'sessionId')!)
        return { closed: true }
      }
    },
    'acp.respondPermission': {
      level: 'process',
      handler: (payload) => {
        acp.respondPermission(
          stringField(payload, 'sessionId')!,
          stringField(payload, 'requestId')!,
          stringField(payload, 'optionId', { required: false })
        )
        return { resolved: true }
      }
    },
    'acp.setConfigOption': {
      level: 'process',
      handler: (payload) => {
        const value = payload.value
        if (typeof value !== 'string' && typeof value !== 'boolean') {
          throw new PublicCommandError('INVALID_REQUEST', 'Config value is invalid.')
        }
        return acp.setConfigOption(
          stringField(payload, 'sessionId')!,
          stringField(payload, 'configId')!,
          value
        )
      }
    }
  }
}
