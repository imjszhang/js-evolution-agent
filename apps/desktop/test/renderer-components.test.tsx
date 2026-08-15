import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AcpWorkspace } from '../src/renderer/src/components/AcpWorkspace'
import {
  ChannelChatView,
  mergeRecords
} from '../src/renderer/src/components/ChannelChatView'
import { Navigation } from '../src/renderer/src/components/Navigation'

describe('desktop renderer components', () => {
  it('merges incremental Channel pages by stable id and offset', () => {
    const records = mergeRecords([
      {
        id: 'a',
        session_id: 'main',
        role: 'user',
        direction: 'inbound',
        content: 'old',
        created_at: '2026-08-15T00:00:00Z',
        offset: 0
      }
    ], [
      {
        id: 'a',
        session_id: 'main',
        role: 'user',
        direction: 'inbound',
        content: 'updated',
        created_at: '2026-08-15T00:00:00Z',
        offset: 0
      },
      {
        id: 'b',
        session_id: 'main',
        role: 'assistant',
        direction: 'outbound',
        content: 'reply',
        created_at: '2026-08-15T00:00:01Z',
        offset: 1
      }
    ])
    expect(records.map((record) => [record.id, record.content])).toEqual([
      ['a', 'updated'],
      ['b', 'reply']
    ])
  })

  it('renders safe empty states without a browser bridge', () => {
    const channel = renderToStaticMarkup(<ChannelChatView subject={null} />)
    expect(channel).toContain('Select a subject')
    const acp = renderToStaticMarkup(<AcpWorkspace />)
    expect(acp).toContain('ACP')
  })

  it('renders Channel navigation and notification preference controls', () => {
    const html = renderToStaticMarkup(
      <Navigation
        page="channel"
        subjects={[{ name: 'alpha', namespace: 'alpha-data', isDefault: true }]}
        subject="alpha"
        onPageChange={() => undefined}
        onSubjectChange={() => undefined}
      />
    )
    expect(html).toContain('Channel')
    expect(html).toContain('System alerts')
    expect(html).toContain('alpha-data')
  })
})
