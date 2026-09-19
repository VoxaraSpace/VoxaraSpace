import { net, desktop, setSetting, getSetting } from './client.js';
import { store } from './state.js';
import { toastError, toastSuccess } from './ui/toast.js';
import { applyTheme, currentThemeId, registerThemes } from './theme.js';

let nonceCounter = 0;
const newNonce = () => `n${Date.now().toString(36)}-${nonceCounter++}`;

function reportError(err, fallback = 'That did not work.') {
  const message = err?.message || fallback;
  toastError(message);
  return null;
}

// -------------------------------------------------------------- navigation

export async function openConversation(channelId, { guildId = null, focusComposer = true, chat = false } = {}) {
  if (!channelId) return;
  // A voice channel has a text chat of its own (opened with chat: true, which
  // is what clicking it in the sidebar does, alongside joining the call). Any
  // other route to a voice channel joins it.
  const chan = store.channel(channelId);
  if (chan?.type === 'voice' && !chat) {
    void import('./ui/call.js').then((m) => m.startVoiceChannel(channelId, chan.name));
    return;
  }
  const guild = guildId ? store.guild(guildId) : store.guildOfChannel(channelId);
  // A DM has no space, so it sits under the "home" view kind.
  store.setView({
    kind: guild ? 'guild' : 'home',
    guildId: guild?.id || null,
    channelId,
  });
  if (!guild) store.lastChannelByGuild.set('@home', channelId);
  // Follow the conversation into whichever section it belongs to.
  setSidebarMode(guild ? 'spaces' : 'friends');

  // Under-18s in an adults-only space (or an age-restricted channel) get the
  // explanation screen; the server would refuse the history anyway, so do not
  // ask for it and do not raise the error toast.
  const gateChan = chan?.type === 'thread' ? store.channel(chan.parentChannelId) : chan;
  if (guild && !store.self?.adult && (guild.adult || gateChan?.nsfw)) return;

  if (!store.loaded.has(channelId)) await loadHistory(channelId);
  markRead(channelId);

  if (focusComposer) {
    requestAnimationFrame(() => document.getElementById('composerInput')?.focus());
  }
}

/** Opens a space, restoring whichever channel was last read there. */
export function openGuild(guildId) {
  const guild = store.guild(guildId);
  if (!guild) return;
  setSidebarMode('spaces');
  // First visit to a space with a welcome screen: show it over the channel.
  void import('./ui/onboarding.js').then((m) => m.maybeShowOnboarding(guildId));
  const remembered = store.lastChannelByGuild.get(guildId);
  // Land on a real text channel — never auto-join a voice channel by opening the space.
  const textChannels = guild.channels.filter((c) => c.type !== 'voice');
  const target = textChannels.find((c) => c.id === remembered) || textChannels[0];
  if (!target) {
    store.setView({ kind: 'guild', guildId, channelId: null });
    return;
  }
  openConversation(target.id, { guildId });
}

export function openHome() {
  setSidebarMode('friends');
  const remembered = store.lastChannelByGuild.get('@home');
  const dm = store.dms.get(remembered) || [...store.dms.values()][0];
  store.setView({ kind: 'home', guildId: null, channelId: dm?.id || null });
  if (dm) {
    if (!store.loaded.has(dm.id)) loadHistory(dm.id);
    markRead(dm.id);
  }
}

/**
 * The conversations in the section you are currently in — friends' DMs, or the
 * channels of every space. Alt+Arrow walks this list.
 */
export function currentNavList() {
  if (store.ui.sidebarMode === 'friends') return [...store.dms.keys()];
  const ids = [];
  for (const guild of store.guilds.values()) {
    for (const channel of guild.channels) ids.push(channel.id);
  }
  return ids;
}

export function cycleChannel(delta) {
  const list = currentNavList();
  if (list.length === 0) return;
  const index = list.indexOf(store.view.channelId);
  const next = list[(index + delta + list.length) % list.length];
  // No guildId hint: the target may live in a different space entirely.
  if (next) openConversation(next);
}

export function cycleGuild(delta) {
  const ids = ['@home', ...store.guilds.keys()];
  const current = store.view.kind === 'home' ? '@home' : store.view.guildId;
  const index = Math.max(0, ids.indexOf(current));
  const next = ids[(index + delta + ids.length) % ids.length];
  if (next === '@home') openHome();
  else openGuild(next);
}

// ----------------------------------------------------------------- history

export async function loadHistory(channelId) {
  try {
    const result = await net.request('messages:fetch', { channelId, limit: 50 });
    store.setMessages(channelId, result.messages, result.hasMore);
  } catch (err) {
    if (err.code !== 'disconnected') reportError(err, 'Could not load messages.');
    store.setMessages(channelId, [], false);
  }
}

export async function loadOlder(channelId) {
  const list = store.messagesFor(channelId);
  const oldest = list.find((m) => !m.pending);
  if (!oldest) return 0;
  try {
    const result = await net.request('messages:fetch', { channelId, before: oldest.id, limit: 50 });
    store.prependMessages(channelId, result.messages, result.hasMore);
    return result.messages.length;
  } catch (err) {
    reportError(err, 'Could not load older messages.');
    return 0;
  }
}

// ------------------------------------------------------------------ threads

/** Starts a thread — from a specific message (messageId) or standalone.
 * `tags` only applies when channelId is a forum channel. */
