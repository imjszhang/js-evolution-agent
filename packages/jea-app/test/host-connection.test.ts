import { describe, expect, it } from 'vitest'
import { isJeaWebHosted, resolveHostedViewState } from '../src/web/host-connection'

describe('web host connection state', () => {
  it('keeps visual-query states and surfaces offline when the hosted bootstrap fails', () => {
    expect(resolveHostedViewState({ queryState: 'ready', hosted: true, connected: false })).toBe('ready')
    expect(resolveHostedViewState({ queryState: 'offline', hosted: false, connected: true })).toBe('offline')
    expect(resolveHostedViewState({ hosted: false, connected: null })).toBe('ready')
    expect(resolveHostedViewState({ hosted: true, connected: null })).toBe('loading')
    expect(resolveHostedViewState({ hosted: true, connected: true })).toBe('ready')
    expect(resolveHostedViewState({ hosted: true, connected: false })).toBe('offline')
  })

  it('detects the injected host bootstrap marker', () => {
    const doc = {
      querySelector(selector: string) {
        return selector === 'meta[name="jea-host"]' ? {} : null
      }
    }
    expect(isJeaWebHosted(doc)).toBe(true)
    expect(isJeaWebHosted({ querySelector: () => null })).toBe(false)
  })
})
