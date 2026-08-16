import { parseFeishuMessageEvent } from './parser.mjs';
import { sanitizeFeishuError } from './errors.mjs';

/**
 * WebSocket monitor — transport only; delegates accepted messages via onMessage.
 */
export class FeishuMonitor {
  /**
   * @param {object} options
   * @param {import('./client.mjs').FeishuClient} options.client
   * @param {import('./policy.mjs').FeishuPolicy} options.policy
   * @param {(event: object) => Promise<void>|void} options.onMessage
   * @param {(state: object) => void} [options.onConnectionChange]
   */
  constructor(options = {}) {
    this.client = options.client;
    this.policy = options.policy;
    this.onMessage = options.onMessage;
    this.onConnectionChange = options.onConnectionChange ?? (() => {});
    this._lifecycleController = new AbortController();
    this.signal = this._lifecycleController.signal;
    this._parentSignal = options.signal ?? null;
    this._onParentAbort = () => {
      if (!this.signal.aborted) this._lifecycleController.abort(this._parentSignal?.reason);
    };
    if (this._parentSignal?.aborted) this._onParentAbort();
    else this._parentSignal?.addEventListener('abort', this._onParentAbort, { once: true });
    this._wsClient = null;
    this._eventDispatcher = null;
    this._isRunning = false;
    this._botOpenId = null;
    this._connectionState = 'stopped';
    this._generation = 0;
  }

  async start() {
    if (this._isRunning) return;
    if (!this.client) throw new Error('FeishuClient not initialized');
    const generation = ++this._generation;
    this._isRunning = true;
    this._connectionState = 'starting';
    this.onConnectionChange({ connected: false, state: 'starting' });
    this._botOpenId = await this.client.getBotOpenId({ signal: this.signal });
    const updateState = (state, error = null) => {
      if (!this._isRunning || generation !== this._generation) return;
      this._connectionState = state;
      this.onConnectionChange({
        connected: state === 'connected',
        state,
        error,
        botOpenId: this._botOpenId,
        botInfo: this.client.getBotInfo(),
      });
    };
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const onAbort = () => {
      const error = this.signal.reason instanceof Error
        ? this.signal.reason
        : new Error('Feishu listener start aborted');
      rejectReady(error);
    };
    this.signal.addEventListener('abort', onAbort, { once: true });
    this._wsClient = await this.client.createWSClient({
      signal: this.signal,
      onReady: () => {
        updateState('connected');
        resolveReady();
      },
      onError: (error) => {
        updateState('failed', error);
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      },
      onReconnecting: () => updateState('reconnecting'),
      onReconnected: () => updateState('connected'),
    });
    this._eventDispatcher = await this.client.createEventDispatcher();
    this._registerHandlers();
    try {
      await Promise.all([
        this._wsClient.start({ eventDispatcher: this._eventDispatcher }),
        ready,
      ]);
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  async stop() {
    this._generation += 1;
    this._isRunning = false;
    this._connectionState = 'stopped';
    if (!this.signal.aborted) this._lifecycleController.abort(new Error('Feishu listener stopped'));
    this._parentSignal?.removeEventListener('abort', this._onParentAbort);
    const wsClient = this._wsClient;
    this._wsClient = null;
    this._eventDispatcher = null;
    if (wsClient) {
      try {
        if (typeof wsClient.close === 'function') await wsClient.close({ force: true });
        else if (typeof wsClient.stop === 'function') await wsClient.stop();
        else if (typeof wsClient.shutdown === 'function') await wsClient.shutdown();
      } catch (err) {
        console.error('[FeishuMonitor] stop error:', sanitizeFeishuError(err, this.client?.config));
      }
    }
    this.onConnectionChange({ connected: false, state: 'stopped' });
  }

  getStatus() {
    return {
      isRunning: this._isRunning,
      connected: this._isRunning && this._connectionState === 'connected',
      state: this._connectionState,
      botOpenId: this._botOpenId,
    };
  }

  _registerHandlers() {
    if (!this._eventDispatcher?.register) return;
    this._eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        try {
          await this._handleMessageEvent(data);
        } catch (err) {
          console.error('[FeishuMonitor] message handler error:', sanitizeFeishuError(err, this.client?.config));
        }
      },
    });
  }

  async _handleMessageEvent(data) {
    const event = parseFeishuMessageEvent(data);
    if (!event.messageId || !event.chatId) return;
    if (this.policy) {
      const decision = this.policy.evaluateInbound(event, this._botOpenId);
      if (!decision.allowed) return;
    }
    if (this.onMessage) await this.onMessage(event);
  }
}
