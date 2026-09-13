import {
  el, clear, append, formatTime, formatStamp, formatFull, formatDayLabel, dayOffset, joinNames, debounce,
} from '../utils.js';
import { icon } from '../icons.js';
import { startCall } from './call.js';
import { store } from '../state.js';
import {
  sendMessage, editMessage, deleteMessage, toggleReaction, loadOlder, loadHistory,
  pingTyping, markRead, retryMessage, toggleMemberList,
  setPinned, fetchPinned, searchMessages as searchServer, openConversation, spaceNotifyLevel,
  createPoll, votePoll, closePoll, copyToClipboard, ensureDm,
  scheduleMessage, cancelScheduled, catchUp, createThread} from '../actions.js';
import { renderMarkdown, highlightMatches } from '../markdown.js';
import { QUICK_REACTIONS, matchEmojiNames } from '../emoji.js';
import { avatar, emptyState } from './bits.js';
import { openPopover, confirmDialog, closePopover, pointAnchor, menuItem, openModal} from './overlay.js';
import { openEmojiPicker } from './emojipicker.js';
import { createMentionAutocomplete } from './mentionpicker.js';
import { createSlashAutocomplete } from './slashpicker.js';
import { openGifPicker } from './gifpicker.js';
import { createEmojiAutocomplete } from './emojiautocomplete.js';
import { toggleRow, choiceRow } from './settingsshell.js';
import { canManage, roleColor } from './spacesettings.js';
import { showUserPopover } from './profile.js';
import { openMessageMenu } from './menus.js';
import { toastSuccess } from './toast.js';
import { showShortcuts, showCreateChannel, showAddFriend, showCreateServer } from './modals.js';
import { desktop, mediaUrl, steamImageUrl, net } from '../client.js';
import { chooseFiles, prepareAttachment } from '../imagepick.js';
import { uploadAttachment, lockThread, peekGuild, joinGuild, openGuild } from '../actions.js';
import { toastError } from './toast.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 90;

let scrollHost;
let composerInput;
/** The message currently being replied to, or null. */
let replyingTo = null;
let composerSend;
let composerCount;
let jumpButton;
let typingBar;
let searchBar;
let searchInput;
let searchCount;

/** Per-channel "you were up to here" markers, captured when a channel opens. */
const unreadMarkers = new Map();
let editingMessageId = null;
let searchQuery = '';
/** Server-side hits for the current query; null until a search has run. */
let searchResults = null;
let loadingOlder = false;
/** Files staged in the composer, not yet sent. */
let pendingAttachments = [];
let trayHost;

export function mountChat() {
  scrollHost = document.getElementById('messageScroll');
  composerInput = document.getElementById('composerInput');
  composerSend = document.getElementById('composerSend');
  composerCount = document.getElementById('composerCount');
  jumpButton = document.getElementById('jumpLatest');
  typingBar = document.getElementById('typingBar');
  searchBar = document.getElementById('chatSearchBar');
  searchInput = document.getElementById('chatSearchInput');
  searchCount = document.getElementById('chatSearchCount');
  trayHost = document.getElementById('composerTray');

  wireComposer();
  wireScroll();
  wireHeader();
  wireSearch();

  store.on('view', onViewChanged);
  // Blocking someone hides their messages, so the view has to redraw.
  store.on('friends', () => renderMessages());
  store.on('messages', onMessagesChanged);
  // Narrow screens: the sidebar slides over the chat; this opens it, and
  // choosing anything in it (a view change) or tapping the backdrop closes it.
  const workspaceEl = document.querySelector('.workspace');
  document.getElementById('chatMenu')?.addEventListener('click', () => workspaceEl?.classList.toggle('sidebar-open'));
  workspaceEl?.addEventListener('click', (event) => { if (event.target === workspaceEl && workspaceEl.classList.contains('sidebar-open')) workspaceEl.classList.remove('sidebar-open'); });
  store.on('view', () => workspaceEl?.classList.remove('sidebar-open'));
  // The "Seen" mark under your last DM message moves as the other side reads.
  store.on('seen', ({ channelId }) => { if (channelId === store.view.channelId) renderSeenMark(); });
  store.on('guilds', renderHeader);
  store.on('users', () => {
    renderHeader();
    renderTyping();
  });
  store.on('typing', renderTyping);
  // Display preferences (density, image handling, timestamps) change how
  // messages are drawn, so repaint them — keeping the reader where they were.
  store.on('ui', () => {
    applyLayout();
    // A forum channel has its own pane (ui/forum.js) — a display-preference
    // change has nothing there to repaint, and calling renderMessages() would
    // just overwrite the post list with an empty "no messages" view.
    if (store.view.channelId && store.channel(store.view.channelId)?.type === 'forum') return;
    const keep = scrollHost?.scrollTop ?? 0;
    const wasAtBottom = isNearBottom();
    renderMessages();
    if (scrollHost) scrollHost.scrollTop = wasAtBottom ? scrollHost.scrollHeight : keep;
  });

  setInterval(renderTyping, 2000);
  applyLayout();
  renderHeader();
  renderMessages();
}

// ------------------------------------------------------------------ layout

export function applyLayout() {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  const conversation = store.conversation();
  const showMembers = store.ui.showMembers && (conversation?.kind === 'channel' || conversation?.kind === 'thread');
  workspace.classList.toggle('no-members', !showMembers);
  document.getElementById('chatToggleMembers')?.setAttribute('aria-pressed', String(showMembers));
}

// ------------------------------------------------------------------ header

function wireHeader() {
  document.getElementById('chatToggleMembers').addEventListener('click', () => toggleMemberList());
  document.getElementById('chatHelp').addEventListener('click', showShortcuts);
  document.getElementById('chatSearch').addEventListener('click', () => toggleSearch());
  document.getElementById('chatPins')
    .addEventListener('click', (event) => void openPinnedPanel(event.currentTarget));
  document.getElementById('chatCatchup')
    .addEventListener('click', () => void showCatchUp(store.view.channelId));
  document.getElementById('chatCall')
    .addEventListener('click', () => { const c = store.conversation(); if (c?.kind === 'dm') startCall(c.partnerId, 'audio'); });
  document.getElementById('chatVideo')
    .addEventListener('click', () => { const c = store.conversation(); if (c?.kind === 'dm') startCall(c.partnerId, 'video'); });
}

// "Catch me up" — a digest of what you missed in this channel.
export async function showCatchUp(channelId) {
  if (!channelId) return;
  const nameOf = (id) => store.userName(id);
  let digest;
  try { digest = await catchUp(channelId); }
  catch (err) { toastError(err.message || 'Could not build a summary.'); return; }

  const body = el('div', { class: 'catchup' });
  if (!digest.count) {
    body.append(el('p', { class: 'field__hint' }, 'You’re all caught up here — nothing new.'));
  } else {
    const names = digest.participants.slice(0, 3).map((p) => p.name);
    const others = digest.participants.length - names.length;
    const who = names.join(', ') + (others > 0 ? ` and ${others} other${others === 1 ? '' : 's'}` : '');
    body.append(el('p', { class: 'catchup__lead' },
      `${digest.count} new message${digest.count === 1 ? '' : 's'}${who ? ` from ${who}` : ''}.`));

    if (digest.mentions.length) {
      body.append(el('div', { class: 'catchup__block' },
        el('div', { class: 'catchup__h' }, 'Mentions of you'),
        ...digest.mentions.map((m) => el('div', { class: 'catchup__item' },
          el('strong', {}, nameOf(m.authorId)), ` ${m.text}`))));
    }
    if (digest.questions.length) {
      body.append(el('div', { class: 'catchup__block' },
        el('div', { class: 'catchup__h' }, 'Open questions'),
        ...digest.questions.map((q) => el('div', { class: 'catchup__item' },
          el('strong', {}, nameOf(q.authorId)), ` ${q.text}`))));
    }
    if (digest.links.length) {
      body.append(el('div', { class: 'catchup__block' },
        el('div', { class: 'catchup__h' }, 'Links shared'),
        ...digest.links.map((href) => el('a', {
          class: 'catchup__link', href, target: '_blank', rel: 'noopener',
          onClick: (e) => { e.preventDefault(); desktop.openExternal(href); },
        }, href))));
    }
  }

  const done = el('button', { class: 'btn btn--primary', type: 'button' }, 'Got it');
  const modal = openModal({ title: 'Catch me up', subtitle: store.channel(channelId) ? `#${store.channel(channelId).name}` : '', body, actions: [done] });
  done.addEventListener('click', () => modal.close());
}

export function renderHeader() {
  const conversation = store.conversation();
  const glyph = document.getElementById('chatGlyph');
  const nameNode = document.getElementById('chatName');
  const topicNode = document.getElementById('chatTopic');
  const breadcrumb = document.getElementById('breadcrumb');

  clear(glyph);
  clear(breadcrumb);

  const catchupBtn = document.getElementById('chatCatchup');
  if (catchupBtn) catchupBtn.hidden = !(conversation && (store.unreads.get(store.view.channelId) || 0) > 0);

  if (!conversation) {
    nameNode.textContent = store.view.kind === 'home' ? 'Direct messages' : 'No channel selected';
    topicNode.textContent = '';
    glyph.appendChild(icon(store.view.kind === 'home' ? 'dm' : 'hash'));
    breadcrumb.appendChild(el('span', { class: 'breadcrumb__item breadcrumb__item--muted' }, 'Nothing open'));
    return;
  }

  const callBtn = document.getElementById('chatCall');
  const videoBtn = document.getElementById('chatVideo');
  if (callBtn) callBtn.hidden = conversation.kind !== 'dm';
  if (videoBtn) videoBtn.hidden = conversation.kind !== 'dm';
  const lockBtn = threadLockButton();
  lockBtn.hidden = true;

  if (conversation.kind === 'dm') {
    const partner = store.user(conversation.partnerId);
    glyph.appendChild(icon('at'));
    nameNode.textContent = conversation.name;
    topicNode.textContent = partner?.customStatus || '';
    append(breadcrumb, [
      el('span', { class: 'breadcrumb__item' }, 'Direct messages'),
      el('span', { class: 'breadcrumb__sep' }, '›'),
      el('span', { class: 'breadcrumb__item breadcrumb__item--current' }, conversation.name),
    ]);
  } else if (conversation.kind === 'thread') {
    const thread = store.channel(conversation.id);
    glyph.appendChild(icon(thread?.locked ? 'lock' : 'chat'));
    nameNode.textContent = conversation.name;
    topicNode.textContent = (conversation.parent ? `Thread from #${conversation.parent.name}` : 'Thread')
      + (thread?.locked ? ' · Locked' : '');
    if (conversation.guild && canManage(conversation.guild, 'manageMessages')) {
      lockBtn.hidden = false;
      lockBtn.classList.toggle('is-on', Boolean(thread?.locked));
      lockBtn.title = thread?.locked ? 'Unlock this thread' : 'Lock this thread';
      lockBtn.setAttribute('aria-label', lockBtn.title);
      lockBtn.onclick = () => lockThread(conversation.id, !thread?.locked);
    }
    const backLabel = conversation.parent ? `#${conversation.parent.name}` : 'Channel';
    const back = el('button', { class: 'breadcrumb__item breadcrumb__item--link', type: 'button' }, backLabel);
    back.addEventListener('click', () => openConversation(conversation.parentChannelId, { guildId: conversation.guild?.id }));
    append(breadcrumb, [
      el('span', { class: 'breadcrumb__item' }, conversation.guild?.name || 'Space'),
      el('span', { class: 'breadcrumb__sep' }, '›'),
      back,
      el('span', { class: 'breadcrumb__sep' }, '›'),
      el('span', { class: 'breadcrumb__item breadcrumb__item--current' }, conversation.name),
    ]);
  } else {
    glyph.appendChild(icon('hash'));
    // The hash is typographic here, not an icon — the glyph slot is hidden.
    nameNode.textContent = `#${conversation.name}`;
    topicNode.textContent = conversation.topic || '';
    append(breadcrumb, [
      el('span', { class: 'breadcrumb__item' }, conversation.guild?.name || 'Space'),
      el('span', { class: 'breadcrumb__sep' }, '›'),
      el('span', { class: 'breadcrumb__item breadcrumb__item--current' }, `#${conversation.name}`),
    ]);
  }
}

