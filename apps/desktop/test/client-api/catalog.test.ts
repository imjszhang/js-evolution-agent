import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertCatalogComplete,
  CLIENT_API_COMMAND_CATALOG,
  CLIENT_API_EVENT_CATALOG,
  createApplicationCommandHandlers,
  JEA_CLIENT_CATALOG,
  JEA_CLIENT_PROTOCOL_VERSION,
  isWebAllowedCommand,
  serializeClientApiCatalog
} from '../../src/client-api'
import { CAPABILITY_LEVELS, CLIENT_API_COMMANDS, CLIENT_API_EVENTS } from '../../src/client-api/protocol'

const catalogJson = JSON.parse(
  readFileSync(new URL('../../src/client-api/catalog.json', import.meta.url), 'utf8')
)

describe('Client API catalog', () => {
  it('exports a single protocol version and a complete machine-readable catalog', () => {
    expect(JEA_CLIENT_PROTOCOL_VERSION).toBe('1.0.0')
    expect(JEA_CLIENT_CATALOG.protocol).toBe('jea.client')
    expect(JEA_CLIENT_CATALOG.version).toBe(JEA_CLIENT_PROTOCOL_VERSION)
    expect(JEA_CLIENT_CATALOG.capabilities).toEqual([...CAPABILITY_LEVELS])
    expect(serializeClientApiCatalog()).toEqual(catalogJson)
  })

  it('covers the 0.1.0 product surface with shapes, errors, capability, and availability', () => {
    const names = CLIENT_API_COMMAND_CATALOG.map((entry) => entry.name)
    expect(names).toEqual([...CLIENT_API_COMMANDS])
    expect(names).toEqual(expect.arrayContaining([
      'subject.list',
      'subject.select',
      'conversation.listSessions',
      'conversation.sendMessage',
      'evolution.listCycles',
      'evolution.getRound',
      'service.getStatus',
      'service.requestCycle',
      'setup.getReadiness',
      'settings.get',
      'cli.getStatus'
    ]))
    expect(CLIENT_API_EVENT_CATALOG.map((entry) => entry.name)).toEqual([...CLIENT_API_EVENTS])

    for (const entry of CLIENT_API_COMMAND_CATALOG) {
      expect(CAPABILITY_LEVELS).toContain(entry.capability)
      expect(entry.request).toBeTypeOf('object')
      expect(entry.response).toBeTypeOf('object')
      expect(entry.errors.length).toBeGreaterThan(0)
      expect(entry.availability).toEqual({
        electron: expect.any(Boolean),
        web: expect.any(Boolean)
      })
      if (entry.capability === 'local-only') expect(entry.availability.web).toBe(false)
      expect(isWebAllowedCommand(entry.name)).toBe(
        entry.availability.web && (entry.capability === 'readonly' || entry.capability === 'write')
      )
    }
  })

  it('fails when a command is registered without catalog or capability classification', () => {
    expect(() => assertCatalogComplete([...CLIENT_API_COMMANDS, 'oops.extra'])).toThrow(
      /missing catalog registration/
    )
    expect(() => assertCatalogComplete(CLIENT_API_COMMANDS.filter((name) => name !== 'subject.list'))).toThrow(
      /has no registered application handler/
    )
    expect(() => createApplicationCommandHandlers({
      sourceRoot: '/tmp/jea-missing-catalog',
      jeaHome: '/tmp/jea-missing-catalog-home'
    })).not.toThrow()
  })

  it('registers every catalog command on the application host', () => {
    const handlers = createApplicationCommandHandlers({
      sourceRoot: '/tmp/jea-catalog-host',
      jeaHome: '/tmp/jea-catalog-host-home'
    })
    expect(Object.keys(handlers).sort()).toEqual([...CLIENT_API_COMMANDS].sort())
    for (const [name, handler] of Object.entries(handlers)) {
      const entry = CLIENT_API_COMMAND_CATALOG.find((item) => item.name === name)
      expect(entry?.capability).toBe(handler.capability)
    }
  })
})
