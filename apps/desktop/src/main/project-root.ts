import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appPathFromElectronBinary,
  isJeaSourceRoot,
  looksLikePackagedApp,
  packagedSourceRootFromApp
} from '../../../../src/product/app-paths.mjs'

export const BUNDLED_PROJECT_ROOT_CANDIDATE = resolve(
  fileURLToPath(new URL('../../../..', import.meta.url))
)

export function isJeaProjectRoot(candidate: string): boolean {
  return isJeaSourceRoot(candidate)
}

export function isInsideMacAppBundle(candidate: string): boolean {
  return resolve(candidate).split(/[/\\]/).some((part) => part.endsWith('.app'))
}

export function findProjectRoot(start: string): string | null {
  let current = resolve(start)
  for (let i = 0; i < 10; i += 1) {
    if (isJeaProjectRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    if (isInsideMacAppBundle(current) && !isInsideMacAppBundle(parent)) break
    current = parent
  }
  return null
}

function packagedSourceRootFromRunningApp({
  env,
  execPath
}: {
  env: NodeJS.ProcessEnv
  execPath: string
}): string | null {
  const fromExec = appPathFromElectronBinary(execPath)
  if (fromExec && looksLikePackagedApp(fromExec)) {
    return packagedSourceRootFromApp(fromExec)
  }
  if (env.JEA_APP_PATH) {
    const explicit = resolve(env.JEA_APP_PATH)
    if (looksLikePackagedApp(explicit)) {
      return packagedSourceRootFromApp(explicit)
    }
  }
  return null
}

export function resolveDesktopProjectRoot({
  env = process.env,
  cwd = process.cwd(),
  fallback = BUNDLED_PROJECT_ROOT_CANDIDATE,
  execPath = process.execPath
}: {
  env?: NodeJS.ProcessEnv
  cwd?: string
  fallback?: string
  execPath?: string
} = {}): string {
  const packaged = packagedSourceRootFromRunningApp({ env, execPath })
  if (packaged) return packaged
  if (env.JEA_PROJECT_ROOT) return resolve(env.JEA_PROJECT_ROOT)
  return findProjectRoot(fallback) ?? findProjectRoot(cwd) ?? fallback
}
