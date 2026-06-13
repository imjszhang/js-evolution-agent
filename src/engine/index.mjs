/**
 * Local engine facade.
 *
 * Phase 5 migrates host code to this boundary first; implementation can then
 * be vendored or replaced without touching domain modules.
 */
export {
  AIError,
  AIDrivenObserver,
  ActionTypeRegistry,
  ActionTypeSpec,
  BaseAIClient,
  EvolutionEngine,
  ExecutionPipeline,
  MockAIClient,
  isoBeijing,
  verifyActions,
} from 'js-evolution-engine';