// ------------------------------------------------------------------- state

function onViewChanged({ previous, view }) {
  if (previous.channelId !== view.channelId) {
    editingMessageId = null;
    searchQuery = '';
    if (searchBar) searchBar.hidden = true;
    // Leaving a channel retires its "New messages" line — it has been read now.
    if (previous.channelId) unreadMarkers.delete(previous.channelId);
    if (view.channelId && !unreadMarkers.has(view.channelId)) {
      const marker = store.reads[view.channelId];
      if (store.unreadFor(view.channelId) > 0) unreadMarkers.set(view.channelId, marker || '');
    }
    // Whatever you were typing stays with that conversation and comes back
    // when you return to it, here and across restarts.
    if (previous.channelId) saveDraft(previous.channelId, composerInput.value);
    composerInput.value = view.channelId ? loadDraft(view.channelId) : '';
    autosize();
  }
  renderHeader();

  // A forum channel has no message list of its own — every post is a thread
  // — so it gets a completely different body (see ui/forum.js) and no composer.
  const isForum = view.channelId && store.channel(view.channelId)?.type === 'forum';
  const composerEl = document.getElementById('composer');
  const typingEl = document.getElementById('typingBar');
  if (composerEl) composerEl.hidden = isForum;
  if (typingEl) typingEl.hidden = isForum;

  if (isForum) {
    void import('./forum.js').then((m) => m.renderForumPane(view.channelId));
  } else {
    renderComposerState();
    renderMessages({ jump: true });
    renderTyping();
  }
  applyLayout();
}

// Swap one message's DOM node in place, with no scroll-affecting rebuild of
// anything around it. Safe whenever the edit can't change grouping or day
// dividers — true for both a pending->confirmed swap and a text edit, since
// neither touches authorId or createdAt. Returns false if the node wasn't
// found (e.g. mid-search, where rows aren't message nodes at all), so the
// caller can fall back to a full render.
function patchMessageNode(selector, message) {
  if (searchQuery) return false;
  const old = scrollHost.querySelector(selector);
  if (!old) return false;
  const list = store.messagesFor(message.channelId);
  const index = list.findIndex((m) => m.id === message.id);
  const previous = index > 0 ? list[index - 1] : null;
  old.replaceWith(messageNode(message, previous));
  return true;
}

/** Same, looked up by id in the open conversation — used to toggle a row into
 * and out of its inline editor (messageNode() consults `editingMessageId`). */
function patchMessageById(messageId) {
  if (!messageId) return false;
  const message = store.messagesFor(store.view.channelId).find((m) => m.id === messageId);
  return Boolean(message) && patchMessageNode(`[data-message-id="${CSS.escape(messageId)}"]`, message);
}

function onMessagesChanged({ channelId, reason, message, nonce }) {
  if (channelId !== store.view.channelId) return;
  queueMicrotask(renderSeenMark);

  if (reason === 'append') {
    const stick = isNearBottom();
    // The first message replaces the "no messages yet" placeholder, so that
    // one case needs a full render rather than an append.
    if (store.messagesFor(channelId).length <= 1) {
      renderMessages({ jump: true });
    } else {
      appendMessage(message);
      if (stick || message.authorId === store.selfId) { scrollToBottom(); stickBottomThroughImageLoads(); }
      else showJumpButton(true);
    }
    if (message.authorId !== store.selfId && document.hasFocus() && stick) markRead(channelId);
    return;
  }

  if (reason === 'prepend') {
    const previousHeight = scrollHost.scrollHeight;
    const previousTop = scrollHost.scrollTop;
    renderMessages();
    scrollHost.scrollTop = scrollHost.scrollHeight - previousHeight + previousTop;
    return;
  }

  // The server confirming a just-sent message, or an edit (yours or someone
  // else's) landing: patch that one row in place. Sending/editing used to
  // fall into the full-rebuild branch below, which briefly emptied and
  // rebuilt the whole scrollHost — with the composer's height also changing
  // at the same moment on send, that showed up as the view visibly jolting.
  if (reason === 'confirm' && patchMessageNode(`[data-nonce="${CSS.escape(nonce)}"]`, message)) return;
  if (reason === 'update' && patchMessageNode(`[data-message-id="${CSS.escape(message.id)}"]`, message)) return;

  const keepScroll = scrollHost.scrollTop;
  const wasAtBottom = isNearBottom();
  renderMessages({ jump: reason === 'replace' });
  if (reason !== 'replace') {
    scrollHost.scrollTop = wasAtBottom ? scrollHost.scrollHeight : keepScroll;
  }
}

// ---------------------------------------------------------------- messages

export function renderMessages({ jump = false } = {}) {
  if (!scrollHost) return;
  const channelId = store.view.channelId;
  const conversation = store.conversation();

  // A forum channel's body belongs to ui/forum.js (the post list lives in
  // this same element). Every caller that repaints messages — reconnects
  // reloading history, preference changes, message events — must leave it
  // alone, or the posts vanish and a blank pane is left behind.
  if (channelId && store.channel(channelId)?.type === 'forum') return;
  clear(scrollHost);

  if (!channelId || !conversation) {
    scrollHost.appendChild(noConversationState());
    showJumpButton(false);
    return;
  }

  if (!store.loaded.has(channelId)) {
    scrollHost.appendChild(el('div', { class: 'empty-state' },
      el('p', {}, 'Loading messages…')));
    return;
  }

  const all = store.messagesFor(channelId);

  // A search shows results from the server, which covers the whole history
  // rather than only the messages already loaded into this view.
  if (searchQuery) {
    renderSearchResults();
    return;
  }
  const list = all;

  if (!searchQuery) {
    if (store.hasMore.get(channelId)) {
      // With auto-loading off this button is the only way back through history.
      scrollHost.appendChild(el('div', { class: 'history-top' },
        el('button', {
          type: 'button',
          onClick: () => void loadMoreHistory(),
        }, 'Load earlier messages')));
    } else {
      scrollHost.appendChild(conversationIntro(conversation));
    }
  }

  if (list.length === 0) {
    scrollHost.appendChild(el('div', { class: 'empty-state', style: { flex: '0 0 auto', paddingTop: '30px' } },
      el('p', {}, searchQuery ? 'Nothing here matches your search.' : 'No messages yet — say hello.')));
    showJumpButton(false);
    return;
  }

  const marker = unreadMarkers.get(channelId);
  let previous = null;
  let dividerShown = false;

  for (const message of list) {
    if (!searchQuery && shouldShowDayDivider(previous, message)) {
      scrollHost.appendChild(el('div', { class: 'divider' }, formatDayLabel(message.createdAt)));
      previous = null;
    }
    if (!dividerShown && marker !== undefined && !searchQuery
      && message.id > marker && message.authorId !== store.selfId) {
      scrollHost.appendChild(el('div', { class: 'divider divider--unread' }, 'New messages'));
      dividerShown = true;
      previous = null;
    }
    scrollHost.appendChild(messageNode(message, previous));
    previous = message;
  }

  // scrollToBottom hides the button itself once the frame lands; checking now
  // would only make it flash.
  if (jump) { scrollToBottom(); stickBottomThroughImageLoads(); }
  else updateJumpVisibility();
}

/** Renders server search hits as a flat, clickable list. */
function renderSearchResults() {
  const hits = searchResults;
  if (hits === null) {
    searchCount.textContent = 'Searching…';
    scrollHost.appendChild(el('div', { class: 'empty-state' }, el('p', {}, 'Searching…')));
    return;
  }

  searchCount.textContent = hits.length === 0
    ? 'No matches'
    : `${hits.length}${hits.length === 50 ? '+' : ''} match${hits.length === 1 ? '' : 'es'}`;

  if (hits.length === 0) {
    scrollHost.appendChild(el('div', { class: 'empty-state', style: { flex: '0 0 auto', paddingTop: '30px' } },
      el('p', {}, 'Nothing matches that search.')));
    showJumpButton(false);
    return;
  }

  const list = el('div', { class: 'searchresults' });
  for (const hit of hits) {
    const author = store.user(hit.authorId);
    const conversation = store.conversation(hit.channelId);
    const where = store.dm(hit.channelId)
      ? `@${conversation?.name || 'Direct message'}`
      : `#${conversation?.name || 'channel'}`;

    const row = el('button', {
      class: 'searchresult',
      type: 'button',
      onClick: () => void openSearchHit(hit),
    },
    el('div', { class: 'searchresult__head' },
      el('span', { class: 'searchresult__author' }, author?.displayName || 'Unknown'),
      el('span', { class: 'searchresult__where' }, where),
      el('span', { class: 'searchresult__time' }, formatDayLabel(hit.createdAt))),
    el('div', { class: 'searchresult__body' }, (hit.content || '').slice(0, 240)));

    highlightMatches(row.querySelector('.searchresult__body'), searchQuery);
    list.appendChild(row);
  }
  scrollHost.appendChild(list);
  showJumpButton(false);
}

/** Opens the conversation a hit belongs to, then jumps to the message. */
async function openSearchHit(hit) {
  if (hit.channelId !== store.view.channelId) {
    const guild = store.guildOfChannel(hit.channelId);
    await openConversation(hit.channelId, { guildId: guild?.id || null, focusComposer: false });
  }
  toggleSearch(false);
  // Let the re-render land before looking for the node.
  setTimeout(() => jumpToMessage(hit.id), 60);
}

function shouldShowDayDivider(previous, message) {
  if (!previous) return true;
  return dayOffset(previous.createdAt) !== dayOffset(message.createdAt);
}

function isGrouped(previous, message) {
  if (!previous) return false;
  // A collapsed block sits between them, so the next message starts a group.
  if (store.isBlocked(previous.authorId) && !revealedBlocked.has(previous.id)) return false;
  if (previous.authorId !== message.authorId) return false;
  if (message.createdAt - previous.createdAt > GROUP_WINDOW_MS) return false;
  return dayOffset(previous.createdAt) === dayOffset(message.createdAt);
}

function appendMessage(message) {
  const list = store.messagesFor(message.channelId);
  const index = list.findIndex((m) => m.id === message.id);
  const previous = index > 0 ? list[index - 1] : null;

  if (shouldShowDayDivider(previous, message)) {
    scrollHost.appendChild(el('div', { class: 'divider' }, formatDayLabel(message.createdAt)));
    scrollHost.appendChild(messageNode(message, null));
    return;
  }
  scrollHost.appendChild(messageNode(message, previous));
}

