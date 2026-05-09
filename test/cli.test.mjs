import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { parseArgv } from '../src/cli/utils/args.mjs';
import { removeProjectDir } from '../src/cli/utils/files.mjs';
import { extractMarkdownSection } from '../src/cli/commands/subject.mjs';
import { findUnknownActions } from '../src/cli/commands/actions.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('CLI argument parsing', () => {
  it('splits positionals and flags', () => {
    expect(parseArgv(['run', '--mock', '--limit', '2'])).toEqual({
      positionals: ['run'],
      flags: { mock: true, limit: '2' },
    });
  });
});

describe('subject extraction', () => {
  it('extracts markdown sections by heading', () => {
    const text = [
      '# Policy',
      '',
      '## Subject',
      'The subject is agent.',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n');
    expect(extractMarkdownSection(text, 'Subject')).toBe('The subject is agent.');
    expect(extractMarkdownSection(text, 'Core Layer')).toBe('- Trust');
  });
});

describe('action checks', () => {
  it('detects unknown queued action types', () => {
    const decisions = [
      { id: 'ok', action: { type: 'record_observation' } },
      { id: 'bad', action: { type: 'custom' } },
    ];
    expect(findUnknownActions(decisions, new Set(['record_observation']))).toEqual([
      { id: 'bad', type: 'custom' },
    ]);
  });
});

describe('data reset safety', () => {
  it('removes only paths under the project root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-reset-'));
    const target = join(tempDir, 'data', 'evolution');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'x.json'), '{}');

    expect(removeProjectDir(tempDir, join('data', 'evolution'))).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(() => removeProjectDir(tempDir, '..')).toThrow(/outside project root/);
  });
});

