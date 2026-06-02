import { parseFeishuMessageEvent } from './parser.mjs';

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
    this._wsClient = null;
    this._eventDispatcher = null;
    this._isRunning = false;
    this._botOpenId = null;
  }

  async start() {
    if (this._isRunning) return;
    if (!this.client) throw new Error('FeishuClient not initialized');
    this._botOpenId = await this.client.getBotOpenId();
    this._wsClient = await this.client.createWSClient();
    this._eventDispatcher = await this.client.createEventDispatcher();
    this._registerHandlers();
    this._wsClient.start({ eventDispatcher: this._eventDispatcher });
    this._isRunning = true;
    this.onConnectionChange({
      connected: true,
      botOpenId: this._botOpenId,
      botInfo: this.client.getBotInfo(),
    });
  }

  async stop() {
    this._isRunning = false;
    const wsClient = this._wsClient;
    this._wsClient = null;
    this._eventDispatcher = null;
    if (wsClient) {
      try {
        if (typeof wsClient.stop === 'function') await wsClient.stop();
        else if (typeof wsClient.close === 'function') await wsClient.close();
        else if (typeof wsClient.shutdown === 'function') await wsClient.shutdown();
      } catch (err) {
        console.error('[FeishuMonitor] stop error:', err?.message || err);
      }
    }
    this.onConnectionChange({ connected: false });
  }

  getStatus() {
    return {
      isRunning: this._isRunning,
      connected: this._isRunning && Boolean(this._wsClient),
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
          console.error('[FeishuMonitor] message handler error:', err?.message || err);
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
