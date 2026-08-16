import { createRuntimeContext } from '../../../../../src/infra/jea-home.mjs'
import { listRegisteredSubjects } from '../../../../../src/infra/subjects.mjs'
import { runtimeForSubject } from '../../../../../src/infra/runtime-paths.mjs'
import { PublicClientError } from '../errors'

export interface ClientRuntimeContext {
  sourceRoot: string
  jeaHome: string
  jeaHomeSource: string
}

export function createClientRuntimeContext(
  sourceRoot: string,
  jeaHome?: string
): ClientRuntimeContext {
  return createRuntimeContext({
    sourceRoot,
    jeaHome
  }) as ClientRuntimeContext
}

export function requireSubject(runtime: ClientRuntimeContext, subject: string | undefined): string {
  const name = subject?.trim()
  if (!name) {
    throw new PublicClientError('INVALID_REQUEST', 'A subject is required.')
  }
  if (!listRegisteredSubjects(runtime).includes(name)) {
    throw new PublicClientError('NOT_FOUND', 'Requested subject is unavailable.')
  }
  return name
}

export function subjectRuntime(runtime: ClientRuntimeContext, subject: string) {
  return runtimeForSubject(runtime, requireSubject(runtime, subject))
}
