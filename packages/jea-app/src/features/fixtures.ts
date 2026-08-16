import type {
  CliStatus,
  SettingsView,
  SetupReadiness,
  SetupSettingsClient,
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
      appVersion: '0.1.0',
      cliVersion: '0.1.0'
    },
    subjects: readiness.subjects.names.map((name) => ({
      name,
      namespace: `${name}-data`,
      isDefault: name === readiness.subjects.defaultSubject
    })),
    cli
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
    async listSubjects() {
      return current.subjects.map((item) => ({ ...item }))
    },
    async setDefaultSubject(subject) {
      return this.setSettings({ defaultSubject: subject })
    }
  }
}
