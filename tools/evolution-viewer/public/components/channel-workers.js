// <channel-workers>：六个 role worker 卡片，含心跳脉冲、健康态、当前任务。
import { t, onLocaleChange } from '../i18n.js';
import { escapeHtml, formatAge } from './util.js';

const ROLE_ORDER = ['notify', 'control', 'agent', 'presence', 'speech', 'classifier'];

function workerState(role) {
  if (!role) return 'off';
  if (role.zombie) return 'zombie';
  if (role.stale) return 'stale';
  if (role.running) return 'healthy';
  return 'off';
}

class ChannelWorkers extends HTMLElement {
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
    const ch = this._channel ?? {};
    const roles = ch.workers?.roles ?? [];
    const byRole = new Map(roles.map((r) => [r.role, r]));
    const classifier = ch.classifier ?? {};

    const cards = ROLE_ORDER.map((name) => {
      const role = byRole.get(name);
      const state = workerState(role);
      const stateLabel = {
        healthy: t('channel.workerHealthy'),
        stale: t('channel.workerStale'),
        zombie: t('channel.workerZombie'),
        off: t('channel.workerOff'),
      }[state];
      const heartbeat = role?.heartbeat_at
        ? t('channel.workerHeartbeat', { age: formatAge(role.heartbeat_at) })
        : '';
      const extra = name === 'classifier' && classifier.mode
        ? `<span class="cw-extra">${escapeHtml(classifier.mode)} · batch ${classifier.batch_size ?? '—'}</span>`
        : '';
      return `
        <div class="cw-card cw-${state}">
          <span class="cw-pulse cw-pulse-${state}" aria-hidden="true"></span>
          <span class="cw-role">${escapeHtml(name)}</span>
          <span class="cw-state">${escapeHtml(stateLabel)}</span>
          ${heartbeat ? `<span class="cw-heartbeat">${escapeHtml(heartbeat)}</span>` : ''}
          ${extra}
        </div>`;
    }).join('');

    this.innerHTML = `
      <div class="cw-title">${escapeHtml(t('channel.workersTitle'))} <span class="cw-running">${ch.workers?.running_count ?? 0}/${ROLE_ORDER.length}</span></div>
      <div class="cw-grid">${cards}</div>
    `;
  }
}

if (!customElements.get('channel-workers')) {
  customElements.define('channel-workers', ChannelWorkers);
}
