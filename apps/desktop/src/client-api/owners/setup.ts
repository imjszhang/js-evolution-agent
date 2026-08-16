import { accessSync, constants, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readJsonSafe } from '../../../../../src/infra/files.mjs'
import {
  createSubject,
  DEFAULT_SUBJECT,
  getSubjectEntry,
  registerSubject,
  sanitizeSubjectName,
  setDefaultSubject,
  SUBJECT_POLICY_FILENAME,
  subjectGovernanceFile,
  subjectsRegistryFile,
  subjectsRuntimeDir,
  updateSubjectsRegistry
} from '../../../../../src/infra/subjects.mjs'
import { initData } from '../../../../../src/cli/commands/data.mjs'
import { resolveDesktopConfig } from '../../../../../src/channel/adapters/desktop/config.mjs'
import { resolveModelReadiness } from '../../../../../src/actions/execution-env.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type { CliStatus, SetupHomeResult, SetupReadiness, SetupSubjectResult } from '../types'
import { subjectRuntime, type ClientRuntimeContext } from './runtime'

export interface HomePort {
  resolve(requested?: string): SetupHomeResult
}

export function createInjectedHomePort(runtime: ClientRuntimeContext): HomePort {
  return {
    resolve(requested?: string): SetupHomeResult {
      const path = requested?.trim() ? resolve(requested.trim()) : runtime.jeaHome
      if (!isAbsolute(path)) {
        throw new PublicClientError('INVALID_REQUEST', 'A valid path is required.')
      }
      let writable = false
      try {
        mkdirSync(path, { recursive: true })
        accessSync(path, constants.W_OK)
        writable = true
      } catch {
        writable = false
      }
      return {
        path,
        source: requested?.trim() ? 'requested' : runtime.jeaHomeSource,
        writable
      }
    }
  }
}

function safeSubjectName(name: string | undefined): string | null {
  try {
    const subject = sanitizeSubjectName(name)
    return subject || null
  } catch {
    return null
  }
}

function hasHomePolicy(runtime: ClientRuntimeContext, name: string): boolean {
  try {
    return existsSync(subjectGovernanceFile(runtime, name))
  } catch {
    return false
  }
}

function readPersistedRegistry(runtime: ClientRuntimeContext): {
  status: 'ok' | 'missing' | 'malformed'
  defaultSubject: string | null
  names: string[]
  subjects: Record<string, Record<string, unknown>>
} {
  const file = subjectsRegistryFile(runtime)
  if (!existsSync(file)) {
    return { status: 'missing', defaultSubject: null, names: [], subjects: {} }
  }
  const raw = readJsonSafe(file, null) as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'malformed', defaultSubject: null, names: [], subjects: {} }
  }
  if (!raw.subjects || typeof raw.subjects !== 'object' || Array.isArray(raw.subjects)) {
    return { status: 'malformed', defaultSubject: null, names: [], subjects: {} }
  }
  const subjects = raw.subjects as Record<string, Record<string, unknown>>
  const names = Object.keys(subjects)
    .map((name) => safeSubjectName(name))
    .filter((name): name is string => Boolean(name))
  return {
    status: 'ok',
    defaultSubject: safeSubjectName(typeof raw.default_subject === 'string' ? raw.default_subject : undefined),
    names,
    subjects
  }
}

function isFallbackPhantom(runtime: ClientRuntimeContext, name: string): boolean {
  return name === DEFAULT_SUBJECT && !hasHomePolicy(runtime, name)
}

function listHomeSubjects(runtime: ClientRuntimeContext): string[] {
  const persisted = readPersistedRegistry(runtime)
  const names = new Set(
    persisted.status === 'ok'
      ? persisted.names.filter((name) => !isFallbackPhantom(runtime, name))
      : []
  )
  const runtimeDir = subjectsRuntimeDir(runtime)
  if (existsSync(runtimeDir)) {
    for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const subject = safeSubjectName(entry.name)
      if (!subject) continue
      if (existsSync(join(runtimeDir, entry.name, SUBJECT_POLICY_FILENAME))) names.add(subject)
    }
  }
  return [...names].sort()
}

