// Small DOM + formatting helpers shared by every view.

/**
 * Hyperscript-style element builder. Building the UI from real nodes (instead
 * of innerHTML strings) means user-supplied text can never become markup.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, setting] of Object.entries(value)) {
        // Object.assign silently drops custom properties, so --vars set this
        // way would do nothing at all.
        if (prop.startsWith('--')) node.style.setProperty(prop, setting);
        else node.style[prop] = setting;
      }
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else if (key in node && typeof value !== 'object') {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ------------------------------------------------------------------ strings

export function initials(name) {
  const words = String(name || '?').trim().split(/[\s_.-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

/** Subsequence match used by the quick switcher — "gen" matches "#general". */
export function fuzzyScore(query, target) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const exact = t.indexOf(q);
  if (exact === 0) return 1000;
  if (exact > 0) return 800 - exact;

  let score = 0;
  let cursor = 0;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return -1;
    score += found === cursor ? 6 : 2;
    cursor = found + 1;
  }
  return score;
}

// -------------------------------------------------------------------- time

const TODAY_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function dayOffset(timestamp) {
  return Math.round((startOfDay(new Date(timestamp)) - startOfDay(new Date())) / 86_400_000);
}

export function formatTime(timestamp) {
  return TODAY_FMT.format(new Date(timestamp));
}

export function formatFull(timestamp) {
  return FULL_FMT.format(new Date(timestamp));
}

/** "Today", "Yesterday" or an absolute date — used for day dividers. */
export function formatDayLabel(timestamp) {
  const offset = dayOffset(timestamp);
  if (offset === 0) return 'Today';
  if (offset === -1) return 'Yesterday';
  return DATE_FMT.format(new Date(timestamp));
}

/** Compact stamp for message headers: "Today at 4:12 PM". */
export function formatStamp(timestamp) {
  const offset = dayOffset(timestamp);
  if (offset === 0) return `Today at ${formatTime(timestamp)}`;
  if (offset === -1) return `Yesterday at ${formatTime(timestamp)}`;
  return `${DATE_FMT.format(new Date(timestamp))} at ${formatTime(timestamp)}`;
}

// ------------------------------------------------------------------ timing

export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function throttle(fn, wait = 200) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < wait) return;
    last = now;
    fn(...args);
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- misc

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function joinNames(names, max = 3) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} and ${names.length - max} others`;
}

export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** A tiny synchronous event emitter — enough for the app's fan-out needs. */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[emitter] listener for "${event}" threw:`, err);
      }
    }
    for (const handler of this.listeners.get('*') || []) {
      try {
        handler(event, payload);
      } catch (err) {
        console.error('[emitter] wildcard listener threw:', err);
      }
    }
  }
}
