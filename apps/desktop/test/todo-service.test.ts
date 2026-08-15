import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPendingCycleStartRequest } from '../../../src/daemon/cycle-start-requests.mjs'
import { runtimeForSubject } from '../../../src/infra/runtime-paths.mjs'
import { createIntelligenceStore } from '../../../src/intelligence/store.mjs'
import {
  openOperatorQuestion,
  readResolvedOperatorQuestions
} from '../../../src/intelligence/operator-questions.mjs'
import {
  activeGoalsPathForRuntime,
  applyActiveGoalState
} from '../../../src/intelligence/goal-state.mjs'
import { OpsService } from '../src/main/operations'
import { TodoService } from '../src/main/todo-service'

const SUBJECT = 'alpha'
const SECRET = 'sk-roundtrip-secret-1234567890'

let projectRoot: string | null = null

afterEach(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
  projectRoot = null
})

function makeService() {
  projectRoot = mkdtempSync(join(tmpdir(), 'jea-desktop-todo-'))
  const subjectsDir = join(projectRoot, 'runtime', 'subjects')
  mkdirSync(subjectsDir, { recursive: true })
  writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
    default_subject: SUBJECT,
    subjects: {
      [SUBJECT]: {
        policy: 'SUBJECT.md',
        data_namespace: 'alpha-runtime'
      }
    }
  }))

  const ops = new OpsService(projectRoot, {
    daemon: (_root, subject) => ({ subject }),
    observability: ({ subject }) => ({
      subject,
      attention: {
        item_count: 1,
        password: SECRET
      }
    })
  }, () => join(projectRoot!, '.env'))

  return {
    service: new TodoService(projectRoot, ops),
    runtime: runtimeForSubject(projectRoot, SUBJECT)
  }
}

function expectPublicResponse(response: unknown, root: string) {
  const serialized = JSON.stringify(response)
  expect(serialized).not.toContain('"_file"')
  expect(serialized).not.toContain(root)
  expect(serialized).not.toContain(SECRET)
}

