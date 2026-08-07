import { spawn } from 'node:child_process';

export function runNode(args, { cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

