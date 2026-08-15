import { describe, expect, it } from 'vitest'
import type { SubjectSnapshot } from '../src/shared/contract'
import {
  defaultSubjectSelection,
  OVERVIEW_SELECTION,
  snapshotsForSelection
} from '../src/renderer/src/subject-selection'

const snapshots: SubjectSnapshot[] = [
  {
    subject: { name: 'alpha', namespace: 'alpha-data', isDefault: false },
    daemon: {},
    observability: {}
  },
  {
    subject: { name: 'beta', namespace: 'beta-data', isDefault: true },
    daemon: {},
    observability: {}
  }
]

describe('subject switcher contract', () => {
  it('selects the registry default subject initially', () => {
    expect(defaultSubjectSelection(snapshots.map((snapshot) => snapshot.subject))).toBe('beta')
  })

  it('switches to one subject while retaining an all-subject overview', () => {
    expect(snapshotsForSelection(snapshots, 'alpha').map((item) => item.subject.name))
      .toEqual(['alpha'])
    expect(snapshotsForSelection(snapshots, 'beta').map((item) => item.subject.name))
      .toEqual(['beta'])
    expect(snapshotsForSelection(snapshots, OVERVIEW_SELECTION)).toEqual(snapshots)
  })
})