export async function createThread(channelId, { name = '', messageId = null, tags = [] } = {}) {
  try {
    const result = await net.request('thread:create', { channelId, name, messageId, tags });
    store.upsertThread(result.thread);
    return result.thread;
  } catch (err) {
    reportError(err, 'Could not start a thread.');
    return null;
  }
}

export async function fetchThreads(channelId) {
  try {
    const result = await net.request('thread:list', { channelId });
    for (const thread of result.threads) store.upsertThread(thread);
    return result.threads;
  } catch (err) {
    reportError(err, 'Could not load threads.');
    return [];
  }
}

/** Lock (or unlock) a thread so only moderators can post in it. */
/** Replace a forum post's tags (author or a moderator). */
export async function setThreadTags(threadId, tags) {
  try {
    const result = await net.request('thread:set-tags', { threadId, tags });
    store.upsertThread(result.thread);
    return true;
  } catch (err) {
    reportError(err, 'Could not update the tags on that post.');
    return false;
  }
}

export async function lockThread(threadId, locked = true) {
  try {
    const result = await net.request('thread:lock', { threadId, locked });
    store.upsertThread(result.thread);
    return true;
  } catch (err) {
    reportError(err, 'Could not update that thread.');
    return false;
  }
}

/** Disconnect someone from a voice channel (needs the moveMembers permission). */
export async function kickFromVoice(channelId, userId) {
  try {
    await net.request('voice:kick', { channelId, userId });
    return true;
  } catch (err) {
    reportError(err, 'Could not disconnect them.');
    return false;
  }
}

/** Move someone into another voice channel in the same space. */
export async function moveVoiceMember(channelId, userId) {
  try {
    await net.request('voice:move', { channelId, userId });
    return true;
  } catch (err) {
    reportError(err, 'Could not move them.');
    return false;
  }
}

/** Delete a thread or forum post and everything in it. */
export async function deleteThread(threadId) {
  try {
    await net.request('thread:delete', { threadId });
    store.removeThread(threadId);
    return true;
  } catch (err) {
    reportError(err, 'Could not delete that post.');
    return false;
  }
}

export async function archiveThread(threadId, archived = true) {
  try {
    const result = await net.request('thread:archive', { threadId, archived });
    store.upsertThread(result.thread);
    return true;
  } catch (err) {
    reportError(err, 'Could not update that thread.');
    return false;
  }
}

// ----------------------------------------------------------------- webhooks

/** Creates a webhook bound to a text channel. The returned token is shown
 * exactly once by the server — nothing else fetches it again. */
export async function createWebhook(channelId, name) {
  try {
    const result = await net.request('webhook:create', { channelId, name });
    store.upsertUser(result.webhook);
    return result;
  } catch (err) {
    reportError(err, 'Could not create that webhook.');
    return null;
  }
}

export async function fetchWebhooks(channelId) {
  try {
    const result = await net.request('webhook:list', { channelId });
    store.upsertUsers(Object.fromEntries(result.webhooks.map((w) => [w.id, w])));
    return result.webhooks;
  } catch (err) {
    reportError(err, 'Could not load webhooks.');
    return [];
  }
}

export async function renameWebhook(webhookId, name) {
  try {
    const result = await net.request('webhook:rename', { webhookId, name });
    store.upsertUser(result.webhook);
    return true;
  } catch (err) {
    reportError(err, 'Could not rename that webhook.');
    return false;
  }
}

export async function resetWebhookToken(webhookId) {
  try {
    return await net.request('webhook:reset-token', { webhookId });
  } catch (err) {
    reportError(err, 'Could not reset that token.');
    return null;
  }
}

export async function deleteWebhook(webhookId) {
  try {
    await net.request('webhook:delete', { webhookId });
    return true;
  } catch (err) {
    reportError(err, 'Could not delete that webhook.');
    return false;
  }
}

// ---------------------------------------------------------------- messages

// `channelId` defaults to whatever's open; forwarding a message passes a
// different one explicitly, so it can post elsewhere without disturbing the
// conversation actually on screen (see forwardMessage() in ui/chat.js).
export async function sendMessage(content, attachments = [], replyTo = null, channelId = store.view.channelId, forwardedFrom = null) {
  const text = String(content).trim();
  if (!channelId || (!text && attachments.length === 0)) return;

  const nonce = newNonce();
  store.addPending({
    id: nonce,
    nonce,
    channelId,
    authorId: store.selfId,
    content: text,
    attachments,
    reactions: {},
    mentions: [],
    createdAt: Date.now(),
    editedAt: null,
    replyTo,
    forwardedFrom,
    pending: true,
  });

  try {
    await net.request('message:send', { channelId, content: text, attachments, nonce, replyTo, forwardedFrom });
    // The confirming `message:new` event swaps the pending row for the real one.
  } catch (err) {
    store.markPendingFailed(channelId, nonce);
    reportError(err, 'Message not sent.');
  }
}

export async function retryMessage(channelId, nonce) {
  const list = store.messagesFor(channelId);
  const failed = list.find((m) => m.nonce === nonce);
  if (!failed) return;
  store.removePending(channelId, nonce);
  const previous = store.view.channelId;
  store.view.channelId = channelId;
  await sendMessage(failed.content);
  store.view.channelId = previous;
}

export async function editMessage(channelId, messageId, content) {
  try {
    await net.request('message:edit', { channelId, messageId, content });
    return true;
  } catch (err) {
    reportError(err, 'Could not save that edit.');
    return false;
  }
}

export async function deleteMessage(channelId, messageId) {
  try {
    await net.request('message:delete', { channelId, messageId });
  } catch (err) {
    reportError(err, 'Could not delete that message.');
  }
}

