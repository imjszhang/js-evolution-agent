import { listPendingChannelEvents } from './event-queue.mjs';
import { runPresenceReactor, runChannelSpeechGenerationTask } from './presence-reactor.mjs';
import { resolvePresenceConfig } from './presence-config.mjs';
import { requestExpressionRecompute } from './wake.mjs';

/**
 * Subject presence loop entry (reactor task handler).
 */
export async function runChannelPresenceTask(root, subject, input = {}) {
  const presenceConfig = resolvePresenceConfig(root, subject);
  if (!presenceConfig.enabled) {
    return { skipped: true, reason: 'presence_disabled' };
  }

  const pending = listPendingChannelEvents(root, subject, { limit: 1 });
  if (!pending.length) {
    requestExpressionRecompute(root, subject, {
      reason: input.reason ?? 'direct_run',
      payload_summary: { tick_id: input.tick_id ?? null },
    });
  }

  const reactorResult = await runPresenceReactor(root, subject, {
    ...input,
    force: input.force ?? true,
    allow_empty_claim: true,
  });

  if (reactorResult.skipped || input.dry_run || input.skip_speech_generation) {
    return reactorResult;
  }

  const speechResult = await runChannelSpeechGenerationTask(root, subject, input);
  return { ...reactorResult, speech_generation: speechResult };
}

export { runChannelSpeechGenerationTask };
