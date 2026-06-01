import { parseTextContent } from './parser.mjs';
import { matchesBindPhrase } from './binding.mjs';

const PolicyType = {
  OPEN: 'open',
  ALLOWLIST: 'allowlist',
  DISABLED: 'disabled',
};

export class FeishuPolicy {
  constructor(config = {}) {
    this.config = {
      dmPolicy: PolicyType.OPEN,
      allowFrom: [],
      groupPolicy: PolicyType.ALLOWLIST,
      groupAllowFrom: [],
      requireMention: true,
      groups: {},
      bindEnabled: false,
      bindPhrase: 'JEA BIND',
      bindToken: '',
      ...config,
    };
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  _matchAllowlist(id, list) {
    if (!id || !Array.isArray(list) || !list.length) return false;
    const normalized = String(id).replace(/^(chat:|user:)/, '');
    return list.some((item) => {
      const candidate = String(item).replace(/^(chat:|user:)/, '');
      return candidate === normalized || candidate === id;
    });
  }

  _getGroupConfig(chatId) {
    if (!chatId || !this.config.groups) return null;
    return this.config.groups[chatId] ?? null;
  }

  checkDM({ senderId }) {
    const policy = this.config.dmPolicy || PolicyType.OPEN;
    if (policy === PolicyType.OPEN) return { allowed: true };
    if (policy === PolicyType.DISABLED) return { allowed: false, reason: 'dm_disabled' };
    if (policy === PolicyType.ALLOWLIST) {
      if (!this._matchAllowlist(senderId, this.config.allowFrom)) {
        return { allowed: false, reason: 'not_in_allowlist' };
      }
    }
    return { allowed: true };
  }

  checkGroup({ chatId, senderId }) {
    const groupConfig = this._getGroupConfig(chatId);
    if (groupConfig?.enabled === false) {
      return { allowed: false, reason: 'group_disabled' };
    }
    const policy = this.config.groupPolicy || PolicyType.ALLOWLIST;
    if (policy === PolicyType.DISABLED) return { allowed: false, reason: 'group_disabled' };
    if (policy === PolicyType.OPEN) {
      const senderAllowlist = groupConfig?.allowFrom || this.config.groupAllowFrom;
      if (senderAllowlist?.length && !this._matchAllowlist(senderId, senderAllowlist)) {
        return { allowed: false, reason: 'sender_not_in_allowlist' };
      }
      return { allowed: true };
    }
    if (policy === PolicyType.ALLOWLIST) {
      if (!this._matchAllowlist(chatId, this.config.groupAllowFrom)) {
        return { allowed: false, reason: 'group_not_in_allowlist' };
      }
      const senderAllowlist = groupConfig?.allowFrom;
      if (senderAllowlist?.length && !this._matchAllowlist(senderId, senderAllowlist)) {
        return { allowed: false, reason: 'sender_not_in_allowlist' };
      }
    }
    return { allowed: true };
  }

  requiresMention(chatId) {
    const groupConfig = this._getGroupConfig(chatId);
    if (groupConfig && typeof groupConfig.requireMention === 'boolean') {
      return groupConfig.requireMention;
    }
    return this.config.requireMention !== false;
  }

  /**
   * @param {object} event - parsed Feishu message event
   * @param {string|null} botOpenId
   */
  evaluateInbound(event, botOpenId = null) {
    const isGroup = event.chatType === 'group';
    if (!isGroup && this.config.bindEnabled) {
      const text = parseTextContent(event.content, event.messageType);
      if (matchesBindPhrase(text, this.config.bindPhrase)) {
        return { allowed: true, reason: 'bind_handshake' };
      }
    }
    if (isGroup) {
      const groupResult = this.checkGroup({
        chatId: event.chatId,
        senderId: event.senderOpenId || event.senderId,
      });
      if (!groupResult.allowed) return groupResult;
      const mentioned = this._checkBotMentioned(event.mentions, botOpenId);
      if (this.requiresMention(event.chatId) && !mentioned) {
        return { allowed: false, reason: 'not_mentioned' };
      }
      return { allowed: true };
    }
    return this.checkDM({ senderId: event.senderOpenId || event.senderId });
  }

  _checkBotMentioned(mentions, botOpenId) {
    if (!mentions?.length) return false;
    if (!botOpenId) return mentions.length > 0;
    return mentions.some((m) =>
      m.id?.open_id === botOpenId || m.id?.user_id === botOpenId,
    );
  }
}
