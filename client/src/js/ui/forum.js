// A forum channel: instead of one message list, it's a list of posts (each
// post is a thread — see actions.js createThread/fetchThreads). This module
// renders that list into the same #messageScroll element chat.js normally
// fills with messages, and chat.js hides the composer/typing bar while a
// forum channel is open, since you can't post to a forum directly.

import { el, clear, initials } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { openModal } from './overlay.js';
import { labelledField, textInput, avatar } from './bits.js';
import { toastError } from './toast.js';
import { openConversation, createThread, fetchThreads, sendMessage, updateChannel, setThreadTags } from '../actions.js';
import { canManage } from './spacesettings.js';

const TAG_COLORS = ['#5b6cff', '#22cc88', '#e9724c', '#a866dc', '#e8b93b', '#39b8d6', '#e0576f', '#8b93a7'];

function relativeTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2_592_000) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

let activeTagFilter = null;
let searchQuery = '';

export async function renderForumPane(channelId) {
  const host = document.getElementById('messageScroll');
  if (!host) return;
  const channel = store.channel(channelId);
  if (!channel) return;

  clear(host);
  activeTagFilter = null;
  searchQuery = '';

  const wrap = el('div', { class: 'forum' });
  const toolbar = el('div', { class: 'forum__toolbar' });
  const search = textInput({ placeholder: 'Search posts…' });
  search.classList.add('forum__search');
  const newPostBtn = el('button', {
    class: 'btn btn--primary btn--sm',
    type: 'button',
    onClick: () => showNewPostModal(channelId),
  }, icon('plus'), 'New Post');
  // Curating the tag list is moderation work: moderators get the button
  // here, not only people who can edit the channel itself.
  const guild = store.guildOfChannel(channelId);
  if (guild && (canManage(guild, 'manageMessages') || canManage(guild, 'manageChannels'))) {
    toolbar.appendChild(el('button', {
      class: 'btn btn--sm', type: 'button', title: 'Add, rename or remove the tags posts can carry',
      onClick: () => showTagManager(store.channel(channelId) || channel),
    }, icon('tag'), 'Manage tags'));
  }
  toolbar.append(search, newPostBtn);
  wrap.appendChild(toolbar);

  const tagBar = el('div', { class: 'forum__tags' });
  wrap.appendChild(tagBar);

  const list = el('div', { class: 'forum__list' });
  wrap.appendChild(list);

  host.appendChild(wrap);

  function matchesFilters(thread) {
    if (activeTagFilter && !(thread.tags || []).includes(activeTagFilter)) return false;
    if (searchQuery && !thread.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }

  function renderTagBar(threads) {
    clear(tagBar);
    const tags = (store.channel(channelId) || channel).availableTags || [];
    if (!tags.length) return;
    tagBar.appendChild(el('button', {
      class: `forum__tagchip${activeTagFilter === null ? ' is-active' : ''}`,
      type: 'button',
      onClick: () => { activeTagFilter = null; renderList(threads); renderTagBar(threads); },
    }, 'All'));
    for (const tag of tags) {
      tagBar.appendChild(el('button', {
        class: `forum__tagchip${activeTagFilter === tag.id ? ' is-active' : ''}`,
        type: 'button',
        style: { '--tag-color': tag.color },
        onClick: () => { activeTagFilter = tag.id; renderList(threads); renderTagBar(threads); },
      }, tag.label));
    }
  }

  function renderList(threads) {
    clear(list);
    const filtered = threads.filter(matchesFilters).sort((a, b) => (b.lastActivityAt || b.createdAt) - (a.lastActivityAt || a.createdAt));
    if (!filtered.length) {
      list.appendChild(el('p', { class: 'field__hint', style: { padding: '20px' } },
        threads.length ? 'No posts match.' : 'No posts yet — be the first.'));
      return;
    }
    for (const thread of filtered) list.appendChild(postCard(store.channel(channelId) || channel, thread));
  }

  const threads = await fetchThreads(channelId);
  if (store.view.channelId !== channelId || !wrap.isConnected) return; // navigated away while loading
  renderTagBar(threads);
  renderList(threads);

  search.addEventListener('input', () => { searchQuery = search.value.trim(); renderList(threads); });

  // Keep the list live: a post created, renamed, locked or archived by
  // anyone shows up without reopening the channel. The listener retires
  // itself once this pane has been replaced.
  const off = store.on('threads', ({ thread }) => {
    if (!wrap.isConnected) { off(); return; }
    if (!thread || thread.parentChannelId !== channelId) return;
    const at = threads.findIndex((t) => t.id === thread.id);
    if (at === -1) threads.push(thread); else threads[at] = thread;
    renderList(threads);
  });
  // The tag list lives on the channel; an edit (yours or a moderator's)
  // arrives as a channel update, so the filter chips and cards follow it.
  const offGuilds = store.on('guilds', () => {
    if (!wrap.isConnected) { offGuilds(); return; }
    if (activeTagFilter && !((store.channel(channelId)?.availableTags) || []).some((t) => t.id === activeTagFilter)) activeTagFilter = null;
    renderTagBar(threads);
    renderList(threads);
  });
}

function postCard(channel, thread) {
  const author = store.user(thread.createdBy);
  const card = el('button', { class: 'forum__card', type: 'button' },
    author
      ? avatar(author, { size: 'sm' })
      : el('span', { class: 'avatar avatar--sm' }, initials(thread.name)),
    el('div', { class: 'forum__cardbody' },
      el('div', { class: 'forum__cardhead' },
        el('span', { class: 'forum__title' }, thread.name),
        thread.locked ? el('span', { class: 'forum__archived' }, 'Locked') : null,
        thread.archived ? el('span', { class: 'forum__archived' }, 'Archived') : null),
      el('div', { class: 'forum__cardmeta' },
        el('span', {}, author?.displayName || 'Unknown'),
        el('span', { class: 'forum__dot' }, '·'),
        el('span', {}, `${thread.replyCount || 0} repl${thread.replyCount === 1 ? 'y' : 'ies'}`),
        el('span', { class: 'forum__dot' }, '·'),
        el('span', {}, relativeTime(thread.lastActivityAt || thread.createdAt))),
      thread.tags?.length ? el('div', { class: 'forum__cardtags' },
        ...thread.tags.map((tagId) => {
          const tag = (channel.availableTags || []).find((t) => t.id === tagId);
          return tag ? el('span', { class: 'role-tag', style: { color: tag.color, borderColor: tag.color } }, tag.label) : null;
        })) : null));
  card.addEventListener('click', () => openConversation(thread.id, { guildId: channel.guildId }));
  // Right-click: the post's own tags, for its author and for moderators.
  if (canEditPostTags(channel, thread)) {
    card.title = 'Right-click to edit tags';
    card.addEventListener('contextmenu', (event) => { event.preventDefault(); showEditTagsModal(thread); });
  }
  return card;
}

/** Whether you may change a forum post's tags: you wrote it, or you moderate here. */
export function canEditPostTags(channel, thread) {
  const guild = store.guildOfChannel(channel.id);
  return Boolean(guild) && (thread.createdBy === store.selfId || canManage(guild, 'manageMessages'));
}

/** Pick the tags an existing post carries, from the forum's list. */
export function showEditTagsModal(thread) {
  const channel = store.channel(thread.parentChannelId);
  const tags = channel?.availableTags || [];
  if (!channel) return;
  if (!tags.length) { toastError('This forum has no tags yet. Add some with Manage tags first.'); return; }
  const chosen = new Set(thread.tags || []);
  const picker = el('div', { class: 'forum__tagpicker' }, ...tags.map((tag) => {
    const chip = el('button', {
      class: `forum__tagchip${chosen.has(tag.id) ? ' is-active' : ''}`, type: 'button', style: { '--tag-color': tag.color },
      onClick: () => { if (chosen.has(tag.id)) { chosen.delete(tag.id); chip.classList.remove('is-active'); } else if (chosen.size < 5) { chosen.add(tag.id); chip.classList.add('is-active'); } else toastError('A post can carry up to five tags.'); },
    }, tag.label);
    return chip;
  }));
  const handle = openModal({
    title: 'Edit tags',
    subtitle: thread.name,
    body: [el('p', { class: 'field__hint' }, 'Pick up to five. Everyone in the forum sees the change straight away.'), picker],
  });
  const save = el('button', { class: 'btn btn--primary', type: 'button', onClick: async () => { save.disabled = true; const ok = await setThreadTags(thread.id, [...chosen]); if (ok) handle.close(); else save.disabled = false; } }, 'Save tags');
  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => handle.close() }, 'Cancel'),
    save));
}

