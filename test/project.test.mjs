import { afterEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  getProjectAuthorityDocsDir,
  resolveAuthorityDocsDir,
} from '../src/cli/utils/project.mjs';

describe('resolveAuthorityDocsDir', () => {
  const originalEnv = process.env.CYBER_TAOIST_DOCS_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CYBER_TAOIST_DOCS_DIR;
    } else {
      process.env.CYBER_TAOIST_DOCS_DIR = originalEnv;
    }
  });

  it('defaults to policies/authority under project root', () => {
    delete process.env.CYBER_TAOIST_DOCS_DIR;
    const root = '/tmp/jea-project';
    expect(getProjectAuthorityDocsDir(root)).toBe(join(root, 'policies', 'authority'));
    expect(resolveAuthorityDocsDir(root)).toBe(join(root, 'policies', 'authority'));
  });

  it('honors CYBER_TAOIST_DOCS_DIR override', () => {
    process.env.CYBER_TAOIST_DOCS_DIR = '/custom/authority-docs';
    expect(resolveAuthorityDocsDir('/tmp/jea-project')).toBe(resolve('/custom/authority-docs'));
  });
});
