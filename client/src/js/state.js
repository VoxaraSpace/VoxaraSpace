import { Emitter } from './utils.js';

const TYPING_TTL_MS = 7000;

/**
 * Client-side model. Views subscribe to coarse events and re-render their own
 * region; only the message list does incremental DOM work, because that is the
 * one place where scroll position must survive an update.
 */
class AppStore extends Emitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.self = null;
    /** { name } for the Voxara server this client is signed in to. */
    this.server = { name: '' };
    /** Community colour themes, shared server-wide. */
    this.themes = [];
    /** Count of themes awaiting review (admins only). */
    this.pendingThemes = 0;
    /** friendId -> { game, appid } — what friends are playing on Steam. */
    this.steamPlaying = new Map();
    /** Collectible-card collection state (from ready / cards ops). */
    this.cards = null;
    this.users = new Map();
    this.guilds = new Map();
    this.dms = new Map();
    /** threadId -> thread (a lightweight channel; not part of guild.channels
     * so it never shows in the regular channel list — fetched via thread:list
     * or pushed by thread:new/thread:update). */
    this.threads = new Map();
    this.messages = new Map();
    /** @type {Set<string>} friend user ids */
    this.friends = new Set();
    /** Accounts this user has blocked. */
    this.blocked = new Set();
    /** [{ id, name, memberIds }] — how this user groups their friends. */
    this.friendGroups = [];
    /** @type {Map<string, object>} requestId -> request */
    this.incoming = new Map();
    this.outgoing = new Map();
    this.hasMore = new Map();
    this.loaded = new Set();
    this.unreads = new Map();
    this.mentions = new Map();
    /** @type {Map<string, string[]>} voice channelId -> user ids currently connected */
    this.voiceStates = new Map();
    this.voiceSharing = new Map(); // channelId -> [userId] currently sharing a screen
    /** The Inbox: saved messages, mentions of me, and fired reminders. */
    this.inbox = { bookmarks: [], mentions: [], deals: [], due: new Set() };
    /** Messages queued to send later. */
    this.scheduled = [];
    this.reads = {};
    this.typing = new Map();
    this.view = { kind: 'home', guildId: null, channelId: null };
    this.lastChannelByGuild = new Map();
    this.filter = '';
    this.ui = {
      showMembers: true,
      sidebarOpen: false,
      collapsedCategories: new Set(),
      theme: 'dark',
      density: 'comfortable',
      fontSize: 'medium',
      notifications: 'mentions',
      /** 'friends' | 'spaces' — the two sidebar sections are never mixed. */
      sidebarMode: 'friends',
    };
  }

  // ------------------------------------------------------------- bootstrap

  playing(userId) { return this.steamPlaying.get(userId) || null; }

  applyReady(payload) {
    this.self = payload.user;
    this.isAdmin = Boolean(payload.isAdmin);
    this.server = payload.server || { name: '' };
    this.reads = payload.reads || {};

    this.users = new Map(Object.entries(payload.users || {}));
    this.users.set(this.self.id, { ...this.self, status: this.self.status === 'invisible' ? 'offline' : this.self.status });

    this.guilds = new Map((payload.guilds || []).map((guild) => [guild.id, guild]));
    this.dms = new Map((payload.dms || []).map((dm) => [dm.id, dm]));

    this.unreads = new Map(Object.entries(payload.unreads || {}));
    this.friends = new Set(payload.friends || []);
    this.blocked = new Set(payload.blocked || []);
    this.friendGroups = payload.friendGroups || [];
    this.incoming = new Map((payload.friendRequests?.incoming || []).map((r) => [r.id, r]));
    this.outgoing = new Map((payload.friendRequests?.outgoing || []).map((r) => [r.id, r]));

    this.inbox = {
      bookmarks: payload.bookmarks || [],
      mentions: payload.mentions || [],
      deals: payload.deals || [],
      due: new Set(),
    };
    this.scheduled = payload.scheduled || [];
    this.themes = payload.themes || [];
    this.pendingThemes = payload.pendingThemes || 0;
    this.steamPlaying = new Map(Object.entries(payload.steamPlaying || {}));
    this.cards = payload.cards || null;
    this.voiceStates = new Map(Object.entries(payload.voiceStates || {}));
    this.voiceSharing = new Map(Object.entries(payload.voiceSharing || {}));

    this.emit('ready');
    this.emit('self');
    this.emit('friends');
    this.emit('guilds');
    this.emit('unreads');
    this.emit('users');
  }

  // ----------------------------------------------------------------- inbox

  setBookmarks(list) { this.inbox.bookmarks = list || []; this.emit('inbox'); }
  setMentions(list) { this.inbox.mentions = list || []; this.emit('inbox'); }

  isBookmarked(messageId) {
    return this.inbox.bookmarks.some((b) => b.messageId === messageId);
  }

  applyBookmarkToggle({ bookmarked, bookmark, messageId }) {
    if (bookmarked && bookmark) {
      if (!this.inbox.bookmarks.some((b) => b.id === bookmark.id)) {
        this.inbox.bookmarks.unshift(bookmark);
      }
    } else {
      const mid = messageId || bookmark?.messageId;
      this.inbox.bookmarks = this.inbox.bookmarks.filter((b) => b.messageId !== mid);
    }
    this.emit('inbox');
  }

  updateBookmark(bookmark) {
    const i = this.inbox.bookmarks.findIndex((b) => b.id === bookmark.id);
    if (i !== -1) this.inbox.bookmarks[i] = bookmark;
    this.emit('inbox');
  }

  markReminderDue(bookmark) {
    this.inbox.due.add(bookmark.id);
    const i = this.inbox.bookmarks.findIndex((b) => b.id === bookmark.id);
    if (i !== -1) this.inbox.bookmarks[i] = bookmark;
    else this.inbox.bookmarks.unshift(bookmark);
    this.emit('inbox');
  }

  /** Unopened inbox items: new mentions since `seenAt`, plus any fired reminders. */
  inboxBadge(seenAt = 0) {
    const freshMentions = this.inbox.mentions.filter((m) => m.at > seenAt).length;
    return freshMentions + this.inbox.due.size;
  }

  clearInboxDue() { this.inbox.due.clear(); this.emit('inbox'); }

  // ------------------------------------------------------ scheduled messages

  /** Who is connected to a voice channel right now. */
  /** The other side's read position in a DM (from serializeDm.seen / read:seen). */
  setSeen(channelId, userId, messageId) {
    const dm = this.dms.get(channelId);
    if (!dm) return;
    dm.seen = { ...(dm.seen || {}), [userId]: messageId };
    this.emit('seen', { channelId, userId, messageId });
  }
  seenBy(channelId, userId) { return this.dms.get(channelId)?.seen?.[userId] || null; }

  voiceUsers(channelId) { return this.voiceStates.get(channelId) || []; }
  /** Ids of the people sharing their screen in a voice channel. */
  voiceSharers(channelId) { return this.voiceSharing.get(channelId) || []; }
  isSharing(channelId, userId) { return this.voiceSharers(channelId).includes(userId); }
  setVoiceState(channelId, users, sharing = []) {
    if (users && users.length) this.voiceStates.set(channelId, users);
    else this.voiceStates.delete(channelId);
    if (sharing && sharing.length) this.voiceSharing.set(channelId, sharing);
    else this.voiceSharing.delete(channelId);
    this.emit('voice', { channelId });
  }

  setScheduled(list) { this.scheduled = list || []; this.emit('scheduled'); }
  addScheduled(entry) { this.scheduled.push(entry); this.emit('scheduled'); }
  removeScheduled(id) {
    this.scheduled = this.scheduled.filter((s) => s.id !== id);
    this.emit('scheduled');
  }
  scheduledForChannel(channelId) {
    return this.scheduled.filter((s) => s.channelId === channelId).sort((a, b) => a.sendAt - b.sendAt);
  }

  /** Focus Mode: while active, every notification is silenced (mentions too). */
  isFocusActive() {
    return (this.ui.focusUntil || 0) > Date.now();
  }

  // ------------------------------------------------------------- accessors

  get selfId() {
    return this.self?.id || null;
  }

  user(id) {
    return this.users.get(id) || null;
  }

  userName(id) {
    const user = this.users.get(id);
    if (user) return user.displayName || user.username;
    return id === this.selfId ? 'You' : 'Unknown user';
  }

  knownUsernames() {
    const set = new Set();
    for (const user of this.users.values()) set.add(user.username.toLowerCase());
    return set;
  }

  guild(id) {
    return this.guilds.get(id) || null;
  }

  channel(channelId) {
    for (const guild of this.guilds.values()) {
      const found = guild.channels.find((c) => c.id === channelId);
      if (found) return found;
    }
    return this.threads.get(channelId) || null;
  }

  guildOfChannel(channelId) {
    for (const guild of this.guilds.values()) {
      if (guild.channels.some((c) => c.id === channelId)) return guild;
    }
    const thread = this.threads.get(channelId);
    return thread ? this.guilds.get(thread.guildId) || null : null;
  }

  thread(threadId) {
    return this.threads.get(threadId) || null;
  }

  upsertThread(thread) {
    this.threads.set(thread.id, thread);
    this.emit('threads', { threadId: thread.id, thread });
  }

  removeThread(threadId) {
    const thread = this.threads.get(threadId) || null;
    this.threads.delete(threadId);
    this.messages.delete(threadId);
    this.unreads.delete(threadId);
    this.emit('threads', { threadId, thread: null, removed: true, parentChannelId: thread?.parentChannelId || null });
  }

  dm(id) {
    return this.dms.get(id) || null;
  }

  dmPartnerId(dmId) {
    const dm = this.dms.get(dmId);
    if (!dm) return null;
    return dm.memberIds.find((id) => id !== this.selfId) || this.selfId;
  }

  /** Uniform descriptor for whatever is currently open. */
  conversation(channelId = this.view.channelId) {
    if (!channelId) return null;
    const channel = this.channel(channelId);
    if (channel?.type === 'thread') {
      return {
        kind: 'thread',
        id: channel.id,
        name: channel.name,
        topic: '',
        guild: this.guildOfChannel(channel.id),
        parentChannelId: channel.parentChannelId,
        parent: this.channel(channel.parentChannelId),
      };
    }
    if (channel) {
      return {
        kind: 'channel',
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        guild: this.guildOfChannel(channel.id),
      };
    }
    const dm = this.dms.get(channelId);
    if (dm) {
      const partnerId = this.dmPartnerId(channelId);
      return {
        kind: 'dm',
        id: dm.id,
        name: this.userName(partnerId),
        topic: '',
        partnerId,
      };
    }
    return null;
  }

  messagesFor(channelId) {
    return this.messages.get(channelId) || [];
  }

  /** One message by id, or null when it is not in the loaded window. */
  message(channelId, messageId) {
    if (!messageId) return null;
    return (this.messages.get(channelId) || []).find((m) => m.id === messageId) || null;
  }

  unreadFor(channelId) {
    return this.unreads.get(channelId) || 0;
  }

  mentionsFor(channelId) {
    return this.mentions.get(channelId) || 0;
  }

  guildUnread(guildId) {
    const guild = this.guilds.get(guildId);
    if (!guild) return { unread: 0, mentions: 0 };
    let unread = 0;
    let mentions = 0;
    for (const channel of guild.channels) {
      unread += this.unreadFor(channel.id);
      mentions += this.mentionsFor(channel.id);
    }
    return { unread, mentions };
  }

  dmTotals() {
    let unread = 0;
    let mentions = 0;
    for (const dm of this.dms.values()) {
      unread += this.unreadFor(dm.id);
      // Every DM message is effectively a mention.
      mentions += this.unreadFor(dm.id);
    }
    return { unread, mentions };
  }

  totalMentions() {
    let total = this.dmTotals().mentions;
    for (const guildId of this.guilds.keys()) total += this.guildUnread(guildId).mentions;
    return total;
  }

  // ----------------------------------------------------------- navigation

  setView(next) {
    const previous = this.view;
    this.view = { ...previous, ...next };
    if (this.view.guildId && this.view.channelId) {
      this.lastChannelByGuild.set(this.view.guildId, this.view.channelId);
    }
    this.emit('view', { previous, view: this.view });
  }

  // ------------------------------------------------------------- messages

  setMessages(channelId, messages, hasMore) {
    this.messages.set(channelId, messages.slice());
    this.hasMore.set(channelId, Boolean(hasMore));
    this.loaded.add(channelId);
    this.emit('messages', { channelId, reason: 'replace' });
  }

  prependMessages(channelId, messages, hasMore) {
    const existing = this.messages.get(channelId) || [];
    const seen = new Set(existing.map((m) => m.id));
    const fresh = messages.filter((m) => !seen.has(m.id));
    this.messages.set(channelId, [...fresh, ...existing]);
    this.hasMore.set(channelId, Boolean(hasMore));
    this.emit('messages', { channelId, reason: 'prepend', count: fresh.length });
  }

  addMessage(message, { nonce } = {}) {
    const list = this.messages.get(message.channelId);
    if (!list) {
      // History for this channel is not loaded yet; the fetch will include it.
      this.emit('messages', { channelId: message.channelId, reason: 'skip' });
      return;
    }
    if (nonce) {
      const index = list.findIndex((m) => m.nonce === nonce);
      if (index !== -1) {
        list[index] = message;
        this.emit('messages', { channelId: message.channelId, reason: 'confirm', message, nonce });
        return;
      }
    }
    if (list.some((m) => m.id === message.id)) return;
    list.push(message);
    this.emit('messages', { channelId: message.channelId, reason: 'append', message });
  }

  addPending(message) {
    const list = this.messages.get(message.channelId);
    if (!list) return;
    list.push(message);
    this.emit('messages', { channelId: message.channelId, reason: 'append', message });
  }

  markPendingFailed(channelId, nonce) {
    const list = this.messages.get(channelId) || [];
    const found = list.find((m) => m.nonce === nonce);
    if (!found) return;
    found.failed = true;
    found.pending = false;
    this.emit('messages', { channelId, reason: 'update', message: found });
  }

  removePending(channelId, nonce) {
    const list = this.messages.get(channelId) || [];
    const index = list.findIndex((m) => m.nonce === nonce);
    if (index === -1) return;
    list.splice(index, 1);
    this.emit('messages', { channelId, reason: 'replace' });
  }

  updateMessage(message) {
    const list = this.messages.get(message.channelId);
    if (!list) return;
    const index = list.findIndex((m) => m.id === message.id);
    if (index === -1) return;
    list[index] = message;
    this.emit('messages', { channelId: message.channelId, reason: 'update', message });
  }

  removeMessage(channelId, messageId) {
    const list = this.messages.get(channelId);
    if (!list) return;
    const index = list.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    list.splice(index, 1);
    this.emit('messages', { channelId, reason: 'remove', messageId });
  }

  lastMessageId(channelId) {
    const list = this.messages.get(channelId) || [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!list[i].pending && !list[i].failed) return list[i].id;
    }
    return null;
  }

  // --------------------------------------------------------------- unread

  bumpUnread(channelId, { mention }) {
    this.unreads.set(channelId, this.unreadFor(channelId) + 1);
    if (mention) this.mentions.set(channelId, this.mentionsFor(channelId) + 1);
    this.emit('unreads');
  }

  clearUnread(channelId) {
    let changed = false;
    if (this.unreads.get(channelId)) {
      this.unreads.set(channelId, 0);
      changed = true;
    }
    if (this.mentions.get(channelId)) {
      this.mentions.set(channelId, 0);
      changed = true;
    }
    if (changed) this.emit('unreads');
    return changed;
  }

  // --------------------------------------------------------------- typing

  noteTyping(channelId, userId) {
    if (!this.typing.has(channelId)) this.typing.set(channelId, new Map());
    this.typing.get(channelId).set(userId, Date.now());
    this.emit('typing', { channelId });
  }

  typistsIn(channelId) {
    const map = this.typing.get(channelId);
    if (!map) return [];
    const now = Date.now();
    const alive = [];
    for (const [userId, at] of [...map]) {
      if (now - at > TYPING_TTL_MS) map.delete(userId);
      else if (userId !== this.selfId) alive.push(userId);
    }
    return alive;
  }

  // ---------------------------------------------------------------- users

  upsertUser(user) {
    if (!user) return;
    const existing = this.users.get(user.id);
    this.users.set(user.id, { ...existing, ...user });
    this.emit('users');
  }

  upsertUsers(map) {
    for (const user of Object.values(map || {})) {
      const existing = this.users.get(user.id);
      this.users.set(user.id, { ...existing, ...user });
    }
    this.emit('users');
  }

  setPresence(userId, status, customStatus) {
    const user = this.users.get(userId);
    if (!user) return;
    user.status = status;
    if (customStatus !== undefined) user.customStatus = customStatus;
    if (userId === this.selfId && this.self) this.self.customStatus = user.customStatus;
    this.emit('users');
    if (userId === this.selfId) this.emit('self');
  }

  // -------------------------------------------------------------- friends

  isBlocked(userId) {
    return this.blocked.has(userId);
  }

  isFriend(userId) {
    return this.friends.has(userId);
  }

  addFriend(user) {
    this.upsertUser(user);
    this.friends.add(user.id);
    // Any pending request between you is now resolved.
    for (const [id, request] of [...this.incoming]) {
      if (request.fromId === user.id) this.incoming.delete(id);
    }
    for (const [id, request] of [...this.outgoing]) {
      if (request.toId === user.id) this.outgoing.delete(id);
    }
    this.emit('friends');
  }

  removeFriend(userId) {
    this.friends.delete(userId);
    this.emit('friends');
  }

  addIncomingRequest(request, user) {
    if (user) this.upsertUser(user);
    this.incoming.set(request.id, request);
    this.emit('friends');
  }

  addOutgoingRequest(request, user) {
    if (user) this.upsertUser(user);
    this.outgoing.set(request.id, request);
    this.emit('friends');
  }

  removeRequest(requestId) {
    const had = this.incoming.delete(requestId) || this.outgoing.delete(requestId);
    if (had) this.emit('friends');
  }

  friendList() {
    return [...this.friends]
      .map((id) => this.user(id))
      .filter(Boolean)
      .sort((a, b) => {
        const rank = (a.status === 'offline' ? 1 : 0) - (b.status === 'offline' ? 1 : 0);
        if (rank !== 0) return rank;
        return a.displayName.localeCompare(b.displayName);
      });
  }

  /** The DM channel with this user, if one exists yet. */
  dmWith(userId) {
    for (const dm of this.dms.values()) {
      if (dm.memberIds.includes(userId)) return dm;
    }
    return null;
  }

  // --------------------------------------------------------------- guilds

  upsertGuild(guild) {
    this.guilds.set(guild.id, guild);
    this.emit('guilds');
  }

  removeGuild(guildId) {
    this.guilds.delete(guildId);
    this.lastChannelByGuild.delete(guildId);
    this.emit('guilds');
  }

  addChannel(channel) {
    const guild = this.guilds.get(channel.guildId);
    if (!guild) return;
    if (guild.channels.some((c) => c.id === channel.id)) return;
    guild.channels.push(channel);
    guild.channels.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
    this.emit('guilds');
  }

  updateChannel(channel) {
    const guild = this.guilds.get(channel.guildId);
    if (!guild) return;
    const index = guild.channels.findIndex((c) => c.id === channel.id);
    if (index === -1) return;
    guild.channels[index] = channel;
    this.emit('guilds');
  }

  removeChannel(guildId, channelId) {
    const guild = this.guilds.get(guildId);
    if (!guild) return;
    guild.channels = guild.channels.filter((c) => c.id !== channelId);
    this.messages.delete(channelId);
    this.unreads.delete(channelId);
    this.emit('guilds');
  }

  upsertDm(dm) {
    this.dms.set(dm.id, dm);
    this.emit('guilds');
  }
}

export const store = new AppStore();
