import { existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverAppPath,
  isJeaSourceRoot,
  packagedSourceRootFromApp
} from '../../../../src/product/app-paths.mjs'

export const BUNDLED_PROJECT_ROOT_CANDIDATE = resolve(
  fileURLToPath(new URL('../../../..', import.meta.url))
)

export function isJeaProjectRoot(candidate: string): boolean {
  return isJeaSourceRoot(candidate)
}

export function findProjectRoot(start: string): string | null {
  let current = resolve(start)
  for (let i = 0; i < 10; i += 1) {
    if (isJeaProjectRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
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
  if (env.JEA_PROJECT_ROOT) return resolve(env.JEA_PROJECT_ROOT)
  const appPath = discoverAppPath({ env, execPath })
  if (appPath) {
    const packaged = packagedSourceRootFromApp(appPath)
    if (packaged && existsSync(join(packaged, 'src', 'cli', 'jea.mjs'))) return packaged
  }
  return findProjectRoot(fallback) ?? findProjectRoot(cwd) ?? fallback
}
