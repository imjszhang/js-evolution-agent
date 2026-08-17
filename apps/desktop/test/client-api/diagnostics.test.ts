import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApplicationCommandHost, createTypedJeaClient, JEA_CLIENT_PROTOCOL_VERSION } from '../../src/client-api'
import { CLIENT_API_COMMANDS } from '../../src/client-api/protocol'
import { OPERATIONAL_READINESS_SEAM } from '../../src/client-api/owners/operational-readiness'
import { simulateProcessFailure } from '../../src/main/process-failures'
import { recordDaemonStartupFailure } from '../../../../src/product/diagnostics-store.mjs'
import { writeBuildMetadata } from '../../../../src/product/build-metadata.mjs'

const API_KEY_CANARY = 'sk-canary-api-key-142-should-never-export'
const WEB_TOKEN_CANARY = 'jea-web-token-canary-142-aabbccddeeff'
const OWNER_TOKEN_CANARY = 'owner-token-canary-142-001122334455'
const MESSAGE_BODY_CANARY = 'CANARY_MESSAGE_BODY_142_do_not_export_this_conversation'
const CERTIFIED_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

function tempRoots() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-diag-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-diag-home-'))
  mkdirSync(join(sourceRoot, 'src', 'product'), { recursive: true })
  writeBuildMetadata(join(sourceRoot, 'src', 'product'), {
    version: '0.1.0',
    commit: CERTIFIED_COMMIT,
    dirty: false,
    built_at: '2026-08-17T04:32:54.000Z',
    platform: 'linux',
    arch: 'x64'
  })
  return { sourceRoot, jeaHome }
}

function clientFor(sourceRoot: string, jeaHome: string) {
  process.env.JEA_HOME = jeaHome
  const host = createApplicationCommandHost({ sourceRoot, jeaHome })
  return {
    host,
    client: createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })
  }
}

function seedCanaries(jeaHome: string) {
  writeFileSync(join(jeaHome, '.env'), `DEEPSEEK_API_KEY=${API_KEY_CANARY}\n`)
  mkdirSync(join(jeaHome, 'web-host'), { recursive: true })
  writeFileSync(join(jeaHome, 'web-host', 'session'), WEB_TOKEN_CANARY)
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'evolution', 'daemon'), { recursive: true })
  writeFileSync(
    join(jeaHome, 'subjects', 'alpha', 'evolution', 'daemon', 'desktop-supervisor.json'),
    JSON.stringify({ owner_token: OWNER_TOKEN_CANARY, pid: 4242 }, null, 2)
  )
}

function assertNoCanaries(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain(API_KEY_CANARY)
  expect(text).not.toContain(WEB_TOKEN_CANARY)
  expect(text).not.toContain(OWNER_TOKEN_CANARY)
  expect(text).not.toContain(MESSAGE_BODY_CANARY)
  expect(text).not.toMatch(/DEEPSEEK_API_KEY=/)
}

describe('settings.exportDiagnostics', () => {
  it('reuses service.getReadiness instead of inventing a second catalog', () => {
    expect(CLIENT_API_COMMANDS).toContain('settings.exportDiagnostics')
    expect(CLIENT_API_COMMANDS).toContain('service.getReadiness')
    expect(OPERATIONAL_READINESS_SEAM).toEqual({
      issue: 138,
      reservedCommand: 'service.getReadiness',
      source: 'service.getReadiness'
    })
  })

  it('exports a machine-readable report with provenance and operational domains', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    await client.initData('alpha')
    const report = await client.exportDiagnostics({ redactPaths: true })
    expect(report.schema_version).toBe(1)
    expect(report.product).toMatchObject({
      version: '0.1.0',
      commit: CERTIFIED_COMMIT,
      commit_short: 'bbbbbbb',
      platform: 'linux',
      architecture: 'x64',
      dirty: false
    })
    expect(report.host.jea_home).toBe('<JEA_HOME>')
    expect(report.host.subject).toBe('alpha')
    expect(report.readiness.source).toBe('service.getReadiness')
    expect(report.readiness.reservedCommand).toBe('service.getReadiness')
    for (const id of ['web', 'cycle', 'channel', 'model', 'conversation'] as const) {
      expect(report.readiness[id].id).toBe(id)
      expect(typeof report.readiness[id].status).toBe('string')
      expect(Array.isArray(report.readiness[id].reasons)).toBe(true)
      expect(report.readiness[id].reasons.length).toBeLessThanOrEqual(3)
    }
    expect(report.daemon.log_paths?.stdout).toContain('<JEA_HOME>/logs/')
    expect(report.daemon.log_paths?.stderr).toContain('<JEA_HOME>/logs/')
  })

  it('redacts the JEA Home prefix and keeps the raw path only when asked', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    const redacted = await client.exportDiagnostics({ redactPaths: true })
    expect(redacted.host.jea_home).toBe('<JEA_HOME>')
    expect(JSON.stringify(redacted)).not.toContain(jeaHome)

    const raw = await client.exportDiagnostics({ redactPaths: false })
    expect(raw.host.jea_home).toBe(jeaHome)
  })

  it('omits seeded API-key, Web-token, owner-token, and message-body canaries', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    seedCanaries(jeaHome)
    process.env.DEEPSEEK_API_KEY = API_KEY_CANARY
    const { client } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    await client.initData('alpha')
    await client.sendMessage('alpha', MESSAGE_BODY_CANARY, { sessionId: 'main', messageId: 'canary-142' })
    const page = await client.readMessages('alpha', 'main')
    expect(page.records.some((item) => item.content === MESSAGE_BODY_CANARY)).toBe(true)

    const report = await client.exportDiagnostics({ subject: 'alpha', redactPaths: true })
    assertNoCanaries(report)
    expect(JSON.stringify(report)).not.toContain(jeaHome)
  })

  it('includes a simulated renderer failure without crashing export', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client, host } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    const recorded = simulateProcessFailure(host.runtime, 'renderer')
    expect(recorded).toMatchObject({
      process_type: 'renderer',
      reason: 'crashed',
      version: '0.1.0'
    })
    const report = await client.exportDiagnostics()
    expect(report.process_failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        process_type: 'renderer',
        reason: 'crashed',
        version: '0.1.0'
      })
    ]))
    assertNoCanaries(report)
  })

  it('surfaces redacted managed-daemon startup log paths', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client, host } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    recordDaemonStartupFailure(host.runtime, {
      subject: 'alpha',
      reason: 'startup_deadline',
      logPaths: {
        stdout: join(jeaHome, 'logs', 'daemon-alpha.desktop.stdout.log'),
        stderr: join(jeaHome, 'logs', 'daemon-alpha.desktop.stderr.log')
      }
    })
    const report = await client.exportDiagnostics({ subject: 'alpha' })
    expect(report.daemon.last_startup_failure).toMatchObject({
      subject: 'alpha',
      reason: 'startup_deadline',
      log_paths: {
        stdout: '<JEA_HOME>/logs/daemon-alpha.desktop.stdout.log',
        stderr: '<JEA_HOME>/logs/daemon-alpha.desktop.stderr.log'
      }
    })
    expect(JSON.stringify(report.daemon)).not.toContain(jeaHome)
  })
})
