// 轻量 i18n 核心模块。语言包以 ES module 同步导入，t() 在渲染时同步可用，无需 fetch。
import zhCN from './i18n/zh-CN.js';
import en from './i18n/en.js';

const PACKS = { 'zh-CN': zhCN, en };
const FALLBACK = 'zh-CN';
const STORAGE_KEY = 'jea-viewer-locale';

export const LOCALE_LABELS = { 'zh-CN': '中文', en: 'English' };

/** @type {Set<(locale: string) => void>} */
const listeners = new Set();

function detectInitialLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && PACKS[saved]) return saved;
  } catch {
    // ignore storage errors (private mode / file://)
  }
  const nav = (navigator.language || '').toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('en')) return 'en';
  return FALLBACK;
}

let currentLocale = detectInitialLocale();
try {
  document.documentElement.lang = currentLocale;
} catch {
  // ignore
}

export function getLocale() {
  return currentLocale;
}

export function availableLocales() {
  return Object.keys(PACKS);
}

export function setLocale(locale) {
  if (!PACKS[locale] || locale === currentLocale) return;
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore
  }
  try {
    document.documentElement.lang = locale;
  } catch {
    // ignore
  }
  for (const fn of listeners) {
    try {
      fn(locale);
    } catch {
      // ignore listener errors
    }
  }
}

/**
 * Subscribe to locale changes. Returns an unsubscribe function.
 * @param {(locale: string) => void} fn
 */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(pack, key) {
  if (!pack) return undefined;
  return key.split('.').reduce((obj, part) => (obj == null ? undefined : obj[part]), pack);
}

function interpolate(template, params) {
  if (!params || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => (
    params[name] != null ? String(params[name]) : `{${name}}`
  ));
}

/**
 * Translate a dot-path key with optional params. Falls back to zh-CN then key.
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params) {
  let val = lookup(PACKS[currentLocale], key);
  if (val == null) val = lookup(PACKS[FALLBACK], key);
  if (val == null) return key;
  return interpolate(val, params);
}

/**
 * Translate using a key prefix + dynamic suffix, with a raw fallback value.
 * @param {string} prefix - e.g. 'events'
 * @param {string|null|undefined} suffix - dynamic key segment
 * @param {string} [fallback] - value when not found (defaults to suffix)
 */
export function tDynamic(prefix, suffix, fallback) {
  if (suffix == null) return fallback ?? '';
  const val = lookup(PACKS[currentLocale], `${prefix}.${suffix}`)
    ?? lookup(PACKS[FALLBACK], `${prefix}.${suffix}`);
  return val == null ? (fallback ?? suffix) : val;
}
