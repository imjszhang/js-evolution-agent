// <channel-pipeline>：横向消息流水线，节点显示积压/状态，事件到达时脉冲动画，点击节点展开详情。
import { t, onLocaleChange } from '../i18n.js';
import { escapeHtml, truncate, formatTimeShort } from './util.js';

const STAGES = [
  { id: 'feishu', label: 'channel.stageFeishu' },
  { id: 'inbound', label: 'channel.stageInbound' },
  { id: 'classifier', label: 'channel.stageClassifier' },
  { id: 'presence', label: 'channel.stagePresence' },
  { id: 'speech', label: 'channel.stageSpeech' },
  { id: 'outbox', label: 'channel.stageOutbox' },
  { id: 'notify', label: 'channel.stageNotify' },
  { id: 'sent', label: 'channel.stageSent' },
];

const TASK_STAGE = {
  channel_classifier: 'classifier',
  channel_presence: 'presence',
  channel_speech_generation: 'speech',
  channel_notify: 'notify',
};

function eventStage(type) {
  if (!type) return null;
  if (/message_received/.test(type)) return 'inbound';
  if (/inbound_completed|message_ingest|classif/.test(type)) return 'classifier';
  if (/expression|presence/.test(type)) return 'presence';
  if (/speech/.test(type)) return 'speech';
  if (/message_sent|notify|message_send/.test(type)) return 'notify';
  if (/feishu_listener/.test(type)) return 'feishu';
  return null;
}

function countByType(rows, type) {
  return (rows ?? []).filter((r) => r.type === type).length;
}

class ChannelPipeline extends HTMLElement {
  constructor() {
    super();
    this._channel = null;
    this._subject = null;
    this._openStage = null;
    /** @type {Record<string, object>} */
    this._detailCache = {};
    this._unsub = null;
  }

  connectedCallback() {
    this._unsub = onLocaleChange(() => this.render());
    if (!this.innerHTML) this.render();
  }

  disconnectedCallback() {
    this._unsub?.();
  }

  set channel(data) {
    this._channel = data ?? null;
    this.render();
  }

  get channel() {
    return this._channel;
  }

  set subject(value) {
    this._subject = value || null;
  }

  /** Compute display model for a single stage. */
  _stageModel(stageId) {
    const ch = this._channel ?? {};
    const running = ch.tasks?.running ?? [];
    const failed = ch.tasks?.failed ?? [];
    const presence = ch.presence ?? {};
    switch (stageId) {
      case 'feishu': {
        const on = Boolean(ch.feishu?.listener?.running);
        return { badge: on ? t('channel.feishuOn') : t('channel.feishuOff'), state: on ? 'on' : 'idle' };
      }
      case 'inbound': {
        const n = ch.inbound?.pending_count ?? 0;
        return { badge: n ? t('channel.nodePending', { count: n }) : t('channel.nodeEmpty'), state: n ? 'warn' : 'idle', count: n };
      }
      case 'classifier': {
        const r = countByType(running, 'channel_classifier');
        const f = countByType(failed, 'channel_classifier');
        const mode = ch.classifier?.enabled === false ? t('channel.classifierDisabled') : (ch.classifier?.mode ?? t('channel.classifierDefault'));
        if (f) return { badge: t('channel.nodeFailed', { count: f }), state: 'error' };
        return { badge: r ? t('channel.nodeRunning') : escapeHtml(mode), state: r ? 'active' : 'idle' };
      }
      case 'presence': {
        const status = presence.reactor?.status ?? 'idle';
        const r = countByType(running, 'channel_presence');
        return { badge: escapeHtml(status), state: r || status === 'running' ? 'active' : 'idle' };
      }
      case 'speech': {
        const n = presence.pending_speech_generation?.length ?? 0;
        const f = countByType(failed, 'channel_speech_generation');
        if (f) return { badge: t('channel.nodeFailed', { count: f }), state: 'error' };
        return { badge: n ? t('channel.nodePending', { count: n }) : t('channel.nodeEmpty'), state: n ? 'warn' : 'idle', count: n };
      }
      case 'outbox': {
        const n = ch.outbox?.pending_count ?? 0;
        return { badge: n ? t('channel.nodePending', { count: n }) : t('channel.nodeEmpty'), state: n ? 'warn' : 'idle', count: n };
      }
      case 'notify': {
        const r = countByType(running, 'channel_notify');
        const f = countByType(failed, 'channel_notify');
        if (f) return { badge: t('channel.nodeFailed', { count: f }), state: 'error' };
        return { badge: r ? t('channel.nodeRunning') : t('channel.nodeEmpty'), state: r ? 'active' : 'idle' };
      }
      case 'sent':
      default:
        return { badge: '', state: 'idle' };
    }
  }

  render() {
    if (!this._channel) {
      this.innerHTML = `<p class="card-empty">${escapeHtml(t('channel.pipelineEmpty'))}</p>`;
      return;
    }
    const nodes = STAGES.map((stage, i) => {
      const model = this._stageModel(stage.id);
      const open = this._openStage === stage.id ? ' is-open' : '';
      const connector = i < STAGES.length - 1
        ? '<span class="cpl-connector" aria-hidden="true"></span>'
        : '';
      return `
        <button type="button" class="cpl-node state-${model.state}${open}" data-stage="${stage.id}">
          <span class="cpl-node-label">${escapeHtml(t(stage.label))}</span>
          ${model.badge ? `<span class="cpl-node-badge">${model.badge}</span>` : ''}
        </button>
        ${connector}`;
    }).join('');

    this.innerHTML = `
      <div class="cpl-title">${escapeHtml(t('channel.pipelineTitle'))}</div>
      <div class="cpl-track">${nodes}</div>
      <div class="cpl-branches">
        <span class="cpl-branch">${escapeHtml(t('channel.branchClassified'))}</span>
        <span class="cpl-branch">${escapeHtml(t('channel.branchAgent'))}</span>
      </div>
      <div class="cpl-detail${this._openStage ? '' : ' hidden'}" id="cpl-detail"></div>
    `;

    for (const btn of this.querySelectorAll('.cpl-node')) {
      btn.addEventListener('click', () => this._toggleStage(btn.dataset.stage));
    }
    if (this._openStage) this._renderDetail();
  }