/** Messages from blocked people, revealed one at a time on request. */
const revealedBlocked = new Set();

/**
 * A collapsed stand-in for a blocked person's message. Blocking should mean you
 * stop seeing them everywhere — spaces included — but the message is still
 * reachable, because a hidden reply can leave a conversation nonsensical.
 */
function blockedMessageNode(message) {
  const node = el('div', {
    class: 'msg msg--blocked',
    dataset: { messageId: message.id },
    onContextMenu: (event) => {
      event.preventDefault();
      openMessageMenu(pointAnchor(event.clientX, event.clientY), message,
        { guild: store.guildOfChannel(message.channelId) });
    },
  });

  node.appendChild(el('span', { class: 'msg__blockedtext' }, 'Message from someone you blocked'));
  node.appendChild(el('button', {
    class: 'msg__blockedshow',
    type: 'button',
    onClick: () => {
      revealedBlocked.add(message.id);
      renderMessages();
    },
  }, 'Show'));
  return node;
}

function messageNode(message, previous) {
  if (store.isBlocked(message.authorId) && !revealedBlocked.has(message.id)) {
    return blockedMessageNode(message);
  }
  const grouped = isGrouped(previous, message);
  const author = store.user(message.authorId);
  const mentionsMe = Array.isArray(message.mentions) && message.mentions.includes(store.selfId);

  const node = el('div', {
    class: [
      'msg',
      grouped ? '' : 'msg--group-start',
      mentionsMe ? 'msg--mention' : '',
      message.pending ? 'msg--pending' : '',
      message.failed ? 'msg--failed' : '',
    ].filter(Boolean).join(' '),
    dataset: { messageId: message.id, nonce: message.nonce || '' },
    onContextMenu: (event) => {
      if (event.target.closest('a, button, input, textarea')) return;
      event.preventDefault();
      openMessageMenu(pointAnchor(event.clientX, event.clientY), message,
        { guild: store.guildOfChannel(message.channelId) });
    },
  });

  // A reply shows a one-line quote of its parent, which jumps to it when clicked.
  if (message.replyTo) node.appendChild(replyPreview(message));
  if (message.forwardedFrom) node.appendChild(forwardLine(message.forwardedFrom));

  // Gutter: avatar for the first message of a group, hover timestamp otherwise.
  const gutter = el('div', { class: 'msg__gutter' });
  if (grouped) {
    gutter.appendChild(el('span', { class: 'msg__stamp' }, formatTime(message.createdAt)));
  } else {
    const face = avatar(author || { displayName: 'Unknown', avatarColor: 'var(--offline)' }, { status: false });
    face.style.cursor = 'pointer';
    face.addEventListener('click', () => showUserPopover(face, message.authorId, { placement: 'right-start', guild: store.conversation()?.guild }));
    gutter.appendChild(face);
  }
  node.appendChild(gutter);

  const content = el('div', { class: 'msg__content' });

  if (!grouped) {
    // A name takes its space role's colour (highest coloured role wins);
    // otherwise bylines stay uniform and identity colour lives in the avatar.
    const nameColor = roleColor(store.conversation()?.guild, message.authorId);
    const authorName = el('span', {
      class: 'msg__author',
      role: 'button',
      tabindex: '0',
      ...(nameColor ? { style: { color: nameColor } } : {}),
      onClick: (event) => showUserPopover(event.currentTarget, message.authorId, { guild: store.conversation()?.guild }),
      onKeydown: (event) => {
        if (event.key === 'Enter') showUserPopover(event.currentTarget, message.authorId, { guild: store.conversation()?.guild });
      },
    }, store.userName(message.authorId));

    content.appendChild(el('div', { class: 'msg__head' },
      authorName,
      store.user(message.authorId)?.bot ? el('span', { class: 'tag-bot' }, 'BOT') : null,
      el('span', { class: 'msg__time', title: formatFull(message.createdAt) }, formatStamp(message.createdAt)),
    ));
  }

  if (editingMessageId === message.id) {
    content.appendChild(inlineEditor(message));
  } else {
    const body = el('div', { class: 'msg__body' });
    body.appendChild(renderMarkdown(message.content, {
      selfUsername: store.self?.username,
      knownUsernames: store.knownUsernames(),
      knownChannels: channelMapFor(message.channelId),
      emojis: emojiMapFor(message.channelId),
      reduceFlashing: reduceFlashing(),
    }));
    if (message.editedAt) {
      body.appendChild(el('span', {
        class: 'msg__edited',
        title: `Edited ${formatFull(message.editedAt)}`,
      }, '(edited)'));
    }
    if (searchQuery) highlightMatches(body, searchQuery);
    if (message.content) content.appendChild(body);

    const attached = attachmentsFor(message);
    if (attached) content.appendChild(attached);

    if (message.poll) content.appendChild(pollCard(message));

    // An invite link becomes a card (name, members, Join) instead of a plain preview.
    const inviteCodes = [...new Set([...String(message.content || '').matchAll(/https?:\/\/[^\s<]+\/(?:invite|join)\/([A-Za-z0-9-]{4,16})/gi)].map((m) => m[1].toUpperCase()))].slice(0, 3);
    for (const code of inviteCodes) content.appendChild(inviteCard(code));
    if (Array.isArray(message.embeds)) {
      for (const embed of message.embeds) { if (inviteCodes.length && /\/(?:invite|join)\//i.test(embed.url || '')) continue; content.appendChild(embedCard(embed)); }
    }

    if (message.failed) {
      content.appendChild(el('div', { class: 'msg__editor-hint' },
        'Not sent. ',
        el('button', {
          type: 'button',
          onClick: () => retryMessage(message.channelId, message.nonce),
        }, 'Try again'),
      ));
    }

    const reactionRow = reactions(message);
    if (reactionRow) content.appendChild(reactionRow);

    if (message.threadId) {
      const guild = store.guildOfChannel(message.channelId);
      const strip = el('button', { class: 'msg__threadlink', type: 'button' },
        icon('chat'),
        el('span', {}, store.thread(message.threadId)?.name || 'Thread'));
      strip.addEventListener('click', () => openConversation(message.threadId, { guildId: guild?.id }));
      content.appendChild(strip);
    }
  }

  node.appendChild(content);

  if (!message.pending && !message.failed && editingMessageId !== message.id) {
    node.appendChild(messageTools(message));
  }

  return node;
}

// Map of :name: -> media URL for the space a channel belongs to (null in DMs).
function emojiMapFor(channelId) {
  const guild = store.guildOfChannel(channelId);
  if (!guild?.emojis?.length) return null;
  const map = {};
  for (const e of guild.emojis) map[e.name] = mediaUrl(e.url);
  return map;
}

// Render an emoji (unicode, or a :name: custom emoji shown as an image) into a
// span with the given text class, so reactions and polls render alike.
function emojiGlyph(emoji, channelId, textClass) {
  const custom = /^:([a-z0-9_]{2,32}):$/i.exec(emoji);
  if (custom) {
    const url = emojiMapFor(channelId)?.[custom[1].toLowerCase()];
    if (url) {
      // Photosensitivity: an animated (GIF) emoji can't be frozen client-side
      // (cross-origin canvas taint), so show its :name: instead of the motion.
      if (reduceFlashing() && /\.gif(\?|$)/i.test(url)) {
        return el('span', { class: 'emoji-muted', title: `${emoji} (animated — hidden)` }, emoji);
      }
      return el('img', { class: 'custom-emoji', src: url, alt: emoji });
    }
  }
  return el('span', { class: textClass }, emoji);
}

/** True when the signed-in account has asked to reduce flashing/motion. */
function reduceFlashing() {
  return Boolean(store.self?.reduceFlashing);
}

/** A click-to-play gate for a full-size animated image (no autoplay). */
function gifGate(src, alt) {
  const holder = el('button', {
    class: 'gif-gate', type: 'button',
    title: 'This image contains motion — click to play',
    'aria-label': `Play animated image${alt ? ` ${alt}` : ''}`,
  }, el('span', { class: 'gif-gate__label' }, '▶ GIF — click to play'));
  holder.addEventListener('click', () => {
    holder.replaceChildren(el('img', { class: 'gif-gate__img', src, alt: alt || '' }));
    holder.classList.add('is-playing');
  }, { once: true });
  return holder;
}

function reactionGlyph(emoji, channelId) {
  return emojiGlyph(emoji, channelId, 'reaction__emoji');
}

function reactions(message) {
  const entries = Object.entries(message.reactions || {});
  if (entries.length === 0) return null;

  const row = el('div', { class: 'reactions' });
  for (const [emoji, userIds] of entries) {
    const mine = userIds.includes(store.selfId);
    const names = userIds.map((id) => store.userName(id));
    row.appendChild(el('button', {
      class: `reaction${mine ? ' is-mine' : ''}`,
      type: 'button',
      title: `${joinNames(names)} reacted with ${emoji}`,
      onClick: () => toggleReaction(message.channelId, message.id, emoji),
    },
    reactionGlyph(emoji, message.channelId),
    el('span', {}, String(userIds.length))));
  }

  row.appendChild(el('button', {
    class: 'reaction reaction--add',
    type: 'button',
    title: 'Add a reaction',
    'aria-label': 'Add a reaction',
    onClick: (event) => openEmojiPicker(
      event.currentTarget,
      (emoji) => toggleReaction(message.channelId, message.id, emoji),
      { placement: 'top-start' },
    ),
  }, icon('smile')));

  return row;
}

// A link preview card. Text comes from the server's SSRF-guarded fetch; the
// thumbnail is loaded client-side (the CSP permits http/https images).
// One lookup per code per minute keeps re-renders from hammering the server.
const inviteCache = new Map();
function inviteCard(code) {
  const card = el('div', { class: 'invitecard' });
  const icon = el('div', { class: 'invitecard__icon' }, '?');
  const name = el('div', { class: 'invitecard__name' }, 'Loading invite…');
  const meta = el('div', { class: 'invitecard__meta' }, '');
  const action = el('button', { class: 'btn btn--sm btn--primary', type: 'button', disabled: true }, 'Join');
  card.append(icon, el('div', { class: 'invitecard__text' }, el('div', { class: 'invitecard__label' }, 'Space invite'), name, meta), action);
  const paint = (info) => {
    if (!info) { name.textContent = 'This invite is no longer valid'; meta.textContent = ''; action.hidden = true; card.classList.add('is-dead'); return; }
    const g = info.guild;
    icon.textContent = String(g.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    icon.style.background = g.iconColor || 'var(--accent)';
    name.textContent = g.name;
    meta.textContent = `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}${g.description ? ` · ${g.description}` : ''}`;
    const member = info.alreadyMember || store.guild(g.id);
    action.textContent = member ? 'Open' : 'Join';
    action.disabled = false;
    action.onclick = async () => {
      action.disabled = true;
      try { if (member) openGuild(g.id); else { await joinGuild(code); } }
      catch (err) { toastError(err.message || 'Could not join.'); action.disabled = false; }
    };
  };
  const cached = inviteCache.get(code);
  if (cached && cached.at > Date.now() - 60_000) paint(cached.info);
  else {
    peekGuild(code).then((info) => { inviteCache.set(code, { at: Date.now(), info }); paint(info); })
      .catch(() => { inviteCache.set(code, { at: Date.now(), info: null }); paint(null); });
  }
  return card;
}

function embedCard(embed) {
  // A shared Steam game renders as a rich card that opens the full in-app page.
  if (embed.kind === 'steamgame') return steamGameCard(embed);
  // A bot- or webhook-authored embed (see BOTS.md) — arbitrary title, text,
  // fields and images the sender composed, not something we scraped.
  if (embed.kind === 'rich') return richEmbedCard(embed);

  const card = el('div', { class: 'embed' });
  const text = el('div', { class: 'embed__text' });
  if (embed.siteName) text.appendChild(el('div', { class: 'embed__site' }, embed.siteName));
  if (embed.title) {
    text.appendChild(el('a', {
      class: 'embed__title', href: embed.url, target: '_blank', rel: 'noopener',
      onClick: (e) => { e.preventDefault(); desktop.openExternal(embed.url); },
    }, embed.title));
  }
  if (embed.description) text.appendChild(el('div', { class: 'embed__desc' }, embed.description));
  card.appendChild(text);
  // Photosensitivity: drop an animated (GIF) preview thumbnail entirely.
  const animatedThumb = reduceFlashing() && /\.gif(\?|$)/i.test(embed.image || '');
  if (embed.image && !animatedThumb) {
    const img = el('img', { class: 'embed__img', src: mediaUrl(embed.image), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }
  return card;
}

/** A bot/webhook's own embed: title, text, name/value fields, images. */
function richEmbedCard(embed) {
  const openLink = (url) => (e) => { e.preventDefault(); desktop.openExternal(url); };
  const mdOpts = { reduceFlashing: reduceFlashing() };

  const card = el('div', {
    class: 'embed embed--rich',
    style: embed.color ? { borderLeftColor: embed.color } : {},
  });
  const main = el('div', { class: 'embed__main' });

  if (embed.author) {
    main.appendChild(embed.author.url
      ? el('a', { class: 'embed__author', href: embed.author.url, target: '_blank', rel: 'noopener', onClick: openLink(embed.author.url) }, embed.author.name)
      : el('div', { class: 'embed__author' }, embed.author.name));
  }
  if (embed.title) {
    main.appendChild(embed.url
      ? el('a', { class: 'embed__title', href: embed.url, target: '_blank', rel: 'noopener', onClick: openLink(embed.url) }, embed.title)
      : el('div', { class: 'embed__title' }, embed.title));
  }
  if (embed.description) {
    main.appendChild(el('div', { class: 'embed__desc' }, renderMarkdown(embed.description, mdOpts)));
  }
  if (Array.isArray(embed.fields) && embed.fields.length) {
    main.appendChild(el('div', { class: 'embed__fields' },
      ...embed.fields.map((field) => el('div', { class: `embed__field${field.inline ? ' embed__field--inline' : ''}` },
        el('div', { class: 'embed__field-name' }, field.name),
        el('div', { class: 'embed__field-value' }, renderMarkdown(field.value, mdOpts))))));
  }
  if (embed.image) {
    const img = el('img', { class: 'embed__rich-img', src: mediaUrl(embed.image), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.remove());
    main.appendChild(img);
  }
  if (embed.footer || embed.timestamp) {
    main.appendChild(el('div', { class: 'embed__footer' },
      [embed.footer?.text, embed.timestamp ? formatFull(embed.timestamp) : null].filter(Boolean).join(' · ')));
  }
  card.appendChild(main);

  if (embed.thumbnail) {
    const thumb = el('img', { class: 'embed__thumb', src: mediaUrl(embed.thumbnail), alt: '', loading: 'lazy' });
    thumb.addEventListener('error', () => thumb.remove());
    card.appendChild(thumb);
  }
  return card;
}

/** A shared game: cover art (proxied), price/discount, opens the store page. */
function steamGameCard(embed) {
  const art = el('span', { class: 'gamecard__art' });
  const img = el('img', { src: steamImageUrl(embed.appid, 'capsule'), alt: '', loading: 'lazy', draggable: 'false' });
  img.addEventListener('error', () => { img.remove(); art.classList.add('is-missing'); art.append(icon('steam')); });
  art.append(img);

  return el('button', {
    class: 'gamecard', type: 'button', title: 'View on Steam',
    onClick: () => void import('./steamstore.js').then((m) => m.showSteamApp(embed.appid)),
  },
    art,
    el('span', { class: 'gamecard__body' },
      el('span', { class: 'gamecard__eyebrow' }, 'Steam'),
      el('span', { class: 'gamecard__name' }, embed.name || 'Game'),
      embed.reviews ? el('span', { class: 'gamecard__reviews' }, embed.reviews) : null),
    el('span', { class: 'gamecard__price' },
      embed.discount ? el('span', { class: 'gaming__discount' }, `−${embed.discount}%`) : null,
      embed.originalPrice ? el('span', { class: 'store__was' }, embed.originalPrice) : null,
      embed.price ? el('span', { class: 'store__price' }, embed.price) : null));
}

// A poll rendered inside a message: the question, a voteable row per option
// with a live result bar, and a footer with the total and status.
function pollCard(message) {
  const poll = message.poll;
  const votes = poll.votes || {};
  const isClosed = poll.closed || (poll.closesAt && poll.closesAt <= Date.now());
  const total = Object.values(votes).reduce((n, arr) => n + arr.length, 0);
  const myVotes = new Set(
    Object.entries(votes).filter(([, arr]) => arr.includes(store.selfId)).map(([id]) => id),
  );
  const leader = Math.max(0, ...poll.options.map((o) => (votes[o.id] || []).length));
  const showResults = total > 0 || isClosed;

  const card = el('div', { class: `poll${isClosed ? ' poll--closed' : ''}` });

  // Identity eyebrow + question.
  const kicker = isClosed ? 'Final results' : poll.multi ? 'Poll · pick any' : 'Poll';
  card.appendChild(el('div', { class: 'poll__eyebrow' }, icon('list'), el('span', {}, kicker)));
  card.appendChild(el('div', { class: 'poll__q' }, poll.question));

  const list = el('div', { class: 'poll__options' });
  for (const option of poll.options) {
    const count = (votes[option.id] || []).length;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const mine = myVotes.has(option.id);
    const winning = showResults && count > 0 && count === leader;

    const row = el('button', {
      class: `poll__opt${mine ? ' is-mine' : ''}${winning ? ' is-winning' : ''}${isClosed ? ' is-locked' : ''}`,
      type: 'button',
      disabled: isClosed || undefined,
      title: showResults ? `${count} vote${count === 1 ? '' : 's'}` : (isClosed ? '' : 'Vote'),
      onClick: () => { if (!isClosed) votePoll(message.channelId, message.id, option.id); },
    },
      showResults ? el('span', { class: 'poll__fill', style: { width: `${pct}%` } }) : null,
      el('span', { class: `poll__mark${mine ? ' is-on' : ''}` }, mine ? icon('check') : null),
      option.emoji ? emojiGlyph(option.emoji, message.channelId, 'poll__emoji') : null,
      el('span', { class: 'poll__label' }, option.text),
      showResults
        ? el('span', { class: 'poll__stats' },
            el('span', { class: 'poll__count' }, String(count)),
            el('span', { class: 'poll__pct' }, `${pct}%`))
        : null,
    );
    list.appendChild(row);
  }
  card.appendChild(list);

  const bits = [`${total} vote${total === 1 ? '' : 's'}`];
  if (!isClosed && poll.closesAt) bits.push(`ends ${formatStamp(poll.closesAt)}`);
  else if (isClosed) bits.push('closed');
  const foot = el('div', { class: 'poll__foot' }, el('span', { class: 'poll__meta' }, bits.join(' · ')));

  // The author can end it early (moderators can too, server-side).
  if (!isClosed && message.authorId === store.selfId) {
    foot.appendChild(el('button', {
      class: 'poll__end', type: 'button',
      onClick: () => closePoll(message.channelId, message.id),
    }, 'End poll'));
  }
  card.appendChild(foot);
  return card;
}

/** The quoted line shown above a reply. */
function replyPreview(message) {
  const parent = store.message(message.channelId, message.replyTo);
  const row = el('div', { class: 'msg__replyline' });
  row.appendChild(el('span', { class: 'msg__replyicon' }, icon('reply')));

  if (!parent) {
    row.appendChild(el('span', { class: 'msg__replygone' }, 'Original message was deleted'));
    return row;
  }

  const author = store.user(parent.authorId);
  row.appendChild(el('span', { class: 'msg__replyauthor' }, author?.displayName || 'Unknown'));
  const text = (parent.content || '').replace(/\s+/g, ' ').trim()
    || (parent.attachments?.length ? 'Attachment' : '');
  row.appendChild(el('span', { class: 'msg__replytext' }, text.slice(0, 120)));

  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Jump to the message from ${author?.displayName || 'Unknown'}`);
  const go = () => jumpToMessage(parent.id);
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  return row;
}

/** A forwarded message's origin — who sent it, and where, so it reads as
 * clearly forwarded rather than as this person's own words. Not a link:
 * the source may not even be somewhere the reader can see. */
function forwardLine({ authorName, where }) {
  const row = el('div', { class: 'msg__forwardline' });
  row.appendChild(el('span', { class: 'msg__forwardicon' }, icon('forward')));
  row.appendChild(el('span', { class: 'msg__forwardlabel' }, 'Forwarded from'));
  row.appendChild(el('span', { class: 'msg__forwardauthor' }, authorName));
  if (where) row.appendChild(el('span', { class: 'msg__forwardwhere' }, where));
  return row;
}

/** Scrolls a message into view and flashes it so the eye can find it. */
export function jumpToMessage(messageId) {
  const node = scrollHost.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!node) {
    toastSuccess('That message is further back than the loaded history.');
    return false;
  }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('msg--flash');
  void node.offsetWidth;            // restart the animation if it is already on
  node.classList.add('msg--flash');
  setTimeout(() => node.classList.remove('msg--flash'), 1600);
  return true;
}

// ------------------------------------------------------------------- replying

// ------------------------------------------------------------- drafts
// One unsent message per conversation, kept in this browser's storage so it
// survives switching channels and restarting the app. Sent or cleared text
// removes its entry; only non-empty drafts are stored, at most 200 of them.
const DRAFTS_KEY = 'voxara:drafts';
let drafts = null;
function allDrafts() {
  if (drafts) return drafts;
  try { drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {}; } catch { drafts = {}; }
  return drafts;
}
function saveDraft(channelId, text) {
  const all = allDrafts();
  const value = String(text || '');
  if (value.trim()) all[channelId] = value; else delete all[channelId];
  const keys = Object.keys(all);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ }
}
function loadDraft(channelId) { return allDrafts()[channelId] || ''; }
let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (store.view.channelId) saveDraft(store.view.channelId, composerInput.value); }, 400);
}

export function startReply(message) {
  replyingTo = message;
  renderReplyBar();
  composerInput.focus();
}

export function cancelReply() {
  replyingTo = null;
  renderReplyBar();
}

function renderReplyBar() {
  const bar = document.getElementById('composerReply');
  if (!bar) return;
  bar.hidden = !replyingTo;
  bar.replaceChildren();
  if (!replyingTo) return;

  const author = store.user(replyingTo.authorId);
  bar.appendChild(el('span', { class: 'composer__replyicon' }, icon('reply')));
  bar.appendChild(el('span', { class: 'composer__replylabel' },
    'Replying to ', el('strong', {}, author?.displayName || 'Unknown')));
  bar.appendChild(el('button', {
    class: 'icon-btn composer__replyclose',
    type: 'button',
    'aria-label': 'Cancel reply',
    title: 'Cancel reply (Esc)',
    onClick: () => cancelReply(),
  }, icon('close')));
}

function messageTools(message) {
  const isMine = message.authorId === store.selfId;
  const guild = store.guildOfChannel(message.channelId);
  const canDelete = isMine || (guild ? canManage(guild, 'manageMessages') : false);
  // Matches the server: manageMessages pins in a space, either party in a DM.
  const canPin = guild ? canManage(guild, 'manageMessages') : true;

  const tools = el('div', { class: 'msg__tools' });

  tools.appendChild(el('button', {
    class: 'msg__tool',
    type: 'button',
    title: 'Add a reaction',
    'aria-label': 'Add a reaction',
    onClick: (event) => openQuickReactions(event.currentTarget, message),
  }, icon('smile')));

  if (isMine) {
    tools.appendChild(el('button', {
      class: 'msg__tool',
      type: 'button',
      title: 'Edit message',
      'aria-label': 'Edit message',
      onClick: () => startEditing(message.id),
    }, icon('pencil')));
  }

  tools.appendChild(el('button', {
    class: 'msg__tool',
    type: 'button',
    title: 'Reply',
    'aria-label': 'Reply to this message',
    onClick: () => startReply(message),
  }, icon('reply')));

  if (canPin) {
    const pinned = Boolean(message.pinnedAt);
    tools.appendChild(el('button', {
      class: 'msg__tool',
      type: 'button',
      title: pinned ? 'Unpin message' : 'Pin message',
      'aria-label': pinned ? 'Unpin message' : 'Pin message',
      onClick: () => setPinned(message.channelId, message.id, !pinned),
    }, icon('pin')));
  }

  // No threads-from-threads — matches the server's own rejection of that.
  if (guild && store.channel(message.channelId)?.type !== 'thread') {
    const hasThread = Boolean(message.threadId);
    tools.appendChild(el('button', {
      class: 'msg__tool',
      type: 'button',
      title: hasThread ? 'Open thread' : 'Reply in thread',
      'aria-label': hasThread ? 'Open thread' : 'Reply in thread',
      onClick: async () => {
        if (hasThread) { openConversation(message.threadId, { guildId: guild.id }); return; }
        const thread = await createThread(message.channelId, { messageId: message.id });
        if (thread) openConversation(thread.id, { guildId: guild.id });
      },
    }, icon('chat')));
  }

  tools.appendChild(el('button', {
    class: 'msg__tool',
    type: 'button',
    title: 'Forward',
    'aria-label': 'Forward this message',
    onClick: (event) => openForwardPicker(event.currentTarget, message),
  }, icon('forward')));

  tools.appendChild(el('button', {
    class: 'msg__tool',
    type: 'button',
    title: 'Copy text',
    'aria-label': 'Copy text',
    onClick: () => copyToClipboard(message.content, 'Message'),
  }, icon('copy')));

  if (canDelete) {
    tools.appendChild(el('button', {
      class: 'msg__tool msg__tool--danger',
      type: 'button',
      title: 'Delete message',
      'aria-label': 'Delete message',
      onClick: async () => {
        if (!store.ui.confirmDelete) return void deleteMessage(message.channelId, message.id);
        const ok = await confirmDialog({
          title: 'Delete message?',
          message: 'This removes it for everyone in the conversation.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) deleteMessage(message.channelId, message.id);
      },
    }, icon('trash')));
  }

  return tools;
}

function openQuickReactions(anchor, message) {
  const row = el('div', { style: { display: 'flex', gap: '2px', padding: '2px' } });
  for (const emoji of QUICK_REACTIONS) {
    row.appendChild(el('button', {
      class: 'emoji-picker__btn',
      type: 'button',
      style: { width: '34px', height: '34px' },
      title: emoji,
      onClick: () => {
        closePopover();
        toggleReaction(message.channelId, message.id, emoji);
      },
    }, emoji));
  }
  row.appendChild(el('button', {
    class: 'emoji-picker__btn',
    type: 'button',
    style: { width: '34px', height: '34px' },
    title: 'More emoji',
    onClick: (event) => openEmojiPicker(
      event.currentTarget,
      (emoji) => toggleReaction(message.channelId, message.id, emoji),
      { placement: 'top-end' },
    ),
  }, icon('plus')));

  openPopover(anchor, row, { placement: 'top-end' });
}

// Only friends — forwarding into a space's channel would hand the message to
// everyone who happens to be a member there, not just whoever you meant to
// share it with, so channels aren't offered as a destination at all.
function forwardTargets() {
  const withDm = new Map();
  for (const dm of store.dms.values()) withDm.set(store.dmPartnerId(dm.id), dm.id);

  return [...store.friends]
    .map((id) => store.user(id))
    .filter(Boolean)
    .map((user) => ({
      userId: user.id,
      dmId: withDm.get(user.id) || null,
      label: user.displayName || user.username,
      where: `@${user.username}`,
      user,
      match: `${user.username || ''} ${user.displayName || ''}`.toLowerCase(),
    }));
}

/** A short, human description of where a message came from — attribution
 * shown on the forwarded copy, not a reference the recipient could use to
 * reach the original (they may not even be able to see that channel). */
function describeOrigin(message) {
  const conversation = store.conversation(message.channelId);
  if (!conversation) return '';
  if (conversation.kind === 'dm') return 'a direct message';
  return conversation.guild ? `#${conversation.name} in ${conversation.guild.name}` : `#${conversation.name}`;
}

/** Re-post a message's content and attachments into a friend's DM — a plain
 * new message there carrying a forwardedFrom stamp (see messageNode()),
 * not a special linked/quoted one. Passes the target channel explicitly
 * (see sendMessage()) rather than switching store.view.channelId to it, so
 * the conversation on screen never flickers to the forwarded-to one, even
 * for a second. */
async function forwardMessage(message, target) {
  const channelId = target.dmId || (await ensureDm(target.userId)).id;
  if (!store.loaded.has(channelId)) await loadHistory(channelId);
  const forwardedFrom = {
    authorName: store.user(message.authorId)?.displayName || 'Someone',
    where: describeOrigin(message),
  };
  await sendMessage(message.content, message.attachments || [], null, channelId, forwardedFrom);
  toastSuccess(`Forwarded to ${target.label}.`);
}

export function openForwardPicker(anchor, message) {
  const targets = forwardTargets();
  const input = el('input', {
    class: 'switcher__input', type: 'text', placeholder: 'Forward to a friend…', 'aria-label': 'Forward to', autocomplete: 'off',
  });
  const list = el('div', { class: 'switcher__list', role: 'listbox' });

  function renderList() {
    clear(list);
    const query = input.value.trim().toLowerCase();
    const matches = query ? targets.filter((t) => t.match.includes(query) || t.label.toLowerCase().includes(query)) : targets;
    if (!matches.length) {
      list.appendChild(el('div', { class: 'switcher__empty' },
        targets.length ? 'No friends match that.' : 'Add a friend to forward messages to them.'));
      return;
    }
    for (const target of matches) {
      list.appendChild(el('button', {
        class: 'switcher__item', type: 'button', role: 'option',
        onClick: () => { closePopover(); void forwardMessage(message, target); },
      },
        avatar(target.user, { size: 'sm' }),
        el('span', { class: 'switcher__label' }, target.label),
        el('span', { class: 'switcher__where' }, target.where)));
    }
  }
  input.addEventListener('input', renderList);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') list.querySelector('.switcher__item')?.click();
  });

  const panel = el('div', { class: 'switcher forwardpick' }, input, list);
  openPopover(anchor, panel, { placement: 'top-end', className: 'forward-popover' });
  renderList();
  requestAnimationFrame(() => input.focus());
}

// ------------------------------------------------------------ inline edit

export function startEditing(messageId) {
  editingMessageId = messageId;
  // Swap just this row into its editor — a full renderMessages() here used to
  // reset scroll position with nothing to restore it, which is why opening
  // (and, in stopEditing() below, closing) the editor could jolt the view.
  if (!patchMessageById(messageId)) renderMessages();
  const textarea = scrollHost.querySelector('.msg__editor textarea');
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    autosizeNode(textarea, 260);
  }
}

function stopEditing() {
  const messageId = editingMessageId;
  editingMessageId = null;
  if (!patchMessageById(messageId)) renderMessages();
  composerInput.focus();
}

function inlineEditor(message) {
  const textarea = el('textarea', {
    value: message.content,
    'aria-label': 'Edit message',
    rows: 1,
    onInput: (event) => autosizeNode(event.target, 260),
    onKeydown: async (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        stopEditing();
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        await commit();
      }
    },
  });

  async function commit() {
    const value = textarea.value.trim();
    if (!value) {
      const ok = await confirmDialog({
        title: 'Delete message?',
        message: 'An empty edit deletes the message for everyone.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (ok) await deleteMessage(message.channelId, message.id);
      stopEditing();
      return;
    }
    if (value !== message.content) {
      const ok = await editMessage(message.channelId, message.id, value);
      if (!ok) return;
    }
    stopEditing();
  }

  return el('div', { class: 'msg__editor' },
    textarea,
    el('div', { class: 'msg__editor-hint' },
      'Escape to ', el('button', { type: 'button', onClick: stopEditing }, 'cancel'),
      ' · Enter to ', el('button', { type: 'button', onClick: commit }, 'save'),
    ),
  );
}

// -------------------------------------------------------------- intro/empty

/* Masthead for the top of a conversation: kicker, headline, standfirst. */
function conversationIntro(conversation) {
  if (conversation.kind === 'dm') {
    return el('div', { class: 'chan-intro' },
      el('div', { class: 'chan-intro__kicker' }, 'Direct message'),
      el('h2', {}, conversation.name),
    );
  }
  return el('div', { class: 'chan-intro' },
    el('div', { class: 'chan-intro__kicker' }, conversation.guild?.name || 'Channel'),
    el('h2', {}, `#${conversation.name}`),
    el('p', {}, conversation.topic || `The beginning of #${conversation.name}. Say something to get things going.`),
  );
}

function noConversationState() {
  if (store.view.kind === 'home') {
    const hasFriends = store.friends.size > 0;
    return emptyState({
      iconName: 'dm',
      title: hasFriends ? 'No conversation open' : 'Add your first friend',
      body: hasFriends
        ? 'Pick a friend from the sidebar to open your conversation.'
        : 'Voxara works by username. Ask someone for theirs, add them as a friend, '
          + 'and you can message each other straight away.',
      actions: [
        el('button', { class: 'btn btn--primary', type: 'button', onClick: showAddFriend }, 'Add a friend'),
        el('button', { class: 'btn', type: 'button', onClick: showCreateServer }, 'Create a space'),
      ],
    });
  }
  const guild = store.guild(store.view.guildId);
  return emptyState({
    iconName: 'hash',
    title: guild ? `${guild.name} has no channels yet` : 'Nothing open',
    body: guild
      ? 'Create the first channel to get the conversation started.'
      : 'Choose a channel in the sidebar, or create a space.',
    actions: guild && canManage(guild, 'manageChannels')
      ? [el('button', {
        class: 'btn btn--primary',
        type: 'button',
        onClick: () => showCreateChannel(guild, guild.categories[0]?.id),
      }, 'Create a channel')]
      : [],
  });
}

// ------------------------------------------------------------------ scroll

function wireScroll() {
  scrollHost.addEventListener('scroll', () => {
    updateJumpVisibility();
    if (store.ui.autoLoadOlder && scrollHost.scrollTop < 120 && !searchQuery) void loadMoreHistory();
    if (isNearBottom() && store.view.channelId) markRead(store.view.channelId);
  }, { passive: true });

  jumpButton.addEventListener('click', () => {
    scrollToBottom();
    if (store.view.channelId) markRead(store.view.channelId);
  });
}

async function loadMoreHistory() {
  const channelId = store.view.channelId;
  if (!channelId || loadingOlder || !store.hasMore.get(channelId)) return;
  loadingOlder = true;
  try {
    await loadOlder(channelId);
  } finally {
    loadingOlder = false;
  }
}

function isNearBottom() {
  if (!scrollHost) return true;
  return scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight < NEAR_BOTTOM_PX;
}

export function scrollToBottom() {
  requestAnimationFrame(() => {
    scrollHost.scrollTop = scrollHost.scrollHeight;
    showJumpButton(false);
  });
}

// Attachments, link-preview thumbnails, custom emoji and Steam capsule art
// all finish loading after the message node holding them is already on
// screen. Landing on a fresh conversation scrolls to the bottom before any
// of that has loaded, so once one of them settles in and grows past whatever
// placeholder size it had, the real bottom ends up that much further down
// than the fixed scroll position already committed to — reads as the view
// having "bumped up" by however many messages that image was worth. Re-pin
// once each image settles, but only if nothing has since deliberately
// scrolled away from the bottom.
function stickBottomThroughImageLoads() {
  for (const img of scrollHost.querySelectorAll('img')) {
    if (img.complete) continue;
    const onSettle = () => { if (isNearBottom()) scrollToBottom(); };
    img.addEventListener('load', onSettle, { once: true });
    img.addEventListener('error', onSettle, { once: true });
  }
}

function updateJumpVisibility() {
  showJumpButton(!isNearBottom() && store.messagesFor(store.view.channelId).length > 0);
}

function showJumpButton(visible) {
  if (jumpButton) jumpButton.hidden = !visible;
}

// ---------------------------------------------------------------- composer

/** channel name (lower) -> id, for the space a message lives in. */
function channelMapFor(channelId) {
  const guild = store.guildOfChannel(channelId);
  const map = new Map();
  if (!guild) return map;
  for (const c of guild.channels || []) if (c.type !== 'thread') map.set(String(c.name).toLowerCase(), c.id);
  return map;
}

/** #channel autocomplete: every channel of the space you are typing in. */
function channelCandidates() {
  const conversation = store.conversation();
  const guild = conversation?.guild;
  if (!guild) return [];
  const kindOf = { voice: 'Voice channel', forum: 'Forum', text: 'Text channel' };
  return (guild.channels || []).filter((c) => c.type !== 'thread').map((c) => ({
    label: `#${c.name}`,
    sub: kindOf[c.type] || 'Channel',
    insert: c.name,
    match: String(c.name).toLowerCase(),
    kind: 'channel',
  }));
}

function mentionCandidates() {
  const conversation = store.conversation();
  const list = [];
  if (conversation?.kind === 'channel' && conversation.guild) {
    list.push({ label: 'everyone', sub: 'Notify everyone here', insert: 'everyone', match: 'everyone all', kind: 'broadcast' });
    list.push({ label: 'here', sub: 'Notify members here', insert: 'here', match: 'here', kind: 'broadcast' });
    for (const id of conversation.guild.memberIds || []) {
      const user = store.user(id);
      if (!user || user.id === store.selfId) continue;
      list.push({
        label: user.displayName || user.username,
        sub: `@${user.username}`,
        insert: user.username,
        match: `${user.username} ${user.displayName || ''}`.toLowerCase(),
        kind: 'user',
        node: avatar(user, { size: 'sm', status: false }),
      });
    }
  } else if (conversation?.kind === 'dm' && conversation.partnerId) {
    const user = store.user(conversation.partnerId);
    if (user) {
      list.push({
        label: user.displayName || user.username,
        sub: `@${user.username}`,
        insert: user.username,
        match: `${user.username} ${user.displayName || ''}`.toLowerCase(),
        kind: 'user',
        node: avatar(user, { size: 'sm', status: false }),
      });
    }
  }
  return list;
}

// `:query` -> up to 8 suggestions: this space's custom emoji first, then the
// built-in shortcode set, both ranked by whether they start with `query`.
function emojiCandidates(query) {
  if (!query) return [];
  const list = [];
  const guild = store.guildOfChannel(store.view.channelId);
  for (const e of guild?.emojis || []) {
    if (!e.name.toLowerCase().includes(query)) continue;
    list.push({
      label: `:${e.name}:`, sub: 'this space', insert: `:${e.name}:`, match: e.name.toLowerCase(),
      node: el('img', { class: 'custom-emoji', src: mediaUrl(e.url), alt: '' }),
    });
  }
  for (const entry of matchEmojiNames(query, 12)) {
    list.push({
      label: `:${entry.name}:`, insert: entry.emoji, match: entry.name,
      node: el('span', { class: 'mention-ac__emoji' }, entry.emoji),
    });
  }
  return list
    .sort((a, b) => (a.match.startsWith(query) ? 0 : 1) - (b.match.startsWith(query) ? 0 : 1))
    .slice(0, 8);
}

function wireComposer() {
  const mentionAC = createMentionAutocomplete(composerInput, mentionCandidates);
  const channelAC = createMentionAutocomplete(composerInput, channelCandidates, { trigger: '#' });
  createSlashAutocomplete(composerInput, slashCandidates);
  // GIFs: only when the server has a Tenor key; the GIF itself is sent as a link
  // and the server's link preview re-hosts it, so viewers load it from Voxara.
  const gifBtn = document.getElementById('composerGif');
  if (gifBtn) {
    const showGif = () => { gifBtn.hidden = !store.server?.gifs; };
    showGif(); store.on('self', showGif);
    gifBtn.addEventListener('click', () => openGifPicker(gifBtn, (gif) => { if (store.view.channelId) void sendMessage(gif.url, [], replyingTo?.id || null); }));
  }
  const emojiAC = createEmojiAutocomplete(composerInput, emojiCandidates);

  composerInput.addEventListener('input', () => {
    autosize();
    renderCount();
    mentionAC.refresh();
    channelAC.refresh();
    emojiAC.refresh();
    scheduleDraftSave();
    if (composerInput.value.trim()) pingTyping();
  });
  composerInput.addEventListener('blur', () => setTimeout(() => { mentionAC.close(); channelAC.close(); emojiAC.close(); }, 120));

  composerInput.addEventListener('keydown', (event) => {
    // Autocomplete popups get first refusal on arrows/enter/tab/escape.
    if (mentionAC.handleKeydown(event)) return;
    if (channelAC.handleKeydown(event)) return;
    if (emojiAC.handleKeydown(event)) return;
    // Which chord sends is a preference; the other one inserts a newline.
    if (event.key === 'Enter') {
      const wantsCtrl = store.ui.sendKey === 'ctrl-enter';
      const sends = wantsCtrl ? (event.ctrlKey || event.metaKey) : !event.shiftKey;
      if (sends) {
        event.preventDefault();
        submit();
        return;
      }
    }
    // Up-arrow on an empty box edits your last message, as people expect.
    if (event.key === 'ArrowUp' && composerInput.value === '') {
      const mine = [...store.messagesFor(store.view.channelId)]
        .reverse()
        .find((m) => m.authorId === store.selfId && !m.pending && !m.failed);
      if (mine) {
        event.preventDefault();
        startEditing(mine.id);
      }
    }
    if (event.key === 'Escape' && replyingTo) {
      event.preventDefault();
      cancelReply();
      return;
    }
    if (event.key === 'Escape' && composerInput.value !== '') {
      composerInput.value = '';
      if (store.view.channelId) saveDraft(store.view.channelId, '');
      autosize();
      renderCount();
    }
  });

  composerSend.addEventListener('click', submit);

  document.getElementById('composerEmoji').addEventListener('click', (event) => {
    openEmojiPicker(event.currentTarget, (emoji) => insertAtCursor(emoji), { placement: 'top-end' });
  });

  document.getElementById('composerAttach').addEventListener('click', (event) => {
    openComposerMenu(event.currentTarget);
  });

  // Dropping onto the conversation attaches too. dragenter/dragleave are
  // counted rather than just toggled: they fire on every child element the
  // cursor crosses while dragging, bubbling up here, so an exact-target
  // check on dragleave alone missed most of those pairs and could leave
  // "Drop to attach" stuck on screen after the drag had already left.
  const dropZone = document.getElementById('chat');
  let dragDepth = 0;
  const clearDropState = () => { dragDepth = 0; dropZone.classList.remove('is-dropping'); };
  dropZone.addEventListener('dragenter', (event) => {
    if (!store.view.channelId) return;
    event.preventDefault();
    dragDepth += 1;
    dropZone.classList.add('is-dropping');
  });
  dropZone.addEventListener('dragover', (event) => {
    if (store.view.channelId) event.preventDefault(); // needed on every dragover, or drop never fires
  });
  dropZone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropZone.classList.remove('is-dropping');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    clearDropState();
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) void stageFiles(files);
  });
  // Belt and braces: a drag that ends without a matching dragleave here
  // (cancelled with Escape, dropped elsewhere, or anything else that skips
  // the normal sequence) still fires dragend on the document — catch it
  // there so the highlight can never outlive the drag that started it.
  window.addEventListener('dragend', clearDropState);

  // So does pasting an image.
  composerInput.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      void stageFiles(files);
    }
  });
}

