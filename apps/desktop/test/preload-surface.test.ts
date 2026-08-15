import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createJeaBridge } from '../src/preload/api'
import {
  JEA_EVENT_CHANNEL,
  JEA_INVOKE_CHANNEL,
  type JeaEventEnvelope
} from '../src/shared/contract'

describe('preload surface', () => {
  it('exposes frozen invoke and subscribe functions with unsubscribe support', async () => {
    const invokeTransport = vi.fn(async () => ({ ok: true }))
    const unsubscribe = vi.fn()
    let emit: ((event: JeaEventEnvelope) => void) | undefined
    const eventTransport = vi.fn((listener: (event: JeaEventEnvelope) => void) => {
      emit = listener
      return unsubscribe
    })
    const listener = vi.fn()
    const bridge = createJeaBridge(invokeTransport, eventTransport)

    expect(Object.keys(bridge)).toEqual(['invoke', 'subscribe'])
    expect(Object.isFrozen(bridge)).toBe(true)
    await expect(bridge.invoke('ops.getDaemon', { subject: 'alpha' })).resolves.toEqual({ ok: true })
    expect(invokeTransport).toHaveBeenCalledWith('ops.getDaemon', { subject: 'alpha' })

    const stop = bridge.subscribe(listener)
    const event: JeaEventEnvelope = {
      type: 'daemon.status',
      ts: '2026-08-15T00:00:00.000Z',
      subject: 'alpha',
      payload: { status: 'running' }
    }
    emit?.(event)
    expect(eventTransport).toHaveBeenCalledWith(listener)
    expect(listener).toHaveBeenCalledWith(event)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()

    expect('require' in bridge).toBe(false)
    expect('process' in bridge).toBe(false)
  })

  it('binds invoke and events to their IPC channels without exposing Node', () => {
    const source = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("contextBridge.exposeInMainWorld('jea', bridge)")
    expect(source).toContain('ipcRenderer.invoke(JEA_INVOKE_CHANNEL')
    expect(source).toContain('ipcRenderer.on(JEA_EVENT_CHANNEL')
    expect(source).toContain('ipcRenderer.removeListener(JEA_EVENT_CHANNEL')
    expect(JEA_INVOKE_CHANNEL).toBe('jea:invoke')
    expect(JEA_EVENT_CHANNEL).toBe('jea:event')
    expect(source).not.toMatch(/exposeInMainWorld\(['"](?:require|process|global|Buffer)['"]/)
  })
})
