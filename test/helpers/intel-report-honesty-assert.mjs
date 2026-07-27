import { expect } from 'vitest';
import { extractMarkdownSection } from '../../src/cli/utils/markdown-sections.mjs';
import { MACHINE_CONTEXT_IDS } from '../../src/intelligence/machine-context-refs.mjs';

export const POISON_INTENT_CLAIM_E2E = 'POISON_INTENT_CLAIM_E2E';

const SEEN_HEADINGS = Object.freeze(['Seen', 'Evidence', '本轮看到']);

const SUPPORTED_SOURCE_READERS = Object.freeze({
  intel_observations: (store, limit) => store.readRecentIntel?.({ days: 3650, limit }) ?? [],
  action_receipts: (store, limit) => store.readActionReceipts?.({ limit }) ?? [],
  probe_results: (store, limit) => store.readProbeResults?.({ limit }) ?? [],
  evolution_events: (store, limit) => store.readEvolutionEvents?.({ limit }) ?? [],
  goal_events: (store, limit) => store.readGoalEvents?.({ limit }) ?? [],
  belief_events: (store, limit) => store.readBeliefEvents?.({ limit }) ?? [],
  retrospectives: (store, limit) => store.readRetrospectives?.({ limit }) ?? [],
  intel_reports: (store, limit) => store.readIntelReports?.({ limit }) ?? [],
});

/** Align with report-builder memorySourceType aliases (singular → plural store keys). */
const SOURCE_TYPE_ALIASES = Object.freeze({
  evolution_event: 'evolution_events',
  goal_event: 'goal_events',
  action_receipt: 'action_receipts',
  probe_result: 'probe_results',
  intel_report: 'intel_reports',
  belief_event: 'belief_events',
});

function normalizeSourceType(sourceType) {
  const key = String(sourceType || '').toLowerCase();
  return SOURCE_TYPE_ALIASES[key] || key;
}

/**
 * @param {string} text
 * @returns {Array<{ raw: string, sourceType: string, sourceId: string }>}
 */
export function extractBracketRefs(text) {
  const out = [];
  const re = /\[([a-z0-9_]+):([^\]]+)\]/gi;
  let match;
  while ((match = re.exec(String(text || ''))) != null) {
    out.push({
      raw: match[0],
      sourceType: String(match[1] || '').toLowerCase(),
      sourceId: String(match[2] || '').trim(),
    });
  }
  return out;
}

export function extractSeenSectionBody(markdown) {
  const md = String(markdown || '');
  for (const heading of SEEN_HEADINGS) {
    const body = extractMarkdownSection(md, heading);
    if (body) return { heading, body };
  }
  return { heading: null, body: '' };
}

function splitBullets(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line && line !== '(none)');
}

function recordExists(store, sourceType, sourceId) {
  const normalized = normalizeSourceType(sourceType);
  if (normalized === 'machine_context') {
    return { supported: true, found: MACHINE_CONTEXT_IDS.includes(sourceId), sourceType: normalized };
  }
  const reader = SUPPORTED_SOURCE_READERS[normalized];
  if (!reader) return { supported: false, found: false, sourceType: normalized };
  const rows = reader(store, 500) || [];
  const found = rows.some((row) => row?.id === sourceId);
  return { supported: true, found, sourceType: normalized };
}

/**
 * Mechanically audit Seen/Evidence honesty for Phase 1.5 reports.
 * @returns {{ findings: Array<{ rule: string, message: string, detail?: object }>, seenHeading: string|null, seenBody: string }}
 */
export function auditIntelReportEvidenceHonesty({
  store,
  markdown,
  forbiddenInSeen = [],
  minSeenBulletsWithRefs = 1,
} = {}) {
  const findings = [];
  const { heading: seenHeading, body: seenBody } = extractSeenSectionBody(markdown);

  if (!seenHeading || !seenBody.trim()) {
    findings.push({
      rule: 'seen_section_missing',
      message: 'Seen/Evidence/本轮看到 section missing or empty',
    });
    return { findings, seenHeading, seenBody };
  }

  for (const phrase of forbiddenInSeen || []) {
    if (phrase && seenBody.includes(String(phrase))) {
      findings.push({
        rule: 'seen_contains_forbidden_intent',
        message: `Seen section contains forbidden intent phrase: ${phrase}`,
        detail: { phrase: String(phrase) },
      });
    }
  }

  const bullets = splitBullets(seenBody);
  if (bullets.length < minSeenBulletsWithRefs) {
    findings.push({
      rule: 'seen_insufficient_bullets',
      message: `Seen section needs at least ${minSeenBulletsWithRefs} evidence bullet(s), found ${bullets.length}`,
      detail: { count: bullets.length, minSeenBulletsWithRefs },
    });
  }

  for (const bullet of bullets) {
    const refs = extractBracketRefs(bullet);
    if (!refs.length) {
      findings.push({
        rule: 'seen_bullet_missing_ref',
        message: `Seen bullet missing typed ref: ${bullet.slice(0, 160)}`,
        detail: { bullet },
      });
      continue;
    }
    for (const ref of refs) {
      const { supported, found } = recordExists(store, ref.sourceType, ref.sourceId);
      if (!supported) {
        findings.push({
          rule: 'seen_unknown_source_type',
          message: `Unsupported source type in Seen ref: ${ref.raw}`,
          detail: ref,
        });
        continue;
      }
      if (!found) {
        findings.push({
          rule: 'seen_dangling_ref',
          message: `Seen citation not found in store: ${ref.raw}`,
          detail: ref,
        });
      }
    }
  }

  return { findings, seenHeading, seenBody };
}

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
