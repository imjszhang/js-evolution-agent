import { expect } from 'vitest';
import {
  auditIntelReportEvidenceHonesty,
  detectNearMissCitations,
  extractBracketRefs,
  extractSeenSectionBody,
  resolveTypedRef,
  sanitizeCitationGlyphs,
} from '../../src/intelligence/report-honesty.mjs';

export const POISON_INTENT_CLAIM_E2E = 'POISON_INTENT_CLAIM_E2E';

export {
  auditIntelReportEvidenceHonesty,
  detectNearMissCitations,
  extractBracketRefs,
  extractSeenSectionBody,
  resolveTypedRef,
  sanitizeCitationGlyphs,
};

/**
 * Vitest assertion wrapper around auditIntelReportEvidenceHonesty.
 */
export function assertIntelReportEvidenceHonesty(opts = {}) {
  const result = auditIntelReportEvidenceHonesty(opts);
  expect(
    result.findings,
    `evidence honesty findings: ${JSON.stringify(result.findings, null, 2)}`,
  ).toEqual([]);
  return result;
}
