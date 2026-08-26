import type { MessageKey } from '../../i18n/messages'
import type { ProductEvolutionIntent, ReactorFreshnessStatus, ReactorSchedulerState } from '../client-types'
import type { ReactorActionId } from '../reactor-progress'

export function schedulerStateMessageKey(
  state: ReactorSchedulerState | ProductEvolutionIntent | null | undefined
): MessageKey {
  switch (state) {
    case 'queued': return 'reactorQueued'
    case 'running': return 'reactorRunning'
    case 'catching_up': return 'evolutionCatchingUp'
    case 'paused_budget': return 'reactorPausedBudget'
    case 'waiting_approval': return 'evolutionWaitingApproval'
    case 'blocked': return 'evolutionBlocked'
    case 'stalled': return 'reactorStalled'
    case 'paused': return 'evolutionAutomaticPaused'
    case 'starting': return 'reactorStarting'
    default: return 'evolutionListening'
  }
}

export function freshnessMessageKey(status: ReactorFreshnessStatus | null | undefined): MessageKey {
  switch (status) {
    case 'fresh': return 'reactorFreshnessFresh'
    case 'stale': return 'reactorFreshnessStale'
    case 'reconciling': return 'reactorFreshnessReconciling'
    case 'degraded': return 'reactorFreshnessDegraded'
    default: return 'reactorFreshnessUnknown'
  }
}

export function actionLabelKey(id: ReactorActionId): MessageKey {
  switch (id) {
    case 'pause_automatic_evolution': return 'evolutionPause'
    case 'resume_automatic_evolution': return 'evolutionResume'
    case 'check_now': return 'evolutionCheckNow'
    case 'process_cycle_once': return 'evolutionProcessOnce'
    case 'start_worker': return 'evolutionStartCycle'
    case 'stop_worker': return 'reactorStopWorker'
    case 'start_replay_plan': return 'reactorStartReplayPlan'
    case 'raise_budget': return 'reactorRaiseBudget'
    case 'view_blocker': return 'evolutionViewBlocker'
    case 'open_desktop': return 'openDesktopRecovery'
    default: return 'evolutionViewBlocker'
  }
}

export function actionReasonKey(reason: string | null | undefined): MessageKey | null {
  switch (reason) {
    case 'local_only_open_desktop': return 'openDesktopRecovery'
    case 'stay_budget_paused': return 'reactorStayBudgetPaused'
    case 'cli_llm_budget_only': return 'evolutionBudgetRecover'
    case 'no_replay_plan_command': return 'reactorReplayPlanUnavailable'
    case 'no_replay_ready': return 'reactorReplayPlanUnavailable'
    case 'already_paused': return 'evolutionAutomaticPaused'
    default: return null
  }
}
