import type { ClientApiCommandName } from './protocol'
import type {
  CliStatus,
  ConversationPage,
  ConversationSendResult,
  ConversationSessionSummary,
  AutomationPolicyView,
  CycleProcessOnceResult,
  CycleRequestResult,
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionObservability,
  EvolutionRoundDetail,
  InvokeRequest,
  JeaEventEnvelope,
  ProtocolInfo,
  ServiceStatus,
  DiagnosticReport,
  SubjectReadiness,
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
  getServiceReadiness(subject: string): Promise<SubjectReadiness>
  startService(subject: string, domain?: 'all' | 'cycle' | 'channel' | 'evolution'): Promise<ServiceStatus>
  stopService(subject: string): Promise<ServiceStatus>
  requestCycle(subject: string, note?: string): Promise<CycleRequestResult>
  requestReaction(subject: string, note?: string): Promise<CycleRequestResult>
  processCycleOnce(subject: string): Promise<CycleProcessOnceResult>
  processEvolutionOnce(subject: string): Promise<CycleProcessOnceResult>
  setAutomation(subject: string, mode: 'automatic' | 'paused'): Promise<AutomationPolicyView>
  getReadiness(subject?: string): Promise<SetupReadiness>
  confirmHome(path?: string): Promise<SetupHomeResult>
  createSubject(name: string, options?: { enableDesktopChannel?: boolean }): Promise<SetupSubjectResult>
  initData(subject: string): Promise<{ subject: string; initialized: boolean }>
  enableDesktopChannel(subject: string): Promise<SetupSubjectResult>
  getSettings(): Promise<SettingsView>
  setSettings(patch: SettingsPatch): Promise<SettingsView>
  exportDiagnostics(options?: { subject?: string; redactPaths?: boolean }): Promise<DiagnosticReport>
  getCliStatus(): Promise<CliStatus>
  installCli(): Promise<CliStatus>
  uninstallCli(): Promise<CliStatus>
}

export function createTypedJeaClient(
  protocolVersion: string,
  transport: JeaClientTransport
): JeaClient {
  const invoke = <T>(command: ClientApiCommandName, payload?: Record<string, unknown>): Promise<T> =>
    transport.invoke({ command, payload }) as Promise<T>

  const client: JeaClient = {
    protocolVersion,
    invoke,
    subscribe: transport.subscribe,
    getProtocol: () => invoke<ProtocolInfo>('protocol.get'),
    listSubjects: () => invoke<SubjectSummary[]>('subject.list'),
    getSubject: (subject) => invoke<SubjectRecord>('subject.get', { subject }),
    selectSubject: (subject) => invoke<SubjectRecord>('subject.select', { subject }),
    setDefaultSubject: (subject) => invoke<SubjectRecord>('subject.setDefault', { subject }),
    listSessions: (subject) => invoke<ConversationSessionSummary[]>('conversation.listSessions', { subject }),
    createSession: (subject, sessionId) => invoke<ConversationSessionSummary>('conversation.createSession', { subject, sessionId }),
    readMessages: (subject, sessionId, options) => invoke<ConversationPage>('conversation.readMessages', { subject, sessionId, ...options }),
    sendMessage: (subject, text, options) => invoke<ConversationSendResult>('conversation.sendMessage', { subject, text, ...options }),
    listCycles: (subject, limit) => invoke<EvolutionCycleList>('evolution.listCycles', { subject, limit }),
    getCycle: (subject, cycleId) => invoke<EvolutionCycleDetail>('evolution.getCycle', { subject, cycleId }),
    getRound: (subject, cycleId) => invoke<EvolutionRoundDetail>('evolution.getRound', { subject, cycleId }),
    getObservability: (subject) => invoke<EvolutionObservability>('evolution.getObservability', { subject }),
    getServiceStatus: (subject) => invoke<ServiceStatus>('service.getStatus', { subject }),
    getServiceReadiness: (subject) => invoke<SubjectReadiness>('service.getReadiness', { subject }),
    startService: (subject, domain) => invoke<ServiceStatus>('service.start', { subject, domain }),
    stopService: (subject) => invoke<ServiceStatus>('service.stop', { subject }),
    requestCycle: (subject, note) => invoke<CycleRequestResult>('service.requestCycle', { subject, note }),
    requestReaction: (subject, note) => invoke<CycleRequestResult>('service.requestCycle', { subject, note }),
    processCycleOnce: (subject) => invoke<CycleProcessOnceResult>('service.processCycleOnce', { subject }),
    processEvolutionOnce: (subject) => invoke<CycleProcessOnceResult>('service.processCycleOnce', { subject }),
    setAutomation: (subject, mode) => invoke<AutomationPolicyView>('service.setAutomation', { subject, mode }),
    getReadiness: (subject) => invoke<SetupReadiness>('setup.getReadiness', subject ? { subject } : {}),
    confirmHome: (path) => invoke<SetupHomeResult>('setup.confirmHome', path ? { path } : {}),
    createSubject: (name, options) => invoke<SetupSubjectResult>('setup.createSubject', { name, ...options }),
    initData: (subject) => invoke<{ subject: string; initialized: boolean }>('setup.initData', { subject }),
    enableDesktopChannel: (subject) => invoke<SetupSubjectResult>('setup.enableDesktopChannel', { subject }),
    getSettings: () => invoke<SettingsView>('settings.get'),
    setSettings: (patch) => invoke<SettingsView>('settings.set', { ...patch }),
    exportDiagnostics: (options) => invoke<DiagnosticReport>('settings.exportDiagnostics', { ...options }),
    getCliStatus: () => invoke<CliStatus>('cli.getStatus'),
    installCli: () => invoke<CliStatus>('cli.install'),
    uninstallCli: () => invoke<CliStatus>('cli.uninstall')
  }
  return Object.freeze(client)
}
