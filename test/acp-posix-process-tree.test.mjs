import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcpRuntime } from '../src/actions/agent-adapter/acp/runtime.mjs';

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timed out');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ACP POSIX process-tree cleanup', () => {
  it.skipIf(process.platform === 'win32')(
    'terminates a grandchild started by the ACP child process group',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'jea-acp-posix-'));
      const parentPidFile = join(root, 'parent.pid');
      const childPidFile = join(root, 'child.pid');
      const script = join(root, 'tree.mjs');
      writeFileSync(script, `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
        spawn(process.execPath, ['-e', ${JSON.stringify(`
          require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
          setInterval(() => {}, 1000);
        `)}], { stdio: 'ignore' });
        setInterval(() => {}, 1000);
      `);
      const runtime = new AcpRuntime({
        framework: { command: process.execPath, args: [script] },
        cwd: root,
        timeoutMs: 300,
        killGraceMs: 300,
        spawnImpl: spawn,
        platform: process.platform,
      });
      try {
        await runtime.start().catch(() => {});
        await waitFor(() => existsSync(parentPidFile) && existsSync(childPidFile));
        const parentPid = Number(readFileSync(parentPidFile, 'utf8'));
        const childPid = Number(readFileSync(childPidFile, 'utf8'));
        expect(alive(parentPid)).toBe(true);
        expect(alive(childPid)).toBe(true);
        await runtime.close();
        await waitFor(() => !alive(parentPid) && !alive(childPid));
      } finally {
        try { await runtime.close(); } catch { /* already closed */ }
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
