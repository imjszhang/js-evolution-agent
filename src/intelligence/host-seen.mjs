/**
 * Host-assembled Seen for Intel reports (phases + agent_loop).
 * Mechanical facts belong to the host; models write judgement sections only.
 */
import { buildMachineContextSeenBullets } from './machine-context-refs.mjs';
import { enforceIntelReportSeenGate } from './report-builder.mjs';
import {
  auditIntelReportEvidenceHonesty,
  extractBracketRefs,
  normalizeSourceType,
  sanitizeCitationGlyphs,
} from './report-honesty.mjs';

/**
 * Canonical ref key for host Seen dedupe (aliases collapse to store plural form).
 */
function canonicalRefKey(sourceType, sourceId) {
  const type = normalizeSourceType(sourceType);
  const id = String(sourceId || '').trim().toLowerCase();
  return `${type}:${id}`;
}

function refsToCanonicalKeys(text) {
  return extractBracketRefs(text).map((r) => canonicalRefKey(r.sourceType, r.sourceId));
}

function forbiddenPhrasesFromBriefs(operatorBriefs = []) {
  const phrases = [];
  for (const brief of Array.isArray(operatorBriefs) ? operatorBriefs : []) {
    const summary = String(brief?.summary || '').trim();
    if (summary) phrases.push(summary);
  }
  return phrases;
}

/**
 * Assemble host-owned Seen body:
 * machine_context bullets + mechanical Seen + verified_facts (deduped by normalized ref).
 */
export function assembleHostSeenBody({
  reportContext = null,
  queueSummary = null,
  operatorBriefs = [],
  mechanicalSeen = '',
  verifiedFacts = [],
} = {}) {
  const mcBody = buildMachineContextSeenBullets({
    reportContext,
    queueSummary,
    operatorBriefs,
  });
  const mechBody = String(mechanicalSeen || '').trim();
  const existingRefs = new Set([
    ...refsToCanonicalKeys(mcBody),
    ...refsToCanonicalKeys(mechBody),
  ]);
  const verifiedBullets = [];
  for (const fact of Array.isArray(verifiedFacts) ? verifiedFacts : []) {
    const ref = String(fact?.ref || '').trim();
    const statement = String(fact?.statement || '').trim();
    if (!ref || !statement) continue;
    const parsed = extractBracketRefs(ref)[0]
      || (() => {
        const bare = ref.replace(/^\[|\]$/g, '');
        const m = /^([a-z0-9_]+)\s*:\s*(.+)$/i.exec(bare);
        return m ? { sourceType: m[1], sourceId: m[2].trim() } : null;
      })();
    if (!parsed) continue;
    const key = canonicalRefKey(parsed.sourceType, parsed.sourceId);
    if (existingRefs.has(key)) continue;
    existingRefs.add(key);
    verifiedBullets.push(`- ${ref}: ${statement}`);
  }
  return [mcBody, mechBody, verifiedBullets.join('\n')]
    .filter((part) => part && part !== '(none)')
    .join('\n\n')
    .trim() || '- (none)';
}

/**
 * Pure Seen splice (sanitize + host gate). Used as persistIntelReport transformMd.
 */
export function spliceHostSeen(markdown, hostSeenBody) {
  let md = sanitizeCitationGlyphs(String(markdown || ''));
  md = enforceIntelReportSeenGate(md, hostSeenBody);
  return md.endsWith('\n') ? md : `${md}\n`;
}

/**
 * Post-persist honesty audit on the final (redacted) report.
 * @param {{ eventType?: string }} opts eventType defaults to intel_report_honesty
 */
export function auditHostSeenReport({
  markdown,
  store = null,
  operatorBriefs = [],
  emitEvent = null,
  logger = null,
  eventType = 'intel_report_honesty',
  logLabel = 'host_seen',
  runtimeRoot = null,
} = {}) {
  if (!store) return;
  try {
    const honesty = auditIntelReportEvidenceHonesty({
      store,
      markdown: String(markdown || ''),
      forbiddenInSeen: forbiddenPhrasesFromBriefs(operatorBriefs),
      minSeenBulletsWithRefs: 1,
      runtimeRoot,
    });
    if (honesty.findings.length) {
      logger?.warning?.(
        `[${logLabel}] report honesty findings after host Seen splice: ${JSON.stringify(honesty.findings)}`,
      );
    }
    emitEvent?.({
      type: eventType,
      status: honesty.findings.length ? 'findings' : 'ok',
      findings_count: honesty.findings.length,
      findings: honesty.findings.slice(0, 20),
    });
  } catch (e) {
    logger?.warning?.(`[${logLabel}] report honesty audit failed: ${e?.message || e}`);
  }
}

/** @deprecated Prefer assembleHostSeenBody */
export const assembleAgentLoopHostSeenBody = assembleHostSeenBody;
/** @deprecated Prefer spliceHostSeen */
export const spliceAgentLoopSeen = spliceHostSeen;