/** Pin or unpin a message. `pinned` false unpins. */
export async function setPinned(channelId, messageId, pinned) {
  try {
    await net.request('message:pin', { channelId, messageId, pinned });
  } catch (err) {
    reportError(err, pinned ? 'Could not pin that.' : 'Could not unpin that.');
  }
}

export async function fetchPinned(channelId) {
  try {
    const data = await net.request('messages:pinned', { channelId });
    return data.messages || [];
  } catch (err) {
    reportError(err, 'Could not load pinned messages.');
    return [];
  }
}

/**
 * Full-history search on the server. Scope is the current channel when one is
 * given, otherwise everything this account can read.
 */
export async function searchMessages(query, { channelId = null, guildId = null, dmsOnly = false } = {}) {
  try {
    const scope = { query };
    if (channelId) scope.channelId = channelId;
    else if (guildId) scope.guildId = guildId;
    else if (dmsOnly) scope.dmsOnly = true;
    const data = await net.request('messages:search', scope);
    return data.messages || [];
  } catch (err) {
    if (err.code !== 'query_too_short') reportError(err, 'Search failed.');
    return [];
  }
}

/** Copies text and says so, falling back quietly where the clipboard is refused. */
export async function copyToClipboard(text, what = 'Copied') {
  try {
    await desktop.copyText(String(text));
    toastSuccess(`${what} copied.`);
    return true;
  } catch {
    toastError('Could not reach the clipboard.');
    return false;
  }
}

export async function reportToAdmin(payload) {
  try {
    await net.request('report:create', payload);
    toastSuccess(payload.guildId
      ? 'Reported. This space’s moderators will see it.'
      : 'Reported. The server admin will see it.');
  } catch (err) {
    reportError(err, 'Could not send that report.');
  }
}

/** Reports raised in a space, for its moderators. */
export async function fetchModReports(guildId) {
  try {
    return await net.request('mod:reports', { guildId });
  } catch (err) {
    reportError(err, 'Could not load reports.');
    return { reports: [], users: {} };
  }
}

export async function resolveModReport(reportId) {
  try {
    await net.request('mod:resolve-report', { reportId });
    return true;
  } catch (err) {
    reportError(err, 'Could not resolve that report.');
    return false;
  }
}

/** Time a member out (they cannot post) for `seconds`; 0 lifts it. */
export async function timeoutMember(guildId, userId, seconds) {
  try {
    await net.request('member:timeout', { guildId, userId, seconds });
    return true;
  } catch (err) {
    reportError(err, 'Could not time out that member.');
    return false;
  }
}

/** Replace the space's automod word list. */
export async function setAutomodWords(guildId, words) {
  try {
    await net.request('automod:set', { guildId, words });
    return true;
  } catch (err) {
    reportError(err, 'Could not save the word filter.');
    return false;
  }
}

export async function blockUser(userId) {
  try {
    const data = await net.request('users:block', { userId });
    store.blocked = new Set(data.blocked || []);
    store.friends.delete(userId);
    store.emit('friends');
    toastSuccess('Blocked. They can no longer message you or send requests.');
  } catch (err) {
    reportError(err, 'Could not block that person.');
  }
}

export async function unblockUser(userId) {
  try {
    const data = await net.request('users:unblock', { userId });
    store.blocked = new Set(data.blocked || []);
    store.emit('friends');
    toastSuccess('Unblocked.');
  } catch (err) {
    reportError(err, 'Could not unblock that person.');
  }
}

export async function toggleReaction(channelId, messageId, emoji) {
  try {
    await net.request('reaction:toggle', { channelId, messageId, emoji });
  } catch (err) {
    reportError(err, 'Could not add that reaction.');
  }
}

export async function createPoll(channelId, { question, options, multi, durationHours }) {
  return net.request('poll:create', { channelId, question, options, multi, durationHours });
}

export async function votePoll(channelId, messageId, optionId) {
  try {
    await net.request('poll:vote', { channelId, messageId, optionId });
  } catch (err) {
    reportError(err, 'Could not record your vote.');
  }
}

export async function closePoll(channelId, messageId) {
  try {
    await net.request('poll:close', { channelId, messageId });
  } catch (err) {
    reportError(err, 'Could not close that poll.');
  }
}

export async function toggleBookmark(channelId, messageId) {
  try {
    const result = await net.request('bookmark:toggle', { channelId, messageId });
    store.applyBookmarkToggle({ ...result, messageId });
    return result;
  } catch (err) {
    reportError(err, 'Could not save that message.');
    return null;
  }
}

export async function remindBookmark(bookmarkId, remindAt) {
  try {
    const { bookmark } = await net.request('bookmark:remind', { bookmarkId, remindAt });
    store.updateBookmark(bookmark);
    return bookmark;
  } catch (err) {
    reportError(err, 'Could not set that reminder.');
    return null;
  }
}

export async function addSpaceEmoji(guildId, name, dataUrl) {
  const { emoji } = await net.request('emoji:add', { guildId, name, data: dataUrl });
  return emoji;
}

export async function deleteSpaceEmoji(guildId, emojiId) {
  try {
    await net.request('emoji:delete', { guildId, emojiId });
  } catch (err) {
    reportError(err, 'Could not remove that emoji.');
  }
}

export async function scheduleMessage(channelId, content, sendAt, { repeat = 'none', attachments = [] } = {}) {
  const { scheduled } = await net.request('schedule:create', { channelId, content, sendAt, repeat, attachments });
  store.addScheduled(scheduled);
  return scheduled;
}

