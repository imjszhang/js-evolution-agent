import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { getProjectRoot } from '../utils/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import { buildEvolutionViewerFromRuntime } from '../../intelligence/evolution-viewer/build-manifest.mjs';

const DEFAULT_LIMIT = 50;
const DEFAULT_PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultOutDir(root) {
  return join(root, 'tools', 'evolution-viewer', 'dist');
}

function defaultPublicDir(root) {
  return join(root, 'tools', 'evolution-viewer', 'public');
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
  const outDir = flags.out ? resolve(flags.out) : defaultOutDir(root);
  const publicDir = flags.public ? resolve(flags.public) : defaultPublicDir(root);
  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);
  const baseDir = join(runtime.runtimeRoot, 'data', 'intelligence');

  const manifest = buildEvolutionViewerFromRuntime({
    baseDir,
    runtime,
    outDir,
    limit,
    publicDir,
  });

  console.log(`Evolution viewer built: ${outDir}`);
  console.log(`  subject: ${manifest.subject}`);
  console.log(`  rounds: ${manifest.round_count}`);
  console.log(`  limit: ${manifest.limit}`);
  console.log(`  serve: jea intel viewer serve [--port ${DEFAULT_PORT}] [--open]`);
  return 0;
}

function createStaticServer(distDir, port) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const filePath = resolve(distDir, pathname.replace(/^\/+/, ''));
      const rel = relative(resolve(distDir), filePath);
      if (rel.startsWith('..') || rel.includes('..')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const body = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
  });
}

export async function intelViewerServe(root, flags = {}) {
  const port = numberFlag(flags, 'port', DEFAULT_PORT);
  const distDir = flags.out ? resolve(flags.out) : defaultOutDir(root);
  if (!existsSync(join(distDir, 'manifest.json'))) {
    console.error(`No viewer build at ${distDir}. Run: jea intel viewer build`);
    return 1;
  }

  const server = createStaticServer(distDir, port);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Evolution viewer: ${url}`);
  console.log('Press Ctrl+C to stop.');

  if (flags.open) {
    openInDefaultApp(url);
  }

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
    '  jea intel viewer serve [--port 4173] [--open] [--out PATH]',
  );
  return 2;
}

export function evolutionViewerPublicDir(root) {
  return defaultPublicDir(root);
}
