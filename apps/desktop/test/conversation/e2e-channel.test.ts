import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runChannelClassifierTask } from '../../../../src/channel/classifier.mjs'
import { runChannelPresenceTask } from '../../../../src/channel/presence.mjs'
import { runChannelNotifyTask } from '../../../../src/channel/tasks.mjs'
import {
  createApplicationCommandHost,
  createTypedJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION
} from '../../src/client-api'
import { ConversationWorkspaceModel } from '../../src/renderer/src/conversation/model'

const homes: string[] = []

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

function writeTestSubjectHome(): { sourceRoot: string; jeaHome: string } {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-conversation-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-conversation-home-'))
  homes.push(jeaHome)
  const namespace = join(jeaHome, 'subjects', 'alpha-data')
  mkdirSync(namespace, { recursive: true })
  writeFileSync(join(namespace, 'SUBJECT.md'), [
    '# alpha',
    '',
    '## Subject',
    'Conversation test subject with desktop Channel enabled.',
    '',
    '## Persona',
    'Concise operator-facing replies. Do not grant approvals.',
    ''
  ].join('\n'), 'utf8')
  writeFileSync(join(namespace, 'SOUL.md'), '# soul\nConcise.\n', 'utf8')
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        policy: 'SUBJECT.md',
        channels: {
          desktop: { enabled: true, default_session: 'main' },
          classifier: { enabled: true, mode: 'deterministic', batch_size: 20 },
          presence: {
            enabled: true,
            planner: 'deterministic',
            default_transport: 'desktop',
            default_target: 'desktop:main'
          }
        }
      }
    }
  }, null, 2))
  return { sourceRoot, jeaHome }
}

describe('governed local Channel conversation E2E', () => {
  it('sends through JeaClient and persists an assistant record after classifier/presence/speech', async () => {
    const { sourceRoot, jeaHome } = writeTestSubjectHome()
    process.env.JEA_HOME = jeaHome
    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })

    await client.initData('alpha')
    const subject = await client.getSubject('alpha')
    expect(subject.desktopChannelEnabled).toBe(true)

    const model = new ConversationWorkspaceModel(client)
    await model.bootstrap('alpha')
    model.setDraft('同意发布候选')
    await model.send()

    const sent = model.getSnapshot().lastSend
    expect(sent).toMatchObject({
      subject: 'alpha',
      session_id: 'main',
      duplicate: false
    })
    expect(model.getSnapshot().records.every((record) => record.role === 'user')).toBe(true)

    const classified = await runChannelClassifierTask(host.runtime, 'alpha')
    expect(classified.classified).toBeGreaterThan(0)
    const presence = await runChannelPresenceTask(host.runtime, 'alpha')
    expect(presence.plan?.kind ?? presence.skipped).toBeTruthy()
    await runChannelNotifyTask(host.runtime, 'alpha')

    const page = await client.readMessages('alpha', 'main', { tail: 20 })
    expect(page.records[0]).toMatchObject({ role: 'user', content: '同意发布候选' })
    expect(page.records.some((record) => record.role === 'assistant')).toBe(true)
    expect(page.records.filter((record) => record.role === 'assistant')
      .every((record) => record.content.trim().length > 0)).toBe(true)
    expect(JSON.stringify(page)).not.toMatch(/approval_granted/)
  })
})
