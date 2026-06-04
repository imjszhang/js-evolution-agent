// 组件共享工具：HTML 转义、时间格式化、channel 事件分组。
import { getLocale, t, tDynamic } from '../i18n.js';

export function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatTimeShort(iso) {
  if (!iso) return t('common.dash');
  try {
    return new Date(iso).toLocaleTimeString(getLocale(), { hour12: false });
  } catch {
    return iso;
  }
}

export function truncate(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}${t('common.ellipsis')}`;
}

/**
 * Classify a channel event into a pipeline-oriented group.
 * @param {object} ev
 * @returns {'inbound'|'presence'|'outbound'|'control'|'error'|'other'}
 */
export function channelEventGroup(ev) {
  const type = ev?.type ?? ev?.event_type ?? '';
  if (ev?.status === 'failed' || /failed|timeout|crashed|zombie|error/.test(type)) return 'error';
  if (/sent|notify|send/.test(type)) return 'outbound';
  if (/expression|presence|speech/.test(type)) return 'presence';
  if (/control_action/.test(type)) return 'control';
  if (/inbound|received|ingest|classif|message/.test(type)) return 'inbound';
  return 'other';
}

export function formatAge(iso) {
  if (!iso) return t('common.dash');
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return t('common.dash');
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

export function channelEventLabel(ev) {
  const type = ev?.type ?? ev?.event_type;
  const base = tDynamic('channelEvents', type, type ?? 'channel');
  const parts = [base];
  if (ev?.task_type) parts.push(ev.task_type);
  if (ev?.message_id) parts.push(ev.message_id);
  if (ev?.ingest_kind) parts.push(ev.ingest_kind);
  if (ev?.status && ev.status !== 'ok') parts.push(ev.status);
  return parts.join(' · ');
}
