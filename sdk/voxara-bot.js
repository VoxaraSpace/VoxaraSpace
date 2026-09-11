'use strict';

/**
 * A small event-driven client for writing Voxara bots.
 *
 *   const { Client } = require('./voxara-bot');
 *   const client = new Client();
 *   client.on('ready', () => console.log(`Logged in as ${client.user.displayName}`));
 *   client.on('messageCreate', (message) => {
 *     if (message.author.bot) return; // ignore bots, including yourself
 *     if (message.content === '!ping') message.reply('pong 🏓');
 *   });
 *   client.login(process.env.PULSE_BOT_TOKEN);
 *
 * This wraps the same WebSocket protocol described in BOTS.md — request/reply
 * frames `{ id, op, data }` and unsolicited events `{ op, data }` — behind an
 * EventEmitter and a handful of convenience methods, so a bot reads like an
 * event handler instead of a frame parser. Nothing here is required: talking
 * to the raw protocol works exactly as well, this is purely for convenience.
 */

const WebSocket = require('ws');
const EventEmitter = require('node:events');

// The Voxara server's address is part of the build, same as in the desktop
// client — nobody should have to type it in.
const DEFAULT_SERVER = process.env.PULSE_SERVER || 'wss://voxaraspace.com';
const RECONNECT_DELAY_MS = 3000;
// A protocol-level ping every so often keeps a quiet connection open through
// proxies that drop idle sockets. Pings are not requests: they cost nothing
// against any limit.
const KEEPALIVE_MS = 45_000;

/**
 * A rich embed, built up with chained calls and handed to `send()`/`reply()`
 * as `{ embed }`. A chainable builder — title,
 * description, a side color, fields, an image, a footer — but stays plain
 * data (`toJSON()`) until the server sanitizes and stores it. `image` and
 * `thumbnail` take a URL; the server fetches and re-hosts it before anyone
 * sees the message, so nothing here needs to already be on this server.
 */
class Embed {
  constructor() { this.data = {}; }
  setTitle(title) { this.data.title = title; return this; }
  setDescription(description) { this.data.description = description; return this; }
  setURL(url) { this.data.url = url; return this; }
  /** A hex color string, e.g. "#5b6cff" — tints the embed's left edge. */
  setColor(color) { this.data.color = color; return this; }
  setAuthor(name, url) { this.data.author = { name, url }; return this; }
  setFooter(text) { this.data.footer = { text }; return this; }
  setTimestamp(date = new Date()) {
    this.data.timestamp = date instanceof Date ? date.getTime() : Number(date);
    return this;
  }
  setImage(url) { this.data.image = url; return this; }
  setThumbnail(url) { this.data.thumbnail = url; return this; }
  /** Up to 10 fields; `inline` lets short ones sit side by side. */
  addField(name, value, inline = false) {
    (this.data.fields || (this.data.fields = [])).push({ name, value, inline });
    return this;
  }
  toJSON() { return this.data; }
}

/** A message, with the lookups and replies you'd reach for wrapped in. */
class Message {
  constructor(client, raw) {
    this.client = client;
    this.raw = raw;
    this.id = raw.id;
    this.channelId = raw.channelId;
    this.authorId = raw.authorId;
    this.content = raw.content;
    this.attachments = raw.attachments || [];
    // Rich (bot-authored), link-preview and Steam-game cards alike — check
    // `.kind` ('rich' is the one you can send yourself; see the Embed class).
    this.embeds = raw.embeds || [];
    this.mentions = raw.mentions || [];
    this.everyone = Boolean(raw.everyone);
    this.reactions = raw.reactions || {};
    this.replyTo = raw.replyTo || null;
    this.threadId = raw.threadId || null;
    this.pinnedAt = raw.pinnedAt || null;
    this.createdAt = raw.createdAt;
    this.editedAt = raw.editedAt || null;
  }

  /**
   * The sender. Always an object, so `message.author.bot` is safe to write
   * without a null check: an author the cache hasn't seen (rare — everyone
   * in the bot's spaces is loaded at sign-in) comes back as a minimal stub.
   */
  get author() {
    return this.client.users.get(this.authorId)
      || { id: this.authorId, username: '', displayName: 'Unknown', bot: false, uncached: true };
  }

  get channel() { return this.client.channels.get(this.channelId) || null; }

