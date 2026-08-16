import type { ClientApiCommandName } from './protocol'
import type {
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

export interface JeaClientTransport {
  invoke(request: InvokeRequest): Promise<unknown>
  subscribe(listener: (event: JeaEventEnvelope) => void): () => void
}

export interface JeaClient {
  readonly protocolVersion: string
  invoke<T = unknown>(command: ClientApiCommandName, payload?: Record<string, unknown>): Promise<T>
  subscribe(listener: (event: JeaEventEnvelope) => void): () => void
  getProtocol(): Promise<ProtocolInfo>
  listSubjects(): Promise<SubjectSummary[]>
  getSubject(subject: string): Promise<SubjectRecord>
  selectSubject(subject: string): Promise<SubjectRecord>
  setDefaultSubject(subject: string): Promise<SubjectRecord>
  listSessions(subject: string): Promise<ConversationSessionSummary[]>
  createSession(subject: string, sessionId?: string): Promise<ConversationSessionSummary>
  readMessages(
    subject: string,
    sessionId: string,
    options?: { offset?: number; limit?: number; tail?: number }
  ): Promise<ConversationPage>
  sendMessage(
    subject: string,
    text: string,
    options?: { sessionId?: string; messageId?: string }
  ): Promise<ConversationSendResult>
  listCycles(subject: string, limit?: number): Promise<EvolutionCycleList>
  getCycle(subject: string, cycleId: string): Promise<EvolutionCycleDetail>
  getRound(subject: string, cycleId: string): Promise<EvolutionRoundDetail>
  getObservability(subject: string): Promise<EvolutionObservability>
  getServiceStatus(subject: string): Promise<ServiceStatus>
  startService(subject: string, domain?: 'all' | 'cycle' | 'channel'): Promise<ServiceStatus>
  stopService(subject: string): Promise<ServiceStatus>
  requestCycle(subject: string, note?: string): Promise<CycleRequestResult>
  getReadiness(subject?: string): Promise<SetupReadiness>
  confirmHome(path?: string): Promise<SetupHomeResult>
  createSubject(name: string, options?: { enableDesktopChannel?: boolean }): Promise<SetupSubjectResult>
  initData(subject: string): Promise<{ subject: string; initialized: boolean }>
  enableDesktopChannel(subject: string): Promise<SetupSubjectResult>
  getSettings(): Promise<SettingsView>
  setSettings(patch: SettingsPatch): Promise<SettingsView>
  getCliStatus(): Promise<CliStatus>
  installCli(): Promise<CliStatus>
  uninstallCli(): Promise<CliStatus>
}

export function createTypedJeaClient(
  protocolVersion: string,
  transport: JeaClientTransport
): JeaClient {
  const invoke = <T = unknown>(command: ClientApiCommandName, payload?: Record<string, unknown>) =>
    transport.invoke({ command, payload }) as Promise<T>

  return Object.freeze({
    protocolVersion,
    invoke,
    subscribe: transport.subscribe,
    getProtocol: () => invoke('protocol.get'),
    listSubjects: () => invoke('subject.list'),
    getSubject: (subject) => invoke('subject.get', { subject }),
    selectSubject: (subject) => invoke('subject.select', { subject }),
    setDefaultSubject: (subject) => invoke('subject.setDefault', { subject }),
    listSessions: (subject) => invoke('conversation.listSessions', { subject }),
    createSession: (subject, sessionId) => invoke('conversation.createSession', { subject, sessionId }),
    readMessages: (subject, sessionId, options) => invoke('conversation.readMessages', { subject, sessionId, ...options }),
    sendMessage: (subject, text, options) => invoke('conversation.sendMessage', { subject, text, ...options }),
    listCycles: (subject, limit) => invoke('evolution.listCycles', { subject, limit }),
    getCycle: (subject, cycleId) => invoke('evolution.getCycle', { subject, cycleId }),
    getRound: (subject, cycleId) => invoke('evolution.getRound', { subject, cycleId }),
    getObservability: (subject) => invoke('evolution.getObservability', { subject }),
    getServiceStatus: (subject) => invoke('service.getStatus', { subject }),
    startService: (subject, domain) => invoke('service.start', { subject, domain }),
    stopService: (subject) => invoke('service.stop', { subject }),
    requestCycle: (subject, note) => invoke('service.requestCycle', { subject, note }),
    getReadiness: (subject) => invoke('setup.getReadiness', subject ? { subject } : {}),
    confirmHome: (path) => invoke('setup.confirmHome', path ? { path } : {}),
    createSubject: (name, options) => invoke('setup.createSubject', { name, ...options }),
    initData: (subject) => invoke('setup.initData', { subject }),
    enableDesktopChannel: (subject) => invoke('setup.enableDesktopChannel', { subject }),
    getSettings: () => invoke('settings.get'),
    setSettings: (patch) => invoke('settings.set', patch),
    getCliStatus: () => invoke('cli.getStatus'),
    installCli: () => invoke('cli.install'),
    uninstallCli: () => invoke('cli.uninstall')
  })
}
