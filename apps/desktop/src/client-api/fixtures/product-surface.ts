import { JEA_CLIENT_PROTOCOL_ID, JEA_CLIENT_PROTOCOL_VERSION, CLIENT_API_COMMANDS } from '../protocol'
import type {
  CliStatus,
  ConversationPage,
  ConversationSendResult,
  ConversationSessionSummary,
  CycleProcessOnceResult,
  CycleRequestResult,
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionObservability,
  EvolutionRoundDetail,
  ProtocolInfo,
  ServiceStatus,
  DiagnosticReport,
  SubjectReadiness,
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
  serviceReadiness: SubjectReadiness
  cycleRequest: CycleRequestResult
  cycleProcessOnce: CycleProcessOnceResult
  readiness: SetupReadiness
  home: SetupHomeResult
  createdSubject: SetupSubjectResult
  initialized: { subject: string; initialized: boolean }
  enabledChannel: SetupSubjectResult
  settings: SettingsView
  diagnostics: DiagnosticReport
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
      attention: { count: 0, highest_severity: null, backlog_count: 0 },
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
    serviceReadiness: {
      subject: 'alpha',
      generated_at: '2026-08-16T00:00:00.000Z',
      web_host: { state: 'stopped', reasons: ['web_host_stopped'] },
      cycle: { state: 'stopped', reasons: ['cycle_stopped'] },
      channel: { state: 'stopped', reasons: ['channel_stopped'] },
      model: { state: 'running', mode: 'mock', reasons: ['model_mock'] },
      conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] },
      reasons: [
        'web_host_stopped',
        'cycle_stopped',
        'channel_stopped',
        'model_mock',
        'conversation_blocked_channel'
      ],
      allowed_actions: ['start_channel', 'start_cycle'],
      actions: [
        { id: 'start_channel', allowed: true, capability: 'local-only' },
        { id: 'start_cycle', allowed: true, capability: 'local-only' },
        { id: 'process_cycle_once', allowed: false, capability: 'write' },
        { id: 'repair_worker_state', allowed: false, capability: 'local-only' },
        { id: 'stop_managed', allowed: false, capability: 'local-only' },
        { id: 'open_desktop', allowed: false, capability: 'readonly' },
        { id: 'none', allowed: false, capability: 'readonly' }
      ]
    },
    cycleRequest: {
      subject: 'alpha',
      cycle_start_request: { request_id: 'req-fixture', reason: 'jea_client' }
    },
    cycleProcessOnce: {
      subject: 'alpha',
      status: 'idle',
      reason: 'no_pending_evidence',
      scanned: { scanned: true, enqueued_count: 0 },
      backlog: { before: 0, after: 0 },
      health: {
        before: { health: 'idle', pending_count: 0 },
        after: { health: 'idle', pending_count: 0 }
      },
      claim: null,
      checkpoint: null,
      events: [],
      channel: {
        before: { pid: null, status: null },
        after: { pid: null, status: null },
        unchanged: true
      },
      work: { worked: false, ok: null, retryable: null, task_id: null, task_type: null, result: null }
    },
    readiness: {
      jeaHome: { path: '/tmp/jea-fixture-home', source: 'fixture', writable: true },
      subjects: { count: 2, defaultSubject: 'alpha', names: ['alpha', 'beta'] },
      model: { configured: false, mode: 'mock' },
      data: { initialized: true },
      conversation: { desktopChannelEnabled: true, subject: 'alpha' },
      conversationReady: true,
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
      cliVersion: '0.1.0',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      commitShort: 'aaaaaaa',
      buildTime: '2026-08-17T00:00:00.000Z',
      platform: 'linux',
      architecture: 'x64',
      dirty: false
    },
    diagnostics: {
      schema_version: 1,
      generated_at: '2026-08-17T00:00:00.000Z',
      product: {
        version: '0.1.0',
        commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commit_short: 'aaaaaaa',
        built_at: '2026-08-17T00:00:00.000Z',
        platform: 'linux',
        architecture: 'x64',
        dirty: false,
        build_id: '0.1.0+aaaaaaa.20260817T000000'
      },
      host: {
        jea_home: '<JEA_HOME>',
        jea_home_source: 'fixture',
        subject: 'alpha'
      },
      readiness: {
        source: 'service.getReadiness',
        reservedCommand: 'service.getReadiness',
        web: { id: 'web', status: 'stopped', reasons: ['web_host_stopped'] },
        cycle: { id: 'cycle', status: 'stopped', reasons: ['cycle_worker_stopped'] },
        channel: { id: 'channel', status: 'ready', reasons: [] },
        model: { id: 'model', status: 'ready', reasons: ['model_unconfigured', 'model_mode_mock'] },
        conversation: { id: 'conversation', status: 'ready', reasons: ['conversation_ready'] }
      },
      daemon: {
        log_paths: {
          stdout: '<JEA_HOME>/logs/daemon-alpha.desktop.stdout.log',
          stderr: '<JEA_HOME>/logs/daemon-alpha.desktop.stderr.log'
        },
        last_startup_failure: null
      },
      process_failures: []
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
    case 'service.getReadiness':
      return fixtures.serviceReadiness
    case 'service.requestCycle':
      return fixtures.cycleRequest
    case 'service.processCycleOnce':
      return fixtures.cycleProcessOnce
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
    case 'settings.exportDiagnostics':
      return fixtures.diagnostics
    case 'cli.getStatus':
    case 'cli.install':
    case 'cli.uninstall':
      return fixtures.cli
    default:
      return undefined
  }
}
