import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createJeaBridge } from '../src/preload/api'
import { JEA_INVOKE_CHANNEL } from '../src/shared/contract'

describe('preload surface', () => {
  it('exposes one frozen invoke function and no Node surface', async () => {
    const transport = vi.fn(async () => ({ ok: true }))
    const bridge = createJeaBridge(transport)

    expect(Object.keys(bridge)).toEqual(['invoke'])
    expect(Object.isFrozen(bridge)).toBe(true)
    await expect(bridge.invoke('ops.getDaemon', { subject: 'alpha' })).resolves.toEqual({ ok: true })
    expect(transport).toHaveBeenCalledWith('ops.getDaemon', { subject: 'alpha' })
    expect('require' in bridge).toBe(false)
    expect('process' in bridge).toBe(false)
  })

  it('binds window.jea through contextBridge on the single IPC channel', () => {
    const source = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("contextBridge.exposeInMainWorld('jea', bridge)")
    expect(source).toContain('ipcRenderer.invoke(JEA_INVOKE_CHANNEL')
    expect(JEA_INVOKE_CHANNEL).toBe('jea:invoke')
  })
})
