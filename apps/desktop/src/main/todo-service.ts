import { rmSync } from 'node:fs'
import { readActiveGoalState, applyActiveGoalState } from '../../../../src/intelligence/goal-state.mjs'
import {
  readPendingOperatorBriefs,
  writePendingOperatorBrief
} from '../../../../src/intelligence/operator-briefs.mjs'
import {
  readPendingOperatorFacts,
  writePendingOperatorFact
} from '../../../../src/intelligence/operator-facts.mjs'
import {
  readPendingOperatorQuestions,
  resolveOperatorQuestion
} from '../../../../src/intelligence/operator-questions.mjs'
import { redactSecrets } from '../../../../src/intelligence/redaction.mjs'
import {
  enqueueCognitiveWake,
  enqueueCycleStartRequestWithEvent
} from '../../../../src/daemon/cycle-dispatch.mjs'
import {
  readPendingCycleStartRequest,
  summarizePendingCycleStartRequest
} from '../../../../src/daemon/cycle-start-requests.mjs'
import { listRegisteredSubjects } from '../../../../src/infra/subjects.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { createRuntimeContext } from '../../../../src/infra/jea-home.mjs'
import type { TodoSnapshot } from '../shared/contract'
import { PublicCommandError } from './command-registry'
import type { OpsService } from './operations'

function publicRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map((record) => {
    const { _file: _ignored, ...rest } = record
    return redactSecrets(rest) as Record<string, unknown>
  })
}

function publicWake(wake: any): Record<string, unknown> | null {
  if (!wake) return null
  return {
    id: wake.intent_id ?? wake.id ?? null,
    kind: wake.kind ?? null,
    reason: wake.reason ?? null,
    status: wake.status ?? null
  }
}

export class TodoService {
  private readonly runtimeContext: any

  constructor(
    readonly projectRoot: string,
    private readonly ops: OpsService,
    jeaHome: string | undefined = process.env.JEA_HOME
  ) {
    this.runtimeContext = jeaHome
      ? createRuntimeContext({ sourceRoot: projectRoot, jeaHome })
      : createRuntimeContext(projectRoot)
  }

  get(subject: string): TodoSnapshot {
    const runtime = this.runtime(subject)
    const questions = readPendingOperatorQuestions(runtime.runtimeRoot, { limit: 100 })
    const briefs = readPendingOperatorBriefs(runtime.runtimeRoot, { limit: 100 })
    const facts = readPendingOperatorFacts(runtime.runtimeRoot, { limit: 100 })
    const goalState = readActiveGoalState(runtime)
    const pending = summarizePendingCycleStartRequest(
      readPendingCycleStartRequest(this.runtimeContext, subject)
    )
    const attention = this.ops.getObservability(subject)?.attention ?? {}

    return redactSecrets({
      subject,
      questions: publicRecords(questions.questions),
      briefs: publicRecords(briefs.briefs),
      facts: publicRecords(facts.facts),
      goals: goalState.goals,
      pending_cycle_request: pending,
      attention
    }) as TodoSnapshot
  }

  putBrief(subject: string, brief: Record<string, unknown>): Record<string, unknown> {
    const runtime = this.runtime(subject)
    const { file, brief: written } = writePendingOperatorBrief(runtime.runtimeRoot, {
      ...brief,
      created_at: undefined,
      created_by: 'desktop_operator',
      producer: 'desktop',
      consumed_by_cycle: undefined,
      consumed_by_batch: undefined,
      consumed_at: undefined,
      outcome: undefined
    })
    let cycle
    try {
      cycle = enqueueCycleStartRequestWithEvent(this.runtimeContext, subject, {
        reason: 'operator_brief',
        meta: { brief_ids: [written.id] }
      })
    } catch (error) {
      rmSync(file, { force: true })
      throw error
    }
    let wake: any = null
    try {
      wake = enqueueCognitiveWake(this.runtimeContext, subject, {
        reason: 'operator_brief',
        source: 'desktop_todo'
      })
    } catch {
      // The durable cycle request remains sufficient to consume the brief.
    }
    return redactSecrets({
      subject,
      brief: written,
      cycle_start_request: cycle.request,
      wake: publicWake(wake?.intent)
    }) as Record<string, unknown>
  }

