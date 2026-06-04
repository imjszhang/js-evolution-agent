// <channel-event-feed>：实时 channel 事件时间线，按类型着色 + 过滤 chip + 新事件高亮。
import { t, onLocaleChange } from '../i18n.js';
import {
  escapeHtml,
  formatTimeShort,
  channelEventGroup,
  channelEventLabel,
} from './util.js';

const FILTERS = [
  { id: 'all', label: 'channel.filterAll', groups: null },
  { id: 'inbound', label: 'channel.filterInbound', groups: ['inbound'] },
  { id: 'presence', label: 'channel.filterPresence', groups: ['presence'] },
  { id: 'outbound', label: 'channel.filterOutbound', groups: ['outbound', 'control'] },
  { id: 'error', label: 'channel.filterError', groups: ['error'] },
];

const MAX_EVENTS = 80;

class ChannelEventFeed extends HTMLElement {
  constructor() {
    super();
    /** @type {object[]} */
    this._events = [];
    this._filter = 'all';
    /** @type {string|null} */
    this._flashId = null;
    this._unsub = null;
  }

  connectedCallback() {
    this._unsub = onLocaleChange(() => this.render());
    if (!this.innerHTML) this.render();
  }

  disconnectedCallback() {
    this._unsub?.();
  }

  set events(list) {
    this._events = Array.isArray(list) ? list.slice(0, MAX_EVENTS) : [];
    this.render();
  }

  get events() {
    return this._events;
  }

  /** Prepend a freshly received event and flash it. */
  pushEvent(ev) {
    if (!ev) return;
    this._events = [ev, ...this._events].slice(0, MAX_EVENTS);
    this._flashId = ev.id ?? `${ev.type}-${ev.recorded_at}`;
    this.render();
  }

  _visibleEvents() {
    const f = FILTERS.find((x) => x.id === this._filter);
    if (!f || !f.groups) return this._events;
    return this._events.filter((ev) => f.groups.includes(channelEventGroup(ev)));
  }

  render() {
    const visible = this._visibleEvents();
    const chips = FILTERS.map((f) => `
      <button type="button" class="cev-filter${this._filter === f.id ? ' active' : ''}" data-filter="${f.id}">${escapeHtml(t(f.label))}</button>
    `).join('');

    const rows = visible.length
      ? visible.map((ev) => {
        const group = channelEventGroup(ev);
        const id = ev.id ?? `${ev.type}-${ev.recorded_at}`;
        const flash = id === this._flashId ? ' cev-flash' : '';
        const rawType = ev.type ?? ev.event_type ?? 'event';
        const label = channelEventLabel(ev);
        return `<div class="cev-row cev-${group}${flash}">
          <span class="cev-time">${formatTimeShort(ev.recorded_at)}</span>
          <span class="cev-dot cev-dot-${group}" aria-hidden="true"></span>
          <span class="cev-type">${escapeHtml(rawType)}</span>
          <span class="cev-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        </div>`;
      }).join('')
      : `<p class="cev-empty">${escapeHtml(t('channel.eventFeedEmpty'))}</p>`;

    this.innerHTML = `
      <div class="cev-head">
        <span class="cev-title">${escapeHtml(t('channel.eventFeedTitle'))}</span>
        <div class="cev-filters">${chips}</div>
      </div>
      <div class="cev-list">${rows}</div>
    `;

    for (const btn of this.querySelectorAll('.cev-filter')) {
      btn.addEventListener('click', () => {
        this._filter = btn.dataset.filter;
        this._flashId = null;
        this.render();
      });
    }
    // flash only once
    this._flashId = null;
  }
}

if (!customElements.get('channel-event-feed')) {
  customElements.define('channel-event-feed', ChannelEventFeed);
}
