export {
  CAPABILITY_LEVELS,
  CLIENT_API_COMMANDS,
  CLIENT_API_EVENTS,
  JEA_CLIENT_PROTOCOL_ID,
  JEA_CLIENT_PROTOCOL_VERSION,
  PUBLIC_ERROR_CODES,
  type CapabilityLevel,
  type ClientApiCommandName,
  type ClientApiEventName,
  type PublicErrorCode
} from './protocol'
export {
  CLIENT_API_COMMAND_CATALOG,
  CLIENT_API_EVENT_CATALOG,
  JEA_CLIENT_CATALOG,
  assertCatalogComplete,
  catalogCommand,
  isClientApiCommand,
  isWebAllowedCommand,
  serializeClientApiCatalog
} from './catalog'
export { PublicClientError, isPublicClientError, publicErrorShape, toPublicClientError } from './errors'
export { createTypedJeaClient, type JeaClient, type JeaClientTransport } from './jea-client'
export { createApplicationCommandHost, createApplicationCommandHandlers, createClientApiCommandDefinitions } from './host'
export { createElectronJeaClient, type ElectronClientTransport } from './adapters/electron'
export { createMemoryJeaClient, createMemoryCommandTransport } from './adapters/memory'
export { createWebJeaClient, type WebJeaClientOptions } from './adapters/web'
export { createProductSurfaceFixture, fixtureCommandResult, PRODUCT_FIXTURE_SUBJECT } from './fixtures/product-surface'
export { redactPublicValue } from './redact'
export {
  observeWebHost,
  projectSubjectReadiness,
  readinessCodeView,
  READINESS_ACTION_CAPABILITY
} from './readiness'
export type {
  CatalogCommandEntry,
  ClientApiCatalog,
  CliStatus,
  ChannelProjectionHealth,
  ConversationPage,
  ConversationSendResult,
  ConversationSessionSummary,
  CycleRequestResult,
  DiagnosticReport,
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionObservability,
  EvolutionRoundDetail,
  InvokeRequest,
  InvokeResponse,
  JeaEventEnvelope,
  ProtocolInfo,
  ClientHostKind,
  ConversationReadinessView,
  DomainReadiness,
  ModelReadinessView,
  RemediationAction,
  ServiceStatus,
  SubjectReadiness,
  SubjectReadinessActionId,
  SubjectReadinessDomainState,
  SubjectReadinessReasonCode,
  SettingsPatch,
  SettingsView,
  SetupHomeResult,
  SetupReadiness,
  SetupSubjectResult,
  SubjectRecord,
  SubjectSummary
} from './types'
export {
  SUBJECT_READINESS_ACTION_IDS,
  SUBJECT_READINESS_DOMAIN_STATES,
  SUBJECT_READINESS_REASON_CODES
} from './types'