export async function cancelScheduled(id) {
  try {
    await net.request('schedule:cancel', { id });
    store.removeScheduled(id);
  } catch (err) {
    reportError(err, 'Could not cancel that scheduled message.');
  }
}

export async function refreshScheduled() {
  try {
    const { scheduled } = await net.request('schedule:list', {});
    store.setScheduled(scheduled);
  } catch { /* non-critical */ }
}

/** Refresh the inbox from the server (saved messages + mentions). */
export async function refreshInbox() {
  try {
    const [bm, mn] = await Promise.all([
      net.request('bookmark:list'),
      net.request('inbox:mentions'),
    ]);
    store.setBookmarks(bm.bookmarks);
    store.setMentions(mn.mentions);
  } catch (err) {
    reportError(err, 'Could not load your inbox.');
  }
}

let lastTypingPing = 0;
export function pingTyping() {
  const channelId = store.view.channelId;
  if (!channelId) return;
  const now = Date.now();
  if (now - lastTypingPing < 3000) return;
  lastTypingPing = now;
  net.notify('typing:start', { channelId });
}

// -------------------------------------------------------------- read state

export function markRead(channelId) {
  if (!channelId) return;
  const changed = store.clearUnread(channelId);
  const lastId = store.lastMessageId(channelId);
  if (!lastId) return;
  if (!changed && store.reads[channelId] === lastId) return;
  store.reads[channelId] = lastId;
  net.notify('read:ack', { channelId, messageId: lastId });
}

// ------------------------------------------------------------------ guilds

export async function createGuild(name, template = 'blank') {
  const result = await net.request('guild:create', { name, template });
  store.upsertGuild(result.guild);
  openGuild(result.guild.id);
  toastSuccess(`“${result.guild.name}” is ready. Share the invite link to bring people in.`, 'Space created');
  return result.guild;
}

/** The shareable form of an invite: a link to the join page. */
export function inviteLink(code) {
  const base = (store.server?.publicUrl || 'https://voxaraspace.com').replace(/\/+$/, '');
  return `${base}/invite/${String(code || '').trim().toUpperCase()}`;
}

/** A code, from either a pasted link (…/invite/CODE, or the older …/join/CODE) or the bare code. */
export function inviteCodeFrom(value) {
  const text = String(value || '').trim();
  const m = /\/(?:invite|join)\/([A-Za-z0-9-]{4,16})/i.exec(text) || /^([A-Za-z0-9-]{4,16})$/.exec(text);
  return m ? m[1].toUpperCase() : text.toUpperCase();
}

export async function joinGuild(invite) {
  const result = await net.request('guild:join', { invite: inviteCodeFrom(invite) });
  store.upsertUsers(result.users);
  store.upsertGuild(result.guild);
  openGuild(result.guild.id);
  if (!result.alreadyMember) toastSuccess(`Welcome to ${result.guild.name}.`, 'Joined');
  return result.guild;
}

export async function leaveGuild(guildId) {
  await net.request('guild:leave', { guildId });
  store.removeGuild(guildId);
  openHome();
}

export async function deleteGuild(guildId) {
  await net.request('guild:delete', { guildId });
  store.removeGuild(guildId);
  openHome();
}

export async function renameGuild(guildId, name) {
  await net.request('guild:update', { guildId, name });
}

/** Name, description and colour in one call. */
export async function updateGuild(guildId, patch) {
  const result = await net.request('guild:update', { guildId, ...patch });
  if (result.guild) store.upsertGuild(result.guild);
  return result.guild;
}

export async function fetchRoles(guildId) {
  try {
    return await net.request('roles:list', { guildId });
  } catch (err) {
    reportError(err, 'Could not load roles.');
    return { roles: [], memberRoles: {}, permissions: {} };
  }
}

export async function createRole(guildId, name, color, permissions, hoist) {
  try {
    const data = await net.request('role:create', { guildId, name, color, permissions, hoist });
    return data.role;
  } catch (err) {
    reportError(err, 'Could not create that role.');
    return null;
  }
}

export async function updateRole(guildId, roleId, patch) {
  try {
    await net.request('role:update', { guildId, roleId, ...patch });
    return true;
  } catch (err) {
    reportError(err, 'Could not save that role.');
    return false;
  }
}

export async function deleteRole(guildId, roleId) {
  try {
    await net.request('role:delete', { guildId, roleId });
    toastSuccess('Role deleted.');
    return true;
  } catch (err) {
    reportError(err, 'Could not delete that role.');
    return false;
  }
}

export async function reorderRoles(guildId, roleIds) {
  try {
    await net.request('role:reorder', { guildId, roleIds });
    return true;
  } catch (err) {
    reportError(err, 'Could not reorder roles.');
    return false;
  }
}

export async function setMemberRoles(guildId, userId, roleIds) {
  try {
    await net.request('member:set-roles', { guildId, userId, roleIds });
    return true;
  } catch (err) {
    reportError(err, 'Could not change those roles.');
    return false;
  }
}

export async function banMember(guildId, userId, reason = '') {
  try {
    await net.request('guild:ban', { guildId, userId, reason });
    toastSuccess('Banned. They cannot rejoin with the invite.');
  } catch (err) {
    reportError(err, 'Could not ban them.');
  }
}

