import { X } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider'
import { FeatureSlot } from '../slots/FeatureSlot'
import type { FeatureRegistry, ShellAdapters } from '../slots/types'
import { useTheme, type ThemePreference } from '../theme/ThemeProvider'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../ui/dialog'
import { SettingsPlaceholder } from './placeholders'
import type { Locale } from '../i18n/messages'

export function SettingsOverlay({
  open,
  onOpenChange,
  adapters,
  registry
}: {
  open: boolean
  onOpenChange(open: boolean): void
  adapters: ShellAdapters
  registry?: FeatureRegistry
}) {
  const { t, locale, setLocale } = useLocale()
  const { preference, setPreference } = useTheme()

  return (
    <Dialog modal open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="settings-overlay"
        aria-describedby="jea-settings-description"
        className="inset-0 overflow-auto bg-surface shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <DialogTitle className="text-xl font-semibold">{t('settings')}</DialogTitle>
            <DialogDescription id="jea-settings-description" className="mt-1 text-sm text-muted-foreground">
              {t('settingsDescription')}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('closeSettings')}
            data-testid="settings-close"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="grid gap-8 px-6 py-6 md:grid-cols-2">
          <section aria-labelledby="jea-appearance-label" className="space-y-3">
            <h3 id="jea-appearance-label" className="text-sm font-semibold">{t('appearance')}</h3>
            <div className="flex flex-wrap gap-2">
              {(['system', 'light', 'dark'] as ThemePreference[]).map((value) => (
                <Button
                  key={value}
                  variant={preference === value ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={preference === value}
                  onClick={() => setPreference(value)}
                >
                  {value === 'system' ? t('themeSystem') : value === 'light' ? t('themeLight') : t('themeDark')}
                </Button>
              ))}
            </div>
          </section>
          <section aria-labelledby="jea-language-label" className="space-y-3">
            <h3 id="jea-language-label" className="text-sm font-semibold">{t('language')}</h3>
            <div className="flex flex-wrap gap-2">
              {(['en', 'zh'] as Locale[]).map((value) => (
                <Button
                  key={value}
                  variant={locale === value ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={locale === value}
                  onClick={() => setLocale(value)}
                >
                  {value === 'en' ? t('languageEnglish') : t('languageChinese')}
                </Button>
              ))}
            </div>
          </section>
          <section aria-labelledby="jea-product-label" className="space-y-3 md:col-span-2">
            <h3 id="jea-product-label" className="text-sm font-semibold">{t('productInfo')}</h3>
            <p className="text-sm text-muted-foreground">{t('productVersion')}</p>
            <FeatureSlot
              slotId="settings"
              adapters={adapters}
              registry={registry}
              fallback={<SettingsPlaceholder slotId="settings" adapters={adapters} />}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
