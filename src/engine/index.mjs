/**
 * JEA engine facade — vendored OADA runtime under ./engine.mjs, ./pipelines/, etc.
 *
 * Host code should import from here, not from deep paths under src/engine/.
 */

export { EvolutionEngine, AutoEvolutionEngine, ActionExecutor, verifyActions } from './engine.mjs';
export { IntelligencePipeline } from './pipelines/intel.mjs';
export { ExecutionPipeline } from './pipelines/exec.mjs';
export { VerifyPipeline } from './pipelines/verify.mjs';

export { NULL_HOST, normalizeHost } from './core/host.mjs';
export { isoBeijing, todayBeijing, nowBeijing, nowBeijingStr } from './core/time.mjs';

export { BaseAIClient, MockAIClient, AIError } from './ai/ai-client.mjs';
export { PromptBuilder, promptBuilder } from './ai/prompt-builder.mjs';

export {
  ACTION_REGISTRY, ActionTypeRegistry, ActionTypeSpec,
} from './decide/action-registry.mjs';
export {
  OBSERVATION_REGISTRY, ObservationSourceRegistry, ObservationSourceSpec,
} from './observe/observation-registry.mjs';
export { QueryResolver, ResolvedPlan } from './observe/query-resolver.mjs';
export { scanProjectStructure } from './observe/project-scanner.mjs';
export { AIDrivenObserver } from './observe/ai-driven-observer.mjs';

export {
  DecisionQueue,
  decisionFingerprint,
  STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED, STATUS_EXPIRED,
} from './decide/decision-queue.mjs';
export { FeatureRequest, FeatureRequestQueue } from './decide/feature-request.mjs';
export { GoalProvider } from './decide/goal-provider.mjs';

export { SelfAnalyzer } from './analyze/analyzer.mjs';
export { SelfModifier } from './act/modifier.mjs';

export { HumanGuidanceReader } from './adapters/human-guidance.mjs';
export { EvolutionLogger } from './adapters/evolution-logger.mjs';

export {
  GitHubIssueManager, IssueResult, OADA_LABEL_DEFS, ACTION_TYPE_TO_LABEL, buildOadaLabelDefs,
} from './github/issues.mjs';
