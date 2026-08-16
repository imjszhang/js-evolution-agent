export { JeaApp, type JeaAppProps } from './JeaApp'
export { AppShell } from './shell/AppShell'
export { Workspace } from './shell/Workspace'
export { SettingsOverlay } from './shell/SettingsOverlay'
export { GlobalStateView, type ShellViewState } from './shell/GlobalStates'
export {
  createFeatureRegistry,
  registerFeature,
  resolveFeatureSlot,
  listFeatureModules,
  resetFeatureRegistry
} from './slots/registry'
export { FeatureSlot } from './slots/FeatureSlot'
export {
  FEATURE_SLOT_IDS,
  type FeatureModule,
  type FeatureRegistry,
  type FeatureSlotId,
  type FeatureSlotProps,
  type ShellAdapters,
  type FixtureSubject,
  type FixtureSession,
  type ServiceStatusKind
} from './slots/types'
export {
  resolveShellPresentation,
  isSettingsShortcut,
  isEscapeKey,
  type ShellPresentation,
  type ShellCloseAction
} from './shell/presentation'
export {
  parseWorkspaceLayout,
  resizeLeft,
  resizeRight,
  setInspectorCollapsed,
  isCompactViewport,
  defaultWorkspaceLayout
} from './shell/layout'
export { ThemeProvider, useTheme } from './theme/ThemeProvider'
export {
  THEME_STORAGE_KEY,
  THEME_BOOT_SCRIPT,
  parseStoredTheme,
  resolveTheme,
  applyResolvedTheme,
  type ThemePreference
} from './theme/theme'
export { LocaleProvider, useLocale } from './i18n/LocaleProvider'
export {
  messages,
  t,
  resolveLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  type MessageKey
} from './i18n/messages'
export { createWave1Adapters, WAVE1_SUBJECTS, WAVE1_SESSIONS } from './fixtures/wave1'
export { JeaProductApp, type JeaProductAppProps } from './features/JeaProductApp'
export { JeaClientProvider, useJeaClientContext, useOptionalJeaClient } from './features/client-context'
export { settingsFeature } from './features/settings/module'
export { SettingsPanel } from './features/settings/SettingsPanel'
export { SetupFlow } from './features/setup/SetupFlow'
export { isConversationReady, resolveSetupStep, type SetupStep } from './features/readiness'
export {
  createFixtureSetupClient,
  createSetupFixtureState,
  cliFixture,
  createEmptyReadiness,
  createReadyReadiness,
  createDisabledChannelReadiness
} from './features/fixtures'
export type {
  CliStatus,
  ProductHostKind,
  SettingsPatch,
  SettingsView,
  SetupHomeResult,
  SetupReadiness,
  SetupSettingsClient,
  SetupSubjectResult,
  SubjectSummary
} from './features/client-types'
export {
  EvolutionInspector,
  createEvolutionInspectorFeature,
  createEvolutionFixtureClient,
  createEvolutionFixtureData,
  EVOLUTION_OPEN_CYCLE_EVENT,
  openEvolutionCycle,
  subscribeEvolutionNavigation,
  resetEvolutionNavigation,
  projectEvolutionCore,
  projectTimeline,
  pickDefaultCycleId,
  resolveSafeState,
  shouldRefreshForEvent,
  mergeCycleRecords,
  coreFromLegacy,
  sanitizeCycleList,
  sanitizeCycleDetail,
  sanitizeRoundDetail,
  sanitizeObservability,
  createInspectorController,
  EVOLUTION_PARITY_INVENTORY,
  parityInventoryMarkdown
} from './features/evolution'
export type {
  EvolutionInspectorProps,
  EvolutionInspectorFeatureOptions,
  EvolutionInspectorClient,
  EvolutionInspectorSnapshot,
  EvolutionInspectorCore,
  EvolutionOpenCycleDetail,
  EvolutionNavigationListener,
  EvolutionFixtureClient,
  TimelineCycleView,
  InspectorSafeState
} from './features/evolution'
export {
  fetchWebBootstrap,
  isJeaWebHosted,
  resolveHostedViewState,
  BOOTSTRAP_PATH,
  JEA_HOST_META
} from './web/host-connection'
export { Button, buttonVariants } from './ui/button'
export { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from './ui/dialog'
export { Separator } from './ui/separator'
export { cn } from './lib/cn'
