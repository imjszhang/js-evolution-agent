let LarkModule = null;

async function loadLarkSdk() {
  if (LarkModule) return LarkModule;
  try {
    LarkModule = await import('@larksuiteoapi/node-sdk');
    return LarkModule;
  } catch (err) {
    const error = new Error(`@larksuiteoapi/node-sdk unavailable: ${err?.message || err}`);
    error.code = 'feishu_sdk_unavailable';
    throw error;
  }
}

function domainFor(Lark, domain) {
  if (domain === 'lark') return Lark.Domain?.Lark ?? Lark.Domain?.Lark;
  return Lark.Domain?.Feishu ?? Lark.Domain?.Feishu;
}

export class FeishuClient {
  constructor(config = {}) {
    this.config = {
      appId: '',
      appSecret: '',
      domain: 'feishu',
      encryptKey: '',
      verificationToken: '',
      ...config,
    };
    this._client = null;
    this._botInfo = null;
  }

  updateConfig(newConfig) {
    const needRecreate = newConfig.appId !== this.config.appId
      || newConfig.appSecret !== this.config.appSecret
      || newConfig.domain !== this.config.domain;
    this.config = { ...this.config, ...newConfig };
    if (needRecreate) {
      this._client = null;
      this._botInfo = null;
    }
  }

  async getLark() {
    return loadLarkSdk();
  }

  checkCredentials() {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu credentials not configured (appId, appSecret)');
    }
  }

  async getClient() {
    const Lark = await loadLarkSdk();
    this.checkCredentials();
    if (!this._client) {
      this._client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: Lark.AppType?.SelfBuild,
        domain: domainFor(Lark, this.config.domain),
      });
    }
    return this._client;
  }

  async createWSClient() {
    const Lark = await loadLarkSdk();
    this.checkCredentials();
    return new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: domainFor(Lark, this.config.domain),
      loggerLevel: Lark.LoggerLevel?.info,
    });
  }

  async createEventDispatcher() {
    const Lark = await loadLarkSdk();
    return new Lark.EventDispatcher({
      encryptKey: this.config.encryptKey || undefined,
      verificationToken: this.config.verificationToken || undefined,
    });
  }

  async probe() {
    try {
      const client = await this.getClient();
      let response;
      if (client?.application?.bot?.get) {
        response = await client.application.bot.get();
      } else if (client?.im?.bot?.get) {
        response = await client.im.bot.get();
      } else {
        response = await client.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (response.code !== 0) {
        return { ok: false, error: response.msg || `code ${response.code}` };
      }
      const botData = response.bot || response.data?.bot || response.data || {};
      this._botInfo = {
        appId: this.config.appId,
        botName: botData.app_name || '',
        botOpenId: botData.open_id || '',
      };
      return { ok: true, ...this._botInfo };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  getBotInfo() {
    return this._botInfo;
  }

  async getBotOpenId() {
    if (this._botInfo?.botOpenId) return this._botInfo.botOpenId;
    const probeResult = await this.probe();
    return probeResult.ok ? probeResult.botOpenId : undefined;
  }

  async sendText({ receiveId, receiveIdType, text }) {
    const client = await this.getClient();
    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
    if (response.code !== 0) {
      throw new Error(`Send failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id, success: true };
  }

  async replyText({ messageId, text }) {
    const client = await this.getClient();
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
    if (response.code !== 0) {
      throw new Error(`Reply failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id, success: true };
  }

  async sendCard({ receiveId, receiveIdType, card }) {
    const client = await this.getClient();
    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
    if (response.code !== 0) {
      throw new Error(`Send card failed: ${response.msg || `code ${response.code}`}`);
    }
    return { messageId: response.data?.message_id, success: true };
  }
}
