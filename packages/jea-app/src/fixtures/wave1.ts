import type { FixtureSession, FixtureSubject, ServiceStatusKind, ShellAdapters } from '../slots/types'

export const WAVE1_SUBJECTS: FixtureSubject[] = [
  { id: 'alpha', name: 'alpha', namespace: 'alpha-data', isDefault: true },
  { id: 'beta', name: 'beta', namespace: 'beta-data' }
]

export const WAVE1_SESSIONS: FixtureSession[] = [
  { id: 'alpha-main', title: 'main', subjectId: 'alpha' },
  { id: 'alpha-review', title: 'review', subjectId: 'alpha' }
]

export function createWave1Adapters(overrides: Partial<ShellAdapters> = {}): ShellAdapters {
  return {
    subjects: WAVE1_SUBJECTS,
    sessions: WAVE1_SESSIONS,
    selectedSubjectId: 'alpha',
    selectedSessionId: 'alpha-main',
    serviceStatus: 'online' satisfies ServiceStatusKind,
    ...overrides
  }
}