  putFact(subject: string, fact: Record<string, unknown>): Record<string, unknown> {
    const runtime = this.runtime(subject)
    const { file, fact: written } = writePendingOperatorFact(runtime.runtimeRoot, {
      ...fact,
      subject,
      source: 'operator',
      confidence: 'high',
      created_at: undefined,
      recorded_at: undefined,
      created_by: 'desktop_operator',
      producer: 'desktop',
      injected_by_cycle: null,
      injected_by_batch: null,
      activation_batch_id: null,
      injected_at: null,
      digested_by_cycle: null,
      digested_by_batch: null,
      digested_at: null,
      digestion_outcome: null,
      digestion_reason: null,
      resulting_belief_id: null,
      resulting_question_id: null
    })
    let cycle
    try {
      cycle = enqueueCycleStartRequestWithEvent(this.runtimeContext, subject, {
        reason: 'operator_fact',
        meta: { fact_ids: [written.id] }
      })
    } catch (error) {
      rmSync(file, { force: true })
      throw error
    }
    let wake: any = null
    try {
      wake = enqueueCognitiveWake(this.runtimeContext, subject, {
        reason: 'operator_fact',
        source: 'desktop_todo'
      })
    } catch {
      // The durable cycle request remains sufficient to consume the fact.
    }
    return redactSecrets({
      subject,
      fact: written,
      cycle_start_request: cycle.request,
      wake: publicWake(wake?.intent)
    }) as Record<string, unknown>
  }

  resolveQuestion(subject: string, questionId: string, note?: string): Record<string, unknown> {
    const runtime = this.runtime(subject)
    const result = resolveOperatorQuestion(runtime.runtimeRoot, questionId, {
      resolution: 'acknowledged',
      resolvedBy: 'desktop_operator',
      note: note?.trim() || null
    })
    const { _file: _ignored, ...question } = result.question
    return redactSecrets({ subject, question }) as Record<string, unknown>
  }

  requestCycle(subject: string, note?: string): Record<string, unknown> {
    this.runtime(subject)
    const result = enqueueCycleStartRequestWithEvent(this.runtimeContext, subject, {
      reason: 'desktop_operator',
      meta: note?.trim() ? { note: note.trim() } : {}
    })
    let wake: any = null
    try {
      wake = enqueueCognitiveWake(this.runtimeContext, subject, {
        reason: 'desktop_operator',
        source: 'desktop_todo'
      })
    } catch {
      // The cycle request itself is durable; wake dispatch is best-effort.
    }
    return redactSecrets({
      subject,
      cycle_start_request: result.request,
      wake: publicWake(wake?.intent)
    }) as Record<string, unknown>
  }

  updateGoals(
    subject: string,
    goals: Record<string, unknown>,
    reason: string,
    evidenceRefs: Record<string, unknown>[] = [],
    cycle: string | null = null
  ): Record<string, unknown> {
    const runtime = this.runtime(subject)
    const result = applyActiveGoalState(runtime, goals, {
      reason,
      evidenceRefs,
      cycle
    })
    const {
      previous_goal: _previousGoal,
      next_goal: _nextGoal,
      ...publicEvent
    } = result.event
    return redactSecrets({
      subject,
      goals: result.nextGoal,
      event: publicEvent,
      written: result.written
    }) as Record<string, unknown>
  }

  private runtime(subject: string): ReturnType<typeof runtimeForSubject> {
    if (!subject || !listRegisteredSubjects(this.runtimeContext).includes(subject)) {
      throw new PublicCommandError('NOT_FOUND', 'Requested subject is unavailable.')
    }
    return runtimeForSubject(this.runtimeContext, subject)
  }
}