/** In a DM: a small "Seen" line under your last message once the other person has read it. */
function renderSeenMark() {
  if (!scrollHost) return;
  scrollHost.querySelector('.msg-seen')?.remove();
  const conversation = store.conversation();
  if (!conversation || conversation.kind !== 'dm') return;
  const list = store.messagesFor(conversation.id);
  const mine = [...list].reverse().find((m) => m.authorId === store.selfId);
  if (!mine) return;
  const seenId = store.seenBy(conversation.id, conversation.partnerId);
  if (!seenId) return;
  const seenIndex = list.findIndex((m) => m.id === seenId);
  const mineIndex = list.findIndex((m) => m.id === mine.id);
  if (seenIndex === -1 || seenIndex < mineIndex) return;
  const node = scrollHost.querySelector(`[data-message-id="${mine.id}"]`);
  if (!node) return;
  node.insertAdjacentElement('afterend', el('div', { class: 'msg-seen' }, 'Seen'));
}

/** Slash commands offered by the bots in the current space. */
function slashCandidates() {
  const guild = store.conversation()?.guild;
  if (!guild) return [];
  const out = [];
  for (const id of guild.memberIds) {
    const u = store.user(id);
    if (!u?.bot || !Array.isArray(u.commands)) continue;
    for (const c of u.commands) out.push({ ...c, botId: u.id, bot: u.displayName });
  }
  return out;
}

