'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the renderer and Node. Everything is an explicit,
 * narrow function — the renderer never sees ipcRenderer or require.
 */
contextBridge.exposeInMainWorld('pulse', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    version: () => ipcRenderer.invoke('update:version'),
    changelog: () => ipcRenderer.invoke('update:changelog'),
    // the builds this copy can switch to, and switching to one (older or newer)
    versions: () => ipcRenderer.invoke('update:versions'),
    rollback: (serial) => ipcRenderer.invoke('update:rollback', serial),
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
    onAvailable: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('update:available', listener);
      return () => ipcRenderer.removeListener('update:available', listener);
    },
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
    // Fired after a restore/heal: the page should re-measure its viewport.
    onViewportNudge: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('window:viewport-nudge', listener);
      return () => ipcRenderer.removeListener('window:viewport-nudge', listener);
    },
    diag: () => ipcRenderer.invoke('window:diag'),
  },

  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },

  // The main process's process-scanning: a non-Steam game (Minecraft,
  // Roblox, ...) starting or stopping, or null when nothing recognised is
  // running. Windows only — the callback simply never fires elsewhere.
  games: {
    onDetected: (callback) => {
      const listener = (_event, game) => callback(game);
      ipcRenderer.on('game:detected', listener);
      return () => ipcRenderer.removeListener('game:detected', listener);
    },
    // The value as of right now — for syncing state a push sent before this
    // listener existed would otherwise have missed.
    current: () => ipcRenderer.invoke('game:current'),
  },

  notify: (payload) => ipcRenderer.send('app:notify', payload),
  onNotificationClick: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:notification-click', listener);
    return () => ipcRenderer.removeListener('app:notification-click', listener);
  },
  flash: () => ipcRenderer.send('app:flash'),
  setBadge: (count) => ipcRenderer.send('app:badge', count),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  // voxara:// links: the one the app was launched with, and ones that arrive later.
  deepLinkPending: () => ipcRenderer.invoke('app:deep-link-pending'),
  onDeepLink: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:deep-link', listener);
    return () => ipcRenderer.removeListener('app:deep-link', listener);
  },

  // In-game voice overlay: the app pushes what to show; the overlay page listens.
  overlay: {
    set: (state) => ipcRenderer.send('overlay:set', state),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('overlay:state', listener);
      return () => ipcRenderer.removeListener('overlay:state', listener);
    },
  },

  // Screen sharing: the main process asks the page to pick a source.
  screen: {
    onRequest: (callback) => {
      const listener = (_event, sources) => callback(sources);
      ipcRenderer.on('screen:choose', listener);
      return () => ipcRenderer.removeListener('screen:choose', listener);
    },
    // id of the chosen source, or null to cancel.
    // id of the chosen source (null cancels) and { audio: true } to include what the computer is playing.
    choose: (id, opts) => ipcRenderer.send('screen:chosen', id, opts || {}),
    // a fresh preview snapshot (data URL) of one source.
    preview: (id) => ipcRenderer.invoke('screen:preview', id),
    // fresh small thumbnails for every source, for the picker's tiles.
    thumbs: () => ipcRenderer.invoke('screen:thumbs'),
  },
});
