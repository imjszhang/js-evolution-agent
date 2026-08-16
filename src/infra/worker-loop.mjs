function sleep(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
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
  afterExecute = null,
  shouldStop = null,
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
    if (typeof shouldStop === 'function' && shouldStop({ iteration, executed })) break;
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
      const postDelay = typeof afterExecute === 'function'
        ? Number(await afterExecute(task, { iteration, executed })) || 0
        : 0;
      if (postDelay > 0) await sleep(postDelay, signal);
      continue;
    }

    await onIdle?.({ iteration, executed });
    iteration += 1;
    if (once) break;
    if (idleMs > 0) await sleep(idleMs, signal);
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
