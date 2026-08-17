import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordDaemonStartupFailure,
  recordProcessFailure,
  sanitizeProcessFailure,
} from '../src/product/diagnostics-store.mjs';
import {
  HOME_TOKEN,
  JEA_HOME_TOKEN,
  redactAbsolutePath,
  redactMachinePaths,
} from '../src/product/path-redact.mjs';

const temps = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

const API_KEY_CANARY = 'sk-canary-api-key-142-should-never-export';
const WEB_TOKEN_CANARY = 'jea-web-token-canary-142-aabbccddeeff';
const OWNER_TOKEN_CANARY = 'owner-token-canary-142-001122334455';
const MESSAGE_BODY_CANARY = 'CANARY_MESSAGE_BODY_142_do_not_export_this_conversation';
const USER_HOME_CANARY = '/Users/canary/github/js-evolution-agent';

describe('path redaction', () => {
  it('replaces user-home prefixes and JEA Home with tokens', () => {
    const home = '/Users/canary';
    const jeaHome = '/Users/canary/.jea';
    expect(redactAbsolutePath(`${jeaHome}/logs/daemon-alpha.desktop.stdout.log`, { home, jeaHome }))
      .toBe(`${JEA_HOME_TOKEN}/logs/daemon-alpha.desktop.stdout.log`);
    expect(redactAbsolutePath(`${home}/projects/secret`, { home, jeaHome }))
      .toBe(`${HOME_TOKEN}/projects/secret`);
    expect(redactAbsolutePath(USER_HOME_CANARY, { home: '/tmp/other', jeaHome: '/tmp/jea' }))
      .toBe(`${HOME_TOKEN}/github/js-evolution-agent`);
  });

  it('walks objects and never leaves machine-specific absolute homes', () => {
    const jeaHome = '/home/canary/.jea';
    const redacted = redactMachinePaths({
      host: { jea_home: jeaHome, note: `${jeaHome}/subjects/alpha` },
      extra: USER_HOME_CANARY,
    }, { home: '/home/canary', jeaHome });
    const text = JSON.stringify(redacted);
    expect(text).toContain(JEA_HOME_TOKEN);
    expect(text).toContain(HOME_TOKEN);
    expect(text).not.toContain('/home/canary');
    expect(text).not.toContain('/Users/canary');
  });
});

describe('diagnostic store privacy', () => {
  it('keeps process-failure summaries to metadata and reason only', () => {
    const record = sanitizeProcessFailure({
      process_type: 'renderer',
      reason: 'crashed; DEEPSEEK_API_KEY=sk-should-not-survive-in-reason-field',
      occurred_at: '2026-08-17T04:32:54.000Z',
      message: MESSAGE_BODY_CANARY,
      env: { DEEPSEEK_API_KEY: API_KEY_CANARY },
      token: WEB_TOKEN_CANARY,
    }, { version: '0.1.0', buildId: '0.1.0+aaaaaaa.dev' });
    expect(record).toEqual({
      schema_version: 1,
      occurred_at: '2026-08-17T04:32:54.000Z',
      process_type: 'renderer',
      reason: 'crashed_DEEPSEEK_API_KEY_sk-should-not-survive-in-reason-field'.slice(0, 64),
      version: '0.1.0',
      build_id: '0.1.0+aaaaaaa.dev',
    });
    expect(JSON.stringify(record)).not.toContain(MESSAGE_BODY_CANARY);
    expect(JSON.stringify(record)).not.toContain(API_KEY_CANARY);
    expect(JSON.stringify(record)).not.toContain(WEB_TOKEN_CANARY);
    expect(record).not.toHaveProperty('message');
    expect(record).not.toHaveProperty('env');
    expect(record).not.toHaveProperty('token');
  });

  it('records daemon startup failures with redacted JEA-owned log paths', () => {
    const jeaHome = tempDir('jea-diag-home-');
    const runtime = { sourceRoot: tempDir('jea-diag-src-'), jeaHome };
    const record = recordDaemonStartupFailure(runtime, {
      subject: 'alpha',
      reason: 'startup_deadline',
      logPaths: {
        stdout: join(jeaHome, 'logs', 'daemon-alpha.desktop.stdout.log'),
        stderr: join(jeaHome, 'logs', 'daemon-alpha.desktop.stderr.log'),
      },
    });
    expect(record.log_paths.stdout).toBe(`${JEA_HOME_TOKEN}/logs/daemon-alpha.desktop.stdout.log`);
    expect(record.log_paths.stderr).toBe(`${JEA_HOME_TOKEN}/logs/daemon-alpha.desktop.stderr.log`);
    expect(JSON.stringify(record)).not.toContain(jeaHome);
  });

  it('does not persist seeded secret or message-body canaries next to failure records', () => {
    const jeaHome = tempDir('jea-diag-canary-');
    const sourceRoot = tempDir('jea-diag-canary-src-');
    writeFileSync(join(jeaHome, '.env'), `DEEPSEEK_API_KEY=${API_KEY_CANARY}\n`);
    mkdirSync(join(jeaHome, 'web-host'), { recursive: true });
    writeFileSync(join(jeaHome, 'web-host', 'session'), WEB_TOKEN_CANARY);
    mkdirSync(join(jeaHome, 'subjects', 'alpha', 'evolution', 'daemon'), { recursive: true });
    writeFileSync(join(jeaHome, 'subjects', 'alpha', 'evolution', 'daemon', 'desktop-supervisor.json'), JSON.stringify({
      owner_token: OWNER_TOKEN_CANARY,
    }));
    mkdirSync(join(jeaHome, 'subjects', 'alpha', 'channel', 'desktop'), { recursive: true });
    writeFileSync(join(jeaHome, 'subjects', 'alpha', 'channel', 'desktop', 'main.jsonl'), `${JSON.stringify({
      content: MESSAGE_BODY_CANARY,
    })}\n`);

    const runtime = { sourceRoot, jeaHome };
    const failure = recordProcessFailure(runtime, {
      process_type: 'utility',
      reason: 'abnormal-exit',
      occurred_at: '2026-08-17T04:32:54.000Z',
    }, { version: '0.1.0', build_id: '0.1.0+test' });
    const text = JSON.stringify(failure);
    expect(text).not.toContain(API_KEY_CANARY);
    expect(text).not.toContain(WEB_TOKEN_CANARY);
    expect(text).not.toContain(OWNER_TOKEN_CANARY);
    expect(text).not.toContain(MESSAGE_BODY_CANARY);
  });
});
