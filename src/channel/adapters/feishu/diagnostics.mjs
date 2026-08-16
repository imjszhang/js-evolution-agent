import { lookup as defaultDnsLookup } from 'node:dns/promises';
import { request as defaultHttpsRequest } from 'node:https';
import { sanitizeFeishuError } from './errors.mjs';

export const FEISHU_API_HOST = 'open.feishu.cn';
export const LARK_API_HOST = 'open.larksuite.com';

export function feishuApiHost(domain = 'feishu') {
  return domain === 'lark' ? LARK_API_HOST : FEISHU_API_HOST;
}

export function summarizeProxyEnv(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '';
  if (!raw) return { present: false, protocol: null };
  try {
    const url = new URL(raw);
    return { present: true, protocol: (url.protocol || '').replace(/:$/, '') || 'unknown' };
  } catch {
    return { present: true, protocol: 'unknown' };
  }
}

export function classifyNetworkFailure(error) {
  const code = error?.code || '';
  const message = String(error?.message || error || '');
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'EAI_FAIL'].includes(code)) return 'dns';
  if (
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)
    || /certificate|ssl|tls/i.test(message)
  ) return 'tls';
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'channel_timeout'].includes(code) || /timed out/i.test(message)) {
    return 'timeout';
  }
  if (/websocket|ws handshake|opening handshake/i.test(message) || code === 'feishu_ws_handshake_failed') return 'ws';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'https';
  return 'https';
}

function safeCheckError(error, config) {
  return sanitizeFeishuError(error, config);
}

async function defaultLoadSdk() {
  const mod = await import('@larksuiteoapi/node-sdk');
  return { ok: true, name: '@larksuiteoapi/node-sdk', version: mod?.default?.version ?? mod?.version ?? null };
}

function defaultHttpsProbe({ hostname, path, method = 'GET', body = null, headers = {}, timeoutMs = 5_000 }) {
  return new Promise((resolve, reject) => {
    const req = defaultHttpsRequest({
      hostname,
      path,
      method,
      timeout: timeoutMs,
      headers,
    }, (res) => {
      res.resume();
      resolve({
        status_code: res.statusCode ?? null,
        ok: (res.statusCode ?? 500) < 500,
      });
    });
    req.on('timeout', () => {
      req.destroy();
      const error = new Error('HTTPS probe timed out');
      error.code = 'ETIMEDOUT';
      reject(error);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function probeFeishuNetwork(config = {}, options = {}) {
  const host = feishuApiHost(config.domain);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 5_000);
  const loadSdk = options.loadSdk ?? defaultLoadSdk;
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  const httpsProbe = options.httpsProbe ?? defaultHttpsProbe;
  const botProbe = options.botProbe ?? null;
  const wsHandshake = options.wsHandshake ?? null;
  const env = options.env ?? process.env;
  const checks = [];

  const push = (name, result) => {
    checks.push({
      name,
      ...result,
      error: result.error ? safeCheckError(result.error, config) : null,
    });
  };

  try {
    const sdk = await loadSdk();
    push('sdk', { ok: true, detail: { loaded: true, name: sdk?.name ?? '@larksuiteoapi/node-sdk' } });
  } catch (error) {
    push('sdk', { ok: false, kind: 'sdk', error: error?.message || String(error), error_code: error?.code ?? 'feishu_sdk_unavailable' });
  }

  try {
    const lookup = await dnsLookup(host);
    push('dns', { ok: true, detail: { host, family: lookup?.family ?? null } });
  } catch (error) {
    push('dns', {
      ok: false,
      kind: classifyNetworkFailure(error),
      error: error?.message || String(error),
      error_code: error?.code ?? 'dns_failed',
    });
  }

  try {
    const https = await httpsProbe({
      hostname: host,
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      timeoutMs,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    push('https', {
      ok: https.ok !== false,
      kind: https.ok === false ? 'https' : null,
      detail: { host, status_code: https.status_code ?? null },
    });
  } catch (error) {
    push('https', {
      ok: false,
      kind: classifyNetworkFailure(error),
      error: error?.message || String(error),
      error_code: error?.code ?? 'https_failed',
    });
  }

  if (config.appId && config.appSecret && typeof botProbe === 'function') {
    try {
      const bot = await botProbe(config);
      if (bot?.ok) {
        push('bot', { ok: true, detail: { probed: true } });
      } else {
        push('bot', {
          ok: false,
          kind: 'api_permission',
          error: bot?.error || 'bot probe failed',
          error_code: bot?.error_code ?? 'feishu_bot_probe_failed',
        });
      }
    } catch (error) {
      push('bot', {
        ok: false,
        kind: classifyNetworkFailure(error) === 'https' ? 'api_permission' : classifyNetworkFailure(error),
        error: error?.message || String(error),
        error_code: error?.code ?? 'feishu_bot_probe_failed',
      });
    }
  } else {
    push('bot', { ok: true, skipped: true, reason: 'credentials_missing' });
  }

  if (options.probeWs) {
    if (options.liveWorker) {
      push('ws', {
        ok: false,
        kind: 'ws',
        error: 'Refusing to start a second Feishu WebSocket while a live channel worker exists',
        error_code: 'feishu_ws_probe_blocked_live_worker',
      });
    } else if (typeof wsHandshake === 'function') {
      try {
        await wsHandshake({ host, timeoutMs, config });
        push('ws', { ok: true, detail: { host } });
      } catch (error) {
        push('ws', {
          ok: false,
          kind: classifyNetworkFailure(error),
          error: error?.message || String(error),
          error_code: error?.code ?? 'feishu_ws_handshake_failed',
        });
      }
    } else {
      push('ws', { ok: true, skipped: true, reason: 'ws_probe_unavailable' });
    }
  } else {
    push('ws', { ok: true, skipped: true, reason: 'not_requested' });
  }

  return {
    ok: checks.filter((check) => !check.skipped).every((check) => check.ok),
    host,
    proxy: summarizeProxyEnv(env),
    checks,
  };
}
