export async function runReceiptVerifyLoop({
  attempts = 1,
  runAttempt,
  validate,
} = {}) {
  if (typeof runAttempt !== 'function') throw new Error('runReceiptVerifyLoop requires runAttempt');
  if (typeof validate !== 'function') throw new Error('runReceiptVerifyLoop requires validate');
  const max = Math.max(1, Number(attempts) || 1);
  const results = [];
  for (let index = 0; index < max; index += 1) {
    const result = await runAttempt({ attempt: index + 1, previous: results.at(-1) ?? null });
    const validation = validate(result);
    results.push({ result, validation });
    if (validation?.valid || validation?.ok) {
      return { ok: true, result, validation, attempts: results };
    }
  }
  const last = results.at(-1);
  return {
    ok: false,
    result: last?.result ?? null,
    validation: last?.validation ?? null,
    attempts: results,
  };
}
