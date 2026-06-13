function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldContinueLoop({ once = false, signal = null, iteration = 0 } = {}) {
  if (signal?.aborted) return false;
  if (once && iteration > 0) return false;
  return true;
}

export async function runDomainWorkerLoop({
  claim,
  execute,
  heartbeat = null,
  ticks = [],
  onIdle = null,
  onError = null,
  idleMs = 1000,
  once = false,
  signal = null,
} = {}) {
  if (typeof claim !== 'function') throw new Error('runDomainWorkerLoop requires claim');
  if (typeof execute !== 'function') throw new Error('runDomainWorkerLoop requires execute');
  const tickList = Array.isArray(ticks) ? ticks : [];
  let iteration = 0;
  let executed = 0;
  let lastTask = null;

  while (shouldContinueLoop({ once, signal, iteration })) {
    heartbeat?.({ iteration, executed });
    for (const tick of tickList) {
      await tick?.({ iteration, executed });
    }

    const task = await claim({ iteration, executed });
    if (task) {
      lastTask = task;
      await execute(task, { iteration, executed });
      executed += 1;
      iteration += 1;
      continue;
    }

    await onIdle?.({ iteration, executed });
    iteration += 1;
    if (once) break;
    if (idleMs > 0) await sleep(idleMs);
  }

  return { stopped: true, executed, lastTask };
}

export async function guardedDomainWorkerLoop(options = {}) {
  try {
    return await runDomainWorkerLoop(options);
  } catch (err) {
    await options.onError?.(err);
    throw err;
  }
}
