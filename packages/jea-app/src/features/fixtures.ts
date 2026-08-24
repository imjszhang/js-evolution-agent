import type {
  CliStatus,
  DiagnosticReport,
  SettingsView,
  SetupReadiness,
  SetupSettingsClient,
  SubjectReadiness,
  SubjectSummary
} from './client-types'

export type CliFixtureKind = 'installed' | 'onPath' | 'pathHint' | 'native' | 'unsupported'

export interface SetupFixtureState {
  readiness: SetupReadiness
  settings: SettingsView
  subjects: SubjectSummary[]
  cli: CliStatus
}

const BASE_CLI: CliStatus = {
  installed: false,
  onPath: false,
  pathHint: '~/.local/bin/jea',
  supported: false,
  detail: 'CLI launcher installation is owned by the macOS packaging workstream.'
}

export function cliFixture(kind: CliFixtureKind = 'unsupported'): CliStatus {
  if (kind === 'installed') {
    return {
      installed: true,
      onPath: false,
      pathHint: '~/.local/bin/jea',
      supported: true,
      detail: 'Installed. Add the path hint to PATH to run `jea` in a terminal.'
    }
  }
  if (kind === 'onPath') {
    return {
      installed: true,
      onPath: true,
      pathHint: '~/.local/bin/jea',
      supported: true,
      detail: 'Installed and available on PATH.'
    }
  }
  if (kind === 'pathHint') {
    return {
      installed: false,
      onPath: false,
      pathHint: '~/.local/bin/jea',
      supported: true,
      detail: 'Not installed. The native app can place `jea` at the path hint.'
    }
  }
  if (kind === 'native') {
    return {
      installed: false,
      onPath: false,
      pathHint: '~/.local/bin/jea',
      supported: false,
      detail: 'CLI installation is available only in the native JEA app.'
    }
  }
  return { ...BASE_CLI }
}

export function createEmptyReadiness(cli: CliStatus = cliFixture('unsupported')): SetupReadiness {
  return {
    jeaHome: { path: '/tmp/jea-empty-home', source: 'fixture', writable: true },
    subjects: { count: 0, defaultSubject: null, names: [] },
    model: { configured: false, mode: 'mock' },
    data: { initialized: false },
    conversation: { desktopChannelEnabled: false, subject: null },
    conversationReady: false,
    cli
  }
}

export function createReadyReadiness(cli: CliStatus = cliFixture('unsupported')): SetupReadiness {
  return {
    jeaHome: { path: '/tmp/jea-fixture-home', source: 'fixture', writable: true },
    subjects: { count: 2, defaultSubject: 'alpha', names: ['alpha', 'beta'] },
    model: { configured: false, mode: 'mock' },
    data: { initialized: true },
    conversation: { desktopChannelEnabled: true, subject: 'alpha' },
    conversationReady: true,
    cli
  }
}

export function createSubjectReadinessFixture(options: {
  subject?: string
  host?: 'electron' | 'web'
  webHost?: string
  cycle?: string
  channel?: string
  conversation?: string
} = {}): SubjectReadiness {
  const webState = options.webHost ?? 'stopped'
  const cycleState = options.cycle ?? 'stopped'
  const channelState = options.channel ?? 'stopped'
  const conversationState = options.conversation ?? (channelState === 'running' || channelState === 'attached' ? 'running' : 'blocked')
  const localNeeded = channelState === 'stopped' || cycleState === 'stopped'
  const openDesktop = options.host === 'web' && localNeeded
  return {
    subject: options.subject ?? 'alpha',
    generated_at: '2026-08-17T00:00:00.000Z',
    web_host: { state: webState, reasons: [`web_host_${webState}`] },
    cycle: { state: cycleState, reasons: [`cycle_${cycleState}`] },
    channel: { state: channelState, reasons: [`channel_${channelState}`] },
    model: { state: 'running', mode: 'mock', reasons: ['model_mock'] },
    conversation: {
      state: conversationState,
      reasons: conversationState === 'running' ? ['conversation_ready'] : ['conversation_blocked_channel']
    },
    reasons: [`web_host_${webState}`, `cycle_${cycleState}`, `channel_${channelState}`],
    allowed_actions: openDesktop
      ? ['open_desktop']
      : localNeeded
        ? ['start_channel', 'start_cycle']
        : ['none'],
    actions: [
      { id: 'start_channel', allowed: !openDesktop && channelState === 'stopped', capability: 'local-only' },
      { id: 'start_cycle', allowed: !openDesktop && cycleState === 'stopped', capability: 'local-only' },
      { id: 'process_cycle_once', allowed: false, capability: 'write' },
      { id: 'repair_worker_state', allowed: false, capability: 'local-only' },
      { id: 'stop_managed', allowed: false, capability: 'local-only' },
      { id: 'open_desktop', allowed: openDesktop, capability: 'readonly' },
      { id: 'pause_automatic_evolution', allowed: cycleState !== 'stopped', capability: 'write' },
      { id: 'resume_automatic_evolution', allowed: false, capability: 'write' },
      { id: 'check_now', allowed: true, capability: 'write' },
      { id: 'view_blocker', allowed: cycleState === 'stopped' || cycleState === 'blocked', capability: 'readonly' },
      { id: 'none', allowed: !localNeeded && !openDesktop, capability: 'readonly' }
    ],
    automation: {
      mode: 'automatic',
      intent: cycleState === 'stopped' || cycleState === 'blocked'
        ? 'blocked'
        : cycleState === 'stalled' ? 'catching_up' : 'listening',
      mapped_from: 'default',
      diagnostic: null,
      background: false,
      remaining_evidence: 0,
      blocker: cycleState === 'stopped' ? 'cycle_stopped' : null
    },
    product_actions: [
      { id: 'pause_automatic_evolution', allowed: cycleState !== 'stopped', capability: 'write' },
      { id: 'check_now', allowed: true, capability: 'write' },
      { id: 'view_blocker', allowed: cycleState === 'stopped' || cycleState === 'blocked', capability: 'readonly' }
    ]
  }
}

