import {
  getSubjectEntry,
  listRegisteredSubjects,
  readSubjectsRegistry,
  setDefaultSubject as setDefaultSubjectDomain
} from '../../../../../src/infra/subjects.mjs'
import { runtimeForSubject } from '../../../../../src/infra/runtime-paths.mjs'
import { resolveDesktopConfig } from '../../../../../src/channel/adapters/desktop/config.mjs'
import { PublicClientError } from '../errors'
import type { SubjectRecord, SubjectSummary } from '../types'
import { requireSubject, type ClientRuntimeContext } from './runtime'

export class SubjectCommandOwner {
  selected: string | null = null

  constructor(private readonly runtime: ClientRuntimeContext) {}

  list(): SubjectSummary[] {
    const registry = readSubjectsRegistry(this.runtime)
    return listRegisteredSubjects(this.runtime).map((name: string) => this.summary(name, registry.default_subject))
  }

  get(subject: string): SubjectRecord {
    const name = requireSubject(this.runtime, subject)
    const registry = readSubjectsRegistry(this.runtime)
    return this.record(name, registry.default_subject)
  }

  select(subject: string): SubjectRecord {
    const record = this.get(subject)
    this.selected = record.name
    return { ...record, selected: true }
  }

  setDefault(subject: string): SubjectRecord {
    const name = requireSubject(this.runtime, subject)
    try {
      setDefaultSubjectDomain(this.runtime, name)
    } catch (error) {
      if (String(error).includes('not found')) {
        throw new PublicClientError('NOT_FOUND', 'Requested subject is unavailable.')
      }
      throw error
    }
    this.selected = name
    return this.get(name)
  }

  private summary(name: string, defaultSubject: string | null): SubjectSummary {
    const runtime = runtimeForSubject(this.runtime, name)
    return {
      name,
      namespace: runtime.dataNamespace,
      isDefault: name === defaultSubject
    }
  }

  private record(name: string, defaultSubject: string | null): SubjectRecord {
    const entry = getSubjectEntry(this.runtime, name)
    const desktop = resolveDesktopConfig(this.runtime, name)
    return {
      ...this.summary(name, defaultSubject),
      selected: this.selected === name || (!this.selected && name === defaultSubject),
      desktopChannelEnabled: Boolean(desktop.enabled || entry?.channels?.desktop?.enabled)
    }
  }
}
