// The Inbox: saved messages (with reminders) and mentions of you — opened from
// the titlebar. Personal to you; nothing here is visible to anyone else.
import { el, clear, formatStamp } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { openPopover, closePopover, menuItem } from './overlay.js';
import { avatar } from './bits.js';
import {
  openConversation, toggleBookmark, remindBookmark, refreshInbox,
} from '../actions.js';
import { jumpToMessage } from './chat.js';

let activeTab = 'saved';

function goToMessage(channelId, messageId) {
  closePopover();
  const guild = store.guildOfChannel(channelId);
  openConversation(channelId, { guildId: guild?.id || null });
  setTimeout(() => jumpToMessage(messageId), 260);
}

function whenLabel(ts) {
  // formatStamp already handles "Today at …" / "Yesterday at …" nicely.
  return formatStamp(ts);
}

// Reminder presets, computed at click time.
function reminderChoices() {
  const now = new Date();
  const at = (h, m = 0, addDays = 0) => {
    const d = new Date(now); d.setDate(d.getDate() + addDays); d.setHours(h, m, 0, 0); return d.getTime();
  };
  const inHours = (h) => Date.now() + h * 3_600_000;
  const eveningToday = at(18) > Date.now() ? at(18) : at(18, 0, 1);
  return [
    { label: 'In 1 hour', at: inHours(1) },
    { label: 'In 3 hours', at: inHours(3) },
    { label: 'This evening', at: eveningToday },
    { label: 'Tomorrow morning', at: at(9, 0, 1) },
  ];
}

function openReminderMenu(anchor, bookmark) {
  const items = reminderChoices().map((c) => menuItem({
    label: c.label, iconName: 'clock',
    onSelect: () => remindBookmark(bookmark.id, c.at),
  }));
  if (bookmark.remindAt) {
    items.push(menuItem({
      label: 'Clear reminder', iconName: 'close', danger: true,
      onSelect: () => remindBookmark(bookmark.id, null),
    }));
  }
  openPopover(anchor, el('div', { class: 'menu' }, ...items), { placement: 'bottom-end' });
}

function savedRow(bookmark) {
  const author = store.user(bookmark.snapshot?.authorId);
  const due = store.inbox.due.has(bookmark.id);
  const preview = bookmark.snapshot?.preview
    || (bookmark.snapshot?.hasPoll ? 'A poll' : bookmark.snapshot?.hasAttachments ? 'An attachment' : 'A message');

  const remind = el('button', {
    class: `inbox-row__act${bookmark.remindAt ? ' is-set' : ''}`,
    type: 'button',
    title: bookmark.remindAt ? `Reminder ${whenLabel(bookmark.remindAt)}` : 'Remind me',
    onClick: (e) => { e.stopPropagation(); openReminderMenu(e.currentTarget, bookmark); },
  }, icon('clock'));

  const remove = el('button', {
    class: 'inbox-row__act', type: 'button', title: 'Remove',
    onClick: (e) => { e.stopPropagation(); toggleBookmark(bookmark.channelId, bookmark.messageId); },
  }, icon('bookmark'));

  return el('div', {
    class: `inbox-row${due ? ' inbox-row--due' : ''}`,
    role: 'button', tabindex: '0',
    onClick: () => goToMessage(bookmark.channelId, bookmark.messageId),
  },
    avatar(author || { displayName: '?', avatarColor: 'var(--offline)' }, { status: false, size: 'sm' }),
    el('div', { class: 'inbox-row__main' },
      el('div', { class: 'inbox-row__top' },
        el('span', { class: 'inbox-row__who' }, author?.displayName || 'Someone'),
        el('span', { class: 'inbox-row__when' }, formatStamp(bookmark.createdAt)),
      ),
      el('div', { class: 'inbox-row__text' }, preview),
      bookmark.remindAt
        ? el('div', { class: `inbox-row__badge${due ? ' is-due' : ''}` },
            icon('clock'), el('span', {}, due ? 'Reminder due' : `Reminder ${whenLabel(bookmark.remindAt)}`))
        : null,
    ),
    el('div', { class: 'inbox-row__acts' }, remind, remove),
  );
}