function requireHomeSubject(runtime: ClientRuntimeContext, subject: string | undefined): string {
  const name = subject?.trim()
  if (!name) {
    throw new PublicClientError('INVALID_REQUEST', 'A subject is required.')
  }
  if (!listHomeSubjects(runtime).includes(name)) {
    throw new PublicClientError('NOT_FOUND', 'Requested subject is unavailable.')
  }
  return name
}

function desktopEnabled(runtime: ClientRuntimeContext, subject: string): boolean {
  try {
    return resolveDesktopConfig(runtime, subject).enabled === true
  } catch {
    const entry = getSubjectEntry(runtime, subject) as { channels?: { desktop?: { enabled?: boolean } } } | null
    return Boolean(entry?.channels?.desktop?.enabled)
  }
}

function enableDesktopChannelEntry(entry: Record<string, unknown> = {}): Record<string, unknown> {
  const channels = (entry.channels && typeof entry.channels === 'object' && !Array.isArray(entry.channels))
    ? { ...(entry.channels as Record<string, unknown>) }
    : {}
  const desktop = (channels.desktop && typeof channels.desktop === 'object' && !Array.isArray(channels.desktop))
    ? { ...(channels.desktop as Record<string, unknown>) }
    : {}
  const presence = (channels.presence && typeof channels.presence === 'object' && !Array.isArray(channels.presence))
    ? { ...(channels.presence as Record<string, unknown>) }
    : {}
  return {
    ...entry,
    channels: {
      ...channels,
      desktop: {
        ...desktop,
        enabled: true,
        default_session: desktop.default_session ?? desktop.defaultSession ?? 'main'
      },
      presence: {
        ...presence,
        default_transport: presence.default_transport ?? 'desktop',
        default_target: presence.default_target ?? 'desktop:main'
      }
    }
  }
}

function stripPhantomSubjects(runtime: ClientRuntimeContext, keepDefault?: string): void {
  const persisted = readPersistedRegistry(runtime)
  if (persisted.status !== 'ok') return
  const real = new Set(listHomeSubjects(runtime))
  const phantoms = persisted.names.filter((name) => isFallbackPhantom(runtime, name) || !real.has(name))
  if (phantoms.length === 0 && (!keepDefault || persisted.defaultSubject === keepDefault)) return
  updateSubjectsRegistry(runtime, (registry: {
    default_subject?: string
    subjects: Record<string, Record<string, unknown>>
  }) => {
    const subjects = { ...registry.subjects }
    for (const name of phantoms) delete subjects[name]
    const remaining = Object.keys(subjects)
    const defaultSubject = (keepDefault && remaining.includes(keepDefault))
      ? keepDefault
      : (remaining.includes(String(registry.default_subject ?? '')) ? registry.default_subject : (keepDefault ?? remaining[0]))
    return {
      ...registry,
      default_subject: defaultSubject,
      subjects
    }
  })
}

function dataInitialized(runtime: ClientRuntimeContext, subject: string): boolean {
  try {
    return existsSync(join(subjectRuntime(runtime, subject).runtimeRoot, 'data', 'evolution'))
  } catch {
    return existsSync(join(runtime.jeaHome, 'subjects', subject, 'data', 'evolution'))
  }
}

function homeWritable(homePort: HomePort): boolean {
  try {
    return homePort.resolve().writable
  } catch {
    return false
  }
}

export function isSetupConversationReady(readiness: Pick<
  SetupReadiness,
  'jeaHome' | 'subjects' | 'data' | 'conversation'
>): boolean {
  return Boolean(
    readiness.jeaHome.writable
    && readiness.subjects.count > 0
    && readiness.subjects.defaultSubject
    && readiness.subjects.names.includes(readiness.subjects.defaultSubject)
    && readiness.data.initialized
    && readiness.conversation.desktopChannelEnabled
  )
}

export class SetupCommandOwner {
  constructor(
    private readonly runtime: ClientRuntimeContext,
    private readonly homePort: HomePort,
    private readonly cliStatus: () => CliStatus
  ) {}

