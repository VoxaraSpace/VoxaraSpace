import { el, clear, fuzzyScore, debounce} from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { jumpToMessage } from './chat.js';
import { openConversation, openGuild, openDm, openHome, searchMessages as searchServer} from '../actions.js';
import { avatar, key } from './bits.js';

let overlayNode = null;

/** Everything the switcher can jump to, built fresh each time it opens. */
/**
 * What the switcher searches depends on where you are. In Friends it lists
 * people and conversations; inside a space it lists that space's channels.
 * Listing every channel of every space was noise in both cases.
 */
function currentScope() {
  const guild = store.guild(store.view.guildId);
  if (store.ui.sidebarMode === 'spaces' && guild) return { kind: 'space', guild };
  return { kind: 'friends' };
}

function buildIndex(scope) {
  const entries = [];

  if (scope.kind === 'space') {
    const { guild } = scope;
    for (const channel of guild.channels) {
      entries.push({
        kind: 'channel',
        label: `#${channel.name}`,
        where: guild.name,
        iconName: 'hash',
        unread: store.unreadFor(channel.id),
        run: () => openConversation(channel.id, { guildId: guild.id }),
      });
    }
    // Somewhere to go when you want to leave this space.
    for (const other of store.guilds.values()) {
      if (other.id === guild.id) continue;
      entries.push({
        kind: 'space',
        label: other.name,
        where: 'Space',
        iconName: 'compass',
        run: () => openGuild(other.id),
      });
    }
    return entries;
  }

  entries.push({
    kind: 'view',
    label: 'Direct messages',
    where: 'Home',
    iconName: 'dm',
    run: openHome,
  });

  for (const dm of store.dms.values()) {
    const partnerId = store.dmPartnerId(dm.id);
    const partner = store.user(partnerId);
    entries.push({
      kind: 'dm',
      label: store.userName(partnerId),
      where: 'Direct message',
      user: partner,
      unread: store.unreadFor(dm.id),
      run: () => openConversation(dm.id),
    });
  }

  const seen = new Set(store.dms.size ? [...store.dms.values()].map((dm) => store.dmPartnerId(dm.id)) : []);
  for (const user of store.users.values()) {
    if (user.id === store.selfId || seen.has(user.id)) continue;
    if (!store.isFriend(user.id)) continue;
    entries.push({
      kind: 'person',
      label: user.displayName,
      where: `@${user.username}`,
      user,
      run: () => openDm(user.id),
    });
  }

  return entries;
}

const GROUP_ORDER = ['channel', 'dm', 'person', 'message', 'space', 'view'];
const GROUP_TITLE = {
  channel: 'Channels',
  message: 'Messages',
  dm: 'Direct messages',
  person: 'People',
  space: 'Spaces',
  view: 'Places',
};

export function openQuickSwitcher() {
  if (overlayNode) return;

  const scope = currentScope();
  const index = buildIndex(scope);
  /** Server-side message hits for the current query, appended to the index. */
  let messageHits = [];
  let searchTicket = 0;
  const list = el('div', { class: 'switcher__list', role: 'listbox' });
  let rows = [];
  let cursor = 0;

  const input = el('input', {
    class: 'switcher__input',
    type: 'text',
    placeholder: scope.kind === 'space'
      ? `Jump to a channel in ${scope.guild.name}, or find a message…`
      : 'Jump to a person, or find a message…',
    'aria-label': 'Search',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  function score(entry, query) {
    if (!query) return entry.unread ? 500 + entry.unread : 100;
    return Math.max(fuzzyScore(query, entry.label), fuzzyScore(query, entry.where));
  }

  /**
   * Looks for messages containing the query, scoped to where you are, and adds
   * them under their own heading so you can jump straight to what was said.
   */
  async function searchMessages(query) {
    const ticket = ++searchTicket;
    if (query.length < 2) {
      messageHits = [];
      return;
    }
    const hits = await searchServer(query, scope.kind === 'space' ? { guildId: scope.guild.id } : { dmsOnly: true });
    if (ticket !== searchTicket) return;

    messageHits = hits.slice(0, 8).map((message) => {
      const conversation = store.conversation(message.channelId);
      const isDm = Boolean(store.dm(message.channelId));
      const where = isDm ? `@${conversation?.name || 'Direct message'}` : `#${conversation?.name || 'channel'}`;
      return {
        kind: 'message',
        label: (message.content || '').replace(/\s+/g, ' ').slice(0, 70),
        where: `${store.userName(message.authorId)} · ${where}`,
        iconName: 'search',
        alwaysShow: true,
        run: async () => {
          const guild = store.guildOfChannel(message.channelId);
          if (message.channelId !== store.view.channelId) {
            await openConversation(message.channelId, { guildId: guild?.id || null, focusComposer: false });
          }
          setTimeout(() => jumpToMessage(message.id), 80);
        },
      };
    });
    render();
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    const matches = [...index, ...messageHits]
      .map((entry) => ({ entry, score: entry.alwaysShow ? 900 : score(entry, query) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((item) => item.entry);

    clear(list);
    rows = [];

    if (matches.length === 0) {
      list.appendChild(el('div', { class: 'switcher__empty' },
        input.value.trim().length >= 2
          ? `Nothing matches “${input.value.trim()}”.`
          : 'Type at least two characters to search messages.'));
      return;
    }

    for (const groupKind of GROUP_ORDER) {
      const group = matches.filter((entry) => entry.kind === groupKind);
      if (group.length === 0) continue;
      list.appendChild(el('div', { class: 'switcher__group' }, GROUP_TITLE[groupKind]));
      for (const entry of group) {
        const row = el('button', {
          class: 'switcher__item',
          type: 'button',
          role: 'option',
          onClick: () => choose(entry),
          onMousemove: () => setCursor(rows.indexOf(row)),
        },
        entry.user ? avatar(entry.user, { size: 'sm' }) : icon(entry.iconName || 'hash'),
        el('span', { class: 'switcher__label' }, entry.label),
        entry.unread ? el('span', { class: 'row__badge' }, String(entry.unread)) : null,
        el('span', { class: 'switcher__where' }, entry.where));
        row.__entry = entry;
        rows.push(row);
        list.appendChild(row);
      }
    }

    cursor = 0;
    highlight();
  }

  function setCursor(next) {
    if (next < 0 || next >= rows.length || next === cursor) return;
    cursor = next;
    highlight();
  }

  function highlight() {
    rows.forEach((row, index) => row.classList.toggle('is-active', index === cursor));
    rows[cursor]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(entry) {
    close();
    entry.run();
  }

  const runSearch = debounce(() => searchMessages(input.value.trim()), 200);
  input.addEventListener('input', () => {
    render();
    runSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor(Math.min(cursor + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor(Math.max(cursor - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[cursor];
      if (row) choose(row.__entry);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  const panel = el('div', { class: 'switcher', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick switcher' },
    input,
    list,
    el('div', { class: 'switcher__foot' },
      el('span', {}, key('↑'), key('↓'), ' to move'),
      el('span', {}, key('Enter'), ' to open'),
      el('span', {}, key('Esc'), ' to dismiss'),
    ));

  overlayNode = el('div', { class: 'overlay overlay--top' }, panel);
  overlayNode.addEventListener('mousedown', (event) => {
    if (event.target === overlayNode) close();
  });

  document.getElementById('overlayRoot').appendChild(overlayNode);
  render();
  requestAnimationFrame(() => input.focus());
}

export function close() {
  if (!overlayNode) return;
  overlayNode.remove();
  overlayNode = null;
  document.getElementById('composerInput')?.focus();
}

export const isQuickSwitcherOpen = () => Boolean(overlayNode);
