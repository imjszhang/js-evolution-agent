import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaClientProvider } from '../src/features/client-context'
import { createFixtureSetupClient, createReadyReadiness, createSetupFixtureState, createSubjectReadinessFixture } from '../src/features/fixtures'
import { JeaProductApp } from '../src/features/JeaProductApp'
import { ServiceStatusView } from '../src/features/service-status/ServiceStatusView'
import { createFeatureRegistry } from '../src/slots/registry'
import { withDefaultProductFeatures } from '../src/features/product-features'
import { deriveServiceStatusKind, needsOpenDesktop, shouldRefreshServiceReadiness, webHostStoppedIsNotOutage } from '../src/features/service-status/derive'
import { LocaleProvider } from '../src/i18n/LocaleProvider'
import { ThemeProvider } from '../src/theme/ThemeProvider'
import { messages } from '../src/i18n/messages'

function renderStatus(readiness = createSubjectReadinessFixture({ host: 'web' }), host: 'web' | 'electron' = 'web') {
  return renderToStaticMarkup(
    <ThemeProvider initialPreference="light">
      <LocaleProvider initialLocale="en">
        <JeaClientProvider host={host}>
          <ServiceStatusView
            slotId="serviceStatus"
            adapters={{
              selectedSubjectId: 'alpha',
              hostKind: host,
              subjectReadiness: readiness
            }}
          />
        </JeaClientProvider>
      </LocaleProvider>
    </ThemeProvider>
  )
}

describe('service status surfaces', () => {
  it('names Desktop/CLI as the recovery path for native-only Web actions', () => {
    const readiness = createSubjectReadinessFixture({ host: 'web', channel: 'stopped', cycle: 'stopped' })
    expect(needsOpenDesktop(readiness)).toBe(true)
    const html = renderStatus(readiness, 'web')
    expect(html).toContain('data-testid="service-status-open-desktop"')
    expect(html).toContain('Desktop app or CLI')
    expect(html).toContain('jea start')
    expect(html).not.toMatch(/access_token=|sk-/)
  })

  it('does not treat a stopped Web host as an Electron product outage', () => {
    const readiness = createSubjectReadinessFixture({
      host: 'electron',
      webHost: 'stopped',
      channel: 'attached',
      cycle: 'stopped',
      conversation: 'running'
    })
    expect(webHostStoppedIsNotOutage(readiness, 'electron')).toBe(true)
    expect(deriveServiceStatusKind(readiness, { host: 'electron' })).toBe('online')
    const html = renderToStaticMarkup(
      <JeaProductApp
        locale="en"
        host="electron"
        client={createFixtureSetupClient(createSetupFixtureState({ kind: 'ready', cli: 'pathHint' }))}
        initialReadiness={createReadyReadiness()}
        adapters={{
          hostKind: 'electron',
          subjectReadiness: readiness,
          serviceStatus: deriveServiceStatusKind(readiness, { host: 'electron' })
        }}
      />
    )
    expect(html).toContain('data-testid="workspace"')
    expect(html).not.toContain('data-testid="global-state-offline"')
    expect(html).toContain('data-testid="service-status-web-not-outage"')
    expect(html).toContain('not a Desktop outage')
  })

  it('does not overwrite a conversation serviceStatus slot', () => {
    function ConversationStatus() {
      return null
    }
    const registry = createFeatureRegistry(withDefaultProductFeatures([
      { id: 'conversation-119', slots: { serviceStatus: ConversationStatus } }
    ]))
    expect(registry.resolve('serviceStatus')).toBe(ConversationStatus)
  })

  it('refreshes readiness after service and subject events for the active subject', () => {
    expect(shouldRefreshServiceReadiness({ type: 'service.status', subject: 'alpha' }, 'alpha')).toBe(true)
    expect(shouldRefreshServiceReadiness({ type: 'projection.channel_updated', payload: { subject: 'alpha' } }, 'alpha')).toBe(true)
    expect(shouldRefreshServiceReadiness({ type: 'evolution.updated', subject: 'alpha' }, 'alpha')).toBe(true)
    expect(shouldRefreshServiceReadiness({ type: 'subject.changed', subject: 'alpha' }, 'alpha')).toBe(true)
    expect(shouldRefreshServiceReadiness({ type: 'service.status', subject: 'beta' }, 'alpha')).toBe(false)
    expect(shouldRefreshServiceReadiness({ type: 'conversation.updated', subject: 'alpha' }, 'alpha')).toBe(false)
  })

  it('does not freeze an initial online kind over later degraded readiness', () => {
    const readiness = createSubjectReadinessFixture({
      host: 'web',
      cycle: 'stalled',
      channel: 'attached',
      conversation: 'running'
    })
    expect(deriveServiceStatusKind(readiness, { host: 'web', connection: undefined })).toBe('degraded')
    expect(deriveServiceStatusKind(readiness, { host: 'web' })).toBe('degraded')
  })

  it('keeps Web offline copy pointing at Desktop/CLI', () => {
    expect(messages.en.offlineBody).toContain('Desktop app')
    expect(messages.en.offlineBody).toContain('jea start')
    expect(messages.zh.offlineBody).toContain('Desktop')
    expect(messages.zh.offlineBody).toContain('jea start')
    expect(messages.en.openDesktopRecovery).toContain('Desktop')
    expect(messages.zh.openDesktopRecovery).toContain('CLI')
  })
})
