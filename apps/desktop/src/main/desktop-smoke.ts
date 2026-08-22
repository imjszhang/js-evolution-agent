import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_SMOKE_FIXTURE_SUBJECT = 'smoke-desktop'

export interface SmokeCommandResult {
  ok: boolean
  value?: unknown
  error?: { message?: string } | string
}

export interface SmokeStageDeps {
  invoke: (command: string, payload?: Record<string, unknown>) => Promise<SmokeCommandResult>
  subjects: string[]
  fixtureSubject: string
  listProcesses: () => unknown[]
  acpBin?: string | null
  createExecutionRoot?: () => string
}

function sessionIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

export async function runDesktopSmokeStages({
  invoke,
  subjects,
  fixtureSubject,
  listProcesses,
  acpBin = process.env.JEA_ACP_CLAUDE_CODE_BIN ?? null,
  createExecutionRoot = () => mkdtempSync(join(tmpdir(), 'jea-smoke-acp-'))
}: SmokeStageDeps): Promise<Record<string, any>> {
  const stages: Record<string, any> = {}
  const subject = subjects.includes(fixtureSubject) ? fixtureSubject : null

  if (!subject) {
    const error = `fixture subject ${fixtureSubject} was not listed`
    stages.projection = { ok: false, error }
    stages.channel = { ok: false, error }
    stages.service = { ok: false, error }
  } else {
    const watch = await invoke('projection.watch', { subject })
    stages.projection = { ok: watch.ok, error: watch.ok ? null : watch.error }
    const channelGet = await invoke('channel.get', { subject })
    const send = channelGet.ok
      ? await invoke('channel.sendMessage', {
        subject,
        sessionId: 'smoke',
        text: 'desktop smoke',
        messageId: `smoke-${Date.now()}`
      })
      : { ok: false as const, error: channelGet.error }
    stages.channel = {
      ok: Boolean(channelGet.ok && send.ok),
      get: channelGet.ok,
      send: Boolean(send.ok),
      error: send.ok ? null : (channelGet.ok ? send.error : channelGet.error)
    }
    const serviceStart = await invoke('service.start', { subject, domain: 'channel' })
    const serviceStop = serviceStart.ok
      ? await invoke('service.stop', { subject })
      : { ok: false as const, error: serviceStart.error }
    stages.service = {
      ok: Boolean(serviceStart.ok && serviceStop.ok),
      started: serviceStart.ok,
      stopped: serviceStop.ok,
      error: serviceStart.ok ? (serviceStop.ok ? null : serviceStop.error) : serviceStart.error
    }
  }

  const notify = await invoke('notifications.get')
  stages.notifications = { ok: notify.ok, error: notify.ok ? null : notify.error }

  const frameworks = await invoke('acp.listFrameworks')
  if (!acpBin) {
    stages.acp = {
      ok: frameworks.ok,
      frameworks: frameworks.ok,
      leftover: listProcesses().length
    }
    return stages
  }

  const executionRoot = createExecutionRoot()
  let sessionId = ''
  let startedOk = false
  let promptOk = false
  let closeOk = false
  let error: SmokeCommandResult['error'] | null = null
  try {
    const started = await invoke('acp.startSession', {
      provider: 'acp:claude-code',
      executionRoot,
      permissionProfile: 'read_only'
    })
    startedOk = started.ok
    sessionId = sessionIdFrom(started.value)
    if (!started.ok || !sessionId) {
      error = started.ok ? 'acp session id missing' : started.error
    } else {
      const prompted = await invoke('acp.prompt', { sessionId, text: 'ping' })
      promptOk = prompted.ok
      if (!prompted.ok) error = prompted.error
    }
  } finally {
    if (sessionId) {
      const closed = await invoke('acp.closeSession', { sessionId })
      closeOk = closed.ok
      if (!closed.ok && !error) error = closed.error
    }
  }

  // Caller must pass ACP sessions only. Lifecycle-managed Cycle/Channel daemons are expected.
  const leftover = listProcesses().length
  stages.acp = {
    ok: Boolean(startedOk && promptOk && closeOk && leftover === 0),
    started: startedOk,
    prompt: promptOk,
    closed: closeOk,
    leftover,
    execution_root: executionRoot,
    error: startedOk && promptOk && closeOk ? null : error
  }
  return stages
}
