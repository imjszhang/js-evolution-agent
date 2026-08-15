import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { createRuntimeWatcher } from '../../../../src/intelligence/evolution-viewer/runtime-watch.mjs'
import type { SubjectSnapshot, TodoSnapshot } from '../shared/contract'
import type { DesktopEventBus } from './event-bus'
import type { OpsService } from './operations'
import type { TodoService } from './todo-service'

interface RuntimeWatcher {
  start(): void
  stop(): void
  notify(reason?: string): void
}

type WatcherFactory = typeof createRuntimeWatcher

export class ProjectionWatcher {
  private activeSubject: string | null = null
  private watcher: RuntimeWatcher | null = null
  private revision = 0

  constructor(
    private readonly projectRoot: string,
    private readonly ops: OpsService,
    private readonly todo: TodoService,
    private readonly events: DesktopEventBus,
    private readonly watcherFactory: WatcherFactory = createRuntimeWatcher
  ) {}

  watch(subject: string): { subject: string; watching: true } {
    this.ops.refresh(subject)
    if (this.activeSubject === subject && this.watcher) {
      return { subject, watching: true }
    }
    this.stop()
    const runtime = runtimeForSubject(this.projectRoot, subject)
    this.activeSubject = subject
    this.watcher = this.watcherFactory({
      runtimeRoot: runtime.runtimeRoot,
      projectRoot: this.projectRoot,
      subjectMeta: { subject, namespace: runtime.dataNamespace },
      watchSubjectsJson: false,
      includeOperator: true,
      includeDesktopSessions: true,
      onRuntimeChange: ({ reason }: { reason: string }) => this.publish(subject, reason)
    })
    this.watcher.start()
    return { subject, watching: true }
  }

  refresh(): void {
    this.watcher?.notify('manual')
  }

  stop(): { stopped: boolean } {
    const stopped = Boolean(this.watcher)
    this.watcher?.stop()
    this.watcher = null
    this.activeSubject = null
    this.revision += 1
    return { stopped }
  }

  private publish(subject: string, reason: string): void {
    if (subject !== this.activeSubject) return
    const revision = ++this.revision
    try {
      const snapshot = this.ops.refresh(subject)[0] as SubjectSnapshot | undefined
      if (snapshot) {
        this.events.publish({
          type: 'projection.ops_updated',
          subject,
          payload: { snapshot, reason, revision }
        })
      }
      const todo = this.todo.get(subject) as TodoSnapshot
      this.events.publish({
        type: 'projection.todo_updated',
        subject,
        payload: { snapshot: todo, reason, revision }
      })
    } catch {
      this.events.publish({
        type: 'projection.refresh_failed',
        subject,
        payload: { reason, revision }
      })
    }
  }
}
