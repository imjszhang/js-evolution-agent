import { describe, expect, it } from 'vitest'
import { createFeatureRegistry } from '../src/slots/registry'

function Marker() {
  return null
}

describe('feature registration', () => {
  it('lets later modules occupy slots without editing the root App', () => {
    const registry = createFeatureRegistry([
      { id: 'wave1', slots: { conversation: Marker } }
    ])
    expect(registry.resolve('conversation')).toBe(Marker)
    expect(registry.resolve('evolutionInspector')).toBeNull()

    const ConversationV2 = function ConversationV2() { return null }
    registry.register({
      id: 'conversation-119',
      slots: { conversation: ConversationV2 }
    })
    expect(registry.resolve('conversation')).toBe(ConversationV2)
  })
})
