import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SMOKE_FIXTURE_SUBJECT = 'smoke-desktop';

export function createDesktopSmokeFixture(prefix = 'jea-desktop-smoke-root-') {
  const jeaHome = mkdtempSync(join(tmpdir(), prefix));
  try {
    mkdirSync(join(jeaHome, 'subjects', SMOKE_FIXTURE_SUBJECT, 'data'), { recursive: true });
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), `${JSON.stringify({
      default_subject: SMOKE_FIXTURE_SUBJECT,
      subjects: {
        [SMOKE_FIXTURE_SUBJECT]: {
          data_namespace: SMOKE_FIXTURE_SUBJECT,
          channels: {
            desktop: { enabled: true, default_session: 'main' },
            classifier: { enabled: true, mode: 'deterministic' },
          },
        },
      },
    }, null, 2)}\n`);
    writeFileSync(
      join(jeaHome, 'subjects', SMOKE_FIXTURE_SUBJECT, 'SUBJECT.md'),
      `# ${SMOKE_FIXTURE_SUBJECT}\n\n## Subject\n${SMOKE_FIXTURE_SUBJECT}\n`,
    );
    writeFileSync(
      join(jeaHome, 'subjects', SMOKE_FIXTURE_SUBJECT, 'SOUL.md'),
      `# ${SMOKE_FIXTURE_SUBJECT} Soul\n`,
    );
    return { root: jeaHome, jeaHome, subject: SMOKE_FIXTURE_SUBJECT };
  } catch (error) {
    rmSync(jeaHome, { recursive: true, force: true });
    throw error;
  }
}

export function snapshotJeaHome(jeaHome) {
  const files = [];
  const dir = join(jeaHome, 'subjects');
  if (!existsSync(dir)) return { dir, files };
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dir, files };
}

export function snapshotRuntimeSubjects(projectRoot) {
  const dir = join(projectRoot, 'runtime', 'subjects');
  const files = [];
  if (!existsSync(dir)) return { dir, files };
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { dir, files };
}

export function runtimeSubjectsChanged(before, after) {
  const left = new Map(before.files.map((file) => [file.path, file]));
  const right = new Map(after.files.map((file) => [file.path, file]));
  if (left.size !== right.size) return true;
  for (const [path, file] of left) {
    const next = right.get(path);
    if (!next || next.size !== file.size || next.mtimeMs !== file.mtimeMs) return true;
  }
  return false;
}

export function removeDesktopSmokeFixture(root) {
  if (root) rmSync(root, { recursive: true, force: true });
}
