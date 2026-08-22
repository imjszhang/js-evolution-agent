import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/intelligence/redaction.mjs';

const TOKENS = [
  'github_pat_11AA22BB33CC44DD55EE66FF77GG88HH',
  'ghp_0123456789abcdefghijklmnop',
  'glpat-0123456789abcdefghij',
  'npm_0123456789abcdefghijklmnop',
  ['xox', 'b-1234567890-abcdefghijklmnop'].join(''),
  'AIza0123456789abcdefghijklmnop',
  'AKIA0123456789ABCDEF',
];

describe('redactSecrets', () => {
  it.each(TOKENS)('redacts common token pattern %s', (token) => {
    const redacted = redactSecrets(`prefix ${token} suffix`);
    expect(redacted).toBe('prefix [REDACTED_SECRET] suffix');
  });

  it('redacts bearer and expanded sensitive keys without changing object shape', () => {
    const input = {
      headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      nested: {
        client_secret: 'client-value',
        refresh_token: 'refresh-value',
        safe: 'preserved',
      },
      list: ['APP_SECRET=app-value', 'ordinary text'],
    };
    const redacted = redactSecrets(input);

    expect(redacted).toEqual({
      headers: { authorization: 'Bearer [REDACTED_SECRET]' },
      nested: {
        client_secret: '[REDACTED_SECRET]',
        refresh_token: '[REDACTED_SECRET]',
        safe: 'preserved',
      },
      list: ['APP_SECRET=[REDACTED_SECRET]', 'ordinary text'],
    });
  });

  it.each([
    {
      label: 'PKCS8 PEM private key block',
      input: 'before\n-----BEGIN PRIVATE KEY-----\nabc123\nsecond-line\n-----END PRIVATE KEY-----\nafter',
      secrets: ['abc123', 'second-line', 'BEGIN PRIVATE KEY'],
    },
    {
      label: 'RSA PEM private key block',
      input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----',
      secrets: ['MIIEowIBAAKCAQEAsecret', 'BEGIN RSA PRIVATE KEY'],
    },
    {
      label: 'Basic authorization header',
      input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      secrets: ['dXNlcjpwYXNzd29yZA=='],
    },
    {
      label: 'Digest authorization header',
      input: 'Authorization: Digest username="admin", realm="private", nonce="abcdef"',
      secrets: ['admin', 'private', 'abcdef'],
    },
    {
      label: 'cookie headers',
      input: 'Cookie: sid=session-secret; theme=dark\nSet-Cookie: auth=server-secret; HttpOnly',
      secrets: ['session-secret', 'server-secret'],
    },
    {
      label: 'session token assignment',
      input: 'SESSION_TOKEN=standalone-session-secret',
      secrets: ['standalone-session-secret'],
    },
    {
      label: 'session secret assignment',
      input: 'SESSION_SECRET=standalone-session-secret',
      secrets: ['standalone-session-secret'],
    },
    {
      label: 'standalone valid Basic credential',
      input: 'Basic dXNlcjpwYXNzd29yZA==',
      secrets: ['dXNlcjpwYXNzd29yZA=='],
    },
    {
      label: 'serialized cookie value',
      input: '{"cookie":"json-cookie-secret","session_id":"json-session-secret"}',
      secrets: ['json-cookie-secret'],
    },
  ])('fully redacts $label', ({ input, secrets }) => {
    const redacted = String(redactSecrets(input));
    expect(redacted).toContain('[REDACTED_SECRET]');
    for (const secret of secrets) expect(redacted).not.toContain(secret);
  });

  it('redacts authorization, cookie, and session values outside header-shaped text', () => {
    expect(redactSecrets({
      authorization: 'Basic dXNlcjpwYXNzd29yZA==',
      cookie: 'sid=object-session-secret',
      'set-cookie': 'auth=object-server-secret',
      session_id: 'object-session-id',
    })).toEqual({
      authorization: 'Basic [REDACTED_SECRET]',
      cookie: '[REDACTED_SECRET]',
      'set-cookie': '[REDACTED_SECRET]',
      session_id: 'object-session-id',
    });
  });

  it('preserves internal session identifiers and non-credential Basic text', () => {
    const input = {
      env: 'SESSION_ID=cycle-2026-08-22',
      session_id: 'cycle-object-1234',
      note: 'Basic internal-id-1234',
      encodedWithoutCredential: 'Basic aW50ZXJuYWwtaWQtMTIzNA==',
    };

    expect(redactSecrets(input)).toEqual(input);
  });

  it('redacts Basic credentials in authorization context even when payload is not base64', () => {
    expect(redactSecrets({
      authorization: 'Basic internal-id-1234',
      note: 'Authorization: Basic internal-id-1234',
    })).toEqual({
      authorization: 'Basic [REDACTED_SECRET]',
      note: 'Authorization: Basic [REDACTED_SECRET]',
    });
  });

  it('keeps session token, session secret, cookie, PEM, and token protections intact', () => {
    const input = {
      session_token: 'object-session-token',
      session_secret: 'object-session-secret',
      cookie: 'sid=cookie-secret',
      text: [
        'SESSION_TOKEN=env-session-token',
        'SESSION_SECRET=env-session-secret',
        'Cookie: sid=header-cookie-secret',
        '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
        TOKENS[0],
      ].join('\n'),
    };
    const redacted = JSON.stringify(redactSecrets(input));

    expect(redacted).toContain('[REDACTED_SECRET]');
    for (const secret of [
      'object-session-token',
      'object-session-secret',
      'cookie-secret',
      'env-session-token',
      'env-session-secret',
      'header-cookie-secret',
      'private-material',
      TOKENS[0],
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });
});
