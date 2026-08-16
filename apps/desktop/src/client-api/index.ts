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
  serializeClientApiCatalog
} from './catalog'
export { PublicClientError, isPublicClientError, publicErrorShape, toPublicClientError } from './errors'
export { createTypedJeaClient, type JeaClient, type JeaClientTransport } from './jea-client'
export { createApplicationCommandHost, createApplicationCommandHandlers, createClientApiCommandDefinitions } from './host'
export { createElectronJeaClient, type ElectronClientTransport } from './adapters/electron'
export { createMemoryJeaClient, createMemoryCommandTransport } from './adapters/memory'
export { createProductSurfaceFixture, fixtureCommandResult, PRODUCT_FIXTURE_SUBJECT } from './fixtures/product-surface'
export { redactPublicValue } from './redact'
export type {
  CatalogCommandEntry,
  ClientApiCatalog,
  CliStatus,
  ConversationPage,
  ConversationSendResult,
  ConversationSessionSummary,
  CycleRequestResult,
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionObservability,
  EvolutionRoundDetail,
  InvokeRequest,
  InvokeResponse,
  JeaEventEnvelope,
  ProtocolInfo,
  ServiceStatus,
  SettingsPatch,
  SettingsView,
  SetupHomeResult,
  SetupReadiness,
  SetupSubjectResult,
  SubjectRecord,
  SubjectSummary
} from './types'
