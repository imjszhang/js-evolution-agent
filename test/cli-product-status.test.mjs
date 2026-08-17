import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helpText } from '../src/cli/jea.mjs';
import { productStatusCommand } from '../src/cli/commands/product.mjs';
import { createRuntimeContext } from '../src/infra/jea-home.mjs';
import {
  WEB_HOST_STATUS_STOPPED,
  currentStatus,
  webStartCommand,
  webStatusCommand,
  webStopCommand,
  webUrlCommand,
} from '../src/cli/commands/web.mjs';
import { productStatusPayload } from '../src/cli/commands/product.mjs';
import { readinessCodeView, readSubjectReadiness } from '../src/product/subject-readiness.mjs';
import { buildWebHost } from '../scripts/build-web-host.mjs';
import { getProjectRoot } from '../src/infra/project.mjs';

const WEB_TOKEN = 'a'.repeat(32) + 'cli-status-web-token';
const homes = [];
const previousHome = process.env.JEA_HOME;

function tempHome() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-product-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-product-home-'));
  homes.push(jeaHome);
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        channels: { desktop: { enabled: true, default_session: 'main' } },
      },
    },
  }));
  mkdirSync(join(jeaHome, 'subjects', 'alpha-data', 'data', 'evolution'), { recursive: true });
  process.env.JEA_HOME = jeaHome;
  return { sourceRoot, jeaHome, context: createRuntimeContext({ sourceRoot, jeaHome }) };
}