export async function unbanMember(guildId, userId) {
  try {
    await net.request('guild:unban', { guildId, userId });
    toastSuccess('Ban lifted.');
  } catch (err) {
    reportError(err, 'Could not lift that ban.');
  }
}

export async function fetchBans(guildId) {
  try {
    return await net.request('guild:bans', { guildId });
  } catch (err) {
    reportError(err, 'Could not load the ban list.');
    return { bans: [], users: {} };
  }
}

export async function fetchAudit(guildId) {
  try {
    return await net.request('guild:audit', { guildId });
  } catch (err) {
    reportError(err, 'Could not load the moderation log.');
    return { entries: [], users: {} };
  }
}

// --- safety & trust -------------------------------------------------------

export async function setVerification(guildId, level) {
  try {
    await net.request('verification:set', { guildId, level });
    const g = store.guild(guildId); if (g) { g.verification = level; store.emit('guilds'); }
    toastSuccess('Verification level updated.');
  } catch (err) { reportError(err, 'Could not change verification.'); }
}

export async function setAntiRaid(guildId, config) {
  try {
    const { antiRaid } = await net.request('antiraid:set', { guildId, ...config });
    const g = store.guild(guildId); if (g) { g.antiRaid = antiRaid; store.emit('guilds'); }
    return antiRaid;
  } catch (err) { reportError(err, 'Could not update raid protection.'); return null; }
}

export async function setLockdown(guildId, on, minutes) {
  try {
    await net.request('guild:lockdown', { guildId, on, minutes });
    toastSuccess(on ? 'Lockdown on — only moderators can post.' : 'Lockdown lifted.');
  } catch (err) { reportError(err, 'Could not change the lockdown.'); }
}

export async function fetchNotes(guildId, userId) {
  try { return await net.request('note:list', { guildId, userId }); }
  catch (err) { reportError(err, 'Could not load notes.'); return { notes: [], users: {} }; }
}

export async function addNote(guildId, userId, text) {
  try { const { note } = await net.request('note:add', { guildId, userId, text }); return note; }
  catch (err) { reportError(err, 'Could not save that note.'); return null; }
}

export async function deleteNote(guildId, userId, noteId) {
  try { await net.request('note:delete', { guildId, userId, noteId }); }
  catch (err) { reportError(err, 'Could not delete that note.'); }
}

export async function submitAppeal(invite, text) {
  return net.request('appeal:submit', { invite, text });
}

export async function fetchAppeals(guildId) {
  try { return await net.request('mod:appeals', { guildId }); }
  catch (err) { reportError(err, 'Could not load appeals.'); return { appeals: [], users: {} }; }
}

export async function resolveAppeal(guildId, userId, action) {
  try { await net.request('appeal:resolve', { guildId, userId, action }); }
  catch (err) { reportError(err, 'Could not resolve that appeal.'); }
}

/** Delete any message (moderator use, from the report queue). */
export async function modDeleteMessage(channelId, messageId) {
  try { await net.request('message:delete', { channelId, messageId }); }
  catch (err) { reportError(err, 'Could not delete that message.'); }
}

// --- differentiators: catch-up, tasks, peek, export ----------------------

export async function catchUp(channelId) {
  const { digest } = await net.request('channel:catchup', { channelId });
  return digest;
}

export async function listTasks(guildId) {
  try { return (await net.request('task:list', { guildId })).tasks; }
  catch (err) { reportError(err, 'Could not load the to-do board.'); return []; }
}
export async function addTask(guildId, text) {
  try { return (await net.request('task:add', { guildId, text })).task; }
  catch (err) { reportError(err, 'Could not add that task.'); return null; }
}
export async function toggleTask(guildId, taskId) {
  try { return (await net.request('task:toggle', { guildId, taskId })).task; }
  catch (err) { reportError(err, 'Could not update that task.'); return null; }
}
export async function deleteTask(guildId, taskId) {
  try { await net.request('task:delete', { guildId, taskId }); }
  catch (err) { reportError(err, 'Could not remove that task.'); }
}

export async function peekGuild(invite) {
  return net.request('guild:peek', { invite: inviteCodeFrom(invite) });
}

export async function exportMyData() {
  return net.request('me:export');
}

// --- Steam integration ---------------------------------------------------

/**
 * Age verification by credit card (Stripe). The server opens a Stripe page in
 * the browser; when it finishes, the server marks the account and pushes
 * `self:age` to every open client.
 */
export async function startAgeVerification() {
  const { url } = await net.request('age:verify-start');
  desktop.openExternal(url);
}

export async function linkSteam() {
  const { url } = await net.request('steam:link-url');
  desktop.openExternal(url);
}

export async function unlinkSteam() {
  try {
    await net.request('steam:unlink');
    store.self = { ...store.self, steam: null, steamLinked: false };
    store.emit('self');
    toastSuccess('Steam account unlinked.');
  } catch (err) { reportError(err, 'Could not unlink Steam.'); }
}

export async function fetchSteamProfile(userId) {
  return net.request('steam:profile', { userId });
}

export async function fetchSteamWishlist(userId) {
  return net.request('steam:wishlist', { userId });
}

/** Opens a game's Steam store page — and counts the click for the metrics. */
export function openSteamStore(appid) {
  net.request('steam:click', { appid }).catch(() => {});
  desktop.openExternal(`https://store.steampowered.com/app/${appid}/`);
}

export function fetchSteamStore() {
  return net.request('steam:store');
}

export function searchSteamStore(term) {
  return net.request('steam:store-search', { term });
}

