import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApplicationCommandHost, createTypedJeaClient, JEA_CLIENT_PROTOCOL_VERSION } from '../../src/client-api'
import { PublicClientError } from '../../src/client-api/errors'
import type { SetupReadiness } from '../../src/client-api/types'

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

function tempRoots() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-setup-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-setup-home-'))
  return { sourceRoot, jeaHome }
}

function clientFor(sourceRoot: string, jeaHome: string, home?: { writable?: boolean }) {
  process.env.JEA_HOME = jeaHome
  const host = createApplicationCommandHost({
    sourceRoot,
    jeaHome,
    ...(home?.writable === false ? {
      home: {
        resolve: () => ({ path: jeaHome, source: 'injected', writable: false })
      }
    } : {})
  })
  return {
    host,
    client: createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })
  }
}

function readRegistry(jeaHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(jeaHome, 'subjects', 'registry.json'), 'utf8')) as Record<string, unknown>
}

describe('setup/settings JEA_HOME matrix', () => {
  it('treats an empty JEA Home as not conversation-ready and does not invent a default Subject', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    const readiness = await client.getReadiness()
    expect(readiness.subjects).toEqual({ count: 0, defaultSubject: null, names: [] })
    expect(readiness.conversationReady).toBe(false)
    expect(readiness.model.mode).toBe('mock')
    expect(JSON.stringify(readiness)).not.toMatch(/sk-|api_key|DEEPSEEK_API_KEY=/)
  })

  it('creates a first Subject with desktop Channel, sets default, and inits data without a phantom default', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    const beforeMissing = () => {
      try {
        return readRegistry(jeaHome)
      } catch {
        return null
      }
    }
    expect(beforeMissing()).toBeNull()

    await client.confirmHome(jeaHome)
    const created = await client.createSubject('demo-app')
    expect(created).toMatchObject({
      name: 'demo-app',
      created: true,
      skipped: false,
      desktopChannelEnabled: true
    })
    const afterCreate = readRegistry(jeaHome)
    expect(afterCreate.default_subject).toBe('demo-app')
    expect(Object.keys(afterCreate.subjects as object)).toEqual(['demo-app'])
    const demo = (afterCreate.subjects as Record<string, { channels?: Record<string, unknown> }>)['demo-app']
    expect(demo.channels?.desktop).toMatchObject({ enabled: true, default_session: 'main' })
    expect(demo.channels?.presence).toMatchObject({
      default_transport: 'desktop',
      default_target: 'desktop:main'
    })
    expect(demo.channels?.feishu).toBeUndefined()

    const initialized = await client.initData('demo-app')
    expect(initialized).toEqual({ subject: 'demo-app', initialized: true })
    const ready = await client.getReadiness('demo-app')
    expect(ready.conversationReady).toBe(true)
    expect(ready.data.initialized).toBe(true)
    expect(ready.subjects.names).toEqual(['demo-app'])
    expect(Object.keys(readRegistry(jeaHome).subjects as object)).toEqual(['demo-app'])
  })

  it('skips Setup for an existing conversation-ready Subject', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    await client.initData('alpha')
    const readiness = await client.getReadiness()
    expect(readiness.conversationReady).toBe(true)
    expect(readiness.subjects.defaultSubject).toBe('alpha')
  })

  it('does not silently enable desktop Channel on an existing Subject and keeps Feishu settings', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
    const before = {
      default_subject: 'legacy',
      subjects: {
        legacy: {
          data_namespace: 'legacy',
          channels: {
            feishu: { enabled: true, app_id: 'cli_keep' },
            desktop: { enabled: false, default_session: 'main' }
          }
        }
      }
    }
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify(before, null, 2))
    mkdirSync(join(jeaHome, 'subjects', 'legacy'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', 'legacy', 'SUBJECT.md'), '# Subject\n\nlegacy\n')
    const { client } = clientFor(sourceRoot, jeaHome)

    const readiness = await client.getReadiness('legacy')
    expect(readiness.conversation.desktopChannelEnabled).toBe(false)
    expect(readiness.conversationReady).toBe(false)
    expect(readRegistry(jeaHome)).toMatchObject(before)

    const created = await client.createSubject('legacy', { enableDesktopChannel: true })
    expect(created.skipped).toBe(true)
    expect(created.desktopChannelEnabled).toBe(false)
    expect(readRegistry(jeaHome).subjects).toMatchObject(before.subjects)

    const enabled = await client.enableDesktopChannel('legacy')
    expect(enabled.desktopChannelEnabled).toBe(true)
    const after = readRegistry(jeaHome) as {
      subjects: { legacy: { channels: { feishu: unknown; desktop: { enabled: boolean } } } }
    }
    expect(after.subjects.legacy.channels.feishu).toEqual({ enabled: true, app_id: 'cli_keep' })
    expect(after.subjects.legacy.channels.desktop.enabled).toBe(true)
  })

  it('reports a malformed registry as empty and can recover by creating a Subject', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), '{not-json')
    const { client } = clientFor(sourceRoot, jeaHome)
    const readiness = await client.getReadiness()
    expect(readiness.subjects.count).toBe(0)
    expect(readiness.conversationReady).toBe(false)
    await client.createSubject('recovered')
    expect(readRegistry(jeaHome).default_subject).toBe('recovered')
    expect(Object.keys(readRegistry(jeaHome).subjects as object)).toEqual(['recovered'])
  })

  it('does not block Setup when DeepSeek is missing and never returns the key', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    delete process.env.DEEPSEEK_API_KEY
    const { client } = clientFor(sourceRoot, jeaHome)
    const readiness = await client.getReadiness()
    expect(readiness.model).toEqual({ configured: false, mode: 'mock' })
    expect(JSON.stringify(readiness)).not.toContain('DEEPSEEK')
  })

  it('detects DeepSeek from JEA Home and Subject env files without returning the key', async () => {
    const homeRoots = tempRoots()
    writeFileSync(join(homeRoots.jeaHome, '.env'), 'DEEPSEEK_API_KEY=home-secret\n')
    const homeReadiness = await clientFor(homeRoots.sourceRoot, homeRoots.jeaHome).client.getReadiness()
    expect(homeReadiness.model).toEqual({ configured: true, mode: 'deepseek' })
    expect(JSON.stringify(homeReadiness)).not.toContain('home-secret')

    const subjectRoots = tempRoots()
    const { client } = clientFor(subjectRoots.sourceRoot, subjectRoots.jeaHome)
    await client.createSubject('alpha')
    writeFileSync(
      join(subjectRoots.jeaHome, 'subjects', 'alpha', '.env'),
      'DEEPSEEK_API_KEY=subject-secret\n'
    )
    const subjectReadiness = await client.getReadiness('alpha')
    expect(subjectReadiness.model).toEqual({ configured: true, mode: 'deepseek' })
    expect(JSON.stringify(subjectReadiness)).not.toContain('subject-secret')
  })

  it('resumes interrupted initialization without writing a second default Subject', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('paused')
    const interrupted = await client.getReadiness('paused')
    expect(interrupted.data.initialized).toBe(false)
    expect(interrupted.conversationReady).toBe(false)
    expect(interrupted.subjects.names).toEqual(['paused'])

    await client.initData('paused')
    const resumed = await client.getReadiness('paused')
    expect(resumed.conversationReady).toBe(true)
    expect(Object.keys(readRegistry(jeaHome).subjects as object)).toEqual(['paused'])
    expect(readRegistry(jeaHome).default_subject).toBe('paused')
  })

  it('rejects a non-writable JEA Home and keeps getReadiness from crashing', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome, { writable: false })
    const readiness = await client.getReadiness()
    expect(readiness.jeaHome.writable).toBe(false)
    expect(readiness.conversationReady).toBe(false)
    await expect(client.confirmHome(jeaHome)).rejects.toMatchObject({
      name: 'PublicCommandError',
      code: 'OPERATION_FAILED'
    })
  })

  it('updates language, theme, and default Subject through settings commands', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    const { client } = clientFor(sourceRoot, jeaHome)
    await client.createSubject('alpha')
    await client.createSubject('beta', { enableDesktopChannel: false })
    const next = await client.setSettings({ language: 'en', theme: 'dark', defaultSubject: 'beta' })
    expect(next).toMatchObject({
      language: 'en',
      theme: 'dark',
      defaultSubject: 'beta',
      appVersion: '0.2.0',
      cliVersion: '0.2.0',
      platform: expect.any(String),
      architecture: expect.any(String)
    })
    expect(next).toHaveProperty('commitSha')
    expect(next).toHaveProperty('commitShort')
    expect(next).toHaveProperty('buildTime')
    expect(next).toHaveProperty('dirty')
    expect(readRegistry(jeaHome).default_subject).toBe('beta')
  })

  it('keeps CLI install unavailable on the stub launcher without exposing secrets', async () => {
    const { sourceRoot, jeaHome } = tempRoots()
    process.env.DEEPSEEK_API_KEY = 'sk-secret-value-should-not-leak'
    const { client } = clientFor(sourceRoot, jeaHome)
    const status = await client.getCliStatus()
    expect(status.supported).toBe(false)
    await expect(client.installCli()).rejects.toBeInstanceOf(PublicClientError)
    const readiness = await client.getReadiness() as SetupReadiness
    expect(JSON.stringify(readiness)).not.toContain('sk-secret-value-should-not-leak')
  })
})
