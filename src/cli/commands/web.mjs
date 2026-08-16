import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8788;
const serverMain = fileURLToPath(new URL('../../../apps/desktop/src/web-host/server-main.ts', import.meta.url));
const registerLoader = fileURLToPath(new URL('../../../scripts/register-ts-resolve.mjs', import.meta.url));

function stateDir(jeaHome) {
  return join(jeaHome, 'web-host');
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentStatus(jeaHome) {
  const state = readJson(join(stateDir(jeaHome), 'state.json'));
  if (!state) return { running: false, bind: null, pid: null };
  return {
    running: processAlive(state.pid),
    pid: state.pid ?? null,
    bind: state.bind ?? null,
    protocol: state.protocol ?? 'jea.client',
    version: state.version ?? null,
    headless: true,
    started_at: state.started_at ?? null,
  };
}

function currentToken(jeaHome) {
  const path = join(stateDir(jeaHome), 'session');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim() || null;
}

function numberFlag(flags, name, fallback) {
  if (flags[name] == null || flags[name] === true) return fallback;
  return Number(flags[name]);
}

export async function webStartCommand({ flags = {}, context }) {
  const port = numberFlag(flags, 'port', DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Port ${String(flags.port)} is invalid. Use an integer from 1 to 65535.`);
    return 2;
  }
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '*' || host === '[::]') {
    console.error(`Refusing to bind ${host}. The Web host is localhost-only and cannot listen on a wildcard address.`);
    return 2;
  }

  const existing = currentStatus(context.jeaHome);
  if (existing.running) {
    console.error(`The localhost Web host is already running on ${existing.bind.address}:${existing.bind.port}.`);
    return 1;
  }

  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--no-warnings=ExperimentalWarning',
    '--import',
    registerLoader,
    serverMain,
  ], {
    env: {
      ...process.env,
      JEA_HOME: context.jeaHome,
      JEA_PROJECT_ROOT: context.sourceRoot,
      JEA_WEB_PORT: String(port),
      JEA_WEB_HOST: host,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(String(chunk)));

  const ready = await new Promise((resolveReady) => {
    const timer = setTimeout(() => resolveReady(false), 10_000);
    const onData = (chunk) => {
      if (String(chunk).includes('"running":true')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolveReady(true);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveReady(false);
    });
  });

  if (!ready) {
    const detail = errors.join('').trim() || 'Web host failed to start.';
    console.error(detail.split('\n')[0]);
    return 1;
  }

  child.unref();
  console.log(`JEA Web host listening on ${host}:${port}`);
  return 0;
}

export async function webStatusCommand({ flags = {}, context }) {
  const status = currentStatus(context.jeaHome);
  if (flags.json) console.log(JSON.stringify(status, null, 2));
  else if (status.running) console.log(`running ${status.bind.address}:${status.bind.port}`);
  else console.log('stopped');
  return 0;
}

export async function webUrlCommand({ context }) {
  const status = currentStatus(context.jeaHome);
  const token = currentToken(context.jeaHome);
  if (!status.running || !status.bind || !token) {
    console.error('The localhost Web host is not running.');
    return 1;
  }
  console.log(`http://${status.bind.address}:${status.bind.port}/?access_token=${token}`);
  return 0;
}

export async function webStopCommand({ context }) {
  const status = currentStatus(context.jeaHome);
  if (status.pid && processAlive(status.pid)) {
    try {
      process.kill(status.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  rmSync(stateDir(context.jeaHome), { recursive: true, force: true });
  console.log('JEA Web host stopped');
  return 0;
}
