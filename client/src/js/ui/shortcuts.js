import { store } from '../state.js';
import { cycleChannel, cycleGuild, openHome, openGuild, toggleMemberList, markRead, setPref} from '../actions.js';
import { openQuickSwitcher, isQuickSwitcherOpen, close as closeQuickSwitcher } from './quickswitcher.js';
import { hasOpenOverlay, closePopover } from './overlay.js';
import { showShortcuts } from './modals.js';
import { showSettings } from './settings.js';
import { toggleSearch, focusComposer } from './chat.js';

const isTypingTarget = (target) =>
  target instanceof HTMLElement
  && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

export function mountShortcuts() {
  document.addEventListener('keydown', (event) => {
    // Overlays own Escape while they are open.
    if (event.key === 'Escape') {
      if (isQuickSwitcherOpen()) {
        closeQuickSwitcher();
        return;
      }
      if (hasOpenOverlay()) return;
      if (store.view.channelId) markRead(store.view.channelId);
      focusComposer();
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;

    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      setPref('spacesCollapsed', !store.ui.spacesCollapsed);
      return;
    }

    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openQuickSwitcher();
      return;
    }

    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      openHome();
      return;
    }

    if (ctrl && !event.altKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      toggleMemberList();
      return;
    }

    if (ctrl && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleSearch(true);
      return;
    }

    if (ctrl && event.key === '/') {
      event.preventDefault();
      showShortcuts();
      return;
    }

    if (ctrl && event.key === ',') {
      event.preventDefault();
      showSettings();
      return;
    }

    // Ctrl+1..9 jumps straight to a server by position.
    if (ctrl && !event.altKey && /^[1-9]$/.test(event.key)) {
      const ids = [...store.guilds.keys()];
      const target = ids[Number(event.key) - 1];
      if (target) {
        event.preventDefault();
        openGuild(target);
      }
      return;
    }

    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      if (ctrl) cycleGuild(delta);
      else cycleChannel(delta);
      return;
    }

    // Any other printable key while nothing is focused goes to the composer.
    const idle = !isTypingTarget(event.target) && !hasOpenOverlay() && !isQuickSwitcherOpen();
    if (!ctrl && !event.altKey && event.key.length === 1 && idle) {
      focusComposer();
    }
  });

  // Anchored popovers look broken once the window loses focus; modals stay put.
  window.addEventListener('blur', () => closePopover());
}