/** "/name args" aimed at a bot in this space: runs it instead of posting. True if handled. */
function tryInvokeCommand(value) {
  const m = /^\/([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i.exec(value);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const command = slashCandidates().find((c) => c.name === name);
  if (!command) return false;
  net.request('command:invoke', { channelId: store.view.channelId, botId: command.botId, name, args: (m[2] || '').trim() })
    .catch((err) => toastError(err.message || `Could not run /${name}.`));
  return true;
}

function submit() {
  const value = composerInput.value.trim();
  const ready = pendingAttachments.filter((a) => a.uploaded).map((a) => a.uploaded);
  if ((!value && ready.length === 0) || !store.view.channelId) return;
  if (pendingAttachments.some((a) => !a.uploaded && !a.failed)) return;  // still uploading
  if (ready.length === 0 && tryInvokeCommand(value)) {
    composerInput.value = '';
    saveDraft(store.view.channelId, '');
    autosize();
    renderCount();
    return;
  }

  composerInput.value = '';
  saveDraft(store.view.channelId, '');
  pendingAttachments = [];
  renderTray();
  autosize();
  renderCount();
  void sendMessage(value, ready, replyingTo?.id || null);
  cancelReply();
  scrollToBottom();
}

// ----------------------------------------------------------- composer menu

// The "+" button. A small menu so the composer can grow more actions (poll,
// and later a scheduled message) without a row of buttons.
function openComposerMenu(anchor) {
  if (!store.view.channelId) return;
  const pending = store.scheduledForChannel(store.view.channelId);
  const items = [
    menuItem({ label: 'Upload a file', iconName: 'plus', onSelect: attachFiles }),
    menuItem({ label: 'Create a poll', iconName: 'list', onSelect: showCreatePoll }),
    menuItem({ label: 'Schedule a message', iconName: 'clock', onSelect: showScheduleMessage }),
  ];
  if (pending.length) {
    items.push(menuItem({
      label: 'Scheduled here', iconName: 'clock',
      hint: String(pending.length),
      onSelect: showScheduledList,
    }));
  }
  openPopover(anchor, el('div', { class: 'menu' }, ...items), { placement: 'top-start' });
}

// Pre-fill the datetime picker with a sensible default (an hour from now),
// formatted for <input type="datetime-local"> in the viewer's own timezone.
function defaultScheduleValue() {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function showScheduleMessage() {
  const currentChannel = store.view.channelId;

  // A picker of every place you can post — text channels grouped by space, plus
  // your DMs — so a scheduled message needn't go to the channel you're in.
  const target = el('select', { class: 'input schedule__select' });
  for (const guild of store.guilds.values()) {
    const group = el('optgroup', { label: guild.name });
    for (const channel of guild.channels || []) {
      if (channel.type && channel.type !== 'text') continue;
      group.appendChild(el('option', { value: channel.id }, `#${channel.name}`));
    }
    if (group.children.length) target.appendChild(group);
  }
  const dmGroup = el('optgroup', { label: 'Direct messages' });
  for (const dm of store.dms.values()) {
    const otherId = (dm.memberIds || []).find((id) => id !== store.selfId);
    dmGroup.appendChild(el('option', { value: dm.id }, store.userName(otherId)));
  }
  if (dmGroup.children.length) target.appendChild(dmGroup);
  if (!target.querySelector('option')) return; // nowhere to post
  if (currentChannel) target.value = currentChannel;

  // Seed with whatever is already typed in the composer, then clear it.
  const seed = composerInput?.value?.trim() || '';
  const text = el('textarea', { class: 'input', rows: '3', placeholder: 'Write your message…' });
  text.value = seed;
  const when = el('input', { class: 'input', type: 'datetime-local', value: defaultScheduleValue() });

  let repeat = 'none';
  const repeatRow = choiceRow([
    { value: 'none', label: 'Once' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
  ], 'none', (v) => { repeat = v; });

  const send = el('button', { class: 'btn btn--primary', type: 'button' }, 'Schedule');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');

  const modal = openModal({
    title: 'Schedule a message',
    body: el('div', { class: 'schedule' },
      el('label', { class: 'pollbuild__label' }, 'Send to'),
      target,
      el('label', { class: 'pollbuild__label' }, 'Message'),
      text,
      el('label', { class: 'pollbuild__label' }, 'Send at'),
      when,
      el('label', { class: 'pollbuild__label' }, 'Repeat'),
      repeatRow,
      el('p', { class: 'field__hint' }, 'It posts automatically at that time — the app doesn’t need to be open.'),
    ),
    actions: [cancel, send],
  });
  cancel.addEventListener('click', () => modal.close());
  setTimeout(() => (seed ? when : text).focus(), 30);

  send.addEventListener('click', async () => {
    const channelId = target.value;
    const content = text.value.trim();
    const sendAt = when.value ? new Date(when.value).getTime() : 0;
    if (!channelId) return modal.setError('Pick where to send it.');
    if (!content) return modal.setError('Type a message to schedule.');
    if (!sendAt || sendAt < Date.now() + 30_000) return modal.setError('Pick a time at least a minute from now.');
    send.classList.add('is-busy');
    try {
      await scheduleMessage(channelId, content, sendAt, { repeat });
      if (composerInput && composerInput.value.trim() === seed) composerInput.value = '';
      modal.close();
      toastSuccess(repeat === 'none' ? 'Message scheduled.' : `Scheduled — repeats ${repeat}.`);
    } catch (err) {
      send.classList.remove('is-busy');
      modal.setError(err.message || 'Could not schedule that.');
    }
  });
}

function showScheduledList() {
  const channelId = store.view.channelId;
  const list = el('div', { class: 'schedule-list' });

  const draw = () => {
    clear(list);
    const pending = store.scheduledForChannel(channelId);
    if (!pending.length) {
      list.appendChild(el('p', { class: 'field__hint' }, 'Nothing scheduled here.'));
      return;
    }
    for (const s of pending) {
      list.appendChild(el('div', { class: 'schedule-row' },
        el('div', { class: 'schedule-row__main' },
          el('div', { class: 'schedule-row__text' }, s.content || '(attachment)'),
          el('div', { class: 'schedule-row__when' }, icon('clock'),
            el('span', {}, `Sends ${formatFull(s.sendAt)}${s.repeat && s.repeat !== 'none' ? ` · repeats ${s.repeat}` : ''}`)),
        ),
        el('button', {
          class: 'icon-btn', type: 'button', title: 'Cancel', 'aria-label': 'Cancel',
          onClick: async () => { await cancelScheduled(s.id); draw(); },
        }, icon('trash')),
      ));
    }
  };
  draw();
  store.on('scheduled', draw);

  const done = el('button', { class: 'btn btn--primary', type: 'button' }, 'Done');
  const modal = openModal({ title: 'Scheduled messages', body: list, actions: [done] });
  done.addEventListener('click', () => modal.close());
}

// A little builder: a question, two-to-ten options, single/multiple choice and
// an optional time limit.
function showCreatePoll() {
  const channelId = store.view.channelId;
  if (!channelId) return;

  const question = el('input', {
    class: 'pollbuild__q', type: 'text', maxlength: '300', placeholder: 'Ask a question…',
  });

  const optionList = el('div', { class: 'pollbuild__opts' });
  const addRow = el('button', {
    class: 'pollbuild__add', type: 'button',
    onClick: () => { const input = addOption(); input?.focus(); },
  }, icon('plus'), el('span', {}, 'Add option'));

  // Remove buttons only show once dropping one still leaves the minimum two.
  const syncRows = () => {
    const rows = [...optionList.children];
    for (const r of rows) r.classList.toggle('is-removable', rows.length > 2);
    rows.forEach((r, i) => {
      const inp = r.querySelector('input');
      if (inp) inp.placeholder = `Option ${i + 1}`;
    });
    addRow.disabled = rows.length >= 10;
  };

  function addOption(value = '') {
    if (optionList.children.length >= 10) return null;
    const input = el('input', { class: 'pollbuild__optinput', type: 'text', maxlength: '100', value });

    // A per-option emoji: click the leading button to pick one, right-click to clear.
    let emoji = null;
    const emojiBtn = el('button', {
      class: 'pollbuild__emoji', type: 'button',
      title: 'Add an emoji (right-click to remove)', 'aria-label': 'Add an emoji to this option',
    });
    const renderEmoji = () => {
      clear(emojiBtn);
      emojiBtn.classList.toggle('has-emoji', Boolean(emoji));
      emojiBtn.appendChild(emoji ? emojiGlyph(emoji, channelId, 'pollbuild__emojiglyph') : icon('smile'));
    };
    emojiBtn.addEventListener('click', (event) => {
      openEmojiPicker(event.currentTarget, (picked) => { emoji = picked; renderEmoji(); }, { placement: 'bottom-start' });
    });
    emojiBtn.addEventListener('contextmenu', (event) => { event.preventDefault(); emoji = null; renderEmoji(); });
    renderEmoji();

    const remove = el('button', {
      class: 'pollbuild__remove', type: 'button', title: 'Remove option', 'aria-label': 'Remove option',
      onClick: () => { if (optionList.children.length > 2) { row.remove(); syncRows(); } },
    }, icon('close'));
    const row = el('div', { class: 'pollbuild__opt' }, emojiBtn, input, remove);
    row.getEmoji = () => emoji;
    optionList.appendChild(row);
    syncRows();
    return input;
  }
  addOption();
  addOption();

  let multiChoice = false;
  let durationHours = 24;

  const create = el('button', { class: 'btn btn--primary', type: 'button' }, 'Create poll');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');

  const modal = openModal({
    title: 'Create a poll',
    body: el('div', { class: 'pollbuild' },
      el('div', { class: 'pollbuild__section' },
        el('div', { class: 'pollbuild__label' }, 'Question'),
        question),
      el('div', { class: 'pollbuild__section' },
        el('div', { class: 'pollbuild__label' }, 'Options'),
        optionList,
        addRow),
      toggleRow({
        label: 'Allow multiple answers',
        hint: 'People can pick more than one option.',
        value: false,
        onChange: (v) => { multiChoice = v; },
      }),
      el('div', { class: 'pollbuild__section' },
        el('div', { class: 'pollbuild__label' }, 'Ends after'),
        choiceRow([
          { value: '1', label: '1 hour' },
          { value: '24', label: '1 day' },
          { value: '168', label: '1 week' },
          { value: '0', label: 'No limit' },
        ], '24', (v) => { durationHours = Number(v); })),
    ),
    actions: [cancel, create],
  });
  cancel.addEventListener('click', () => modal.close());
  setTimeout(() => question.focus(), 30);

  create.addEventListener('click', async () => {
    const q = question.value.trim();
    const options = [...optionList.children]
      .map((row) => ({ text: row.querySelector('input').value.trim(), emoji: row.getEmoji?.() || null }))
      .filter((o) => o.text || o.emoji);
    if (!q) return modal.setError('Give your poll a question.');
    if (options.length < 2) return modal.setError('Add at least two options.');
    create.classList.add('is-busy');
    try {
      await createPoll(channelId, { question: q, options, multi: multiChoice, durationHours });
      modal.close();
    } catch (err) {
      create.classList.remove('is-busy');
      modal.setError(err.message || 'Could not create the poll.');
    }
  });
}

// ------------------------------------------------------------- attachments

async function attachFiles() {
  const files = await chooseFiles();
  if (files?.length) await stageFiles(files);
}

/** Stages files in the tray and uploads each one in the background. */
async function stageFiles(files) {
  if (!store.view.channelId) return;
  const room = 4 - pendingAttachments.length;
  if (room <= 0) return toastError('Up to 4 files per message.');

  for (const file of files.slice(0, room)) {
    const entry = { file, name: file.name, uploaded: null, failed: null };
    pendingAttachments.push(entry);
    renderTray();

    try {
      const prepared = await prepareAttachment(file);
      entry.uploaded = await uploadAttachment(prepared);
    } catch (err) {
      entry.failed = err.message;
      toastError(err.message);
    }
    renderTray();
  }
  composerInput.focus();
}

function renderTray() {
  if (!trayHost) return;
  clear(trayHost);
  trayHost.hidden = pendingAttachments.length === 0;

  for (const entry of pendingAttachments) {
    const isImage = entry.file.type.startsWith('image/');
    const chip = el('div', {
      class: `tray__item${entry.failed ? ' is-failed' : ''}${entry.uploaded ? '' : ' is-busy'}`,
      title: entry.failed || entry.name,
    });

    if (isImage) {
      const url = URL.createObjectURL(entry.file);
      const img = el('img', { class: 'tray__thumb', src: url, alt: '' });
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      chip.appendChild(img);
    } else {
      chip.appendChild(el('span', { class: 'tray__ext' },
        (entry.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()));
    }

    chip.appendChild(el('span', { class: 'tray__name' }, entry.name));
    chip.appendChild(el('button', {
      class: 'tray__remove',
      type: 'button',
      title: 'Remove',
      'aria-label': `Remove ${entry.name}`,
      onClick: () => {
        pendingAttachments = pendingAttachments.filter((a) => a !== entry);
        renderTray();
      },
    }, icon('close')));

    trayHost.appendChild(chip);
  }
}

/** Attachment blocks under a message: images inline, everything else a row. */
function attachmentsFor(message) {
  const list = Array.isArray(message.attachments) ? message.attachments : [];
  if (list.length === 0) return null;

  const wrap = el('div', { class: 'attachments' });
  for (const item of list) {
    const src = mediaUrl(item.url);
    const isGif = item.type === 'image/gif' || /\.gif(\?|$)/i.test(item.url || '');
    if (store.ui.inlineImages && reduceFlashing() && isGif) {
      // Photosensitivity: never autoplay a GIF — gate it behind a click.
      wrap.appendChild(gifGate(src, item.name));
    } else if (store.ui.inlineImages && String(item.type).startsWith('image/')) {
      const figure = el('button', {
        class: 'attachment attachment--image',
        type: 'button',
        title: `${item.name} — click to open`,
        onClick: () => desktop.openExternal(src),
      }, el('img', { src, alt: item.name, loading: 'lazy' }));
      wrap.appendChild(figure);
    } else {
      wrap.appendChild(el('button', {
        class: 'attachment attachment--file',
        type: 'button',
        title: 'Open this file',
        onClick: () => desktop.openExternal(src),
      },
      el('span', { class: 'attachment__ext' }, (item.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()),
      el('span', { class: 'attachment__meta' },
        el('span', { class: 'attachment__name' }, item.name),
        el('span', { class: 'attachment__size' }, formatBytes(item.size)))));
    }
  }
  return wrap;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function insertAtCursor(text) {
  const start = composerInput.selectionStart ?? composerInput.value.length;
  const end = composerInput.selectionEnd ?? start;
  const before = composerInput.value.slice(0, start);
  const after = composerInput.value.slice(end);
  const needsSpace = before && !/\s$/.test(before);
  const insertion = `${needsSpace ? ' ' : ''}${text} `;
  composerInput.value = before + insertion + after;
  const cursor = start + insertion.length;
  composerInput.focus();
  composerInput.setSelectionRange(cursor, cursor);
  autosize();
  renderCount();
}

function autosizeNode(node, max) {
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, max)}px`;
}

function autosize() {
  autosizeNode(composerInput, 220);
}

function renderCount() {
  composerSend.disabled = !store.view.channelId
    || (composerInput.value.trim().length === 0 && pendingAttachments.length === 0);
  const length = composerInput.value.length;
  const remaining = 4000 - length;
  composerCount.hidden = remaining > 300;
  composerCount.textContent = String(remaining);
  composerCount.classList.toggle('is-over', remaining < 0);
}

export function renderComposerState() {
  const conversation = store.conversation();
  const composer = document.getElementById('composer');
  // A locked thread only takes messages from moderators — mirrors the server.
  const locked = conversation?.kind === 'thread'
    && Boolean(store.channel(conversation.id)?.locked)
    && !canManage(conversation.guild, 'manageMessages');
  const enabled = Boolean(conversation) && !locked;

  composerInput.disabled = !enabled;
  composerSend.disabled = !enabled;
  composer.classList.toggle('is-disabled', !enabled);
  composerInput.placeholder = enabled
    ? (conversation.kind === 'dm' ? `Message ${conversation.name}` : `Message #${conversation.name}`)
    : (locked ? 'This thread is locked' : 'Select a channel to start talking');
  renderCount();
}

/** The lock toggle in the header, made once and shown only on threads you moderate. */
function threadLockButton() {
  let btn = document.getElementById('chatThreadLock');
  if (!btn) {
    btn = el('button', { class: 'icon-btn', id: 'chatThreadLock', type: 'button', title: 'Lock this thread' }, icon('lock'));
    const tools = document.querySelector('.chat__tools');
    const pins = document.getElementById('chatPins');
    if (pins) pins.before(btn); else tools?.prepend(btn);
  }
  return btn;
}

export function focusComposer() {
  composerInput?.focus();
}

// ----------------------------------------------------------------- typing

function renderTyping() {
  if (!typingBar) return;
  const channelId = store.view.channelId;
  clear(typingBar);
  if (!channelId) return;

  const typists = store.typistsIn(channelId).map((id) => store.userName(id));
  if (typists.length === 0) return;

  typingBar.appendChild(el('span', { class: 'typing__dots' },
    el('i', {}), el('i', {}), el('i', {})));
  typingBar.appendChild(el('span', {},
    `${joinNames(typists)} ${typists.length === 1 ? 'is' : 'are'} typing…`));
}

// ------------------------------------------------------------------- pins

/** Drops the pinned-message list below the pin button in the header. */
async function openPinnedPanel(anchor) {
  const channelId = store.view.channelId;
  if (!channelId) return;

  const panel = el('div', { class: 'pinpanel' },
    el('div', { class: 'pinpanel__head' }, 'Pinned messages'),
    el('div', { class: 'pinpanel__body' }, el('p', { class: 'pinpanel__empty' }, 'Loading…')));
  openPopover(anchor, panel, { placement: 'bottom-end' });

  const messages = await fetchPinned(channelId);
  const body = panel.querySelector('.pinpanel__body');
  body.replaceChildren();

  if (messages.length === 0) {
    body.appendChild(el('p', { class: 'pinpanel__empty' },
      'Nothing pinned yet. Use the pin button on a message to keep it here.'));
    return;
  }

  const guild = store.guildOfChannel(channelId);
  const canUnpin = guild ? canManage(guild, 'manageMessages') : true;

  for (const message of messages) {
    const author = store.user(message.authorId);
    const row = el('div', { class: 'pinpanel__item' },
      el('div', { class: 'pinpanel__meta' },
        el('span', { class: 'pinpanel__author' }, author?.displayName || 'Unknown'),
        el('span', { class: 'pinpanel__time' }, formatDayLabel(message.createdAt))),
      el('div', { class: 'pinpanel__text' }, (message.content || 'Attachment').slice(0, 200)));

    row.appendChild(el('div', { class: 'pinpanel__actions' },
      el('button', {
        class: 'btn btn--subtle btn--sm',
        type: 'button',
        onClick: () => { closePopover(); jumpToMessage(message.id); },
      }, 'Jump'),
      ...(canUnpin ? [el('button', {
        class: 'btn btn--subtle btn--sm',
        type: 'button',
        onClick: async () => {
          await setPinned(channelId, message.id, false);
          closePopover();
        },
      }, 'Unpin')] : [])));

    body.appendChild(row);
  }
}

// ------------------------------------------------------------------ search

function wireSearch() {
  let latest = 0;
  const run = debounce(async () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    if (!searchQuery) {
      searchResults = null;
      renderMessages({ jump: true });
      return;
    }
    searchResults = null;
    renderMessages();

    // Only the newest query may paint; slower earlier ones are discarded.
    const ticket = ++latest;
    const which = document.getElementById('chatSearchScope')?.value || 'channel';
    const guildId = store.conversation()?.guild?.id;
    const scope = which === 'all' ? {} : (which === 'space' && guildId ? { guildId } : { channelId: store.view.channelId });
    const hits = await searchServer(searchQuery, scope);
    if (ticket !== latest) return;
    searchResults = hits;
    renderMessages();
  }, 220);

  const scopeSel = document.getElementById('chatSearchScope');
  scopeSel?.addEventListener('change', () => { if (searchQuery) run(); });
  // "This space" only makes sense inside one; a DM offers channel and everywhere.
  store.on('view', () => { const opt = scopeSel?.querySelector('option[value="space"]'); if (opt) { opt.hidden = !store.conversation()?.guild; if (opt.hidden && scopeSel.value === 'space') scopeSel.value = 'channel'; } });

  searchInput.addEventListener('input', run);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleSearch(false);
  });
  document.getElementById('chatSearchClose').addEventListener('click', () => toggleSearch(false));
}

export function toggleSearch(force) {
  // The pinned panel is anchored right beside the search button, so leaving it
  // open would sit on top of the bar that just appeared.
  closePopover();
  const next = force === undefined ? searchBar.hidden : force;
  searchBar.hidden = !next;
  if (next) {
    searchInput.value = searchQuery;
    searchInput.focus();
    searchInput.select();
  } else {
    searchQuery = '';
    searchResults = null;
    searchInput.value = '';
    searchCount.textContent = '';
    renderMessages({ jump: true });
    composerInput.focus();
  }
}

// ------------------------------------------------------- desktop notifications

export function notifyIfNeeded(message) {
  if (message.authorId === store.selfId) return;
  // Focus Mode silences everything — mentions included. This is the "muted
  // means muted" people keep asking for.
  if (store.isFocusActive()) return;
  if (store.self?.status === 'dnd') return;
  if (store.ui.notifications === 'none') return;

  const isActive = message.channelId === store.view.channelId && document.hasFocus();
  if (isActive) return;

  const isDm = Boolean(store.dm(message.channelId));
  const mentionsMe = Array.isArray(message.mentions) && message.mentions.includes(store.selfId);

  // A space can override the global setting, so a noisy one can be muted
  // without going quiet everywhere.
  const guild = store.guildOfChannel(message.channelId);
  const level = guild ? spaceNotifyLevel(guild.id) : store.ui.notifications;
  if (level === 'none') return;
  // 'all' notifies for anything; 'mentions' narrows to DMs and direct mentions.
  if (level !== 'all' && !isDm && !mentionsMe) return;

  const conversation = store.conversation(message.channelId);
  const where = isDm ? '' : ` in #${conversation?.name || 'channel'}`;
  desktop.notify({
    title: `${store.userName(message.authorId)}${where}`,
    body: store.ui.notificationPreview ? message.content : 'Sent you a message',
    channelId: message.channelId,
  });
  if (store.ui.flashTaskbar) desktop.flash();
}
