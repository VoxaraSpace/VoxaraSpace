import { Net } from './net.js';

export const net = new Net();

/**
 * Persistent settings live in the main process (a JSON file in userData)
 * rather than localStorage, which is unreliable for `file://` documents.
 */
const bridge = window.pulse;

/** True when Voxara is running in a plain browser tab rather than the app. */
export const isWeb = !bridge;

// In a browser there is no main process to keep settings, so they live in
// localStorage instead (and quietly stay in-memory where even that is blocked).
const WEB_SETTINGS_KEY = 'pulse:settings';
function readWebSettings() {
  try { return JSON.parse(localStorage.getItem(WEB_SETTINGS_KEY)) || {}; } catch { return {}; }
}
function writeWebSettings() {
  try { localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(cache)); } catch { /* private mode */ }
}

let cache = {};
export let runtime = {
  platform: 'win32',
  version: '1.0.0',
  serial: 0,
  isDev: false,
  defaultServerUrl: 'wss://voxaraspace.com',
};

export async function loadRuntime() {
  if (!bridge) {
    // Served over http(s): the server that handed us this page is the server
    // we talk to, so derive the socket URL from the address bar.
    if (/^https?:$/.test(location.protocol)) {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      runtime = { ...runtime, platform: 'web', defaultServerUrl: `${scheme}://${location.host}` };
    }
    cache = readWebSettings();
    return runtime;
  }
  const config = await bridge.getConfig();
  runtime = { ...runtime, ...config };
  cache = config.settings || {};
  return runtime;
  // The build this copy is, sent with every sign-in so the server can refuse
  // builds below its security floor.
  net.clientInfo = { version: runtime.version, serial: Number(runtime.serial) || 0, platform: runtime.platform };
}

export function getSetting(key, fallback = null) {
  return cache[key] === undefined ? fallback : cache[key];
}

export function setSetting(key, value) {
  cache[key] = value;
  if (bridge) bridge.saveSettings({ [key]: value });
  else writeWebSettings();
}

export function setSettings(patch) {
  Object.assign(cache, patch);
  if (bridge) bridge.saveSettings(patch);
  else writeWebSettings();
}

/**
 * Turns a server-relative media path into an absolute URL on the Voxara host.
 * Uploads are private, so the session token rides along as a query parameter —
 * the server refuses `/media/...` without a valid session.
 */
/**
 * Last-resort copy: select the text in a throwaway element and use the
 * classic execCommand path, which needs no clipboard permission as long as
 * it runs inside a user gesture (a click on a Copy button always is).
 */
function copyViaSelection(value) {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

export function mediaUrl(pathOrNull) {
  if (!pathOrNull) return null;
  const base = (net.url || runtime.defaultServerUrl || '')
    .replace(/^ws:/i, 'http:')
    .replace(/^wss:/i, 'https:')
    .replace(/\/+$/, '');
  // The media token stands in for the session token in URLs (it can fetch
  // this session's media, nothing else), so a proxy log never holds a session.
  const token = net.mediaToken || getSetting('mediaToken') || net.token || getSetting('token');
  return token ? `${base}${pathOrNull}?t=${encodeURIComponent(token)}` : `${base}${pathOrNull}`;
}

/**
 * Steam store art, proxied through our own server (route `/steam-image`).
 * The client never fetches from Valve's CDN directly — that would expose the
 * viewer's IP to a third party. `kind` is 'header' (cover) or 'capsule' (row).
 */
export function steamImageUrl(appid, kind = 'header', index) {
  const suffix = index != null ? `/${index}` : '';
  return mediaUrl(`/steam-image/${appid}/${kind}${suffix}`);
}

// A thin, always-present shim so the UI never has to null-check the bridge.
export const desktop = {
  minimize: () => bridge?.window.minimize(),
  toggleMaximize: () => bridge?.window.toggleMaximize(),
  close: () => bridge?.window.close(),
  isMaximized: () => bridge?.window.isMaximized?.() ?? Promise.resolve(false),
  onMaximizedChange: (cb) => bridge?.window.onMaximizedChange(cb) ?? (() => {}),
  onViewportNudge: (cb) => bridge?.window.onViewportNudge?.(cb) ?? (() => {}),
  windowDiag: () => bridge?.window.diag?.() ?? Promise.resolve(null),
  // navigator.clipboard.writeText() is denied by the app's own permission
  // handler (see main.js), so the desktop app always goes through Electron's
  // native clipboard module instead; a plain browser tab has no bridge and
  // falls back to the web API.
  copyText: async (text) => {
    const value = String(text ?? '');
    if (bridge?.clipboard) {
      // The main process reads the clipboard back and reports whether the
      // write actually landed — on Windows the system clipboard can be
      // briefly locked by another app, and a write then fails quietly.
      let ok = false;
      try { ok = (await bridge.clipboard.writeText(value)) !== false; } catch { ok = false; }
      if (ok) return;
      if (copyViaSelection(value)) return;
      throw new Error('clipboard unavailable');
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      if (!copyViaSelection(value)) throw err;
    }
  },
  onGameDetected: (cb) => bridge?.games?.onDetected(cb) ?? (() => {}),
  /** The in-game voice overlay window; a no-op in a browser tab. */
  setOverlay: (state) => { try { bridge?.overlay?.set?.(state); } catch { /* no bridge */ } },
  hasOverlay: () => Boolean(bridge?.overlay),
  currentGame: () => bridge?.games?.current?.() ?? Promise.resolve(null),
  notify: (payload) => bridge?.notify(payload),
  onNotificationClick: (cb) => bridge?.onNotificationClick(cb) ?? (() => {}),
  flash: () => bridge?.flash(),
  setBadge: (count) => bridge?.setBadge(count),
  updates: {
    check: () => bridge?.updates.check() ?? Promise.resolve({ status: 'unsupported' }),
    install: () => bridge?.updates.install() ?? Promise.resolve({ status: 'unsupported' }),
    version: () => bridge?.updates.version() ?? Promise.resolve(''),
    changelog: () => bridge?.updates.changelog() ?? Promise.resolve({ moreUrl: '', entries: [] }),
    versions: () => bridge?.updates.versions?.() ?? Promise.resolve({ current: { version: runtime.version, serial: 0 }, supported: false, history: [] }),
    rollback: (serial) => bridge?.updates.rollback?.(serial) ?? Promise.resolve({ status: 'unsupported' }),
    onProgress: (cb) => bridge?.updates.onProgress(cb) ?? (() => {}),
    onAvailable: (cb) => bridge?.updates.onAvailable(cb) ?? (() => {}),
  },
  openExternal: (url) => {
    if (bridge) bridge.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  },
  // voxara://join/<code> links (desktop) — the web build reads ?join= instead.
  deepLinkPending: () => bridge?.deepLinkPending?.() ?? Promise.resolve(null),
  onDeepLink: (cb) => bridge?.onDeepLink?.(cb) ?? (() => {}),
};
