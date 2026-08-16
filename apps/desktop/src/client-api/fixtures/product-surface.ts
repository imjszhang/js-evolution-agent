import { JEA_CLIENT_PROTOCOL_ID, JEA_CLIENT_PROTOCOL_VERSION, CLIENT_API_COMMANDS } from '../protocol'
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
  ProtocolInfo,
  ServiceStatus,
  SettingsView,
  SetupHomeResult,
  SetupReadiness,
  SetupSubjectResult,
  SubjectRecord,
  SubjectSummary
} from '../types'

export const PRODUCT_FIXTURE_SUBJECT = 'alpha'

export interface ProductSurfaceFixture {
  protocol: ProtocolInfo
  subjects: SubjectSummary[]
  subject: SubjectRecord
  sessions: ConversationSessionSummary[]
  createdSession: ConversationSessionSummary
  messages: ConversationPage
  send: ConversationSendResult
  cycles: EvolutionCycleList
  cycle: EvolutionCycleDetail
  round: EvolutionRoundDetail
  observability: EvolutionObservability
  service: ServiceStatus
  cycleRequest: CycleRequestResult
  readiness: SetupReadiness
  home: SetupHomeResult
  createdSubject: SetupSubjectResult
  initialized: { subject: string; initialized: boolean }
  enabledChannel: SetupSubjectResult
  settings: SettingsView
  cli: CliStatus
}

export function createProductSurfaceFixture(): ProductSurfaceFixture {
  const subjects: SubjectSummary[] = [
    { name: 'alpha', namespace: 'alpha-data', isDefault: true },
    { name: 'beta', namespace: 'beta-data', isDefault: false }
  ]
  const subject: SubjectRecord = {
    name: 'alpha',
    namespace: 'alpha-data',
    isDefault: true,
    selected: true,
    desktopChannelEnabled: true
  }
  const sessions: ConversationSessionSummary[] = [
    { session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:00.000Z' }
  ]
  const cli: CliStatus = {
    installed: false,
    onPath: false,
    pathHint: '~/.local/bin/jea',
    supported: false,
    detail: 'CLI launcher installation is owned by the macOS packaging workstream.'
  }
  return {
    protocol: {
      protocol: JEA_CLIENT_PROTOCOL_ID,
      version: JEA_CLIENT_PROTOCOL_VERSION,
      commands: [...CLIENT_API_COMMANDS],
      events: [
        'client.hello',
        'subject.changed',
        'conversation.updated',
        'evolution.updated',
        'service.status',
        'setup.readiness',
        'settings.changed',
        'cli.status'
      ]
    },
    subjects,
    subject,
    sessions,
    createdSession: {
      session_id: 'work',
      target: 'desktop:work',
      message_count: 0,
      last_message_at: null
    },
    messages: {
      schema_version: 1,
      subject: 'alpha',
      session_id: 'main',
      records: [{
        id: 'inbound:m-1',
        session_id: 'main',
        role: 'user',
        direction: 'inbound',
        content: 'hello',
        created_at: '2026-08-16T00:00:00.000Z',
        offset: 0,
        message_id: 'm-1'
      }],
      offset: 0,
      next_offset: 1,
      total: 1
    },
    send: {
      subject: 'alpha',
      session_id: 'main',
      message_id: 'm-1',
      session_created: true,
      duplicate: false
    },
    cycles: {
      subject: 'alpha',
      namespace: 'alpha-data',
      round_count: 1,
      cycles: [{
        cycle_id: 'cycle-fixture',
        generated_at: '2026-08-16T00:00:00.000Z',
        tldr: 'Fixture cycle',
        has_diary: true,
        status: null
      }]
    },
    cycle: {
      subject: 'alpha',
      cycle_id: 'cycle-fixture',
      cycle_status: 'closed',
      opened_at: '2026-08-16T00:00:00.000Z',
      closed_at: '2026-08-16T00:05:00.000Z',
      has_report: true,
      steps: {
        reactor: { status: 'done', updated_at: '2026-08-16T00:01:00.000Z', error: null }
      },
      blockers: []
    },
    round: {
      subject: 'alpha',
      cycle_id: 'cycle-fixture',
      report: { available: true, tldr: 'Fixture cycle' },
      diary: { available: true, items: [{ exec_id: 'exec-fixture', tldr: 'Fixture diary' }] },
      verify: { available: true, semantic_status: 'ok', verified_count: 1, pending_count: 0 },
      receipts: { count: 1 },
      blockers: []
    },
    observability: {
      subject: 'alpha',
      attention: { count: 0, highest_severity: null },
      open_cycles: 0
    },
    service: {
      subject: 'alpha',
      mode: 'none',
      pid: null,
      domain: null,
      heartbeat_at: null,
      started_at: null,
      health: 'idle',
      detail: null
    },
    cycleRequest: {
      subject: 'alpha',
      cycle_start_request: { request_id: 'req-fixture', reason: 'jea_client' }
    },
    readiness: {
      jeaHome: { path: '/tmp/jea-fixture-home', source: 'fixture', writable: true },
      subjects: { count: 2, defaultSubject: 'alpha', names: ['alpha', 'beta'] },
      model: { configured: false, mode: 'mock' },
      data: { initialized: true },
      conversation: { desktopChannelEnabled: true, subject: 'alpha' },
      cli
    },
    home: { path: '/tmp/jea-fixture-home', source: 'fixture', writable: true },
    createdSubject: {
      name: 'gamma',
      created: true,
      skipped: false,
      desktopChannelEnabled: true
    },
    initialized: { subject: 'alpha', initialized: true },
    enabledChannel: {
      name: 'alpha',
      created: false,
      skipped: false,
      desktopChannelEnabled: true
    },
    settings: {
      language: 'zh-CN',
      theme: 'system',
      defaultSubject: 'alpha',
      appVersion: '0.1.0',
      cliVersion: '0.1.0'
    },
    cli
  }
}

export function fixtureCommandResult(fixtures: ProductSurfaceFixture, command: string): unknown {
  switch (command) {
    case 'protocol.get':
      return fixtures.protocol
    case 'subject.list':
      return fixtures.subjects
    case 'subject.get':
    case 'subject.select':
    case 'subject.setDefault':
      return fixtures.subject
    case 'conversation.listSessions':
      return fixtures.sessions
    case 'conversation.createSession':
      return fixtures.createdSession
    case 'conversation.readMessages':
      return fixtures.messages
    case 'conversation.sendMessage':
      return fixtures.send
    case 'evolution.listCycles':
      return fixtures.cycles
    case 'evolution.getCycle':
      return fixtures.cycle
    case 'evolution.getRound':
      return fixtures.round
    case 'evolution.getObservability':
      return fixtures.observability
    case 'service.getStatus':
    case 'service.start':
    case 'service.stop':
      return fixtures.service
    case 'service.requestCycle':
      return fixtures.cycleRequest
    case 'setup.getReadiness':
      return fixtures.readiness
    case 'setup.confirmHome':
      return fixtures.home
    case 'setup.createSubject':
      return fixtures.createdSubject
    case 'setup.initData':
      return fixtures.initialized
    case 'setup.enableDesktopChannel':
      return fixtures.enabledChannel
    case 'settings.get':
    case 'settings.set':
      return fixtures.settings
    case 'cli.getStatus':
    case 'cli.install':
    case 'cli.uninstall':
      return fixtures.cli
    default:
      return undefined
  }
}