export function fetchSteamApp(appid) {
  return net.request('steam:app', { appid });
}

export function fetchSteamForYou() {
  return net.request('steam:store-foryou');
}

export function fetchSteamTogether() {
  return net.request('steam:together');
}

// ------------------------------------------------------------ cards
export async function fetchCardCollection() {
  const col = await net.request('cards:collection');
  store.cards = col; store.emit('cards');
  return col;
}
export async function claimDailyDrop() {
  const res = await net.request('cards:daily');
  store.cards = res.collection; store.emit('cards');
  return res.card;
}
export async function redeemCardReward() {
  const res = await net.request('cards:redeem');
  store.cards = res.collection; store.emit('cards');
  return res.reward;
}

export async function setSteamCountry(cc) {
  const res = await net.request('steam:set-country', { cc });
  store.self = { ...store.self, steamCountry: res.cc };
  store.emit('self');
  return res.cc;
}

export async function kickMember(guildId, userId) {
  await net.request('guild:kick', { guildId, userId });
  const guild = store.guild(guildId);
  if (guild) {
    guild.memberIds = guild.memberIds.filter((id) => id !== userId);
    store.emit('guilds');
    store.emit('users');
  }
}

export async function resetInvite(guildId) {
  const result = await net.request('guild:reset-invite', { guildId });
  const guild = store.guild(guildId);
  if (guild) {
    guild.invite = result.invite;
    store.emit('guilds');
  }
  return result.invite;
}

export async function reorderChannels(guildId, channelIds) {
  const result = await net.request('channel:reorder', { guildId, channelIds });
  const guild = store.guild(guildId);
  if (guild && result.channels) {
    guild.channels = result.channels;
    store.emit('guilds');
  }
}

// ---------------------------------------------------------------- channels

export async function createCategory(guildId, name) {
  try {
    const data = await net.request('category:create', { guildId, name });
    return data.category;
  } catch (err) {
    reportError(err, 'Could not create that category.');
    return null;
  }
}

export async function renameCategory(guildId, categoryId, name) {
  try {
    await net.request('category:rename', { guildId, categoryId, name });
  } catch (err) {
    reportError(err, 'Could not rename that category.');
  }
}

export async function deleteCategory(guildId, categoryId) {
  try {
    const data = await net.request('category:delete', { guildId, categoryId });
    if (data.moved) toastSuccess(`Category deleted. ${data.moved} channel${data.moved === 1 ? '' : 's'} moved.`);
    else toastSuccess('Category deleted.');
  } catch (err) {
    reportError(err, 'Could not delete that category.');
  }
}

export async function reorderCategories(guildId, categoryIds) {
  try {
    await net.request('category:reorder', { guildId, categoryIds });
  } catch (err) {
    reportError(err, 'Could not reorder categories.');
  }
}

export async function moveChannelToCategory(channelId, categoryId) {
  try {
    await net.request('channel:update', { channelId, categoryId });
  } catch (err) {
    reportError(err, 'Could not move that channel.');
  }
}

export async function createChannel(guildId, name, topic = '', categoryId = null, type = 'text', { nsfw = false } = {}) {
  const result = await net.request('channel:create', { guildId, name, topic, categoryId, type, nsfw });
  store.addChannel(result.channel);
  if (result.channel.type !== 'voice') openConversation(result.channel.id, { guildId });
  return result.channel;
}

export async function updateChannel(channelId, patch) {
  const result = await net.request('channel:update', { channelId, ...patch });
  store.updateChannel(result.channel);
  return result.channel;
}

/** `value` is 'allow', 'deny', or null to clear the override back to inherit.
 * Returns the updated channel (so a caller holding a stale reference can
 * swap it in), or null if the change was refused. */
export async function setChannelOverwrite(channelId, roleId, permission, value) {
  try {
    const result = await net.request('channel:set-overwrite', { channelId, roleId, permission, value });
    store.updateChannel(result.channel);
    return result.channel;
  } catch (err) {
    reportError(err, 'Could not change that permission.');
    return null;
  }
}

/** Same as above but for a category; returns the updated category. */
export async function setCategoryOverwrite(guildId, categoryId, roleId, permission, value) {
  try {
    const result = await net.request('category:set-overwrite', { guildId, categoryId, roleId, permission, value });
    return result.category;
  } catch (err) {
    reportError(err, 'Could not change that permission.');
    return null;
  }
}

export async function deleteChannel(channelId) {
  const guild = store.guildOfChannel(channelId);
  await net.request('channel:delete', { channelId });
  if (guild) {
    store.removeChannel(guild.id, channelId);
    if (store.view.channelId === channelId) openGuild(guild.id);
  }
}

// --------------------------------------------------------------------- DMs

/** Makes sure a DM with this user exists (creating it server-side on first
 * contact), without navigating there — for posting into a DM the current
 * view never opened (see forwardMessage() in ui/chat.js). */
export async function ensureDm(userId) {
  const result = await net.request('dm:open', { userId });
  store.upsertUsers(result.users);
  store.upsertDm(result.dm);
  return result.dm;
}

export async function openDm(userId) {
  try {
    const result = await net.request('dm:open', { userId });
    store.upsertUsers(result.users);
    store.upsertDm(result.dm);
    store.setView({ kind: 'home', guildId: null, channelId: result.dm.id });
    store.lastChannelByGuild.set('@home', result.dm.id);
    if (!store.loaded.has(result.dm.id)) await loadHistory(result.dm.id);
    markRead(result.dm.id);
    requestAnimationFrame(() => document.getElementById('composerInput')?.focus());
    return result.dm;
  } catch (err) {
    return reportError(err, 'Could not open that conversation.');
  }
}