function mentionRow(m) {
  const author = store.user(m.authorId);
  const channel = store.channel(m.channelId);
  const where = channel ? `#${channel.name}` : 'a conversation';
  return el('div', {
    class: 'inbox-row', role: 'button', tabindex: '0',
    onClick: () => goToMessage(m.channelId, m.messageId),
  },
    avatar(author || { displayName: '?', avatarColor: 'var(--offline)' }, { status: false, size: 'sm' }),
    el('div', { class: 'inbox-row__main' },
      el('div', { class: 'inbox-row__top' },
        el('span', { class: 'inbox-row__who' }, author?.displayName || 'Someone'),
        el('span', { class: 'inbox-row__when' }, formatStamp(m.at)),
      ),
      el('div', { class: 'inbox-row__text' }, `mentioned you in ${where}`),
    ),
  );
}

function dealRow(d) {
  return el('div', {
    class: 'inbox-row', role: 'button', tabindex: '0',
    onClick: () => void import('./steamstore.js').then((m) => m.showSteamApp(d.appid)),
  },
    el('span', { class: 'inbox-row__deal' }, `−${d.discount}%`),
    el('div', { class: 'inbox-row__main' },
      el('div', { class: 'inbox-row__top' },
        el('span', { class: 'inbox-row__who' }, d.name),
        el('span', { class: 'inbox-row__when' }, formatStamp(d.at)),
      ),
      el('div', { class: 'inbox-row__text' },
        `On your wishlist — now ${d.price}${d.originalPrice ? ` (was ${d.originalPrice})` : ''}`),
    ),
  );
}

export function openInbox(anchor) {
  const panel = el('div', { class: 'inbox' });
  const tabs = el('div', { class: 'inbox__tabs' });
  const list = el('div', { class: 'inbox__list' });

  const draw = () => {
    clear(tabs); clear(list);
    const saved = store.inbox.bookmarks;
    const mentions = store.inbox.mentions;
    const deals = store.inbox.deals || [];

    const tabDefs = [['saved', 'Saved', saved.length], ['mentions', 'Mentions', mentions.length]];
    if (store.self?.steamLinked) tabDefs.push(['deals', 'Deals', deals.length]);
    for (const [id, label, count] of tabDefs) {
      tabs.appendChild(el('button', {
        class: `inbox__tab${activeTab === id ? ' is-active' : ''}`,
        type: 'button',
        onClick: () => { activeTab = id; draw(); },
      }, label, count ? el('span', { class: 'inbox__count' }, String(count)) : null));
    }

    const rows = activeTab === 'saved' ? saved.map(savedRow)
      : activeTab === 'deals' ? deals.map(dealRow)
      : mentions.map(mentionRow);
    if (rows.length === 0) {
      list.appendChild(el('div', { class: 'inbox__empty' },
        icon(activeTab === 'saved' ? 'bookmark' : activeTab === 'deals' ? 'steam' : 'at'),
        el('p', {}, activeTab === 'saved'
          ? 'Nothing saved yet. Hover a message and hit the bookmark to keep it here — and set a reminder if you like.'
          : activeTab === 'deals'
            ? 'No deals yet. When a game on your Steam wishlist goes on sale, it shows up here.'
            : 'No mentions yet. When someone @mentions you, it lands here.'),
      ));
    } else {
      rows.forEach((r) => list.appendChild(r));
    }
  };

  draw();
  const onChange = () => draw();
  store.on('inbox', onChange);
  store.on('users', onChange);

  panel.appendChild(el('div', { class: 'inbox__head' }, el('span', {}, 'Inbox')));
  panel.appendChild(tabs);
  panel.appendChild(list);

  // Opening the inbox marks its contents seen and clears fired reminders.
  refreshInbox();
  const handle = openPopover(anchor, panel, { placement: 'bottom-end', className: 'popover--inbox' });
  store.clearInboxDue();

  // Stop listening when the popover closes.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(panel)) {
      store.off?.('inbox', onChange);
      store.off?.('users', onChange);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return handle;
}
