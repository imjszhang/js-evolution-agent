// JEA is authored as native ESM JavaScript and is consumed directly by Electron.
import { buildDaemonProjection } from '../../../../src/daemon/daemon-projection.mjs'
import { buildSubjectObservability } from '../../../../src/intelligence/evolution-viewer/observability-projection.mjs'
import {
  listRegisteredSubjects,
  readSubjectsRegistry
} from '../../../../src/infra/subjects.mjs'
import { loadProjectEnv } from '../../../../src/infra/project.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import type { SubjectSnapshot, SubjectSummary } from '../shared/contract'
import type { DaemonSupervisor } from './daemon-supervisor'
import {
  BUNDLED_PROJECT_ROOT_CANDIDATE,
  resolveDesktopProjectRoot
} from './project-root'

export const DEFAULT_PROJECT_ROOT = BUNDLED_PROJECT_ROOT_CANDIDATE

export interface ProjectionBuilders {
  daemon(root: string, subject: string): Record<string, any>
  observability(input: {
    subject: string
    runtimeRoot: string
    daemon: Record<string, any>
  }): Record<string, any>
}

const directBuilders: ProjectionBuilders = {
  daemon: (root, subject) => buildDaemonProjection(root, subject, { eventLimit: 30 }),
  observability: (input) => buildSubjectObservability(input)
}

export class OpsService {
  constructor(
    readonly projectRoot = resolveDesktopProjectRoot(),
    private readonly builders: ProjectionBuilders = directBuilders,
    envLoader: (root: string) => string = loadProjectEnv,
    private readonly supervisor: Pick<DaemonSupervisor, 'get'> | null = null
  ) {
    envLoader(this.projectRoot)
  }

  listSubjects(): SubjectSummary[] {
    const registry = readSubjectsRegistry(this.projectRoot)
    return listRegisteredSubjects(this.projectRoot).map((name: string) => {
      const runtime = runtimeForSubject(this.projectRoot, name)
      return {
        name,
        namespace: runtime.dataNamespace,
        isDefault: name === registry.default_subject
      }
    })
  }

  getDaemon(subject: string): Record<string, any> {
    this.assertSubject(subject)
    return this.builders.daemon(this.projectRoot, subject)
  }

  getObservability(subject: string): Record<string, any> {
    this.assertSubject(subject)
    const runtime = runtimeForSubject(this.projectRoot, subject)
    const daemon = this.builders.daemon(this.projectRoot, subject)
    return this.builders.observability({
      subject,
      runtimeRoot: runtime.runtimeRoot,
      daemon
    })
  }

  refresh(subject?: string): SubjectSnapshot[] {
    const subjects = this.listSubjects()
      .filter((item) => !subject || item.name === subject)
    if (subject && subjects.length === 0) this.assertSubject(subject)

    return subjects.map((item) => {
      const runtime = runtimeForSubject(this.projectRoot, item.name)
      const daemon = this.builders.daemon(this.projectRoot, item.name)
      return {
        subject: item,
        daemon,
        ...(this.supervisor ? { supervisor: this.supervisor.get(item.name) } : {}),
        observability: this.builders.observability({
          subject: item.name,
          runtimeRoot: runtime.runtimeRoot,
          daemon
        })
      }
    })
  }

  private assertSubject(subject: string): void {
    if (!subject || !listRegisteredSubjects(this.projectRoot).includes(subject)) {
      throw new Error('Requested subject is unavailable.')
    }
  }
}
