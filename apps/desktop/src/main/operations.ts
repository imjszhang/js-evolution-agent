// JEA is authored as native ESM JavaScript and is consumed directly by Electron.
import { readDaemonProjection } from '../../../../src/daemon/daemon-projection.mjs'
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
import { createDesktopServiceRuntimeContext } from './runtime-context'

export const DEFAULT_PROJECT_ROOT = BUNDLED_PROJECT_ROOT_CANDIDATE

export interface ProjectionBuilders {
  daemon(root: any, subject: string): Record<string, any>
  observability(input: {
    subject: string
    runtimeRoot: string
    daemon: Record<string, any>
  }): Record<string, any>
}

const directBuilders: ProjectionBuilders = {
  daemon: (root, subject) => readDaemonProjection(root, subject, { eventLimit: 30, deferRebuild: true }),
  observability: (input) => buildSubjectObservability(input)
}

export class OpsService {
  private readonly runtimeContext: any

  constructor(
    readonly projectRoot = resolveDesktopProjectRoot(),
    private readonly builders: ProjectionBuilders = directBuilders,
    envLoader: (root: string) => string = loadProjectEnv,
    private readonly supervisor: Pick<DaemonSupervisor, 'get'> | null = null,
    jeaHome: string | undefined = process.env.JEA_HOME
  ) {
    envLoader(this.projectRoot)
    this.runtimeContext = createDesktopServiceRuntimeContext(this.projectRoot, jeaHome)
  }

  listSubjects(): SubjectSummary[] {
    const registry = readSubjectsRegistry(this.runtimeContext)
    return listRegisteredSubjects(this.runtimeContext).map((name: string) => {
      const runtime = runtimeForSubject(this.runtimeContext, name)
      return {
        name,
        namespace: runtime.dataNamespace,
        isDefault: name === registry.default_subject
      }
    })
  }

  getDaemon(subject: string): Record<string, any> {
    this.assertSubject(subject)
    return this.builders.daemon(this.runtimeContext, subject)
  }

  getObservability(subject: string): Record<string, any> {
    this.assertSubject(subject)
    const runtime = runtimeForSubject(this.runtimeContext, subject)
    const daemon = this.builders.daemon(this.runtimeContext, subject)
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
      const runtime = runtimeForSubject(this.runtimeContext, item.name)
      const daemon = this.builders.daemon(this.runtimeContext, item.name)
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
    if (!subject || !listRegisteredSubjects(this.runtimeContext).includes(subject)) {
      throw new Error('Requested subject is unavailable.')
    }
  }
}
