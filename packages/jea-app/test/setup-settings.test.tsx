import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaClientProvider } from '../src/features/client-context'
import { createDisabledChannelReadiness, createEmptyReadiness, createFixtureSetupClient, createReadyReadiness, createSetupFixtureState, createSubjectReadinessFixture, cliFixture } from '../src/features/fixtures'
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

function renderSettings(
  options?: Parameters<typeof createSetupFixtureState>[0],
  host: 'web' | 'electron' = 'web',
  projection?: Pick<React.ComponentProps<typeof SettingsPanel>, 'subjectReadiness' | 'observability' | 'cycleList'>
) {
  const state = createSetupFixtureState(options)
  return renderToStaticMarkup(
    <ThemeProvider initialPreference="light">
      <LocaleProvider initialLocale="en">
        <JeaClientProvider client={createFixtureSetupClient(state)} host={host}>
          <SettingsPanel
            settings={state.settings}
            readiness={state.readiness}
            cli={state.cli}
            {...projection}
          />
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
    expect(html).toContain('data-testid="settings-diagnostics"')
    expect(html).toContain('data-testid="settings-cli-native-only"')
    expect(html).toContain('data-testid="settings-home-path"')
    expect(html).toContain('data-testid="settings-commit"')
    expect(html).toContain('aaaaaaa')
    expect(html).toContain('data-testid="settings-platform"')
    expect(html).toContain('linux/x64')
    expect(html).toContain('data-testid="settings-about-home"')
    expect(html).toContain('data-testid="settings-about-subject"')
    expect(html).toContain('data-testid="settings-export-diagnostics"')
    expect(html).toContain('data-testid="settings-diagnostics-web"')
    expect(html).toContain('data-testid="settings-diagnostics-cycle"')
    expect(html).toContain('data-testid="settings-diagnostics-channel"')
    expect(html).toContain('data-testid="settings-diagnostics-model"')
    expect(html).toContain('data-testid="settings-diagnostics-conversation"')
    expect(html).toContain('0.2.1')
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

  it('renders equivalent read-only mixed-domain state while filtering Web local-only controls', () => {
    const subjectReadiness = createSubjectReadinessFixture({
      host: 'electron',
      webHost: 'running',
      channel: 'running',
      conversation: 'running',
      cycle: 'stalled'
    })
    subjectReadiness.actions = subjectReadiness.actions.map((action) => ({
      ...action,
      allowed: action.id === 'start_cycle' || action.id === 'process_cycle_once'
    }))
    subjectReadiness.allowed_actions = ['start_cycle', 'process_cycle_once']
    const projection = {
      subjectReadiness,
      observability: {
        subject: 'alpha',
        attention: { items: [], summary: { count: 0 } },
        open_cycles: 2,
        evidence_pending_count: 7,
        daemon_task_pending_count: 3
      },
      cycleList: {
        subject: 'alpha',
        namespace: 'alpha-data',
        round_count: 9,
        cycles: [{
          cycle_id: 'cycle-real',
          generated_at: '2026-08-21T00:00:00.000Z',
          tldr: 'Latest real summary.',
          has_diary: true,
          status: 'open'
        }]
      }
    }
    const electron = renderSettings({ kind: 'ready', cli: 'native' }, 'electron', projection)
    const web = renderSettings({ kind: 'ready', cli: 'native' }, 'web', projection)

    for (const html of [electron, web]) {
      expect(html).toContain('data-testid="settings-evolution-rounds">9')
      expect(html).toContain('data-testid="settings-evolution-open-cycles">2')
      expect(html).toContain('data-testid="settings-evolution-latest-status">open')
      expect(html).toContain('data-testid="settings-evolution-latest-summary">Latest real summary.')
      expect(html).toContain('data-testid="settings-pending-evidence">7')
      expect(html).toContain('data-testid="settings-daemon-queue-pending">3')
    }
    expect(electron).toContain('data-testid="settings-start-cycle"')
    expect(web).not.toContain('data-testid="settings-start-cycle"')
    expect(web).toContain('data-testid="settings-process-cycle-once"')
  })
})
