import {
  assertJeaHomeAuthority,
  createRuntimeContext
} from '../../../../src/infra/jea-home.mjs'
import { loadProjectEnv } from '../../../../src/infra/project.mjs'
import { buildJeaRuntimeEnv } from '../../../../src/actions/execution-env.mjs'
import { join } from 'node:path'
import { resolveDesktopProjectRoot } from './project-root'

export interface DesktopRuntimeContext {
  sourceRoot: string
  jeaHome: string
  jeaHomeSource: string
  legacyCompat: boolean
}

export function resolveDesktopRuntimeContext(
  sourceRoot = resolveDesktopProjectRoot()
): DesktopRuntimeContext {
  loadProjectEnv(sourceRoot)
  const context = createRuntimeContext({ sourceRoot }) as DesktopRuntimeContext
  process.env.JEA_PROJECT_ROOT = context.sourceRoot
  process.env.JEA_HOME = context.jeaHome
  const { env } = buildJeaRuntimeEnv(context.jeaHome, { baseEnv: process.env })
  for (const [key, value] of Object.entries(env)) {
    if (value != null) process.env[key] = String(value)
  }
  assertJeaHomeAuthority(context)
  return context
}

export function createDesktopServiceRuntimeContext(
  sourceRoot: string,
  jeaHome?: string
): DesktopRuntimeContext {
  return createRuntimeContext({
    sourceRoot,
    jeaHome: jeaHome ?? join(sourceRoot, 'runtime')
  }) as DesktopRuntimeContext
}
