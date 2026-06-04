// <presence-reactor>：Presence reactor 状态机 + 事件队列分布 + 待生成话术。
import { t, onLocaleChange } from '../i18n.js';
import { escapeHtml, formatTimeShort } from './util.js';

const REACTOR_STATES = [
  { id: 'idle', label: 'channel.reactorStateIdle' },
  { id: 'claimed', label: 'channel.reactorStateClaimed' },
  { id: 'planning', label: 'channel.reactorStatePlanning' },
  { id: 'speech_intent', label: 'channel.reactorStateSpeechIntent' },
  { id: 'generating', label: 'channel.reactorStateGenerating' },
  { id: 'completed', label: 'channel.reactorStateCompleted' },
];

// map raw reactor.status -> canonical stage id
const STATUS_ALIAS = {
  idle: 'idle',
  claimed: 'claimed',
  running: 'planning',
  planning: 'planning',
  speech_intent: 'speech_intent',
  generating: 'generating',
  completed: 'completed',
  done: 'completed',
};

const QUEUE_SEGMENTS = [
  { id: 'pending', label: 'channel.queuePending' },
  { id: 'claimed', label: 'channel.queueClaimed' },
  { id: 'handled', label: 'channel.queueHandled' },
];

class PresenceReactor extends HTMLElement {
  constructor() {
    super();
    this._channel = null;
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

  render() {
    const presence = this._channel?.presence ?? {};
    const reactor = presence.reactor ?? {};
    const rawStatus = reactor.status ?? 'idle';
    const activeStage = STATUS_ALIAS[rawStatus] ?? 'idle';
    const reachedIdx = REACTOR_STATES.findIndex((s) => s.id === activeStage);

    const stateMachine = REACTOR_STATES.map((s, i) => {
      const cls = i === reachedIdx ? ' is-active' : (i < reachedIdx ? ' is-done' : '');
      const connector = i < REACTOR_STATES.length - 1 ? '<span class="pr-arrow" aria-hidden="true">›</span>' : '';
      return `<span class="pr-state${cls}">${escapeHtml(t(s.label))}</span>${connector}`;
    }).join('');

    const counts = presence.event_queue?.counts ?? {};
    const total = QUEUE_SEGMENTS.reduce((sum, seg) => sum + (counts[seg.id] ?? 0), 0);
    const bar = total
      ? QUEUE_SEGMENTS.map((seg) => {
        const v = counts[seg.id] ?? 0;
        if (!v) return '';
        const pct = Math.round((v / total) * 100);
        return `<span class="pr-bar-seg pr-seg-${seg.id}" style="width:${pct}%" title="${escapeHtml(t(seg.label))}: ${v}"></span>`;
      }).join('')
      : '<span class="pr-bar-seg pr-seg-empty" style="width:100%"></span>';

    const legend = QUEUE_SEGMENTS.map((seg) => `
      <span class="pr-legend-item"><span class="pr-legend-dot pr-seg-${seg.id}"></span>${escapeHtml(t(seg.label))} ${counts[seg.id] ?? 0}</span>
    `).join('');

    const pending = presence.pending_speech_generation ?? [];
    const pendingHtml = pending.length
      ? `<ul class="pr-speech-list">${pending.slice(0, 5).map((p) => `
        <li><code>${escapeHtml(p.id ?? p.speech_intent_id ?? p.candidate_id ?? 'speech')}</code>${p.requested_at ? ` <span class="pr-speech-time">${formatTimeShort(p.requested_at)}</span>` : ''}</li>
      `).join('')}</ul>`
      : `<p class="pr-empty">${escapeHtml(t('channel.pendingSpeechEmpty'))}</p>`;

    const deadline = reactor.deadline_at ? ` · ${t('channel.reactorDeadline', { time: formatTimeShort(reactor.deadline_at) })}` : '';

    this.innerHTML = `
      <div class="pr-title">${escapeHtml(t('channel.reactorTitle'))} <span class="pr-status">${escapeHtml(rawStatus)}${escapeHtml(deadline)}</span></div>
      <div class="pr-machine">${stateMachine}</div>
      <div class="pr-section-label">${escapeHtml(t('channel.queueTitle'))}</div>
      <div class="pr-bar">${bar}</div>
      <div class="pr-legend">${legend}</div>
      <div class="pr-section-label">${escapeHtml(t('channel.pendingSpeechTitle'))}</div>
      ${pendingHtml}
    `;
  }
}

if (!customElements.get('presence-reactor')) {
  customElements.define('presence-reactor', PresenceReactor);
}
