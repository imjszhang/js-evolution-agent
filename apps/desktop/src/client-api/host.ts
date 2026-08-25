import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CLIENT_API_COMMANDS, JEA_CLIENT_PROTOCOL_ID, JEA_CLIENT_PROTOCOL_VERSION } from './protocol'
import { assertCatalogComplete, catalogCommand } from './catalog'
import { PublicClientError, toPublicClientError } from './errors'
import { payloadObject, optionalBoolean, numberField, stringField } from './payload'
import { redactPublicValue } from './redact'
import type { CapabilityLevel } from './protocol'
import type { ClientHostKind, InvokeRequest, SettingsPatch } from './types'
import { createClientRuntimeContext, type ClientRuntimeContext } from './owners/runtime'
import { SubjectCommandOwner } from './owners/subject'
import { ConversationCommandOwner } from './owners/conversation'
import { EvolutionCommandOwner } from './owners/evolution'
import { ServiceCommandOwner, createProjectionServicePort, type ClientLifecycleHook, type ServiceProcessPort } from './owners/service'
import { SetupCommandOwner, createInjectedHomePort, type HomePort } from './owners/setup'
import { SettingsCommandOwner } from './owners/settings'
import { DiagnosticsCommandOwner } from './owners/diagnostics'
import { CliCommandOwner, createUnsupportedCliLauncher, type CliLauncherPort } from './owners/cli'

export interface ApplicationCommandHandler {
  capability: CapabilityLevel
  handle(payload: Record<string, unknown>): unknown | Promise<unknown>
}

export type ApplicationCommandHandlers = Record<string, ApplicationCommandHandler>

export interface ApplicationCommandHost {
  runtime: ClientRuntimeContext
  handlers: ApplicationCommandHandlers
  invoke(request: InvokeRequest): Promise<unknown>
}

export interface ApplicationCommandHostOptions {
  sourceRoot: string
  jeaHome?: string
  serviceProcess?: ServiceProcessPort
  home?: HomePort
  cliLauncher?: CliLauncherPort
  versions?: { appVersion: string; cliVersion: string }
  hostKind?: ClientHostKind
  lifecycle?: ClientLifecycleHook | null
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '../../../../src/product/version.json'),
    join(here, '../../../../package.json')
  ]
  for (const path of candidates) {
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
      if (payload.version) return payload.version
    } catch {
      // Try the next source.
    }
  }
  return '0.2.1'
}

