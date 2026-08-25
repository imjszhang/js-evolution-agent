import type { LlmBudgetReadinessView } from './client-types'

export function isLlmBudgetBlocker(blocker?: string | null): boolean {
  return blocker === 'rule_llm_budget_exhausted'
    || blocker === 'llm_token_budget_exhausted'
    || blocker === 'llm_spend_budget_exhausted'
}

export function formatLlmBudgetUsage(budget: LlmBudgetReadinessView): string {
  return `${budget.used_tokens}/${budget.token_budget} tokens remaining ${budget.remaining_tokens}`
    + `; $${budget.used_spend_usd}/$${budget.spend_budget_usd} remaining $${budget.remaining_spend_usd}`
}

export function formatLlmBudgetBlocker(
  blocker: string | null | undefined,
  budget: LlmBudgetReadinessView | null | undefined,
): string | null {
  const code = blocker ?? (budget?.state === 'exhausted' ? budget.blocked_reason ?? 'rule_llm_budget_exhausted' : null)
  if (!code && !budget) return null
  if (!budget) return code
  const admission = budget.cycle_admission === 'parked' ? 'cycle parked' : 'cycle open'
  return `${code ?? budget.state} · ${formatLlmBudgetUsage(budget)} · period ${budget.period_id} · ${admission}`
}
