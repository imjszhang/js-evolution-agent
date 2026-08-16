import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApplicationCommandHost, createTypedJeaClient, JEA_CLIENT_PROTOCOL_VERSION } from '../../src/client-api'
import { PublicClientError } from '../../src/client-api/errors'

const homes: string[] = []

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

function tempHome(): { sourceRoot: string; jeaHome: string } {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-client-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-client-home-'))
  homes.push(jeaHome)
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        channels: {
          desktop: { enabled: true, default_session: 'main' },
          classifier: { enabled: true, mode: 'mock' }
        }
      },
      beta: { data_namespace: 'beta-data' }
    }
  }))
  mkdirSync(join(jeaHome, 'subjects', 'alpha-data'), { recursive: true })
  mkdirSync(join(jeaHome, 'subjects', 'beta-data'), { recursive: true })
  return { sourceRoot, jeaHome }
}

describe('application command host', () => {
  it('reads subjects and conversation through domain APIs on a temporary JEA_HOME', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    process.env.JEA_HOME = jeaHome
    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })

    await expect(client.listSubjects()).resolves.toEqual([
      { name: 'alpha', namespace: 'alpha-data', isDefault: true },
      { name: 'beta', namespace: 'beta-data', isDefault: false }
    ])
    const sent = await client.sendMessage('alpha', 'hello', { sessionId: 'main', messageId: 'm-1' })
    expect(sent).toMatchObject({
      subject: 'alpha',
      session_id: 'main',
      message_id: 'm-1',
      duplicate: false
    })
    const page = await client.readMessages('alpha', 'main')
    expect(page.records[0]).toMatchObject({ role: 'user', content: 'hello' })
    const readiness = await client.getReadiness('alpha')
    expect(readiness.model.mode).toBe('mock')
    expect(readiness.conversation.desktopChannelEnabled).toBe(true)
    expect(JSON.stringify(readiness)).not.toMatch(/sk-|api_key|DEEPSEEK_API_KEY=/)
  })

  it('redacts secret-bearing fields from command results', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    process.env.JEA_HOME = jeaHome
    process.env.DEEPSEEK_API_KEY = 'sk-secret-value-should-not-leak'
    const host = createApplicationCommandHost({
      sourceRoot,
      jeaHome,
      cliLauncher: {
        getStatus: () => ({
          installed: false,
          onPath: false,
          pathHint: '~/.local/bin/jea',
          supported: false,
          detail: 'token=sk-secret-value-should-not-leak api_key=hidden'
        }),
        install: () => {
          throw new PublicClientError('UNAVAILABLE', 'CLI installation is not available on this host.')
        },
        uninstall: () => {
          throw new PublicClientError('UNAVAILABLE', 'CLI uninstallation is not available on this host.')
        }
      }
    })
    const status = await host.invoke({ command: 'cli.getStatus' }) as { detail: string }
    expect(status.detail).toContain('[REDACTED_SECRET]')
    expect(JSON.stringify(status)).not.toContain('sk-secret-value-should-not-leak')
    const readiness = await host.invoke({ command: 'setup.getReadiness' }) as { model: { configured: boolean } }
    expect(readiness.model.configured).toBe(true)
    expect(JSON.stringify(readiness)).not.toContain('sk-secret-value-should-not-leak')
  })

  it('does not leak raw stack traces for invalid input', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    process.env.JEA_HOME = jeaHome
    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    const error = await host.invoke({ command: 'subject.get', payload: {} }).catch((caught) => caught)
    expect(error).toMatchObject({
      name: 'PublicCommandError',
      code: 'INVALID_REQUEST',
      message: 'A valid subject is required.'
    })
    expect(String((error as PublicClientError).message)).not.toMatch(/at\s+\S+\s+\(/)
  })
})
