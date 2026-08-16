import { createRuntimeContext } from '../../../../src/infra/jea-home.mjs'
import { getProjectRoot } from '../../../../src/infra/project.mjs'
import { startWebHostService, stopWebHostService } from './lifecycle'
import { redactWebHostText } from './redact'

const sourceRoot = process.env.JEA_PROJECT_ROOT || getProjectRoot()
const runtime = createRuntimeContext({
  sourceRoot,
  jeaHome: process.env.JEA_HOME
})
const jeaHome = runtime.jeaHome

const host = await startWebHostService({
  sourceRoot,
  jeaHome,
  token: process.env.JEA_WEB_TOKEN,
  address: process.env.JEA_WEB_HOST,
  port: process.env.JEA_WEB_PORT ? Number(process.env.JEA_WEB_PORT) : undefined,
  assetDir: process.env.JEA_WEB_ASSET_DIR
})

process.stdout.write(`${JSON.stringify(host.status())}\n`)

const shutdown = async () => {
  await stopWebHostService(jeaHome, host)
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.on('uncaughtException', (error) => {
  process.stderr.write(`${redactWebHostText(error.stack ?? error.message, host.token)}\n`)
  void shutdown()
})
