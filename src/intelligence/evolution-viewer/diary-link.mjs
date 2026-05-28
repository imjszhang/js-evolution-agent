const INTEL_CYCLE_PATTERNS = [
  /intel\s+(cycle-[a-zA-Z0-9-]+)/i,
  /情报阶段[（(]\s*(cycle-[a-zA-Z0-9-]+)/i,
  /情报基准\s*\**\s*[:：]\s*\*?\s*(cycle-[a-zA-Z0-9-]+)/i,
  /情报周期\s*[`'"]?\s*(cycle-[a-zA-Z0-9-]+)/i,
  /基于\s+intel\s+(cycle-[a-zA-Z0-9-]+)/i,
];

const DIARY_ID_FROM_NAME_RE = /^(exec-|cycle-)([a-zA-Z0-9-]+)\.md$/i;

/**
 * Extract linked intel cycle_id from diary markdown (typically in the opening section).
 * @param {string} text
 * @returns {string|null}
 */
export function parseIntelCycleIdFromDiary(text) {
  const body = String(text ?? '');
  for (const re of INTEL_CYCLE_PATTERNS) {
    const match = body.match(re);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * @param {string} fileName
 * @returns {string|null} exec- or cycle- id from diary filename
 */
export function diaryIdFromFileName(fileName) {
  const base = String(fileName ?? '').split(/[/\\]/).pop() ?? '';
  const match = base.match(DIARY_ID_FROM_NAME_RE);
  if (!match) return null;
  const prefix = match[1].startsWith('exec') ? 'exec-' : 'cycle-';
  return `${prefix}${match[2]}`;
}

/** @deprecated use diaryIdFromFileName */
export function execIdFromDiaryFileName(fileName) {
  const id = diaryIdFromFileName(fileName);
  return id?.startsWith('exec-') ? id : null;
}
