export function sanitizeFeishuError(error, config = {}) {
  let message = error?.message || String(error);
  for (const secret of [
    config.appSecret,
    config.bindToken,
    config.encryptKey,
    config.verificationToken,
  ]) {
    if (secret) message = message.replaceAll(String(secret), '[REDACTED]');
  }
  return message
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, 'Authorization: [REDACTED]')
    .replace(/(app[_-]?secret|bind[_-]?token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}
