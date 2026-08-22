import { CLIENT_API_COMMANDS, JEA_CLIENT_PROTOCOL_VERSION } from '../protocol'
import { catalogCommand } from '../catalog'
import { PublicClientError } from '../errors'
import { createTypedJeaClient, type JeaClient, type JeaClientTransport } from '../jea-client'
import { payloadObject, stringField } from '../payload'
import { redactPublicValue } from '../redact'
import type { InvokeRequest, JeaEventEnvelope } from '../types'
import {
  createProductSurfaceFixture,
  fixtureCommandResult,
  type ProductSurfaceFixture
} from '../fixtures/product-surface'

export interface MemoryJeaClientOptions {
  fixtures?: ProductSurfaceFixture
  onEvent?: (event: JeaEventEnvelope) => void
}

function requireFixtureSubject(payload: Record<string, unknown>, fixtures: ProductSurfaceFixture): void {
  const subject = stringField(payload, 'subject', { required: false })
  if (!subject) return
  const known = new Set([
    ...fixtures.subjects.map((item) => item.name),
    fixtures.createdSubject.name
  ])
  if (!known.has(subject)) {
    throw new PublicClientError('NOT_FOUND', 'Requested subject is unavailable.')
  }
}

export function createMemoryCommandTransport(options: MemoryJeaClientOptions = {}): JeaClientTransport {
  const fixtures = options.fixtures ?? createProductSurfaceFixture()
  const listeners = new Set<(event: JeaEventEnvelope) => void>()

  return {
    async invoke(request: InvokeRequest) {
      const command = typeof request?.command === 'string' ? request.command.trim() : ''
      const entry = catalogCommand(command)
      if (!entry || !(CLIENT_API_COMMANDS as readonly string[]).includes(command)) {
        throw new PublicClientError('COMMAND_NOT_ALLOWED', 'Command is not available.')
      }
      const payload = payloadObject(request.payload)
      if (command === 'conversation.sendMessage') stringField(payload, 'text')
      if (command === 'conversation.readMessages') stringField(payload, 'sessionId')
      if (command === 'evolution.getCycle' || command === 'evolution.getRound') stringField(payload, 'cycleId')
      if (command === 'setup.createSubject') stringField(payload, 'name')
      if ([
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
        'setup.initData',
        'setup.enableDesktopChannel'
      ].includes(command)) {
        stringField(payload, 'subject')
        requireFixtureSubject(payload, fixtures)
      }
      const value = fixtureCommandResult(fixtures, command)
      if (value === undefined) {
        throw new PublicClientError('COMMAND_NOT_ALLOWED', 'Command is not available.')
      }
      return redactPublicValue(value)
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export function createMemoryJeaClient(options: MemoryJeaClientOptions = {}): JeaClient {
  return createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, createMemoryCommandTransport(options))
}
