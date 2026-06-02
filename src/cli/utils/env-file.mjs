import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquoteEnvValue(raw) {
  const trimmed = String(raw ?? '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function quoteEnvValue(value) {
  const text = String(value ?? '');
  if (/[\s#"'\\]/.test(text) || text.includes('=')) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return text;
}

export function maskSecret(value, visible = 4) {
  if (!value) return '';
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(4, value.length - visible))}${value.slice(-visible)}`;
}

/**
 * Upsert env keys in a .env file while preserving unrelated lines and comments.
 * @param {string} envPath
 * @param {Record<string, string>} updates
 * @param {{ force?: boolean }} [options]
 */
export function upsertEnvFile(envPath, updates, { force = false } = {}) {
  const content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const lines = content.length ? content.split(/\r?\n/) : [];
  const conflicts = [];

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^(\\s*(?:export\\s+)?)(${escapeRegex(key)})\\s*=\\s*(.*)$`);
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(regex);
      if (!match) continue;
      const existingValue = unquoteEnvValue(match[3]);
      if (existingValue !== value && !force) {
        conflicts.push({ key, existing: existingValue });
        replaced = true;
        break;
      }
      lines[i] = `${match[1]}${key}=${quoteEnvValue(value)}`;
      replaced = true;
      break;
    }
    if (!replaced && !conflicts.some((item) => item.key === key)) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  if (conflicts.length) {
    const err = new Error(
      `Refusing to overwrite existing env keys: ${conflicts.map((item) => item.key).join(', ')}. Use --force.`,
    );
    err.code = 'env_conflict';
    err.conflicts = conflicts;
    throw err;
  }

  let next = lines.join('\n');
  if (next && !next.endsWith('\n')) next += '\n';
  writeFileSync(envPath, next, 'utf-8');
  return { path: envPath, updated: Object.keys(updates) };
}

export function formatEnvBlock(updates) {
  return Object.entries(updates)
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join('\n');
}