export function showNewPostModal(channelId) {
  const channel = store.channel(channelId);
  if (!channel) return;
  const title = textInput({ id: 'postTitle', maxLength: 100, placeholder: 'What\'s this post about?' });
  const body = el('textarea', {
    id: 'postBody', class: 'field__input field__textarea', rows: '5',
    placeholder: 'Write the first message…',
  });
  const chosenTags = new Set();
  const tags = channel.availableTags || [];
  const tagPicker = tags.length ? el('div', { class: 'forum__tagpicker' },
    ...tags.map((tag) => {
      const chip = el('button', {
        class: 'forum__tagchip',
        type: 'button',
        style: { '--tag-color': tag.color },
        onClick: () => {
          if (chosenTags.has(tag.id)) { chosenTags.delete(tag.id); chip.classList.remove('is-active'); }
          else { chosenTags.add(tag.id); chip.classList.add('is-active'); }
        },
      }, tag.label);
      return chip;
    })) : null;

  const handle = openModal({
    title: 'New Post',
    subtitle: `#${channel.name}`,
    body: [
      labelledField({ id: 'postTitle', label: 'Title', input: title }),
      labelledField({ id: 'postBody', label: 'Message', input: body }),
      tags.length ? el('p', { class: 'field__label' }, 'Tags') : null,
      tagPicker,
    ],
    initialFocus: '#postTitle',
  });

  const post = el('button', { class: 'btn btn--primary', type: 'button' }, 'Post');
  post.addEventListener('click', async () => {
    const titleValue = title.value.trim();
    const bodyValue = body.value.trim();
    if (!titleValue) { toastError('Give the post a title.'); return; }
    if (!bodyValue) { toastError('Write something for the first message.'); return; }
    post.disabled = true;
    const thread = await createThread(channelId, { name: titleValue, tags: [...chosenTags] });
    if (!thread) { post.disabled = false; return; }
    await sendMessage(bodyValue, [], null, thread.id);
    handle.close();
    openConversation(thread.id, { guildId: channel.guildId });
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => handle.close() }, 'Cancel'),
    post));
}

