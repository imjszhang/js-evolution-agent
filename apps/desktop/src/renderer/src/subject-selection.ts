import type { SubjectSnapshot, SubjectSummary } from '../../shared/contract'

export const OVERVIEW_SELECTION = 'overview'

export function defaultSubjectSelection(subjects: SubjectSummary[]): string {
  return subjects.find((subject) => subject.isDefault)?.name
    ?? subjects[0]?.name
    ?? OVERVIEW_SELECTION
}

export function snapshotsForSelection(
  snapshots: SubjectSnapshot[],
  selection: string
): SubjectSnapshot[] {
  if (selection === OVERVIEW_SELECTION) return snapshots
  return snapshots.filter((snapshot) => snapshot.subject.name === selection)
}
