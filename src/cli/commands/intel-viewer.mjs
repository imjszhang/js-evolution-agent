import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getProjectRoot } from '../utils/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import {
  DEFAULT_VIEWER_LIMIT,
  buildEvolutionViewerForRuntime,
  evolutionViewerOutDir,
  evolutionViewerPublicDir,
} from '../../intelligence/evolution-viewer/runtime-build.mjs';
import { createViewerApiServer } from '../../intelligence/evolution-viewer/viewer-api.mjs';

const DEFAULT_LIMIT = DEFAULT_VIEWER_LIMIT;
const DEFAULT_PORT = 4173;

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function openInDefaultApp(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function intelViewerBuild(root, flags = {}) {
  const limit = numberFlag(flags, 'limit', DEFAULT_LIMIT);
  const outDir = flags.out ? resolve(flags.out) : evolutionViewerOutDir(root);
  const publicDir = flags.public ? resolve(flags.public) : evolutionViewerPublicDir(root);
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);

  const manifest = buildEvolutionViewerForRuntime(root, runtime, {
    limit,
    outDir,
    publicDir,
  });

  console.log(`Evolution viewer built: ${outDir}`);
  console.log(`  subject: ${manifest.subject}`);
  console.log(`  rounds: ${manifest.round_count}`);
  console.log(`  limit: ${manifest.limit}`);
  console.log(`  offline: npx serve ${outDir}`);
  console.log(`  live API: jea intel viewer serve [--port ${DEFAULT_PORT}] [--open]`);
  return 0;
}

export async function intelViewerServe(root, flags = {}) {
  const port = numberFlag(flags, 'port', DEFAULT_PORT);
  const limit = numberFlag(flags, 'limit', DEFAULT_LIMIT);
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);
  const publicDir = flags.public ? resolve(flags.public) : evolutionViewerPublicDir(root);

  const apiCtx = createViewerApiServer({ runtime, projectRoot: root, limit, port, publicDir });
  await new Promise((resolveListen) => apiCtx.server.listen(port, '127.0.0.1', resolveListen));

  const url = `http://127.0.0.1:${port}/`;
  const eventsUrl = `${url}events`;

  console.log(`Evolution viewer API: ${url}`);
  console.log(`  subject: ${runtime.subject}`);
  console.log(`  runtime: ${runtime.runtimeRoot}`);
  console.log(`  events: ${eventsUrl}`);
  console.log(`  limit: ${limit}`);
  console.log('Press Ctrl+C to stop.');

  if (flags.open) {
    openInDefaultApp(url);
  }

  const shutdown = async () => {
    await apiCtx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  await new Promise(() => {});
  return 0;
}

export async function intelViewerCommand(root, flags = {}, args = []) {
  const action = args[0];
  if (action === 'build') return intelViewerBuild(root, flags);
  if (action === 'serve') return intelViewerServe(root, flags);
  console.error(
    'Usage: jea intel viewer <build|serve> [--subject NAME] [--limit N] [--out PATH] [--port N] [--open]\n' +
    '  jea intel viewer build [--subject NAME] [--limit 50] [--out PATH]\n' +
    '  jea intel viewer serve [--port 4173] [--open] [--limit N] [--subject NAME]',
  );
  return 2;
}

export { evolutionViewerOutDir, evolutionViewerPublicDir } from '../../intelligence/evolution-viewer/runtime-build.mjs';