async function captureIo(run) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value) => { logs.push(String(value)); };
  console.error = (value) => { errors.push(String(value)); };
  try {
    const code = await run();
    return { code, logs, errors, text: [...logs, ...errors].join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(async () => {
  while (homes.length > 0) {
    const jeaHome = homes.pop();
    process.env.JEA_HOME = jeaHome;
    await webStopCommand({ context: { jeaHome, sourceRoot: process.cwd() } }).catch(() => {});
  }
  if (previousHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousHome;
});

describe('jea status --json compatibility', () => {
  it('keeps the Web-host-only stopped snapshot and never mentions Subject domains', async () => {
    const { context } = tempHome();
    const captured = await captureIo(() => webStatusCommand({ flags: { json: true }, context }));
    expect(captured.code).toBe(0);
    const payload = JSON.parse(captured.logs.join('\n'));
    expect(payload).toEqual(WEB_HOST_STATUS_STOPPED);
    expect(payload).toEqual({ running: false, bind: null, pid: null });
    expect(payload).not.toHaveProperty('web_host');
    expect(payload).not.toHaveProperty('cycle');
    expect(payload).not.toHaveProperty('channel');
    expect(payload).not.toHaveProperty('conversation');
    expect(payload).not.toHaveProperty('access_token');
    expect(captured.text).not.toContain(WEB_TOKEN);
  });

  it('documents the distinction from product status in help', () => {
    const help = helpText();
    expect(help).toContain('status [--json]');
    expect(help).toContain('Web-host-only');
    expect(help).toContain('product status [--json] [--subject NAME]');
    expect(help).toContain('service.getReadiness');
    expect(help).toContain('readiness [--json] [--subject NAME]');
    expect(help).toContain('Distinct from `jea status`');
  });
});

describe('jea product status aggregate', () => {
  it('resolves Subject with the same registry rules as domain commands', async () => {
    const { context } = tempHome();
    const implicit = productStatusPayload(context, {});
    const explicit = productStatusPayload(context, { subject: 'alpha' });
    expect(implicit.subject).toBe('alpha');
    expect(explicit.subject).toBe('alpha');
    expect(implicit.source).toBe('service.getReadiness');
    expect(() => productStatusPayload(context, { subject: 'missing' })).toThrow(/Subject not found/);
  });

  it('returns the same state/reason codes as readSubjectReadiness / service.getReadiness', () => {
    const { context } = tempHome();
    const cli = productStatusPayload(context, { subject: 'alpha' });
    const shared = readSubjectReadiness(context, 'alpha', { hostKind: 'electron' });
    expect(readinessCodeView(cli)).toEqual(readinessCodeView(shared));
    expect(cli.web_host).toEqual({ state: 'stopped', reasons: ['web_host_stopped'] });
    expect(cli.cycle).toEqual({ state: 'stopped', reasons: ['cycle_stopped'] });
    expect(cli.channel).toEqual({ state: 'stopped', reasons: ['channel_stopped'] });
    expect(cli.model).toEqual({ state: 'running', mode: 'mock', reasons: ['model_mock'] });
    expect(cli.conversation).toEqual({
      state: 'blocked',
      reasons: ['conversation_blocked_channel'],
    });
    expect(cli.allowed_actions).toEqual(['start_channel', 'start_cycle']);
  });

  it('prints JSON for product status and readiness without leaking a token', async () => {
    const { context, jeaHome } = tempHome();
    mkdirSync(join(jeaHome, 'web-host'), { recursive: true });
    writeFileSync(join(jeaHome, 'web-host', 'session'), WEB_TOKEN);
    const product = await captureIo(() => productStatusCommand({
      flags: { json: true, subject: 'alpha' },
      context,
    }));
    const alias = await captureIo(() => productStatusCommand({
      flags: { json: true },
      context,
    }));
    expect(product.code).toBe(0);
    expect(alias.code).toBe(0);
    const productJson = JSON.parse(product.logs.join('\n'));
    const aliasJson = JSON.parse(alias.logs.join('\n'));
    expect(readinessCodeView(productJson)).toEqual(readinessCodeView(aliasJson));
    expect(product.text).not.toContain(WEB_TOKEN);
    expect(alias.text).not.toContain(WEB_TOKEN);
    expect(product.text).not.toContain('access_token=');
  });
});

describe('jea start/status/url/stop token boundary', () => {
  it('starts headless, reports running, prints the token only from url, and stops cleanly', async () => {
    await buildWebHost({ repoRoot: getProjectRoot() });
    const { context, jeaHome } = tempHome();
    const startedAt = Date.now();
    const started = await captureIo(() => webStartCommand({
      flags: { port: 0, 'no-open': true },
      context,
    }));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(started.code).toBe(0);
    expect(started.text).toMatch(/Started without opening a browser or creating a window/);
    expect(started.text).not.toContain('access_token=');
    expect(started.text).not.toContain(WEB_TOKEN);

    const status = await captureIo(() => webStatusCommand({ flags: { json: true }, context }));
    expect(status.code).toBe(0);
    const statusJson = JSON.parse(status.logs.join('\n'));
    expect(statusJson.running).toBe(true);
    expect(statusJson.bind).toMatchObject({ address: '127.0.0.1' });
    expect(statusJson).toHaveProperty('pid');
    expect(statusJson).toHaveProperty('protocol', 'jea.client');
    expect(statusJson).toHaveProperty('headless', true);
    expect(statusJson).not.toHaveProperty('token');
    expect(statusJson).not.toHaveProperty('access_token');
    expect(JSON.stringify(statusJson)).not.toContain('access_token=');

    const product = productStatusPayload(context, { subject: 'alpha' });
    expect(product.web_host.state).toBe('running');
    expect(JSON.stringify(product)).not.toContain('access_token=');

    const url = await captureIo(() => webUrlCommand({ context }));
    expect(url.code).toBe(0);
    expect(url.logs.join('\n')).toMatch(/access_token=/);
    expect(url.logs.join('\n')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?access_token=/);

    const stopStarted = Date.now();
    const stopped = await captureIo(() => webStopCommand({ context }));
    expect(Date.now() - stopStarted).toBeLessThan(20_000);
    expect(stopped.code).toBe(0);
    expect(stopped.text).toContain('JEA Web host stopped');
    expect(stopped.text).not.toContain('access_token=');
    expect(currentStatus(jeaHome)).toEqual(WEB_HOST_STATUS_STOPPED);
  }, 25_000);
});