/** The tag manager on its own, for moderators who cannot open channel settings. */
export function showTagManager(channel) {
  openModal({
    title: `Tags for #${channel.name}`,
    subtitle: 'Posts can carry any of these. Changes save as you type.',
    body: buildTagManager(channel),
  });
}

/** Tag manager shown in channel settings for a forum channel. */
export function buildTagManager(channel) {
  const wrap = el('div', { class: 'forum__tagmanager' });
  let tags = (channel.availableTags || []).map((t) => ({ ...t }));

  function render() {
    clear(wrap);
    for (const tag of tags) {
      const name = textInput({ value: tag.label, maxLength: 24 });
      name.addEventListener('blur', () => { tag.label = name.value.trim() || tag.label; save(); });
      const swatch = el('div', { class: 'swatches' }, ...TAG_COLORS.map((c) => el('button', {
        class: `swatch${c === tag.color ? ' is-current' : ''}`,
        type: 'button',
        style: { background: c },
        onClick: () => { tag.color = c; save(); render(); },
      })));
      wrap.appendChild(el('div', { class: 'forum__tagrow' },
        name,
        swatch,
        el('button', {
          class: 'icon-btn icon-btn--danger', type: 'button', title: 'Remove tag',
          onClick: () => { tags = tags.filter((t) => t !== tag); save(); render(); },
        }, icon('trash'))));
    }
    wrap.appendChild(el('button', {
      class: 'btn btn--sm', type: 'button',
      disabled: tags.length >= 20,
      onClick: () => { tags.push({ label: 'New tag', color: TAG_COLORS[tags.length % TAG_COLORS.length] }); save(); render(); },
    }, 'Add tag'));
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => updateChannel(channel.id, { availableTags: tags }), 400);
  }

  render();
  return wrap;
}
