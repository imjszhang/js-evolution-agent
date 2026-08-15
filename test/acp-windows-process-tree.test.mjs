import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killWindowsProcessTree } from '../src/actions/agent-adapter/acp/runtime.mjs';

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

describe('ACP Windows process-tree cleanup', () => {
  it.skipIf(process.platform !== 'win32')(
    'terminates a cmd shim and its Node descendant',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'jea-acp-tree-'));
      const pidFile = join(root, 'child.pid');
      const script = join(root, 'agent-child.cjs');
      const shim = join(root, 'agent.cmd');
      writeFileSync(script, `
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => {}, 1000);
      `);
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
      const shell = spawn(shim, [], {
        shell: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      try {
        await waitFor(() => existsSync(pidFile));
        const childPid = Number(readFileSync(pidFile, 'utf8'));
        expect(alive(shell.pid)).toBe(true);
        expect(alive(childPid)).toBe(true);
        expect(killWindowsProcessTree(shell.pid, true)).toBe(true);
        await waitFor(() => !alive(shell.pid) && !alive(childPid));
      } finally {
        if (alive(shell.pid)) killWindowsProcessTree(shell.pid, true);
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
