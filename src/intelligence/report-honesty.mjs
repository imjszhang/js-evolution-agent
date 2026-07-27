/**
 * Mechanical honesty audit for Intel report Seen/Evidence sections.
 * Used by production agent_loop splice path and by CI/live honesty tests.
 */
import { extractMarkdownSection } from '../cli/utils/markdown-sections.mjs';
import { MACHINE_CONTEXT_IDS } from './machine-context-refs.mjs';

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
  reports: 'intel_reports',
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
 * Parse and validate a typed ref string against store / machine_context enum.
 * Accepts `[type:id]` or bare `type:id`.
 * @returns {{ ok: boolean, sourceType: string|null, sourceId: string|null, reason: string|null, raw: string }}
 */
export function resolveTypedRef(store, refString) {
  const raw = String(refString || '').trim();
  if (!raw) {
    return { ok: false, sourceType: null, sourceId: null, reason: 'empty_ref', raw };
  }
  let candidate = raw;
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1).trim();
  }
  const match = /^([a-z0-9_]+)\s*:\s*(.+)$/i.exec(candidate);
  if (!match) {
    return { ok: false, sourceType: null, sourceId: null, reason: 'unparseable_ref', raw };
  }
  const sourceType = normalizeSourceType(match[1]);
  const sourceId = String(match[2] || '').trim();
  if (!sourceId) {
    return { ok: false, sourceType, sourceId: null, reason: 'empty_source_id', raw };
  }
  const { supported, found } = recordExists(store, sourceType, sourceId);
  if (!supported) {
    return { ok: false, sourceType, sourceId, reason: 'unknown_source_type', raw };
  }
  if (!found) {
    return { ok: false, sourceType, sourceId, reason: 'dangling_ref', raw };
  }
  return { ok: true, sourceType, sourceId, reason: null, raw: `[${sourceType}:${sourceId}]` };
}

/**
 * Normalize citation-shaped glyphs only (fullwidth brackets/colons, inner spaces).
 * Does not touch ordinary prose punctuation outside citation shapes.
 */
export function sanitizeCitationGlyphs(markdown) {
  let text = String(markdown || '');

  // Fullwidth square / corner brackets wrapping type:id (half or fullwidth colon).
  text = text.replace(
    /[［【]\s*([a-z0-9_]+)\s*[:：]\s*([^］】]+?)\s*[］】]/gi,
    (_, type, id) => `[${String(type).toLowerCase()}:${String(id).trim()}]`,
  );

  // Halfwidth brackets with fullwidth colon and/or inner whitespace.
  text = text.replace(
    /\[\s*([a-z0-9_]+)\s*[:：]\s*([^\]]+?)\s*\]/gi,
    (_, type, id) => `[${String(type).toLowerCase()}:${String(id).trim()}]`,
  );

  return text;
}

function codePointsOf(text) {
  return [...String(text || '')].map((ch) => {
    const cp = ch.codePointAt(0);
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

/**
 * Detect near-miss citation shapes that extractBracketRefs would miss
 * (fullwidth brackets/colons, spaced variants).
 */
export function detectNearMissCitations(bullet) {
  const text = String(bullet || '');
  const nearMiss = [];
  const patterns = [
    { kind: 'fullwidth_brackets', re: /[［【][^］】]+[］】]/g },
    { kind: 'fullwidth_colon_in_brackets', re: /\[[^\]]*：[^\]]*\]/g },
    { kind: 'spaced_ascii_brackets', re: /\[\s*[a-z0-9_]+\s*:\s*[^\]]+\]/gi },
  ];
  for (const { kind, re } of patterns) {
    let match;
    while ((match = re.exec(text)) != null) {
      nearMiss.push({
        kind,
        raw: match[0],
        code_points: codePointsOf(match[0]),
      });
    }
  }
  return nearMiss;
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
      const nearMiss = detectNearMissCitations(bullet);
      findings.push({
        rule: 'seen_bullet_missing_ref',
        message: `Seen bullet missing typed ref: ${bullet.slice(0, 160)}`,
        detail: {
          bullet,
          ...(nearMiss.length ? { near_miss: nearMiss } : {}),
        },
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

export {
  SEEN_HEADINGS,
  SUPPORTED_SOURCE_READERS,
  SOURCE_TYPE_ALIASES,
  normalizeSourceType,
};
