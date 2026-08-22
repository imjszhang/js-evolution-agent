import { describe, expect, it } from 'vitest'
import { isExplicitWebFixtureMode, isJeaWebHosted, resolveHostedViewState } from '../src/web/host-connection'

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

  it('enables fixtures only through an explicit non-hosted mode', () => {
    expect(isExplicitWebFixtureMode(false, '?fixture=1')).toBe(true)
    expect(isExplicitWebFixtureMode(false, '?locale=en')).toBe(false)
    expect(isExplicitWebFixtureMode(true, '?fixture=1')).toBe(false)
  })
})
