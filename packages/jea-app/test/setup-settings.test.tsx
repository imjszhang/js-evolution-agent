import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaClientProvider } from '../src/features/client-context'
import { createDisabledChannelReadiness, createEmptyReadiness, createFixtureSetupClient, createReadyReadiness, createSetupFixtureState, cliFixture } from '../src/features/fixtures'
import { JeaProductApp } from '../src/features/JeaProductApp'
import { isConversationReady, resolveSetupStep } from '../src/features/readiness'
import { SettingsPanel } from '../src/features/settings/SettingsPanel'
import { SetupFlow } from '../src/features/setup/SetupFlow'
import { LocaleProvider } from '../src/i18n/LocaleProvider'
import { ThemeProvider } from '../src/theme/ThemeProvider'

function renderSetup(readiness = createEmptyReadiness()) {
  return renderToStaticMarkup(
    <ThemeProvider initialPreference="light">
      <LocaleProvider initialLocale="en">
        <SetupFlow
          client={createFixtureSetupClient(createSetupFixtureState({ kind: 'empty' }))}
          readiness={readiness}
          onReadinessChange={() => {}}
          onComplete={() => {}}
        />
      </LocaleProvider>
    </ThemeProvider>
  )
}

function renderSettings(options?: Parameters<typeof createSetupFixtureState>[0], host: 'web' | 'electron' = 'web') {
  const state = createSetupFixtureState(options)
  return renderToStaticMarkup(
    <ThemeProvider initialPreference="light">
      <LocaleProvider initialLocale="en">
        <JeaClientProvider client={createFixtureSetupClient(state)} host={host}>
          <SettingsPanel settings={state.settings} readiness={state.readiness} cli={state.cli} />
        </JeaClientProvider>
      </LocaleProvider>
    </ThemeProvider>
  )
}

describe('first-run readiness', () => {
  it('sends empty homes to Setup and ready homes to the workspace', () => {
    const empty = createEmptyReadiness()
    const ready = createReadyReadiness()
    const channel = createDisabledChannelReadiness()
    expect(isConversationReady(empty)).toBe(false)
    expect(resolveSetupStep(empty)).toBe('home')
    expect(resolveSetupStep(empty, { homeConfirmed: true })).toBe('subject')
    expect(isConversationReady(ready)).toBe(true)
    expect(resolveSetupStep(ready)).toBe('ready')
    expect(isConversationReady(channel)).toBe(false)
    expect(resolveSetupStep(channel)).toBe('channel')
  })

  it('renders Setup instead of an empty workspace', () => {
    const html = renderSetup(createEmptyReadiness())
    expect(html).toContain('data-testid="setup-flow"')
    expect(html).toContain('data-testid="setup-step-home"')
    expect(html).not.toContain('data-testid="workspace"')
    expect(html).not.toContain('data-testid="global-state-empty"')
    expect(html).toContain('mock mode')
  })

  it('explains desktop Channel enablement without offering destructive controls', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider initialPreference="light">
        <LocaleProvider initialLocale="en">
          <SetupFlow
            client={createFixtureSetupClient(createSetupFixtureState({ kind: 'channel' }))}
            readiness={createDisabledChannelReadiness()}
            onReadinessChange={() => {}}
            onComplete={() => {}}
          />
        </LocaleProvider>
      </ThemeProvider>
    )
    expect(html).toContain('data-testid="setup-step-channel"')
    expect(html).toContain('data-testid="setup-enable-channel"')
    expect(html).toContain('data-testid="setup-channel-impact"')
    expect(html).not.toMatch(/reset|delete subject|DEEPSEEK_API_KEY|sk-/i)
  })

  it('opens a conversation-ready fixture in the workspace', () => {
    const html = renderToStaticMarkup(
      <JeaProductApp
        locale="en"
        client={createFixtureSetupClient(createSetupFixtureState({ kind: 'ready' }))}
        initialReadiness={createReadyReadiness()}
      />
    )
    expect(html).toContain('data-testid="workspace"')
    expect(html).not.toContain('data-testid="setup-flow"')
  })
})

describe('settings feature slot', () => {
  it('renders General, Runtime, Command Line, and About without secrets or destructive actions', () => {
    const html = renderSettings({ kind: 'ready', cli: 'native' }, 'web')
    expect(html).toContain('data-testid="settings-general"')
    expect(html).toContain('data-testid="settings-runtime"')
    expect(html).toContain('data-testid="settings-cli"')
    expect(html).toContain('data-testid="settings-about"')
    expect(html).toContain('data-testid="settings-cli-native-only"')
    expect(html).toContain('data-testid="settings-home-path"')
    expect(html).toContain('0.1.0')
    expect(html).toContain('License')
    expect(html).not.toContain('data-testid="settings-cli-install"')
    expect(html).not.toMatch(/reset|migrate|DEEPSEEK_API_KEY|sk-|approval bypass/i)
  })

  it('shows installed / on-PATH / path-hint fixture states for native hosts', () => {
    const installed = renderSettings({ cli: 'installed' }, 'electron')
    expect(installed).toContain('data-testid="settings-cli-installed"')
    expect(installed).toContain('~/.local/bin/jea')
    expect(installed).toContain('data-testid="settings-cli-uninstall"')

    const onPath = renderSettings({ cli: 'onPath' }, 'electron')
    expect(onPath).toContain('On PATH')

    const hint = renderSettings({ cli: 'pathHint' }, 'electron')
    expect(hint).toContain('data-testid="settings-cli-install"')
    expect(hint).toContain('~/.local/bin/jea')
  })

  it('does not display complete API keys in runtime copy', () => {
    const html = renderSettings({ kind: 'ready', model: 'deepseek' })
    expect(html).toContain('DeepSeek configured')
    expect(html).not.toMatch(/sk-[a-zA-Z0-9]+/)
    expect(html).not.toContain('DEEPSEEK_API_KEY')
  })
})
