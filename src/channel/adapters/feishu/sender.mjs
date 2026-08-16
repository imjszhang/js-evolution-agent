export function resolveIdType(id) {
  if (!id) return 'open_id';
  if (id.startsWith('chat:') || id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('user:') || id.startsWith('ou_')) return 'open_id';
  return 'open_id';
}

export function normalizeTarget(target) {
  if (!target) return '';
  return String(target).replace(/^chat:/, '').replace(/^user:/, '').trim();
}

export class FeishuSender {
  constructor(client, config = {}) {
    this.client = client;
    this.config = {
      textChunkLimit: 4000,
      chunkMode: 'length',
      ...config,
    };
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  _splitMessage(text) {
    const limit = this.config.textChunkLimit || 4000;
    if (!text || text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > limit) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  async sendText(to, text, { signal = null } = {}) {
    const receiveId = normalizeTarget(to);
    const receiveIdType = resolveIdType(to);
    const chunks = this._splitMessage(text);
    const messageIds = [];
    for (const chunk of chunks) {
      const result = await this.client.sendText({ receiveId, receiveIdType, text: chunk, signal });
      messageIds.push(result.messageId);
    }
    return { success: true, messageIds, chunks: chunks.length };
  }

  async replyText(messageId, text, { signal = null } = {}) {
    const chunks = this._splitMessage(text);
    const messageIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (i === 0) {
        const result = await this.client.replyText({ messageId, text: chunks[i], signal });
        messageIds.push(result.messageId);
      }
    }
    return { success: true, messageIds, chunks: chunks.length };
  }

  async sendCard(to, card, { signal = null } = {}) {
    const receiveId = normalizeTarget(to);
    const receiveIdType = resolveIdType(to);
    const result = await this.client.sendCard({ receiveId, receiveIdType, card, signal });
    return { success: true, messageId: result.messageId };
  }

  async sendDocumentDelivery(to, document = {}, { signal = null } = {}) {
    const created = await this.client.createDocumentFromMarkdown({
      title: document.title,
      markdown: document.markdown,
      folderToken: document.folder_token ?? document.folderToken ?? this.config.docFolderToken,
      docBaseUrl: document.doc_base_url ?? document.docBaseUrl ?? this.config.docBaseUrl,
      signal,
    });
    const summary = document.message_text
      ?? document.messageText
      ?? `交付物已生成：${created.title || document.title || created.documentId}`;
    const message = String(summary).includes(created.url) ? String(summary) : `${summary}\n${created.url}`;
    const sent = await this.sendText(to, message, { signal });
    return {
      success: true,
      document: created,
      messageIds: sent.messageIds,
      chunks: sent.chunks,
    };
  }
}