  get guild() {
    const channel = this.channel;
    return channel ? this.client.guilds.get(channel.guildId) || null : null;
  }

  /** Sends a message into the same channel, as a reply to this one. */
  reply(content, options = {}) {
    return this.client.send(this.channelId, content, { ...options, replyTo: this.id });
  }

  edit(content) { return this.client.editMessage(this.channelId, this.id, content); }
  delete() { return this.client.deleteMessage(this.channelId, this.id); }
  react(emoji) { return this.client.react(this.channelId, this.id, emoji); }
  pin() { return this.client.pinMessage(this.channelId, this.id, true); }
  unpin() { return this.client.pinMessage(this.channelId, this.id, false); }
}

/**
 * A slash command someone ran: `/name args`. `options` holds the arguments
 * matched to the option names you declared (in order); `argv` is the raw
 * split. `reply()` posts into the channel it was used in.
 */
class Interaction {
  constructor(client, raw) {
    this.client = client;
    this.id = raw.id;
    this.name = raw.name;
    this.args = raw.args || '';
    this.argv = raw.argv || [];
    this.channelId = raw.channelId;
    this.guildId = raw.guildId;
    this.user = raw.user;
    this.createdAt = raw.createdAt;
    const declared = (client.commands.find((c) => c.name === raw.name) || {}).options || [];
    this.options = {};
    declared.forEach((opt, i) => {
      const v = this.argv[i];
      if (v === undefined) return;
      this.options[opt.name] = opt.type === 'number' || opt.type === 'integer' ? Number(v)
        : opt.type === 'boolean' ? /^(true|yes|on|1)$/i.test(v)
          : opt.type === 'user' ? String(v).replace(/^@/, '') : v;
    });
  }

  get channel() { return this.client.channels.get(this.channelId) || null; }
  get guild() { return this.client.guilds.get(this.guildId) || null; }
  reply(content, options = {}) { return this.client.send(this.channelId, content, options); }
}

/** A text channel — just enough to send into it without looking up the id again. */
class Channel {
  constructor(client, raw) {
    this.client = client;
    Object.assign(this, raw);
  }

  send(content, options = {}) { return this.client.send(this.id, content, options); }
  fetchMessages(options = {}) { return this.client.fetchMessages(this.id, options); }
  startTyping() { return this.client.startTyping(this.id); }
}

