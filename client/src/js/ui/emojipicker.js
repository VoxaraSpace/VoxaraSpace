import { el, clear } from '../utils.js';
import { EMOJI_GROUPS, EMOJI_ALL } from '../emoji.js';
import { openPopover, closePopover } from './overlay.js';
import { store } from '../state.js';
import { mediaUrl } from '../client.js';

function spaceEmojis() {
  // The current space's emoji first, then every other space you are in.
  return store.usableEmojis(store.view.channelId);
}

/**
 * Emoji picker popover.
 * @param {HTMLElement} anchor
 * @param {(emoji:string)=>void} onPick
 */
export function openEmojiPicker(anchor, onPick, { placement = 'top-end' } = {}) {
  const scroll = el('div', { class: 'emoji-picker__scroll' });

  const search = el('input', {
    class: 'emoji-picker__search',
    type: 'search',
    placeholder: 'Search emoji…',
    'aria-label': 'Search emoji',
    onInput: (event) => renderGroups(event.target.value.trim().toLowerCase()),
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        const first = scroll.querySelector('.emoji-picker__btn');
        if (first) first.click();
      }
    },
  });

  const button = (emoji) => el('button', {
    class: 'emoji-picker__btn',
    type: 'button',
    title: emoji,
    'aria-label': emoji,
    onClick: () => {
      closePopover();
      onPick(emoji);
    },
  }, emoji);

  // Custom emoji resolve to a :name: token the composer and reactions understand.
  const customButton = (e) => el('button', {
    class: 'emoji-picker__btn',
    type: 'button',
    title: `:${e.name}:`,
    'aria-label': `:${e.name}:`,
    onClick: () => { closePopover(); onPick(`:${e.name}:`); },
  }, el('img', { class: 'custom-emoji', src: mediaUrl(e.url), alt: `:${e.name}:` }));

  function renderGroups(query) {
    clear(scroll);
    const custom = spaceEmojis();
    if (query) {
      const customMatches = custom.filter((e) => e.name.includes(query));
      const matches = EMOJI_ALL.filter((entry) => entry.keywords.includes(query) || entry.emoji === query);
      if (matches.length === 0 && customMatches.length === 0) {
        scroll.appendChild(el('div', { class: 'switcher__empty' }, `No emoji match “${query}”.`));
        return;
      }
      if (customMatches.length) {
        scroll.appendChild(el('div', { class: 'emoji-picker__group' }, 'Custom'));
        scroll.appendChild(el('div', { class: 'emoji-picker__grid' }, ...customMatches.map(customButton)));
      }
      scroll.appendChild(el('div', { class: 'emoji-picker__group' }, `${matches.length} results`));
      scroll.appendChild(el('div', { class: 'emoji-picker__grid' }, ...matches.map((m) => button(m.emoji))));
      return;
    }
    if (custom.length) {
      // Grouped by the space each emoji comes from; the current space first.
      const bySpace = new Map();
      for (const e of custom) { if (!bySpace.has(e.spaceId)) bySpace.set(e.spaceId, { name: e.spaceName, list: [] }); bySpace.get(e.spaceId).list.push(e); }
      for (const group of bySpace.values()) {
        scroll.appendChild(el('div', { class: 'emoji-picker__group' }, group.name));
        scroll.appendChild(el('div', { class: 'emoji-picker__grid' }, ...group.list.map(customButton)));
      }
    }
    for (const group of EMOJI_GROUPS) {
      scroll.appendChild(el('div', { class: 'emoji-picker__group' }, group.name));
      scroll.appendChild(el('div', { class: 'emoji-picker__grid' },
        ...group.items.map(([emoji]) => button(emoji))));
    }
  }

  renderGroups('');

  const picker = el('div', { class: 'emoji-picker' }, search, scroll);
  const handle = openPopover(anchor, picker, { placement, className: 'emoji-popover' });
  requestAnimationFrame(() => search.focus());
  return handle;
}
