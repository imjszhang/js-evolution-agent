/**
 * JEA engine facade — vendored OADA runtime under ./engine.mjs, ./pipelines/, etc.
 *
 * Host code should import from here, not from deep paths under src/engine/.
 */

export { EvolutionEngine, ActionExecutor, verifyActions } from './engine.mjs';
export {
  ExecutionPipeline,
  parseExecAgentBudgetFromEnv,
  parseExecLimitFromEnv,
} from './pipelines/exec.mjs';
export {
  classifyAgentRunScope,
  computeAgentWaveWidth,
  isExclusiveAgentDecision,
  isParallelAgentDecision,
  WRITE_PERMISSION_PROFILES,
} from './act/scope.mjs';

export { NULL_HOST, normalizeHost } from './core/host.mjs';
export {
  isoBeijing,
  nowBeijing,
  nowBeijingStr,
  getCurrentTimeSnapshot,
  formatCurrentTimePromptBlock,
} from './core/time.mjs';

export { BaseAIClient, MockAIClient, AIError } from './ai/ai-client.mjs';

export {
  ACTION_REGISTRY, ActionTypeRegistry, ActionTypeSpec,
} from './decide/action-registry.mjs';
export { AIDrivenObserver } from './observe/ai-driven-observer.mjs';

export {
  DecisionQueue,
  decisionFingerprint,
  decisionIdSequence,
  compareDecisionsForClaim,
  parseAgentMaxAttemptsFromEnv,
  parsePendingTtlCyclesFromEnv,
  parseBlockedTtlCyclesFromEnv,
  parseQueueWallclockTtlDaysFromEnv,
  STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED, STATUS_EXPIRED,
  STATUS_BLOCKED, STATUS_RETIRED,
} from './decide/decision-queue.mjs';
export { GoalProvider } from './decide/goal-provider.mjs';

export { HumanGuidanceReader } from './adapters/human-guidance.mjs';
export { EvolutionLogger } from './adapters/evolution-logger.mjs';
