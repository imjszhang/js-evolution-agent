import { describe, expect, it } from 'vitest';
import {
  channelWorkOnce,
  enqueueDaemonTask,
  runChannelDomainWorker,
  runDaemonDomains,
  runDaemonWorker,
  workOnce,
} from '../src/daemon/index.mjs';

describe('daemon domain facade', () => {
  it('exports worker and step runner entrypoints outside cli edge', () => {
    expect(typeof enqueueDaemonTask).toBe('function');
    expect(typeof workOnce).toBe('function');
    expect(typeof channelWorkOnce).toBe('function');
    expect(typeof runDaemonWorker).toBe('function');
    expect(typeof runChannelDomainWorker).toBe('function');
    expect(typeof runDaemonDomains).toBe('function');
  });
});