// ---------------------------------------------------------------- friends

export async function addFriend(username) {
  const result = await net.request('friends:add', { username });
  if (result.status === 'accepted') {
    store.addFriend(result.user);
    toastSuccess(`You and ${result.user.displayName} are now friends.`, 'Friend added');
  } else {
    store.addOutgoingRequest(result.request, result.user);
    toastSuccess(`Request sent to ${result.user.displayName}.`, 'Friend request');
  }
  return result;
}

export async function acceptFriend(requestId) {
  try {
    const result = await net.request('friends:accept', { requestId });
    store.addFriend(result.user);
    toastSuccess(`You and ${result.user.displayName} are now friends.`, 'Friend added');
  } catch (err) {
    reportError(err, 'Could not accept that request.');
  }
}

/** Used by the recipient to decline and by the sender to cancel. */
export async function dismissFriendRequest(requestId) {
  try {
    await net.request('friends:decline', { requestId });
    store.removeRequest(requestId);
  } catch (err) {
    reportError(err, 'Could not update that request.');
  }
}

/** Saves the whole grouping; the server keeps it on the account. */
export async function saveFriendGroups(groups) {
  try {
    const data = await net.request('me:friend-groups', { groups });
    store.friendGroups = data.groups || [];
    store.emit('friends');
    return true;
  } catch (err) {
    reportError(err, 'Could not save those categories.');
    return false;
  }
}

export async function createFriendGroup(name) {
  const groups = [...(store.friendGroups || []), { id: `g${Date.now()}`, name, memberIds: [] }];
  return saveFriendGroups(groups);
}

export async function renameFriendGroup(groupId, name) {
  const groups = (store.friendGroups || []).map((g) => (g.id === groupId ? { ...g, name } : g));
  return saveFriendGroups(groups);
}

export async function deleteFriendGroup(groupId) {
  return saveFriendGroups((store.friendGroups || []).filter((g) => g.id !== groupId));
}

/** Moves a friend into one category, or out of all of them with null. */
export async function moveFriendToGroup(userId, groupId) {
  const groups = (store.friendGroups || []).map((g) => ({
    ...g,
    memberIds: g.memberIds.filter((id) => id !== userId),
  }));
  if (groupId) {
    const target = groups.find((g) => g.id === groupId);
    if (target) target.memberIds = [...target.memberIds, userId];
  }
  return saveFriendGroups(groups);
}

export async function removeFriend(userId) {
  try {
    await net.request('friends:remove', { userId });
    store.removeFriend(userId);
  } catch (err) {
    reportError(err, 'Could not remove that friend.');
  }
}

// -------------------------------------------------------------- attachments

/** Uploads one prepared file and returns the attachment descriptor. */
export async function uploadAttachment(prepared) {
  const result = await net.request('upload:attachment', prepared);
  return result.attachment;
}

// ------------------------------------------------------------ profile media

/** `dataUrl` is a base64 JPEG the caller has already downscaled; null clears. */
export async function uploadProfileImage(kind, dataUrl) {
  const result = await net.request('me:image', { kind, data: dataUrl });
  store.self = { ...store.self, ...result.user };
  store.upsertUser({ ...store.self, status: store.user(store.selfId)?.status || 'online' });
  store.emit('self');
  return result.user;
}

/** Space picture. `dataUrl` is a base64 JPEG; null clears it. */
export async function uploadSpaceImage(guildId, dataUrl, kind = 'icon') {
  const result = await net.request('guild:image', { guildId, data: dataUrl, kind });
  store.upsertGuild(result.guild);
  return result.guild;
}

