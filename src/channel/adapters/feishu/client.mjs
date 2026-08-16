import { randomUUID } from 'node:crypto';
import axios from 'axios';

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

function boundedHttpInstance(timeoutMs, signal = null) {
  return axios.create({
    timeout: Math.max(1, Number(timeoutMs) || 30_000),
    ...(signal ? { signal } : {}),
  });
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

function sanitizeTableProperty(property = {}) {
  // `column_width` and `merge_info` are read-only / auto-assigned at creation;
  // the descendant API rejects (1770001 invalid param) tables that carry them.
  // Markdown tables never contain merged cells, so dropping these is safe.
  const { column_width: _columnWidth, merge_info: _mergeInfo, ...rest } = property;
  return rest;
}

function toDescendantBlock(block = {}) {
  const { parent_id: _parentId, ...rest } = block;
  if (rest.block_type === 31 && rest.table?.property) {
    rest.table = { ...rest.table, property: sanitizeTableProperty(rest.table.property) };
  }
  return rest;
}

function collectSubtree(byId, rootIds) {
  const out = [];
  const seen = new Set();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const block = byId.get(id);
    out.push(block);
    const children = Array.isArray(block.children) ? block.children : [];
    for (const childId of children) {
      if (!seen.has(childId)) queue.push(childId);
    }
  }
  return out;
}

/**
 * Turn a docx `convert` response into ordered descendant-insertion batches.
 *
 * The convert API returns a *flat* list of blocks where container blocks (e.g.
 * tables, quote containers, lists) reference their nested children by id via the
 * `children` field. Those nested blocks live elsewhere in the same flat array.
 * Inserting first-level container blocks through the flat `documentBlockChildren`
 * API (which only accepts self-contained children) makes Feishu reject the
 * request with HTTP 400. The descendant API accepts the full subtree, so we
 * collect every block reachable from the first-level ids and submit them as
 * `descendants`, with `children_id` selecting the top-level blocks.
 *
 * @param {{ blocks?: Array, first_level_block_ids?: string[] }} converted
 * @param {{ batchSize?: number }} [options]
 * @returns {Array<{ children_id: string[], index: number, descendants: Array }>}
 */
export function planDocumentInsertions(converted = {}, { batchSize = 40 } = {}) {
  const blocks = Array.isArray(converted.blocks) ? converted.blocks : [];
  const firstLevel = Array.isArray(converted.first_level_block_ids)
    ? converted.first_level_block_ids.filter(Boolean)
    : [];
  if (!blocks.length || !firstLevel.length) return [];

  const byId = new Map();
  for (const block of blocks) {
    if (block?.block_id) byId.set(block.block_id, block);
  }

  const size = Math.max(1, batchSize);
  const batches = [];
  let inserted = 0;
  for (let i = 0; i < firstLevel.length; i += size) {
    const chunkFirst = firstLevel.slice(i, i + size).filter((id) => byId.has(id));
    if (!chunkFirst.length) continue;
    const descendants = collectSubtree(byId, chunkFirst).map(toDescendantBlock);
    if (!descendants.length) continue;
    batches.push({ children_id: chunkFirst, index: inserted, descendants });
    inserted += chunkFirst.length;
  }
  return batches;
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

  async getClient({ signal = this.config.signal ?? null } = {}) {
    const Lark = await loadLarkSdk();
    this.checkCredentials();
    if (signal) {
      return new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: Lark.AppType?.SelfBuild,
        domain: domainFor(Lark, this.config.domain),
        httpInstance: boundedHttpInstance(this.config.sendTimeoutMs, signal),
      });
    }
    if (!this._client) {
      this._client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: Lark.AppType?.SelfBuild,
        domain: domainFor(Lark, this.config.domain),
        httpInstance: boundedHttpInstance(this.config.sendTimeoutMs),
      });
    }
    return this._client;
  }

  async createWSClient({ signal = this.config.signal ?? null, onReady, onError, onReconnecting, onReconnected } = {}) {
    const Lark = await loadLarkSdk();
    this.checkCredentials();
    return new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: domainFor(Lark, this.config.domain),
      loggerLevel: Lark.LoggerLevel?.info,
      httpInstance: boundedHttpInstance(this.config.connectTimeoutMs, signal),
      handshakeTimeoutMs: this.config.connectTimeoutMs,
      onReady,
      onError,
      onReconnecting,
      onReconnected,
    });
  }

  async createEventDispatcher() {
    const Lark = await loadLarkSdk();
    return new Lark.EventDispatcher({
      encryptKey: this.config.encryptKey || undefined,
      verificationToken: this.config.verificationToken || undefined,
    });
  }

  async probe({ signal = this.config.signal ?? null } = {}) {
    try {
      const client = await this.getClient({ signal });
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
      if (signal?.aborted || axios.isCancel(err)) throw err;
      return { ok: false, error: err?.message || String(err) };
    }
  }

  getBotInfo() {
    return this._botInfo;
  }

  async getBotOpenId(options = {}) {
    if (this._botInfo?.botOpenId) return this._botInfo.botOpenId;
    const probeResult = await this.probe(options);
    if (!probeResult.ok) {
      const error = new Error(`Feishu bot probe failed: ${probeResult.error || 'unknown error'}`);
      error.code = 'feishu_probe_failed';
      throw error;
    }
    return probeResult.botOpenId;
  }

  async sendText({ receiveId, receiveIdType, text, signal = null }) {
    const client = await this.getClient({ signal });
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

  async replyText({ messageId, text, signal = null }) {
    const client = await this.getClient({ signal });
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

  async sendCard({ receiveId, receiveIdType, card, signal = null }) {
    const client = await this.getClient({ signal });
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
    signal = null,
  } = {}) {
    const client = await this.getClient({ signal });
    const createResponse = assertOk(await client.docx.document.create({
      data: {
        title: String(title || 'Agent 交付物').slice(0, 200),
        folder_token: folderToken || undefined,
      },
    }), 'Create Feishu document');
    const document = createResponse.data?.document ?? {};
    const documentId = document.document_id;
    if (!documentId) throw new Error('Create Feishu document failed: missing document_id');

    let insertions = [];
    try {
      const convertResponse = assertOk(await client.docx.document.convert({
        data: {
          content_type: 'markdown',
          content: String(markdown ?? ''),
        },
      }), 'Convert Markdown to Feishu document blocks');
      insertions = planDocumentInsertions(convertResponse.data ?? {});
    } catch {
      insertions = [];
    }

    if (insertions.length) {
      // Nested blocks (tables, quote containers, lists) require the descendant
      // API; the flat children API rejects orphaned container blocks with 400.
      for (const batch of insertions) {
        assertOk(await client.docx.documentBlockDescendant.create({
          path: {
            document_id: documentId,
            block_id: documentId,
          },
          params: {
            client_token: randomUUID(),
          },
          data: {
            children_id: batch.children_id,
            index: batch.index,
            descendants: batch.descendants,
          },
        }), 'Insert Feishu document blocks');
      }
    } else {
      // Conversion failed or produced nothing usable: drop the raw markdown into
      // a single self-contained text block so the document is never empty.
      assertOk(await client.docx.documentBlockChildren.create({
        path: {
          document_id: documentId,
          block_id: documentId,
        },
        params: {
          client_token: randomUUID(),
        },
        data: {
          children: [plainMarkdownBlock(markdown)],
        },
      }), 'Insert Feishu document fallback block');
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
