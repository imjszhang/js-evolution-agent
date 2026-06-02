import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerQrImagePath,
  renderRegisterQrArtifacts,
} from '../src/cli/utils/register-qr.mjs';

let tempDir = null;

describe('register-qr', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('registerQrImagePath resolves under subject channel dir', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-register-qr-'));
    const path = registerQrImagePath(tempDir, 'feishu-flow-test');
    expect(path.replace(/\\/g, '/')).toContain('runtime/subjects/feishu-flow-test/data/channel/feishu-register-qr.png');
  });

  it('renderRegisterQrArtifacts writes terminal and png output', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-register-qr-'));
    const imagePath = join(tempDir, 'qr.png');
    const artifacts = await renderRegisterQrArtifacts('https://example.com/register', {
      imagePath,
    });
    expect(artifacts.terminal).toMatch(/█/);
    expect(existsSync(imagePath)).toBe(true);
    expect(readFileSync(imagePath).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('renderRegisterQrArtifacts respects noQrImage', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-register-qr-'));
    const imagePath = join(tempDir, 'qr.png');
    const artifacts = await renderRegisterQrArtifacts('https://example.com/register', {
      imagePath,
      noQrImage: true,
    });
    expect(artifacts.terminal).toMatch(/█/);
    expect(artifacts.imagePath).toBeNull();
    expect(existsSync(imagePath)).toBe(false);
  });
});