export function createDisabledChannelReadiness(cli: CliStatus = cliFixture('unsupported')): SetupReadiness {
  return {
    ...createReadyReadiness(cli),
    conversation: { desktopChannelEnabled: false, subject: 'alpha' },
    conversationReady: false
  }
}

export function createSetupFixtureState(options: {
  kind?: 'ready' | 'empty' | 'channel'
  cli?: CliFixtureKind
  model?: 'mock' | 'deepseek'
} = {}): SetupFixtureState {
  const cli = cliFixture(options.cli ?? 'unsupported')
  const readiness = options.kind === 'empty'
    ? createEmptyReadiness(cli)
    : options.kind === 'channel'
      ? createDisabledChannelReadiness(cli)
      : createReadyReadiness(cli)
  if (options.model === 'deepseek') {
    readiness.model = { configured: true, mode: 'deepseek' }
  }
  return {
    readiness,
    settings: {
      language: 'en',
      theme: 'system',
      defaultSubject: readiness.subjects.defaultSubject,
      appVersion: '0.2.1',
      cliVersion: '0.2.1',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      commitShort: 'aaaaaaa',
      buildTime: '2026-08-17T00:00:00.000Z',
      platform: 'linux',
      architecture: 'x64',
      dirty: false
    },
    subjects: readiness.subjects.names.map((name) => ({
      name,
      namespace: `${name}-data`,
      isDefault: name === readiness.subjects.defaultSubject
    })),
    cli
  }
}

export function createFixtureDiagnosticReport(state: SetupFixtureState = createSetupFixtureState()): DiagnosticReport {
  const settings = state.settings
  const ready = state.readiness.conversationReady
  return {
    schema_version: 1,
    generated_at: '2026-08-17T00:00:00.000Z',
    product: {
      version: settings.appVersion,
      commit: settings.commitSha ?? null,
      commit_short: settings.commitShort ?? null,
      built_at: settings.buildTime ?? null,
      platform: settings.platform ?? 'linux',
      architecture: settings.architecture ?? 'x64',
      dirty: settings.dirty ?? false,
      build_id: '0.2.1+aaaaaaa.20260817T000000'
    },
    host: {
      jea_home: state.readiness.jeaHome.path,
      jea_home_source: state.readiness.jeaHome.source,
      subject: state.readiness.subjects.defaultSubject
    },
    readiness: {
      source: 'service.getReadiness',
      reservedCommand: 'service.getReadiness',
      web: { id: 'web', status: 'stopped', reasons: ['web_host_stopped'] },
      cycle: { id: 'cycle', status: 'stopped', reasons: ['cycle_worker_stopped'] },
      channel: {
        id: 'channel',
        status: state.readiness.conversation.desktopChannelEnabled ? 'ready' : 'blocked',
        reasons: state.readiness.conversation.desktopChannelEnabled ? [] : ['desktop_channel_disabled']
      },
      model: {
        id: 'model',
        status: state.readiness.model.mode === 'unset' ? 'blocked' : 'ready',
        reasons: [
          state.readiness.model.configured ? 'model_configured' : 'model_unconfigured',
          `model_mode_${state.readiness.model.mode}`
        ]
      },
      conversation: {
        id: 'conversation',
        status: ready ? 'ready' : 'blocked',
        reasons: ready ? ['conversation_ready'] : ['conversation_blocked']
      }
    },
    daemon: {
      log_paths: {
        stdout: '<JEA_HOME>/logs/daemon-alpha.desktop.stdout.log',
        stderr: '<JEA_HOME>/logs/daemon-alpha.desktop.stderr.log'
      },
      last_startup_failure: null
    },
    process_failures: []
  }
}

