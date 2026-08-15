import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { channelInboundProcessedDir } from '../../../src/channel/paths.mjs'
import { ChannelService } from '../src/main/channel-service'

function fixture(enabled = true): string {
  const root = mkdtempSync(join(tmpdir(), 'jea-desktop-channel-'))
  mkdirSync(join(root, 'runtime', 'subjects'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        channels: {
          desktop: { enabled, default_session: 'main' },
          classifier: { enabled: true, mode: 'mock' }
        }
      }
    }
  }))
  mkdirSync(join(root, 'runtime', 'subjects', 'alpha-data'), { recursive: true })
  return root
}

describe('ChannelService', () => {
  it('sends through the desktop adapter and reads stable offset pages', () => {
    const root = fixture()
    const service = new ChannelService(root)
    const result = service.sendMessage('alpha', 'main', 'hello', 'm-1')
    expect(result).toMatchObject({
      subject: 'alpha',
      session_id: 'main',
      message_id: 'm-1',
      session_created: true
    })
    const duplicate = service.sendMessage('alpha', 'main', 'hello', 'm-1')
    expect(duplicate.duplicate).toBe(true)

    expect(service.listSessions('alpha')).toMatchObject([
      { session_id: 'main', message_count: 1 }
    ])
    const first = service.readSession('alpha', 'main', { offset: 0, limit: 1 })
    expect(first.records).toHaveLength(1)
    expect(first.records[0]).toMatchObject({ role: 'user', content: 'hello' })
    expect(first.next_offset).toBe(1)
    expect(service.readSession('alpha', 'main', { offset: first.next_offset }).records)
      .toHaveLength(0)
  })

  it('exposes processed Feishu classifier understanding', () => {
    const root = fixture()
    const dir = channelInboundProcessedDir(root, 'alpha')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'feishu.json'), JSON.stringify({
      envelope: { message_id: 'fm-1', chat_id: 'oc_chat', text: 'ship it' },
      classifier: {
        classification: 'approval_request',
        understanding: {
          user_intent: 'approve release',
          temporal: 'now',
          complexity: 'medium'
        }
      }
    }))
    const [item] = new ChannelService(root).listInbound('alpha', 'processed')
    expect(item).toMatchObject({
      message_id: 'fm-1',
      chat_id: 'oc_chat',
      classification: 'approval_request',
      understanding: { user_intent: 'approve release', temporal: 'now' }
    })
  })

  it('returns a public conflict when desktop transport is disabled', () => {
    const service = new ChannelService(fixture(false))
    expect(() => service.sendMessage('alpha', 'main', 'hello')).toThrow(
      'Desktop Channel is disabled for this subject.'
    )
  })
})
