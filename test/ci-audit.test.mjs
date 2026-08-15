import { describe, expect, it } from 'vitest';
import {
  collectHighCriticalFindings,
  evaluateAudit,
  ghsaFromUrl,
  npmFixAvailable,
} from '../scripts/ci-audit.mjs';

const undiciHigh = {
  source: 1,
  name: 'undici',
  dependency: 'undici',
  title: 'Undici high advisory',
  url: 'https://github.com/advisories/GHSA-vxpw-j846-p89q',
  severity: 'high',
};

function auditWith(via, { severity = 'high', fixAvailable = false } = {}) {
  return {
    vulnerabilities: {
      undici: {
        name: 'undici',
        severity,
        via,
        fixAvailable,
      },
    },
  };
}

describe('ci-audit helpers', () => {
  it('extracts GHSA ids and treats object fixAvailable as true', () => {
    expect(ghsaFromUrl('https://github.com/advisories/GHSA-vxpw-j846-p89q')).toBe('GHSA-VXPW-J846-P89Q');
    expect(npmFixAvailable(false)).toBe(false);
    expect(npmFixAvailable(true)).toBe(true);
    expect(npmFixAvailable({ name: 'undici', version: '6.28.0' })).toBe(true);
  });

  it('collects only high and critical advisory objects', () => {
    const findings = collectHighCriticalFindings(auditWith([
      'connect-node',
      undiciHigh,
      { ...undiciHigh, severity: 'moderate', url: 'https://github.com/advisories/GHSA-g9mf-h72j-4rw9' },
    ]));
    expect(findings).toEqual([
      expect.objectContaining({
        package: 'undici',
        ghsa: 'GHSA-VXPW-J846-P89Q',
        severity: 'high',
        fixAvailable: false,
      }),
    ]);
  });
});

describe('evaluateAudit', () => {
  const baseline = {
    exceptions: [
      {
        ghsa: 'GHSA-vxpw-j846-p89q',
        package: 'undici',
        expires: '2026-11-15',
      },
    ],
  };

  it('passes an exact unexpired unfixed exception', () => {
    const result = evaluateAudit(auditWith([undiciHigh]), baseline, {
      now: new Date('2026-08-15T00:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails new findings, expired exceptions, available fixes, and stale entries', () => {
    expect(evaluateAudit(auditWith([{
      ...undiciHigh,
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    }]), baseline).failures.map((item) => item.code)).toContain('new_finding');

    expect(evaluateAudit(auditWith([undiciHigh]), baseline, {
      now: new Date('2026-11-16T00:00:00.000Z'),
    }).failures.map((item) => item.code)).toContain('expired_exception');

    expect(evaluateAudit(auditWith([undiciHigh], { fixAvailable: true }), baseline).failures.map((item) => item.code)).toContain('fix_available');

    expect(evaluateAudit({ vulnerabilities: {} }, baseline).failures.map((item) => item.code)).toContain('stale_exception');
  });
});