  getReadiness(subject?: string): SetupReadiness {
    const names = listHomeSubjects(this.runtime)
    const persisted = readPersistedRegistry(this.runtime)
    const requested = subject?.trim()
    if (requested && !names.includes(requested)) {
      throw new PublicClientError('NOT_FOUND', 'Requested subject is unavailable.')
    }
    const selected = requested
      ?? (persisted.defaultSubject && names.includes(persisted.defaultSubject) ? persisted.defaultSubject : null)
      ?? names[0]
      ?? null
    const initialized = selected ? dataInitialized(this.runtime, selected) : false
    const model = resolveModelReadiness({
      jeaHome: this.runtime.jeaHome,
      subjectRoot: selected ? subjectRuntime(this.runtime, selected).runtimeRoot : null
    })
    const readiness: SetupReadiness = {
      jeaHome: {
        path: this.runtime.jeaHome,
        source: this.runtime.jeaHomeSource,
        writable: homeWritable(this.homePort)
      },
      subjects: {
        count: names.length,
        defaultSubject: selected && names.includes(selected) ? selected : null,
        names
      },
      model: {
        configured: model.configured,
        mode: model.mode
      },
      data: { initialized },
      conversation: {
        desktopChannelEnabled: selected ? desktopEnabled(this.runtime, selected) : false,
        subject: selected
      },
      conversationReady: false,
      cli: this.cliStatus()
    }
    readiness.conversationReady = isSetupConversationReady(readiness)
    return redactPublicValue(readiness)
  }

  confirmHome(path?: string): SetupHomeResult {
    const home = this.homePort.resolve(path)
    if (!home.writable) {
      throw new PublicClientError('OPERATION_FAILED', 'The requested JEA Home is not writable.')
    }
    return redactPublicValue(home)
  }

  createSubject(name: string, { enableDesktopChannel = true } = {}): SetupSubjectResult {
    const subject = safeSubjectName(name)
    if (!subject) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid name is required.')
    }
    const before = listHomeSubjects(this.runtime)
    const result = createSubject(this.runtime, subject)
    if (result.skipped && !listHomeSubjects(this.runtime).includes(subject) && hasHomePolicy(this.runtime, subject)) {
      registerSubject(this.runtime, subject, {
        policy: SUBJECT_POLICY_FILENAME,
        data_namespace: subject
      })
    }
    stripPhantomSubjects(this.runtime, before.length === 0 ? subject : undefined)
    if (enableDesktopChannel && !result.skipped) {
      this.enableDesktopChannel(subject)
    }
    if (before.length === 0 && hasHomePolicy(this.runtime, subject)) {
      try {
        setDefaultSubject(this.runtime, subject)
      } catch {
        // Default is reconciled by stripPhantomSubjects; init/retry can set it later.
      }
    }
    return redactPublicValue({
      name: subject,
      created: Boolean(result.written) || before.length === 0,
      skipped: Boolean(result.skipped) && before.includes(subject),
      desktopChannelEnabled: desktopEnabled(this.runtime, subject)
    })
  }

  initData(subject: string): { subject: string; initialized: boolean } {
    const name = requireHomeSubject(this.runtime, subject)
    // goals + seed match `data init --all` for this Subject without ensureSubjectsRegistry,
    // which would otherwise write a half-created DEFAULT_SUBJECT.
    initData(this.runtime, { goals: true, seed: true, subject: name })
    return { subject: name, initialized: dataInitialized(this.runtime, name) }
  }

  enableDesktopChannel(subject: string): SetupSubjectResult {
    const name = requireHomeSubject(this.runtime, subject)
    updateSubjectsRegistry(this.runtime, (registry: {
      default_subject?: string
      subjects: Record<string, Record<string, unknown>>
    }) => ({
      ...registry,
      subjects: {
        ...registry.subjects,
        [name]: enableDesktopChannelEntry(registry.subjects[name] ?? getSubjectEntry(this.runtime, name) ?? {})
      }
    }))
    return redactPublicValue({
      name,
      created: false,
      skipped: false,
      desktopChannelEnabled: desktopEnabled(this.runtime, name)
    })
  }
}
