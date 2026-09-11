import { desktop, getSetting, setSetting, isWeb } from '../client.js';
import { openQuickSwitcher } from './quickswitcher.js';
import { openInbox } from './inbox.js';
import { openPopover, menuItem, menuLabel } from './overlay.js';
import { el } from '../utils.js';
import { setFocusMode } from '../actions.js';
import { store } from '../state.js';

function refreshFocusButton() {
  const btn = document.getElementById('titlebarFocus');
  if (!btn) return;
  const active = store.isFocusActive();
  btn.classList.toggle('is-on', active);
  btn.title = active ? 'Focus mode is on — everything is silenced' : 'Focus mode — silence everything';
}

function openFocusMenu(anchor) {
  const active = store.isFocusActive();
  const items = [
    menuItem({ label: 'Focus for 30 minutes', iconName: 'moon', onSelect: () => setFocusMode(30 * 60_000) }),
    menuItem({ label: 'Focus for 1 hour', iconName: 'moon', onSelect: () => setFocusMode(60 * 60_000) }),
    menuItem({ label: 'Focus for 2 hours', iconName: 'moon', onSelect: () => setFocusMode(2 * 60 * 60_000) }),
    menuItem({ label: 'Until I turn it off', iconName: 'moon', onSelect: () => setFocusMode(null) }),
  ];
  if (active) {
    items.push(menuItem({ label: 'Turn off focus', iconName: 'sun', onSelect: () => setFocusMode(0) }));
  }
  openPopover(anchor, el('div', { class: 'menu' },
    menuLabel('Silences all notifications — mentions included'),
    ...items,
  ), { placement: 'bottom-end' });
}

export function refreshInboxBadge() {
  const badge = document.getElementById('inboxBadge');
  if (!badge) return;
  const count = store.inboxBadge(Number(getSetting('inboxSeenAt', 0)) || 0);
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
}

export function mountTitlebar() {
  const app = document.getElementById('app');

  // In a browser tab the browser owns the window; our controls make no sense.
  if (isWeb) document.querySelector('.window-controls').hidden = true;

  document.getElementById('winMinimize').addEventListener('click', () => desktop.minimize());
  document.getElementById('winMaximize').addEventListener('click', () => desktop.toggleMaximize());
  document.getElementById('winClose').addEventListener('click', () => desktop.close());
  document.getElementById('titlebarSearch').addEventListener('click', openQuickSwitcher);
  document.getElementById('titlebarInbox').addEventListener('click', (event) => {
    openInbox(event.currentTarget);
    setSetting('inboxSeenAt', Date.now());
    refreshInboxBadge();
  });

  store.on('inbox', refreshInboxBadge);
  refreshInboxBadge();

  document.getElementById('titlebarFocus').addEventListener('click', (event) => openFocusMenu(event.currentTarget));
  store.on('ui', refreshFocusButton);
  // Auto-clear the visual when a timed focus lapses.
  setInterval(refreshFocusButton, 30_000);
  refreshFocusButton();

  const setMaximized = (value) => {
    app.classList.toggle('is-maximized', Boolean(value));
    const button = document.getElementById('winMaximize');
    button.setAttribute('aria-label', value ? 'Restore' : 'Maximize');
    button.title = value ? 'Restore' : 'Maximize';
  };

  desktop.onMaximizedChange(setMaximized);
  desktop.isMaximized().then(setMaximized).catch(() => {});

  // Double-clicking the drag strip toggles maximize, matching Windows behaviour.
  document.querySelector('.titlebar__drag').addEventListener('dblclick', () => desktop.toggleMaximize());
}

export function setSearchVisible(visible) {
  document.getElementById('titlebarSearch').hidden = !visible;
}

/**
 * Connection state, shown in the title bar as a labelled chip. Same shape in
 * every state; only the colour and wording change — green connected, amber
 * working, red down.
 *
 * @param {'connecting'|'online'|'reconnecting'|'offline'} state
 * @param {string} [label] overrides the default wording
 */
export function setConnectionState(state, label) {
  const pill = document.getElementById('connectionPill');
  const text = document.getElementById('connectionLabel');
  if (!pill) return;

  const preset = {
    connecting: ['connecting', 'Connecting'],
    online: ['online', 'Connected'],
    reconnecting: ['connecting', 'Reconnecting'],
    offline: ['offline', 'Not connected'],
  }[state] || ['offline', 'Not connected'];

  pill.classList.remove('statuspill--connecting', 'statuspill--online', 'statuspill--offline');
  pill.classList.add(`statuspill--${preset[0]}`);
  text.textContent = label || preset[1];
  const server = document.body.dataset.serverName;
  pill.title = server
    ? `${text.textContent} — ${server}`
    : `Connection: ${text.textContent}`;
}