export async function searchUsers(query) {
  try {
    const result = await net.request('users:search', { query });
    return result.users;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ me

export async function updateProfile(patch) {
  const result = await net.request('me:update', patch);
  store.self = { ...store.self, ...result.user };
  store.upsertUser({ ...result.user, status: result.user.status === 'invisible' ? 'offline' : result.user.status });
  store.emit('self');
  return result.user;
}

/** Voxara Plus: this account's membership plus the tier as it should be shown. */
export async function getBilling() {
  return net.request('billing:status');
}

// -------------------------------------------------------------- preferences

/**
 * Every client-side preference and its default. Each one is read somewhere in
 * the UI — nothing here is decorative.
 */
export const PREF_DEFAULTS = {
  theme: 'dark',                 // dark | light (legacy; superseded by themeId)
  themeId: 'midnight',           // selected theme id (built-in or community)
  density: 'comfortable',        // comfortable | compact
  sidebarLayout: 'tiles',        // tiles | rows | rail (icon column down the left side)
  fontSize: 'medium',            // small | medium | large
  showMembers: true,             // member panel visible in channels
  inlineImages: true,            // render image attachments, or list them as files
  sidebarMode: 'friends',        // friends | spaces
  spacesCollapsed: false,        // space column shows icons only (Ctrl+B)
  spaceNotify: {},               // guildId -> all | mentions | none (overrides the global)
  spaceMuteEveryone: {},         // guildId -> true: don't get pinged by @everyone/@here here
  notifications: 'mentions',     // all | mentions | none
  flashTaskbar: true,            // bounce the taskbar button on a notification
  notificationPreview: true,     // include message text in the notification
  notificationSound: true,       // chime for DMs, mentions and replies to you
  groupTimestamps: false,        // show a time on every message, not just on hover
  confirmDelete: true,           // ask before deleting a message
  developerMode: false,          // reveal technical IDs and advanced affordances
  sendKey: 'enter',              // enter | ctrl-enter
  autoLoadOlder: true,           // fetch older messages when you scroll up
  focusUntil: 0,                 // Focus Mode: silence everything until this time (0 = off)
  minimizeToTray: true,          // closing the window hides it to the system tray, so DMs and mentions still notify
  tourSeen: false,               // has the guided tour been shown once
  showFriendGames: true,         // show what friends are playing (sidebar, gaming profile)
  noiseSuppression: true,        // voice: let the browser strip background noise from your mic
  echoCancellation: true,        // voice: cancel speaker echo
  inputSensitivity: 50,          // voice: 0 (only loud speech lights the ring) to 100 (very sensitive)
  pushToTalk: '',                // voice: a key name (e.g. "Alt" or "F9"); empty = open mic
  gameOverlay: 'game',           // in-game voice overlay: game (only while a game is running) | always (any call) | off
  overlayCorner: 'top-left',     // where the overlay sits: top-left | top-right | bottom-left | bottom-right
  shareAudio: true,              // screen share: include what the computer plays (Windows)
};

// Focus Mode — a private "do not disturb" that truly silences everything,
// mentions included, no leaky exceptions. ms = null means "until I turn
// it off"; ms = 0 turns it off.
const FOCUS_FOREVER = 8.64e15; // the largest timestamp Date can represent
export function setFocusMode(ms) {
  const until = ms == null ? FOCUS_FOREVER : (ms > 0 ? Date.now() + ms : 0);
  setPref('focusUntil', until);
}

/** Attributes the renderer keys its CSS off. */
function applyDocumentPrefs() {
  const root = document.documentElement;
  // The theme owns data-theme (base mode) plus its colour overrides.
  applyTheme(currentThemeId());
  root.dataset.density = store.ui.density;
  root.dataset.sidebar = store.ui.sidebarLayout;
  root.dataset.font = store.ui.fontSize;
  root.dataset.timestamps = store.ui.groupTimestamps ? 'always' : 'hover';
}

export function setPref(key, value) {
  if (!(key in PREF_DEFAULTS)) return;
  store.ui[key] = value;
  setSetting(key, value);
  applyDocumentPrefs();
  store.emit('ui');
}

export const getPref = (key) => store.ui[key];

/** The notification level for one space, falling back to the global setting. */
export function spaceNotifyLevel(guildId) {
  return (store.ui.spaceNotify || {})[guildId] || store.ui.notifications;
}

export function spaceEveryoneMuted(guildId) {
  return Boolean((store.ui.spaceMuteEveryone || {})[guildId]);
}

export function setSpaceEveryoneMuted(guildId, muted) {
  const next = { ...(store.ui.spaceMuteEveryone || {}) };
  if (muted) next[guildId] = true; else delete next[guildId];
  setPref('spaceMuteEveryone', next);
}

export function setSpaceNotifyLevel(guildId, level) {
  const next = { ...(store.ui.spaceNotify || {}) };
  if (!level || level === 'inherit') delete next[guildId];
  else next[guildId] = level;
  setPref('spaceNotify', next);
}

export function loadPreferences() {
  for (const [key, fallback] of Object.entries(PREF_DEFAULTS)) {
    store.ui[key] = getSetting(key, fallback);
  }
  applyDocumentPrefs();
}

// Named wrappers kept for the call sites that read better with them.
export const setTheme = (theme) => setPref('theme', theme);

/** Pick a theme by id (built-in or community) and remember it. */
export function selectTheme(id) {
  store.ui.themeId = id;
  setSetting('themeId', id);
  // Keep the legacy dark/light pref roughly in sync for anything still reading it.
  const base = (store.themes || []).concat().find((t) => t.id === id);
  applyTheme(id);
  store.emit('ui');
}

/** Community themes from the ready payload or a live push. */
export function loadThemes(list) {
  store.themes = (list || []).slice();
  registerThemes(store.themes);
  // If the chosen theme just arrived (or changed), re-apply it.
  applyTheme(currentThemeId());
  store.emit('themes');
}

export async function submitTheme({ name, base, tokens, image, overlay }) {
  const { theme } = await net.request('theme:submit', { name, base, tokens, image, overlay });
  return theme;
}

export async function deleteTheme(id) {
  await net.request('theme:delete', { id });
}

// --- admin theme review ---
export function fetchPendingThemes() {
  return net.request('theme:pending');
}
export function approveThemeSubmission(id) {
  return net.request('theme:approve', { id });
}
export function rejectThemeSubmission(id) {
  return net.request('theme:reject', { id });
}
export const setSidebarMode = (mode) => setPref('sidebarMode', mode);

export function toggleMemberList(force) {
  setPref('showMembers', force === undefined ? !store.ui.showMembers : Boolean(force));
}

export async function changePassword(currentPassword, newPassword) {
  await net.request('auth:change-password', { currentPassword, newPassword });
  toastSuccess('Password changed. Other devices have been signed out.');
}

/** Revokes every session except this one. */
export async function signOutEverywhere() {
  const { closed } = await net.request('auth:logout-all');
  toastSuccess(closed ? `Signed out of ${closed} other device${closed === 1 ? '' : 's'}. Saved sign-ins elsewhere no longer work.` : 'No other device was signed in. Saved sign-ins elsewhere no longer work.');
}

export { reportError };