  _toggleStage(stageId) {
    this._openStage = this._openStage === stageId ? null : stageId;
    this.render();
  }

  async _renderDetail() {
    const panel = this.querySelector('#cpl-detail');
    if (!panel) return;
    const stageId = this._openStage;
    panel.classList.remove('hidden');

    if ((stageId === 'inbound' || stageId === 'outbox') && this._subject) {
      const kind = stageId === 'inbound' ? 'inbound' : 'outbox';
      const status = stageId === 'inbound' ? 'pending' : 'pending';
      panel.innerHTML = `<p class="cpl-detail-loading">${escapeHtml(t('common.loading'))}</p>`;
      try {
        const res = await fetch(`/api/subjects/${encodeURIComponent(this._subject)}/channel/${kind}?status=${status}&limit=10`, { cache: 'no-store' });
        const data = await res.json();
        panel.innerHTML = this._renderFileList(kind, data.files ?? []);
      } catch {
        panel.innerHTML = `<p class="cpl-detail-loading">${escapeHtml(t('channel.pipelineEmpty'))}</p>`;
      }
      return;
    }

    panel.innerHTML = this._renderStageInfo(stageId);
  }

  _renderFileList(kind, files) {
    if (!files.length) {
      return `<p class="cpl-detail-empty">${escapeHtml(t('channel.nodeEmpty'))}</p>`;
    }
    return `<ul class="cpl-file-list">${files.map((f) => {
      if (kind === 'inbound') {
        const tags = f.understanding
          ? `<span class="cpl-tag">${escapeHtml(f.understanding.user_intent ?? '')}</span>
             ${f.understanding.temporal ? `<span class="cpl-tag">${escapeHtml(f.understanding.temporal)}</span>` : ''}
             ${f.understanding.complexity ? `<span class="cpl-tag">${escapeHtml(f.understanding.complexity)}</span>` : ''}`
          : (f.classification ? `<span class="cpl-tag">${escapeHtml(f.classification)}</span>` : '');
        return `<li class="cpl-file">
          <div class="cpl-file-head"><span class="cpl-file-time">${formatTimeShort(f.received_at)}</span>${tags}</div>
          <div class="cpl-file-text">${escapeHtml(truncate(f.text, 120) || f.message_id || f.file)}</div>
        </li>`;
      }
      return `<li class="cpl-file">
        <div class="cpl-file-head"><span class="cpl-file-time">${formatTimeShort(f.sent_at ?? f.failed_at)}</span>${f.to ? `<span class="cpl-tag">${escapeHtml(f.to)}</span>` : ''}${f.reason ? `<span class="cpl-tag cpl-tag-err">${escapeHtml(f.reason)}</span>` : ''}</div>
        <div class="cpl-file-text">${escapeHtml(truncate(f.text, 120) || f.file)}</div>
      </li>`;
    }).join('')}</ul>`;
  }

  _renderStageInfo(stageId) {
    const ch = this._channel ?? {};
    const lines = [];
    if (stageId === 'feishu') {
      const l = ch.feishu?.listener ?? {};
      lines.push(l.running ? t('channel.feishuWsRunning') : t('channel.feishuWsOff'));
    } else if (stageId === 'classifier') {
      const c = ch.classifier ?? {};
      lines.push(c.enabled === false
        ? t('channel.classifierDisabled')
        : t('channel.classifierLine', { mode: c.mode ?? t('channel.classifierDefault'), interval: c.interval_ms ?? '—', batch: c.batch_size ?? '—' }));
    } else if (stageId === 'presence') {
      lines.push(`${t('channel.presenceReactor')}: ${ch.presence?.reactor?.status ?? 'idle'}`);
    } else if (stageId === 'speech') {
      const n = ch.presence?.pending_speech_generation?.length ?? 0;
      lines.push(n ? t('channel.pendingSpeech', { count: n }) : t('channel.pendingSpeechEmpty'));
    } else if (stageId === 'notify') {
      lines.push(ch.feishu?.listener?.running ? t('channel.feishuOn') : t('channel.feishuOff'));
    }
    if (!lines.length) return `<p class="cpl-detail-empty">${escapeHtml(t('channel.nodeEmpty'))}</p>`;
    return lines.map((l) => `<p class="cpl-detail-line">${escapeHtml(l)}</p>`).join('');
  }

  /** Flash the stage matching an incoming event. */
  pulse(ev) {
    const stage = eventStage(ev?.type ?? ev?.event_type);
    if (!stage) return;
    const node = this.querySelector(`.cpl-node[data-stage="${stage}"]`);
    if (!node) return;
    node.classList.remove('cpl-pulse');
    // force reflow to restart animation
    void node.offsetWidth;
    node.classList.add('cpl-pulse');
    setTimeout(() => node.classList.remove('cpl-pulse'), 1200);
  }
}

if (!customElements.get('channel-pipeline')) {
  customElements.define('channel-pipeline', ChannelPipeline);
}
