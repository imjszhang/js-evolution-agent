/**
 * Time helpers (Asia/Shanghai / UTC+8).
 *
 * Vendored as small primitives so the engine has no external time dependency.
 * Override the timezone via OADA_TZ env var if needed.
 */

const TZ = process.env.OADA_TZ || "Asia/Shanghai";

export function nowBeijing() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

export function todayBeijing() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

/**
 * @param {string} [fmt] strftime-like format string (%Y %m %d %H %M %S)
 * @returns {string}
 */
export function nowBeijingStr(fmt) {
  const d = nowBeijing();
  if (!fmt) {
    return `${todayBeijing()} ${d.toTimeString().slice(0, 8)}`;
  }
  return fmt
    .replace("%Y", String(d.getFullYear()))
    .replace("%m", String(d.getMonth() + 1).padStart(2, "0"))
    .replace("%d", String(d.getDate()).padStart(2, "0"))
    .replace("%H", String(d.getHours()).padStart(2, "0"))
    .replace("%M", String(d.getMinutes()).padStart(2, "0"))
    .replace("%S", String(d.getSeconds()).padStart(2, "0"));
}

/** @param {Date} [date] @returns {string} ISO 8601 string with +08:00 offset */
export function isoBeijing(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const offset = 8 * 60;
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + offset * 60000);
  return beijing.toISOString().replace('Z', '+08:00');
}

/**
 * Wall-clock snapshot for prompts / readonly tools (Asia/Shanghai by default).
 * @param {Date} [at]
 * @returns {{ timezone: string, beijing: string, iso: string, weekday: string, unix_ms: number }}
 */
export function getCurrentTimeSnapshot(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const beijing = date
    .toLocaleString('sv-SE', { timeZone: TZ, hour12: false })
    .replace('T', ' ')
    .slice(0, 19);
  const weekday = date.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
  return {
    timezone: TZ,
    beijing,
    iso: isoBeijing(date),
    weekday,
    unix_ms: date.getTime(),
  };
}

/**
 * Markdown body for ## Current Time (agent_loop dynamic payload).
 * @param {ReturnType<typeof getCurrentTimeSnapshot>|null} [snapshot]
 */
export function formatCurrentTimePromptBlock(snapshot = null) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : getCurrentTimeSnapshot();
  return [
    `Beijing time: ${s.beijing} (${s.weekday})`,
    `ISO: ${s.iso}`,
    `timezone: ${s.timezone}`,
  ].join('\n');
}
