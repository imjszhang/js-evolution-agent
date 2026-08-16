import { describe, expect, it } from 'vitest';
import {
  classifyNetworkFailure,
  probeFeishuNetwork,
  summarizeProxyEnv,
} from '../src/channel/adapters/feishu/diagnostics.mjs';

describe('feishu network diagnostics', () => {

  it('classifies DNS, TLS, timeout and WS failures separately', () => {
    expect(classifyNetworkFailure({ code: 'ENOTFOUND' })).toBe('dns');
    expect(classifyNetworkFailure({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).toBe('tls');
    expect(classifyNetworkFailure({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyNetworkFailure({ code: 'feishu_ws_handshake_failed', message: 'websocket handshake' })).toBe('ws');
    expect(classifyNetworkFailure({ code: 'ECONNREFUSED' })).toBe('https');
  });

  it('reports proxy protocol without credentials', () => {
    expect(summarizeProxyEnv({})).toEqual({ present: false, protocol: null });
    expect(summarizeProxyEnv({ HTTPS_PROXY: 'http://user:pass@proxy.example:8080' })).toEqual({
      present: true,
      protocol: 'http',
    });
  });

  it('uses injected SDK/DNS/HTTPS/WS checks and redacts secrets', async () => {
    const result = await probeFeishuNetwork({
      domain: 'feishu',
      appId: 'cli_alpha',
      appSecret: 'never-log-this-secret',
      bindToken: 'bind-token-value',
    }, {
      env: { HTTPS_PROXY: 'https://user:pass@proxy.example:8443' },
      probeWs: true,
      loadSdk: async () => {
        throw new Error('Authorization: Bearer token-value app_secret=never-log-this-secret');
      },
      dnsLookup: async () => ({ address: '203.0.113.10', family: 4 }),
      httpsProbe: async () => ({ ok: true, status_code: 400 }),
      botProbe: async () => ({ ok: false, error: 'app_secret=never-log-this-secret invalid', error_code: 99991663 }),
      wsHandshake: async () => {
        throw new Error('websocket handshake bind-token-value');
      },
    });

    expect(result.proxy).toEqual({ present: true, protocol: 'https' });
    expect(result.checks.find((check) => check.name === 'sdk').kind).toBe('sdk');
    expect(result.checks.find((check) => check.name === 'dns').ok).toBe(true);
    expect(result.checks.find((check) => check.name === 'https').ok).toBe(true);
    expect(result.checks.find((check) => check.name === 'bot').kind).toBe('api_permission');
    expect(result.checks.find((check) => check.name === 'ws').kind).toBe('ws');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('never-log-this-secret');
    expect(serialized).not.toContain('bind-token-value');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('Authorization: Bearer token-value');
  });

  it('refuses a second WS probe when a live channel worker exists', async () => {
    const result = await probeFeishuNetwork({ domain: 'feishu' }, {
      probeWs: true,
      liveWorker: true,
      loadSdk: async () => ({ name: '@larksuiteoapi/node-sdk' }),
      dnsLookup: async () => ({ family: 4 }),
      httpsProbe: async () => ({ ok: true, status_code: 200 }),
      wsHandshake: async () => { throw new Error('should not start ws'); },
    });
    const ws = result.checks.find((check) => check.name === 'ws');
    expect(ws.ok).toBe(false);
    expect(ws.error_code).toBe('feishu_ws_probe_blocked_live_worker');
  });

  it('probes bot credentials over HTTPS without constructing the Feishu SDK client', async () => {
    const calls = [];
    const result = await probeFeishuNetwork({
      domain: 'feishu',
      appId: 'cli_alpha',
      appSecret: 'never-log-this-secret',
    }, {
      loadSdk: async () => ({ name: '@larksuiteoapi/node-sdk' }),
      dnsLookup: async () => ({ family: 4 }),
      httpsProbe: async (request) => {
        calls.push({ path: request.path, hasSecret: String(request.body || '').includes('never-log-this-secret') });
        if (String(request.body || '').includes('never-log-this-secret')) {
          return {
            ok: true,
            status_code: 200,
            body: { code: 99991663, msg: 'app secret invalid never-log-this-secret' },
          };
        }
        return { ok: true, status_code: 400, body: { code: 99991672, msg: 'invalid request' } };
      },
    });
    const bot = result.checks.find((check) => check.name === 'bot');
    expect(bot.ok).toBe(false);
    expect(bot.kind).toBe('api_permission');
    expect(bot.error_code).toBe(99991663);
    expect(calls.some((call) => call.hasSecret)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('never-log-this-secret');
  });
});