describe('TodoService round trip', () => {
  it('persists operator inputs and goals without exposing internals or creating decision memory', () => {
    const { service, runtime } = makeService()
    const { question: seededQuestion } = openOperatorQuestion(runtime.runtimeRoot, {
      id: 'question-round-trip',
      question: `Confirm the desktop flow without exposing ${SECRET}?`,
      cycle_id: 'cycle-seed'
    })

    const initial = service.get(SUBJECT)
    expect(initial).toMatchObject({
      subject: SUBJECT,
      questions: [{
        id: seededQuestion.id,
        question: 'Confirm the desktop flow without exposing [REDACTED_SECRET]?'
      }],
      briefs: [],
      facts: [],
      goals: null,
      pending_cycle_request: null,
      attention: {
        item_count: 1,
        password: '[REDACTED_SECRET]'
      }
    })

    const briefResult = service.putBrief(SUBJECT, {
      id: 'brief-round-trip',
      summary: 'Inspect the next desktop cycle',
      created_by: 'forged-system',
      consumed_by_cycle: 'forged-cycle',
      metadata: { api_key: SECRET }
    })
    expect(briefResult).toMatchObject({
      subject: SUBJECT,
      brief: {
        id: 'brief-round-trip',
        summary: 'Inspect the next desktop cycle',
        created_by: 'desktop_operator',
        producer: 'desktop',
        metadata: { api_key: '[REDACTED_SECRET]' }
      },
      cycle_start_request: {
        reasons: ['operator_brief'],
        meta: { brief_ids: ['brief-round-trip'] }
      },
      wake: {
        kind: 'cognitive',
        reason: 'operator_brief',
        status: 'pending'
      }
    })

    const afterBrief = service.get(SUBJECT)
    expect(afterBrief.briefs).toHaveLength(1)
    expect(afterBrief.briefs[0]).toMatchObject({
      id: 'brief-round-trip',
      summary: 'Inspect the next desktop cycle'
    })
    expect(afterBrief.pending_cycle_request?.reasons).toEqual(['operator_brief'])

    const factResult = service.putFact(SUBJECT, {
      id: 'fact-round-trip',
      subject: 'forged-other-subject',
      content: `Desktop facts are one-shot seeds; token ${SECRET}`,
      confidence: 'low',
      created_by: 'forged-system',
      injected_by_cycle: 'forged-cycle',
      digestion_outcome: 'supported'
    })
    expect(factResult).toMatchObject({
      subject: SUBJECT,
      fact: {
        id: 'fact-round-trip',
        subject: SUBJECT,
        content: 'Desktop facts are one-shot seeds; token [REDACTED_SECRET]',
        confidence: 'high',
        created_by: 'desktop_operator',
        producer: 'desktop',
        injected_by_cycle: null,
        digestion_outcome: null
      },
      cycle_start_request: {
        reasons: ['operator_brief', 'operator_fact'],
        meta: {
          brief_ids: ['brief-round-trip'],
          fact_ids: ['fact-round-trip']
        }
      },
      wake: {
        kind: 'cognitive',
        reason: 'operator_fact',
        status: 'pending'
      }
    })

    const afterFact = service.get(SUBJECT)
    expect(afterFact.facts).toHaveLength(1)
    expect(afterFact.facts[0]).toMatchObject({
      id: 'fact-round-trip',
      subject: SUBJECT,
      content: 'Desktop facts are one-shot seeds; token [REDACTED_SECRET]'
    })
    expect(readPendingCycleStartRequest(projectRoot!, SUBJECT)).toMatchObject({
      reasons: ['operator_brief', 'operator_fact'],
      meta: {
        brief_ids: ['brief-round-trip'],
        fact_ids: ['fact-round-trip']
      }
    })

    const cycleResult = service.requestCycle(SUBJECT, `operator note ${SECRET}`)
    expect(cycleResult).toMatchObject({
      subject: SUBJECT,
      cycle_start_request: {
        reasons: ['operator_brief', 'operator_fact', 'desktop_operator'],
        meta: {
          note: 'operator note [REDACTED_SECRET]'
        }
      },
      wake: {
        kind: 'cognitive',
        reason: 'desktop_operator',
        status: 'pending'
      }
    })

    const resolved = service.resolveQuestion(
      SUBJECT,
      seededQuestion.id,
      `acknowledged with ${SECRET}`
    )
    expect(resolved).toMatchObject({
      subject: SUBJECT,
      question: {
        id: seededQuestion.id,
        resolution: 'acknowledged',
        resolved_by: 'desktop_operator',
        resolution_note: 'acknowledged with [REDACTED_SECRET]'
      }
    })
    expect(service.get(SUBJECT).questions).toEqual([])
    expect(readResolvedOperatorQuestions(runtime.runtimeRoot).questions).toHaveLength(1)

    const goals = {
      id: 'desktop-round-trip',
      name: 'Desktop round trip',
      intent: 'Keep operator state consistent',
      good_signal: 'All TodoService state can be read back',
      bad_signal: 'An operator mutation is missing',
      children: []
    }
    const goalsResult = service.updateGoals(
      SUBJECT,
      goals,
      `operator update ${SECRET}`,
      [{ source_type: 'operator_briefs', id: 'brief-round-trip' }],
      'cycle-round-trip'
    )
    expect(goalsResult).toMatchObject({
      subject: SUBJECT,
      goals,
      event: {
        type: 'updated',
        goal_id: 'desktop-round-trip',
        reason: 'operator update [REDACTED_SECRET]',
        evidence_refs: [{ source_type: 'operator_briefs', id: 'brief-round-trip' }],
        cycle_id: 'cycle-round-trip'
      },
      written: 1
    })
    expect(goalsResult.event).not.toHaveProperty('next_goal')
    expect(goalsResult.event).not.toHaveProperty('previous_goal')
    expect(service.get(SUBJECT).goals).toEqual(goals)

    const goalEvents = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai'
    }).readGoalEvents({ limit: 10 })
    expect(goalEvents).toHaveLength(1)
    expect(goalEvents[0]).toMatchObject({
      type: 'updated',
      goal_id: 'desktop-round-trip',
      next_goal: goals,
      reason: 'operator update [REDACTED_SECRET]',
      cycle_id: 'cycle-round-trip'
    })

    for (const response of [
      initial,
      briefResult,
      afterBrief,
      factResult,
      afterFact,
      cycleResult,
      resolved,
      goalsResult,
      service.get(SUBJECT)
    ]) {
      expectPublicResponse(response, projectRoot!)
    }

    expect(existsSync(join(
      runtime.runtimeRoot,
      'data',
      'evolution',
      'pending_decisions.json'
    ))).toBe(false)
    expect(existsSync(join(
      runtime.runtimeRoot,
      'data',
      'intelligence',
      'memory',
      'standing_memory.json'
    ))).toBe(false)
  })

  it('rolls back an active-goal write when its audit event fails', () => {
    const { runtime } = makeService()
    const goals = {
      id: 'rollback-goal',
      name: 'Rollback goal',
      intent: 'Keep goal state and audit state atomic',
      good_signal: 'Both writes succeed',
      bad_signal: 'Only one write succeeds',
      children: []
    }

    expect(() => applyActiveGoalState(runtime, goals, {
      reason: 'failure injection',
      store: {
        recordGoalEvent() {
          throw new Error('injected audit failure')
        }
      }
    })).toThrow('injected audit failure')
    expect(existsSync(activeGoalsPathForRuntime(runtime.runtimeRoot))).toBe(false)
  })
})