export function createFixtureSetupClient(state: SetupFixtureState = createSetupFixtureState()): SetupSettingsClient {
  let current = structuredClone(state)
  const failIfUnsupported = async (action: 'install' | 'uninstall'): Promise<CliStatus> => {
    if (!current.cli.supported) {
      const error = new Error(
        action === 'install'
          ? 'CLI installation is not available on this host.'
          : 'CLI uninstallation is not available on this host.'
      ) as Error & { name: string; code: string }
      error.name = 'PublicCommandError'
      error.code = 'UNAVAILABLE'
      throw error
    }
    current.cli = action === 'install'
      ? cliFixture(current.cli.onPath ? 'onPath' : 'installed')
      : cliFixture('pathHint')
    current.readiness = { ...current.readiness, cli: current.cli }
    return current.cli
  }

  return {
    async getReadiness() {
      return structuredClone(current.readiness)
    },
    async confirmHome(path) {
      if (!current.readiness.jeaHome.writable) {
        const error = new Error('The requested JEA Home is not writable.') as Error & { name: string; code: string }
        error.name = 'PublicCommandError'
        error.code = 'OPERATION_FAILED'
        throw error
      }
      if (path?.trim()) {
        current.readiness.jeaHome = { path: path.trim(), source: 'requested', writable: true }
      }
      return { ...current.readiness.jeaHome }
    },
    async createSubject(name, options) {
      const enable = options?.enableDesktopChannel !== false
      current.readiness.subjects = {
        count: 1,
        defaultSubject: name,
        names: [name]
      }
      current.readiness.conversation = {
        desktopChannelEnabled: enable,
        subject: name
      }
      current.settings.defaultSubject = name
      current.subjects = [{ name, namespace: `${name}-data`, isDefault: true }]
      current.readiness.conversationReady = false
      return { name, created: true, skipped: false, desktopChannelEnabled: enable }
    },
    async initData(subject) {
      current.readiness.data = { initialized: true }
      current.readiness.conversation.subject = subject
      return { subject, initialized: true }
    },
    async enableDesktopChannel(subject) {
      current.readiness.conversation = { desktopChannelEnabled: true, subject }
      current.readiness.conversationReady = current.readiness.data.initialized
      return { name: subject, created: false, skipped: false, desktopChannelEnabled: true }
    },
    async exportDiagnostics() {
      return createFixtureDiagnosticReport(current)
    },
    async getSettings() {
      return { ...current.settings }
    },
    async setSettings(patch) {
      current.settings = {
        ...current.settings,
        ...(patch.language ? { language: patch.language } : {}),
        ...(patch.theme ? { theme: patch.theme } : {}),
        ...(patch.defaultSubject ? { defaultSubject: patch.defaultSubject } : {})
      }
      if (patch.defaultSubject) {
        current.readiness.subjects.defaultSubject = patch.defaultSubject
        current.subjects = current.subjects.map((item) => ({
          ...item,
          isDefault: item.name === patch.defaultSubject
        }))
      }
      return { ...current.settings }
    },
    async getCliStatus() {
      return { ...current.cli }
    },
    installCli: () => failIfUnsupported('install'),
    uninstallCli: () => failIfUnsupported('uninstall'),
    async getServiceReadiness(subject) {
      return createSubjectReadinessFixture({
        subject,
        host: current.cli.supported ? 'electron' : 'web',
        webHost: 'stopped',
        cycle: 'stopped',
        channel: current.readiness.conversation.desktopChannelEnabled ? 'attached' : 'stopped',
        conversation: current.readiness.conversationReady ? 'running' : 'blocked'
      })
    },
    async listCycles(subject) {
      return {
        subject,
        namespace: `${subject}-data`,
        round_count: 1,
        cycles: [{
          cycle_id: 'fixture-cycle',
          generated_at: '2026-08-17T00:00:00.000Z',
          tldr: 'Fixture evolution summary.',
          has_diary: true,
          status: 'closed'
        }]
      }
    },
    async getObservability(subject) {
      return {
        subject,
        attention: { items: [], summary: { count: 0 } },
        open_cycles: 0,
        evidence_pending_count: 0,
        daemon_task_pending_count: 0
      }
    },
    async processCycleOnce(subject) {
      return { subject, status: 'idle', reason: 'fixture' }
    },
    async startService(subject, domain) {
      return { subject, domain: domain ?? 'all', mode: 'fixture' }
    },
    async listSubjects() {
      return current.subjects.map((item) => ({ ...item }))
    },
    async setDefaultSubject(subject) {
      return this.setSettings({ defaultSubject: subject })
    },
    subscribe() {
      return () => {}
    }
  }
}
