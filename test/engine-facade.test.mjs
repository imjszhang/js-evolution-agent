import { describe, expect, it } from 'vitest';
import {
  AIDrivenObserver,
  ActionTypeRegistry,
  DecisionQueue,
  EvolutionEngine,
  ExecutionPipeline,
  MockAIClient,
  decisionFingerprint,
  isoBeijing,
  verifyActions,
} from '../src/engine/index.mjs';

describe('engine facade', () => {
  it('centralizes the currently used engine surface from vendored src', () => {
    expect(typeof AIDrivenObserver).toBe('function');
    expect(typeof ActionTypeRegistry).toBe('function');
    expect(typeof DecisionQueue).toBe('function');
    expect(typeof EvolutionEngine).toBe('function');
    expect(typeof ExecutionPipeline).toBe('function');
    expect(typeof MockAIClient).toBe('function');
    expect(typeof isoBeijing).toBe('function');
    expect(typeof verifyActions).toBe('function');
    expect(typeof decisionFingerprint).toBe('function');
  });
});
