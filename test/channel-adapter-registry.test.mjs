import { describe, expect, it } from 'vitest';
import {
  defaultInboundAdapter,
  resolveInboundAdapter,
} from '../src/channel/inbound-adapters/registry.mjs';
import {
  ensureChannelListener,
  getChannelListenerStatus,
  stopChannelListener,
} from '../src/channel/listener.mjs';

describe('channel inbound adapter registry', () => {
  it('resolves the default feishu adapter behind a transport-neutral interface', () => {
    const adapter = defaultInboundAdapter();
    expect(adapter).toBe(resolveInboundAdapter('feishu'));
    expect(adapter.id).toBe('feishu');
    expect(typeof adapter.normalizeInboundPayload).toBe('function');
    expect(typeof adapter.resolveConfig).toBe('function');
    expect(typeof adapter.tryHandleBind).toBe('function');
  });

  it('exposes transport-neutral listener lifecycle functions', () => {
    expect(typeof ensureChannelListener).toBe('function');
    expect(typeof getChannelListenerStatus).toBe('function');
    expect(typeof stopChannelListener).toBe('function');
  });
});
