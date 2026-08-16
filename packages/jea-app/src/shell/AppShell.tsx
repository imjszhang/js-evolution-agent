import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider'
import { FeatureSlot } from '../slots/FeatureSlot'
import type { FeatureRegistry, ShellAdapters } from '../slots/types'
import { Button } from '../ui/button'
import { isEscapeKey, isSettingsShortcut, resolveShellPresentation } from './presentation'
import { GlobalStateView, type ShellViewState } from './GlobalStates'
import { SettingsOverlay } from './SettingsOverlay'
import { Workspace } from './Workspace'
import { ServiceStatusPlaceholder } from './placeholders'

export function AppShell({
  adapters,
  registry,
  viewState = 'ready',
  settingsOpen: settingsOpenProp,
  onSettingsOpenChange
}: {
  adapters: ShellAdapters
  registry?: FeatureRegistry
  viewState?: ShellViewState
  settingsOpen?: boolean
  onSettingsOpenChange?(open: boolean): void
}) {
  const { t } = useLocale()
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const [internalSettingsOpen, setInternalSettingsOpen] = useState(false)
  const settingsOpen = settingsOpenProp ?? internalSettingsOpen
  const setSettingsOpen = onSettingsOpenChange ?? setInternalSettingsOpen
  const presentation = useMemo(() => resolveShellPresentation({ settingsOpen }), [settingsOpen])

  const changeSettingsOpen = useCallback((open: boolean) => {
    setSettingsOpen(open)
    if (!open) {
      queueMicrotask(() => settingsButtonRef.current?.focus())
    }
  }, [setSettingsOpen])

  const openSettings = useCallback(() => {
    if (presentation.allowsShortcut('settings')) changeSettingsOpen(true)
  }, [presentation, changeSettingsOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSettingsShortcut(event) && presentation.allowsShortcut('settings')) {
        event.preventDefault()
        changeSettingsOpen(true)
        return
      }
      if (isEscapeKey(event) && presentation.resolveCloseAction().kind === 'close-settings') {
        event.preventDefault()
        changeSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [presentation, changeSettingsOpen])

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="app-shell">
      <a
        href="#jea-conversation"
        className="sr-only focus:not-sr-only focus:absolute focus:z-30 focus:bg-surface-raised focus:px-3 focus:py-2"
      >
        {t('skipToConversation')}
      </a>
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3">
        <div className="min-w-0">
          <strong className="block truncate text-sm">{t('appName')}</strong>
          <span className="block truncate text-xs text-muted-foreground">{t('appTagline')}</span>
        </div>
        <div className="flex items-center gap-3">
          <FeatureSlot
            slotId="workspaceHeader"
            adapters={adapters}
            registry={registry}
          />
          <FeatureSlot
            slotId="serviceStatus"
            adapters={adapters}
            registry={registry}
            fallback={<ServiceStatusPlaceholder slotId="serviceStatus" adapters={adapters} />}
          />
          <Button
            ref={settingsButtonRef}
            variant="outline"
            size="sm"
            data-testid="open-settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={openSettings}
          >
            <Settings className="size-4" aria-hidden="true" />
            {t('settings')}
          </Button>
        </div>
      </header>
      {viewState === 'ready' ? (
        <Workspace adapters={adapters} registry={registry} />
      ) : (
        <GlobalStateView
          state={viewState}
          onRetry={adapters.onRetry}
          onOpenSettings={openSettings}
        />
      )}
      <SettingsOverlay
        open={settingsOpen}
        onOpenChange={changeSettingsOpen}
        adapters={adapters}
        registry={registry}
      />
    </div>
  )
}
