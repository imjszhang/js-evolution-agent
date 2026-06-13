import { describe, expect, it } from 'vitest';
import {
  subjectLane,
  subjectRegistry,
  subjectResources,
} from '../src/domain/subject/index.mjs';

describe('subject domain facades', () => {
  it('splits registry, resources, and lane entrypoints', () => {
    expect(typeof subjectRegistry.resolveSubjectConfig).toBe('function');
    expect(typeof subjectRegistry.runtimeInfoForSubject).toBe('function');
    expect(typeof subjectResources.buildSubjectResourceSummary).toBe('function');
    expect(typeof subjectResources.resolveSubjectPolicyPath).toBe('function');
    expect(typeof subjectLane.resolveSubjectRepoLane).toBe('function');
  });
});
