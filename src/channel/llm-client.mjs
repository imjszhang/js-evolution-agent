import { createLlmClient } from '../ai/gateway.mjs';
import { llmBudgetLedgerPath } from '../ai/token-budget.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { createIntelligenceStore } from '../intelligence/channel-api.mjs';

/**
 * Construct a real subject-scoped gateway. This is Channel cognition wiring,
 * not transport: the budget ledger and audit callback both target the same
 * subject runtime as the caller.
 */
export function createSubjectLlmClient(root, subject, options = {}) {
  const runtime = runtimeForSubject(root, subject);
  let store = null;
  return createLlmClient({
    ...options,
    subjectKey: runtime.subject,
    budgetLedgerPath: llmBudgetLedgerPath(runtime.runtimeRoot),
    onBudgetEvent: (event) => {
      store ??= createIntelligenceStore({
        baseDir: runtime.intelligenceDir,
        timezone: 'Asia/Shanghai',
      });
      store.recordEvolutionEvent(event);
      options.onBudgetEvent?.(event);
    },
  });
}