export function createApplicationCommandHandlers(options: ApplicationCommandHostOptions): ApplicationCommandHandlers {
  const runtime = createClientRuntimeContext(options.sourceRoot, options.jeaHome)
  const subjects = new SubjectCommandOwner(runtime)
  const conversation = new ConversationCommandOwner(runtime)
  const evolution = new EvolutionCommandOwner(runtime)
  const cli = new CliCommandOwner(options.cliLauncher ?? createUnsupportedCliLauncher())
  const hostKind = options.hostKind ?? 'electron'
  const lifecycle = hostKind === 'electron' ? (options.lifecycle ?? null) : null
  const service = new ServiceCommandOwner(
    runtime,
    options.serviceProcess ?? createProjectionServicePort(runtime),
    hostKind,
    lifecycle
  )
  const setup = new SetupCommandOwner(
    runtime,
    options.home ?? createInjectedHomePort(runtime),
    () => cli.getStatus()
  )
  const versions = options.versions ?? { appVersion: packageVersion(), cliVersion: packageVersion() }
  const settings = new SettingsCommandOwner(runtime, versions)
  const diagnostics = new DiagnosticsCommandOwner(runtime, setup, service, settings)

  const handlers: ApplicationCommandHandlers = {
    'protocol.get': {
      capability: 'readonly',
      handle: () => ({
        protocol: JEA_CLIENT_PROTOCOL_ID,
        version: JEA_CLIENT_PROTOCOL_VERSION,
        commands: [...CLIENT_API_COMMANDS],
        events: [
          'client.hello',
          'subject.changed',
          'conversation.updated',
          'evolution.updated',
          'service.status',
          'setup.readiness',
          'settings.changed',
          'cli.status'
        ]
      })
    },
    'subject.list': { capability: 'readonly', handle: () => subjects.list() },
    'subject.get': { capability: 'readonly', handle: (payload) => subjects.get(stringField(payload, 'subject')!) },
    'subject.select': {
      capability: 'write',
      handle: async (payload) => {
        const previous = subjects.selected
        const record = subjects.select(stringField(payload, 'subject')!)
        if (lifecycle) {
          try {
            await lifecycle.reconcile({
              subject: record.name,
              previous,
              reason: 'subject_select'
            })
          } catch {
            // Selection must succeed; readiness projects attach/start failure.
          }
        }
        return record
      }
    },
    'subject.setDefault': {
      capability: 'write',
      handle: async (payload) => {
        const previous = subjects.selected
        const record = subjects.setDefault(stringField(payload, 'subject')!)
        if (lifecycle) {
          try {
            await lifecycle.reconcile({
              subject: record.name,
              previous,
              reason: 'subject_default'
            })
          } catch {
            // Default change must succeed; readiness projects attach/start failure.
          }
        }
        return record
      }
    },
    'conversation.listSessions': {
      capability: 'readonly',
      handle: (payload) => conversation.listSessions(stringField(payload, 'subject')!)
    },
    'conversation.createSession': {
      capability: 'write',
      handle: (payload) => conversation.createSession(
        stringField(payload, 'subject')!,
        stringField(payload, 'sessionId', { required: false })
      )
    },
    'conversation.readMessages': {
      capability: 'readonly',
      handle: (payload) => conversation.readMessages(
        stringField(payload, 'subject')!,
        stringField(payload, 'sessionId')!,
        {
          offset: numberField(payload, 'offset', 0),
          limit: Math.min(1000, numberField(payload, 'limit', 100)),
          ...(payload.tail == null ? {} : { tail: Math.min(1000, numberField(payload, 'tail', 100)) })
        }
      )
    },
    'conversation.sendMessage': {
      capability: 'write',
      handle: (payload) => conversation.sendMessage(
        stringField(payload, 'subject')!,
        stringField(payload, 'text')!,
        {
          sessionId: stringField(payload, 'sessionId', { required: false }),
          messageId: stringField(payload, 'messageId', { required: false })
        }
      )
    },
    'evolution.listCycles': {
      capability: 'readonly',
      handle: (payload) => evolution.listCycles(
        stringField(payload, 'subject')!,
        numberField(payload, 'limit', 50)
      )
    },
    'evolution.getCycle': {
      capability: 'readonly',
      handle: (payload) => evolution.getCycle(stringField(payload, 'subject')!, stringField(payload, 'cycleId')!)
    },
    'evolution.getRound': {
      capability: 'readonly',
      handle: (payload) => evolution.getRound(stringField(payload, 'subject')!, stringField(payload, 'cycleId')!)
    },
    'evolution.getObservability': {
      capability: 'readonly',
      handle: (payload) => evolution.getObservability(stringField(payload, 'subject')!)
    },
    'evolution.getReactorProgress': {
      capability: 'readonly',
      handle: (payload) => evolution.getReactorProgress(stringField(payload, 'subject')!)
    },
    'service.getStatus': {
      capability: 'readonly',
      handle: (payload) => service.getStatus(stringField(payload, 'subject')!)
    },
    'service.getReadiness': {
      capability: 'readonly',
      handle: (payload) => service.getReadiness(stringField(payload, 'subject')!)
    },
    'service.start': {
      capability: 'local-only',
      handle: (payload) => service.start(
        stringField(payload, 'subject')!,
        (stringField(payload, 'domain', { required: false }) ?? 'all') as 'all' | 'cycle' | 'channel' | 'evolution'
      )
    },
    'service.stop': {
      capability: 'local-only',
      handle: (payload) => service.stop(stringField(payload, 'subject')!)
    },
    'service.requestCycle': {
      capability: 'write',
      handle: (payload) => service.requestCycle(
        stringField(payload, 'subject')!,
        stringField(payload, 'note', { required: false })
      )
    },
    'service.processCycleOnce': {
      capability: 'write',
      handle: (payload) => service.processCycleOnce(stringField(payload, 'subject')!)
    },
    'service.setAutomation': {
      capability: 'write',
      handle: (payload) => service.setAutomation(
        stringField(payload, 'subject')!,
        stringField(payload, 'mode')! as 'automatic' | 'paused'
      )
    },
    'setup.getReadiness': {
      capability: 'readonly',
      handle: (payload) => setup.getReadiness(stringField(payload, 'subject', { required: false }))
    },
    'setup.confirmHome': {
      capability: 'local-only',
      handle: (payload) => setup.confirmHome(stringField(payload, 'path', { required: false }))
    },
    'setup.createSubject': {
      capability: 'write',
      handle: (payload) => setup.createSubject(
        stringField(payload, 'name')!,
        { enableDesktopChannel: optionalBoolean(payload, 'enableDesktopChannel') ?? true }
      )
    },
    'setup.initData': {
      capability: 'write',
      handle: (payload) => setup.initData(stringField(payload, 'subject')!)
    },
    'setup.enableDesktopChannel': {
      capability: 'write',
      handle: (payload) => setup.enableDesktopChannel(stringField(payload, 'subject')!)
    },
    'settings.get': { capability: 'readonly', handle: () => settings.get() },
    'settings.set': {
      capability: 'write',
      handle: (payload) => settings.set({
        language: stringField(payload, 'language', { required: false }) as SettingsPatch['language'],
        theme: stringField(payload, 'theme', { required: false }) as SettingsPatch['theme'],
        defaultSubject: stringField(payload, 'defaultSubject', { required: false })
      })
    },
    'settings.exportDiagnostics': {
      capability: 'readonly',
      handle: (payload) => diagnostics.exportDiagnostics({
        subject: stringField(payload, 'subject', { required: false }),
        redactPaths: optionalBoolean(payload, 'redactPaths') ?? true
      })
    },
    'cli.getStatus': { capability: 'readonly', handle: () => cli.getStatus() },
    'cli.install': { capability: 'local-only', handle: () => cli.install() },
    'cli.uninstall': { capability: 'local-only', handle: () => cli.uninstall() }
  }

  for (const [name, handler] of Object.entries(handlers)) {
    const entry = catalogCommand(name)
    if (!entry) {
      throw new Error(`Registered command ${name} is missing catalog registration.`)
    }
    if (handler.capability !== entry.capability) {
      throw new Error(`Registered command ${name} capability ${handler.capability} does not match catalog ${entry.capability}.`)
    }
  }

  assertCatalogComplete(Object.keys(handlers))
  return handlers
}

export function createApplicationCommandHost(options: ApplicationCommandHostOptions): ApplicationCommandHost {
  const runtime = createClientRuntimeContext(options.sourceRoot, options.jeaHome)
  const handlers = createApplicationCommandHandlers(options)

  return {
    runtime,
    handlers,
    async invoke(request: InvokeRequest): Promise<unknown> {
      const command = typeof request?.command === 'string' ? request.command.trim() : ''
      const definition = handlers[command]
      if (!definition) {
        throw new PublicClientError('COMMAND_NOT_ALLOWED', 'Command is not available.')
      }
      try {
        return redactPublicValue(await definition.handle(payloadObject(request.payload)))
      } catch (error) {
        throw toPublicClientError(error, {
          code: 'OPERATION_FAILED',
          message: definition.capability === 'readonly'
            ? 'Unable to read JEA operational state.'
            : 'Unable to complete the requested operation.'
        })
      }
    }
  }
}

export function createClientApiCommandDefinitions(host: ApplicationCommandHost) {
  return Object.fromEntries(
    Object.entries(host.handlers).map(([name, handler]) => [
      name,
      {
        level: handler.capability,
        handler: (payload: Record<string, unknown>) => handler.handle(payload)
      }
    ])
  )
}