class Client extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.reconnect=true] Reconnect automatically on drop —
   *   a bot token doesn't expire, so a dropped connection is always worth
   *   retrying rather than giving up.
   * @param {boolean} [opts.rejectUnauthorized=false] Verify the server's TLS
   *   certificate strictly. Off by default so a bot keeps working through a
   *   certificate rotation; set true to insist on a valid chain.
   */
  constructor({ reconnect = true, rejectUnauthorized = false } = {}) {
    super();
    this.reconnect = reconnect;
    this.rejectUnauthorized = rejectUnauthorized;
    this.ws = null;
    this.token = null;
    this.serverUrl = null;
    this.user = null;
    this.guilds = new Map();
    this.channels = new Map();
    this.users = new Map();
    this.commands = [];
    this._nextRequestId = 1;
    this._pending = new Map();
    this._closedByUser = false;
    this._reconnectTimer = null;
  }

  /** Signs in with a bot token (Settings → Bots → Create a bot, in the app). */
  login(token, serverUrl = DEFAULT_SERVER) {
    if (!token) throw new Error('login(token) needs a bot token — see Settings → Bots in the app.');
    this.token = token;
    this.serverUrl = serverUrl;
    this._closedByUser = false;
    return this._connect();
  }

  /** Closes the connection and stops reconnecting. */
  destroy() {
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    if (this.ws) this.ws.close();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.serverUrl, {
        origin: 'app://pulse',
        rejectUnauthorized: this.rejectUnauthorized,
      });
      this.ws = ws;
      let settled = false;

      ws.on('open', async () => {
        clearInterval(this._keepalive);
        this._keepalive = setInterval(() => { try { ws.ping(); } catch { /* closing */ } }, KEEPALIVE_MS);
        try {
          const ready = await this._request('auth:bot', { token: this.token });
          this._hydrate(ready);
          settled = true;
          this.emit('ready', this);
          resolve(this);
        } catch (err) {
          settled = true;
          reject(err);
          ws.close();
        }
      });

      ws.on('message', (raw) => this._onFrame(raw));

      ws.on('close', () => {
        clearInterval(this._keepalive);
        for (const { reject: rejectPending } of this._pending.values()) {
          rejectPending(new Error('Connection closed.'));
        }
        this._pending.clear();
        this.emit('disconnect');
        if (this.reconnect && !this._closedByUser) {
          this.emit('reconnecting');
          this._reconnectTimer = setTimeout(() => this._connect().catch(() => {}), RECONNECT_DELAY_MS);
        }
      });

      ws.on('error', (err) => {
        // Tearing down a still-connecting socket via destroy() produces an
        // error of our own making; surfacing it would crash a bot that has
        // no 'error' listener (Node throws on unhandled 'error' events).
        if (this._closedByUser) return;
        this.emit('error', err);
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  _hydrate(ready) {
    // Every Client here logged in via auth:bot, so it's always a bot — stamp
    // that in case an older server hasn't got the fix that puts `bot` on a
    // bot's own `ready.user` (it's always been there for every *other* user).
    // Without it, `message.author.bot` would be false for the bot's own
    // messages and a self-reply guard would silently never fire.
    this.user = { ...ready.user, bot: true };
    // Read-only proof of this session for /media URLs (attachments, avatars):
    // it fetches media and nothing else, so it's safe to put in a URL.
    this.mediaToken = ready.mediaToken || null;
    this.users.set(this.user.id, this.user);
    for (const [id, user] of Object.entries(ready.users || {})) this.users.set(id, user);
    for (const guild of ready.guilds || []) this._cacheGuild(guild);
  }

  _cacheGuild(guild) {
    this.guilds.set(guild.id, guild);
    for (const channel of guild.channels || []) {
      this.channels.set(channel.id, new Channel(this, { ...channel, guildId: guild.id }));
    }
  }

  _request(op, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected.'));
    }
    return new Promise((resolve, reject) => {
      const id = this._nextRequestId++;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, op, data }));
    });
  }

  _onFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }

    if (frame.id != null) {
      const pending = this._pending.get(frame.id);
      if (!pending) return;
      this._pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.data);
      else {
        const err = Object.assign(new Error(frame.error?.message || 'Request failed.'), { code: frame.error?.code });
        if (err.code === 'rate_limited') this.emit('rateLimit', err);
        pending.reject(err);
      }
      return;
    }

    this._onEvent(frame.op, frame.data || {});
  }

  _onEvent(op, data) {
    switch (op) {
      case 'message:new':
        this.emit('messageCreate', new Message(this, data.message));
        break;
      case 'message:update':
        this.emit('messageUpdate', new Message(this, data.message));
        break;
      case 'message:delete':
        this.emit('messageDelete', { id: data.messageId, channelId: data.channelId });
        break;
      case 'command:invoke':
        this.emit('command', new Interaction(this, data));
        break;
      case 'message:pinned':
        this.emit('messagePin', data);
        break;
      case 'typing':
        this.emit('typingStart', data);
        break;
      case 'member:add':
        this.users.set(data.user.id, data.user);
        this.emit('memberAdd', { guildId: data.guildId, user: data.user });
        break;
      case 'member:remove':
        this.emit('memberRemove', { guildId: data.guildId, userId: data.userId });
        break;
      case 'guild:new':
        this._cacheGuild(data.guild);
        this.emit('guildCreate', data.guild);
        break;
      case 'channel:delete':
        this.channels.delete(data.channelId);
        this.emit('channelDelete', data);
        break;
      default:
        // Anything not wrapped above is still reachable, unparsed.
        this.emit('raw', { op, data });
    }
  }

  // ------------------------------------------------------------- actions

  /** Any raw operation: resolves with the reply's data, rejects with an error carrying `.code`. */
  request(op, data = {}) {
    return this._request(op, data);
  }

  /**
   * A `/media/...` path (an attachment's `url`, someone's `avatarUrl`) as a
   * fetchable https URL, media token attached. Bots read media the same way
   * the app does: the file is private to people who can see the message.
   */
  mediaUrl(mediaPath) {
    if (!mediaPath) return null;
    const base = String(this.serverUrl || DEFAULT_SERVER).replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/+$/, '');
    const token = this.mediaToken || this.token || '';
    return `${base}${mediaPath}?t=${encodeURIComponent(token)}`;
  }

  /**
   * Sends a message. `content` can be the text itself, or — for an
   * embed-only message — the options object, e.g. `send(id, { embed })`.
   * `options.embed` takes an `Embed` or a plain object shaped like one.
   * `options.replyTo` is a message id to reply to.
   */
  async send(channelId, content = '', options = {}) {
    if (content && typeof content === 'object') {
      options = content;
      content = options.content || '';
    }
    const embed = options.embed && typeof options.embed.toJSON === 'function' ? options.embed.toJSON() : options.embed;
    const { message } = await this._request('message:send', {
      channelId, content, replyTo: options.replyTo || null, attachments: options.attachments || [], embed,
    });
    return new Message(this, message);
  }

  async editMessage(channelId, messageId, content) {
    const { message } = await this._request('message:edit', { channelId, messageId, content });
    return new Message(this, message);
  }

  deleteMessage(channelId, messageId) {
    return this._request('message:delete', { channelId, messageId });
  }

  /** Toggles a reaction — calling it again with the same emoji removes it. */
  react(channelId, messageId, emoji) {
    return this._request('reaction:toggle', { channelId, messageId, emoji });
  }

  pinMessage(channelId, messageId, pinned = true) {
    return this._request('message:pin', { channelId, messageId, pinned });
  }

  async fetchMessages(channelId, { limit = 50, before = null } = {}) {
    const { messages } = await this._request('messages:fetch', { channelId, limit, before });
    return messages.map((m) => new Message(this, m));
  }

  startTyping(channelId) {
    return this._request('typing:start', { channelId });
  }

  /**
   * Sends someone a direct message. Only works for people who share a space
   * with the bot and whose DM privacy allows it ("everyone", or the default);
   * anyone else rejects with code 'cannot_dm' — catch it and fall back to a
   * channel post rather than treating it as an error.
   */
  async dm(userId, content, options = {}) {
    const { dm } = await this._request('dm:open', { userId });
    return this.send(dm.id, content, options);
  }

  // ------------------------------------------------------- moderation

  /** Requires kickMembers; fails if the bot's own role can't reach theirs. */
  kick(guildId, userId) {
    return this._request('guild:kick', { guildId, userId });
  }

  /** Requires banMembers. `reason` shows up in the space's ban list. */
  ban(guildId, userId, reason = '') {
    return this._request('guild:ban', { guildId, userId, reason });
  }

  unban(guildId, userId) {
    return this._request('guild:unban', { guildId, userId });
  }

  /** Disconnect someone from a voice channel. Requires moveMembers. */
  kickFromVoice(channelId, userId) {
    return this._request('voice:kick', { channelId, userId });
  }

  /** Move someone into another voice channel in the same space. Requires moveMembers. */
  moveToVoice(channelId, userId) {
    return this._request('voice:move', { channelId, userId });
  }

  /** Lock a thread so only moderators can post in it (or unlock it). Requires manageMessages. */
  lockThread(threadId, locked = true) {
    return this._request('thread:lock', { threadId, locked }).then((r) => r.thread);
  }

  /** Requires kickMembers. `seconds` of 0 (or omitted) lifts an existing timeout. */
  timeout(guildId, userId, seconds = 0) {
    return this._request('member:timeout', { guildId, userId, seconds });
  }

  // ----------------------------------------------------------- commands

  /**
   * Declares the bot's slash commands. People see them after typing "/" in
   * any space the bot is in; each use arrives as a 'command' event.
   *   client.setCommands([{ name: 'roll', description: 'Roll dice', options: [{ name: 'sides', type: 'integer' }] }]);
   */
  async setCommands(commands) {
    const { commands: saved } = await this._request('bot:commands', { commands });
    this.commands = saved;
    return saved;
  }

  // --------------------------------------------------------- self / presence

  /** 'online' | 'idle' | 'dnd' | 'invisible'. */
  setStatus(status) {
    return this._request('me:update', { status }).then((r) => r.user);
  }

  setCustomStatus(text) {
    return this._request('me:update', { customStatus: text }).then((r) => r.user);
  }
}

module.exports = { Client, Message, Channel, Embed, Interaction };
