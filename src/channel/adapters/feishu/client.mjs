import { randomUUID } from 'node:crypto';

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

function assertOk(response, action) {
  if (response?.code !== 0) {
    throw new Error(`${action} failed: ${response?.msg || `code ${response?.code}`}`);
  }
  return response;
}

function documentUrl(documentId, { domain = 'feishu', docBaseUrl = null } = {}) {
  if (docBaseUrl) {
    const base = String(docBaseUrl).trim();
    if (base.includes('{document_id}')) return base.replaceAll('{document_id}', documentId);
    if (base.includes('{doc_id}')) return base.replaceAll('{doc_id}', documentId);
    return `${base.replace(/\/+$/, '')}/docx/${documentId}`;
  }
  const host = domain === 'lark' ? 'https://www.larksuite.com' : 'https://www.feishu.cn';
  return `${host}/docx/${documentId}`;
}

function stripConvertedBlock(block = {}) {
  const {
    block_id: _blockId,
    parent_id: _parentId,
    children: _children,
    ...rest
  } = block;
  return rest;
}

function plainMarkdownBlock(markdown) {
  return {
    block_type: 2,
    text: {
      elements: [{
        text_run: {
          content: String(markdown ?? ''),
        },
      }],
    },
  };
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

  async createDocumentFromMarkdown({
    title,
    markdown,
    folderToken = null,
    docBaseUrl = null,
  } = {}) {
    const client = await this.getClient();
    const createResponse = assertOk(await client.docx.document.create({
      data: {
        title: String(title || 'Agent 交付物').slice(0, 200),
        folder_token: folderToken || undefined,
      },
    }), 'Create Feishu document');
    const document = createResponse.data?.document ?? {};
    const documentId = document.document_id;
    if (!documentId) throw new Error('Create Feishu document failed: missing document_id');

    let blocks = [];
    try {
      const convertResponse = assertOk(await client.docx.document.convert({
        data: {
          content_type: 'markdown',
          content: String(markdown ?? ''),
        },
      }), 'Convert Markdown to Feishu document blocks');
      const converted = convertResponse.data ?? {};
      const firstLevel = new Set(converted.first_level_block_ids ?? []);
      const convertedBlocks = converted.blocks ?? [];
      blocks = convertedBlocks
        .filter((block) => !firstLevel.size || firstLevel.has(block?.block_id))
        .map(stripConvertedBlock)
        .filter((block) => block?.block_type);
    } catch {
      blocks = [plainMarkdownBlock(markdown)];
    }

    if (blocks.length) {
      assertOk(await client.docx.documentBlockChildren.create({
        path: {
          document_id: documentId,
          block_id: documentId,
        },
        params: {
          client_token: randomUUID(),
        },
        data: {
          children: blocks,
        },
      }), 'Insert Feishu document blocks');
    }

    return {
      success: true,
      documentId,
      revisionId: document.revision_id ?? null,
      title: document.title ?? title ?? null,
      url: documentUrl(documentId, { domain: this.config.domain, docBaseUrl }),
    };
  }
}
