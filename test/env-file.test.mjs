import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEnvFile, formatEnvBlock, maskSecret } from '../src/infra/env-file.mjs';

let tempDir = null;

describe('env-file', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('upsertEnvFile preserves comments and updates keys', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-env-file-'));
    const envPath = join(tempDir, '.env');
    writeFileSync(envPath, '# comment\nFOO=bar\n', 'utf-8');
    upsertEnvFile(envPath, { FOO: 'baz', NEW_KEY: 'value' }, { force: true });
    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('# comment');
    expect(content).toContain('FOO=baz');
    expect(content).toContain('NEW_KEY=value');
  });

  it('upsertEnvFile refuses overwrite without force', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-env-file-'));
    const envPath = join(tempDir, '.env');
    writeFileSync(envPath, 'SECRET=old\n', 'utf-8');
    expect(() => upsertEnvFile(envPath, { SECRET: 'new' })).toThrow(/Refusing to overwrite/);
    upsertEnvFile(envPath, { SECRET: 'new' }, { force: true });
    expect(readFileSync(envPath, 'utf-8')).toContain('SECRET=new');
  });

  it('formatEnvBlock and maskSecret work', () => {
    expect(formatEnvBlock({ A: '1', B: 'sp ace' })).toContain('B="sp ace"');
    expect(maskSecret('abcdefghij')).toMatch(/\*+ghij/);
  });
});
