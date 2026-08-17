import { listRegisteredSubjects, readSubjectsRegistry } from '../../../../src/infra/subjects.mjs'
import { ChannelService } from '../main/channel-service'
import { DesktopEventBus } from '../main/event-bus'
import { OpsService } from '../main/operations'
import { ProjectionWatcher } from '../main/projection-watcher'
import { createDesktopServiceRuntimeContext } from '../main/runtime-context'
import { TodoService } from '../main/todo-service'
import type { JeaEventEnvelope } from '../client-api/types'
import type { WebHostWatcher } from './host'

export interface WebHostProjectionBridge extends WebHostWatcher {
  watch(subject: string): { subject: string; watching: true }
  status(): ReturnType<ProjectionWatcher['status']>
}

export function createWebHostProjectionBridge(options: {
  sourceRoot: string
  jeaHome?: string
  publish(event: Omit<JeaEventEnvelope, 'ts'> & { ts?: string }): void
}): WebHostProjectionBridge {
  const events = new DesktopEventBus()
  const ops = new OpsService(options.sourceRoot, undefined, undefined, undefined, options.jeaHome)
  const todo = new TodoService(options.sourceRoot, ops, options.jeaHome)
  const channel = new ChannelService(options.sourceRoot, options.jeaHome)
  const projection = new ProjectionWatcher(
    options.sourceRoot,
    ops,
    todo,
    channel,
    events,
    undefined,
    options.jeaHome
  )
  events.subscribe((event) => {
    options.publish({
      type: event.type,
      subject: event.subject,
      session_id: event.session_id,
      payload: event.payload
    })
  })

  const defaultSubject = (): string | null => {
    const runtime = createDesktopServiceRuntimeContext(options.sourceRoot, options.jeaHome)
    const registry = readSubjectsRegistry(runtime)
    const names = listRegisteredSubjects(runtime)
    if (registry.default_subject && names.includes(registry.default_subject)) {
      return registry.default_subject
    }
    return names[0] ?? null
  }

  return {
    start() {
      const subject = defaultSubject()
      if (subject) projection.watch(subject)
    },
    stop() {
      projection.stop()
    },
    watch(subject) {
      return projection.watch(subject)
    },
    status() {
      return projection.status()
    }
  }
}
