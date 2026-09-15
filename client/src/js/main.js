import { hydrateIcons } from './icons.js';
import { net, loadRuntime, desktop, setSettings, setSetting, getSetting, isWeb } from './client.js';
import { el } from './utils.js';
import { store } from './state.js';
import { closePopover } from './ui/overlay.js';
import {
  loadPreferences, markRead, openConversation, loadHistory, openHome, openGuild, loadThemes, joinGuild } from './actions.js';
import { mountTitlebar, setConnectionState } from './ui/titlebar.js';
import { mountAuth, tryResume, showAuthScreen } from './ui/auth.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountChat, notifyIfNeeded, renderMessages, applyLayout, renderHeader, renderComposerState } from './ui/chat.js';
import { mountMembers } from './ui/members.js';
import { mountShortcuts } from './ui/shortcuts.js';
import { showUserPopover } from './ui/profile.js';
import { toast } from './ui/toast.js';
import { initUpdates } from './ui/update.js';
import { maybeStartTour } from './ui/tour.js';
import { spaceEveryoneMuted } from './actions.js';
import * as callui from './ui/call.js';

let workspaceMounted = false;

// ------------------------------------------------------- browser tab nudge
// Voxara in a browser works, but the app is the nicer home for it. Offer the
// download once; a dismissal is remembered and never nagged past.
function mountWebNudge() {
  if (!isWeb || getSetting('webNudgeDismissed')) return;
  const nudge = el('aside', { class: 'webnudge', role: 'note' },
    el('div', { class: 'webnudge__text' },
      el('b', {}, 'You are using Voxara in your browser.'),
      el('span', {}, ' The Windows app is smoother, with proper notifications and self updates.')),
    el('a', { class: 'webnudge__get', href: '/download' }, 'Get the app'),
    el('button', {
      class: 'webnudge__x', type: 'button', 'aria-label': 'Dismiss',
      onClick: () => { setSetting('webNudgeDismissed', true); nudge.remove(); },
    }, '\u00d7'));
  document.body.append(nudge);
}

// ------------------------------------------------------------ viewport sync

// The app frame was height:100vh — but after a minimize/restore on Windows,
// vh can keep resolving against a stale viewport even when window.innerHeight
// is already correct, and the composer ends up laid out beyond the bottom
// edge of the window. So the frame height is driven by the measured pixel
// value instead (--app-h, with 100vh only as the fallback), re-checked when
// the window resizes, becomes visible again, or the main process says it just
// restored the window.
let lastViewportH = 0;
function syncViewport() {
  const h = window.innerHeight;
  if (!h || h < 200) return; // a minimized or hidden window reads tiny — noise
  if (h === lastViewportH) return;
  lastViewportH = h;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}

// The Windows failure, finally measured for real (diag from a scale-1.5
// machine): after un-maximizing, innerHeight, --app-h and the .app box are
// all CORRECT — yet the composer sits laid out hundreds of px past the
// window bottom. The engine believes that layout is clean, so nothing
// re-layouts on its own and only a real drag-resize used to fix it. The cure
// has to come from in here: notice that our own content overflows the
// viewport, and force the whole tree through layout again.
let lastLayoutHeal = null;
let healGuard = 0;
function viewportBroken() {
  const composer = document.getElementById('composer');
  const probe = (composer && composer.getBoundingClientRect().height > 0)
    ? composer
    : document.querySelector('.app');
  if (!probe) return false;
  return probe.getBoundingClientRect().bottom > window.innerHeight + 2;
}
function healLayout(why) {
  if (!viewportBroken()) return;
  if (Date.now() - healGuard < 1000) return;
  healGuard = Date.now();

  // Gentle first: change the frame height by a pixel and back, two forced
  // layout passes. If the boxes are still stale after that, rebuild the whole
  // tree — display:none flush is the one thing a "clean" layout cannot
  // survive. That resets scroll positions and focus, so save and restore.
  const root = document.documentElement;
  root.style.setProperty('--app-h', `${window.innerHeight - 1}px`);
  void document.body.offsetHeight;
  root.style.setProperty('--app-h', `${window.innerHeight}px`);
  void document.body.offsetHeight;
  let hammer = false;
  if (viewportBroken()) {
    hammer = true;
    const scroller = document.getElementById('messageScroll');
    const stuck = scroller
      && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
    const scrollTop = scroller?.scrollTop || 0;
    const focused = document.activeElement;
    document.body.style.display = 'none';
    void document.body.offsetHeight;
    document.body.style.display = '';
    void document.body.offsetHeight;
    if (scroller) scroller.scrollTop = stuck ? scroller.scrollHeight : scrollTop;
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
  lastViewportH = window.innerHeight;
  lastLayoutHeal = { at: Date.now(), why, hammer, fixed: !viewportBroken() };
  scheduleWindowDiag('layout-heal', 1500);
}
let healTimer = null;
function healLayoutSoon(why, delay = 250) {
  clearTimeout(healTimer);
  healTimer = setTimeout(() => healLayout(why), delay);
}

function wireViewport() {
  syncViewport();
  // Every one of these is a moment the layout can have gone stale. The
  // overflow self-check is cheap (two getBoundingClientRect calls) and only
  // acts when something is genuinely sticking out past the viewport, so it
  // runs after ANY resize — whichever main-process path (or Windows whim)
  // caused it, including ones nobody has found yet.
  window.addEventListener('resize', () => { syncViewport(); healLayoutSoon('resize', 300); });
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.addEventListener('focus', () => healLayoutSoon('focus', 400));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    syncViewport();
    setTimeout(syncViewport, 200);
    healLayoutSoon('visible', 450);
  });
  desktop.onViewportNudge(() => {
    // Sizes settle late during a restore animation; measure a few times.
    syncViewport();
    setTimeout(syncViewport, 150);
    setTimeout(syncViewport, 600);
    healLayoutSoon('nudge', 700);
    scheduleWindowDiag('restore');
  });
  // One report per launch regardless of any restore: its log tail carries the
  // previous session's window events — including whether 'restore' ever fired.
  scheduleWindowDiag('startup', 10_000);
}

// After every restore — and once on each start — the client ships a small
// diagnostic to the server: the window.log tail from the main process plus
// what the renderer itself measures. This is how the recurring "clipped after
// minimize" bug finally gets pinned on machines no debugger can reach. The
// startup report matters as much as the restore one: its log tail shows what
// the previous session's window events actually were. Right after a restore
// the connection is often still waking up, so a failed send retries rather
// than vanishing. Read back with `npm run admin windowlog`; throttled to one
// delivered report a minute, silent towards the user.
let diagTimer = null;
let lastDiagAt = 0;
let diagTries = 0;
let diagReason = 'restore';
function scheduleWindowDiag(reason, delay = 3000) {
  diagReason = reason || diagReason;
  diagTries = 0;
  clearTimeout(diagTimer);
  diagTimer = setTimeout(() => void sendWindowDiag(), delay);
}
async function sendWindowDiag() {
  // A layout heal is the report that matters most — it jumps the queue.
  if (diagReason !== 'layout-heal' && Date.now() - lastDiagAt < 60_000) return;
  try {
    const main = await desktop.windowDiag();
    const app = document.querySelector('.app');
    const composer = document.getElementById('composer');
    const rect = (node) => {
      if (!node || node.hidden) return null;
      const r = node.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
    };
    await net.request('diag:window', {
      report: {
        reason: diagReason,
        inner: { w: window.innerWidth, h: window.innerHeight },
        dpr: window.devicePixelRatio,
        appH: document.documentElement.style.getPropertyValue('--app-h') || null,
        appRect: rect(app),
        composerRect: rect(composer),
        heal: lastLayoutHeal,
        main,
      },
    });
    lastDiagAt = Date.now(); // only a delivered report consumes the slot
    diagReason = 'restore';
  } catch {
    // Not connected yet, most likely. Try again a few times, then let it go.
    diagTries += 1;
    if (diagTries < 4) diagTimer = setTimeout(() => void sendWindowDiag(), diagTries * 15_000);
  }
}

async function boot() {
  await loadRuntime();
  loadPreferences();
  hydrateIcons();
  wireViewport();

  mountTitlebar();
  initUpdates(desktop);
  mountAuth(enterWorkspace);
  wireNetwork();
  wireDelegatedClicks();

  const resumed = await tryResume();
  if (!resumed) showAuthScreen();
}

// ------------------------------------------------------------- workspace

// An invite carried in by a link: voxara://join/<code> on the desktop, or
// /app/?join=<code> in a browser. Held until sign-in, then joined once.
let pendingInvite = null;
function inviteFromUrl(url) {
  const m = /^voxara:\/\/join\/([A-Za-z0-9-]{4,16})/i.exec(String(url || ''));
  return m ? m[1].toUpperCase() : null;
}
function rememberInvite(code) {
  if (!code) return;
  pendingInvite = code;
  if (document.body.classList.contains('is-authed')) void consumePendingInvite();
}
async function consumePendingInvite() {
  const code = pendingInvite;
  pendingInvite = null;
  if (!code) return;
  try { await joinGuild(code); }
  catch (err) { toast({ title: 'Could not join that space', body: err.message, kind: 'error', timeout: 8000 }); }
}
try {
  const fromQuery = new URLSearchParams(location.search).get('join');
  if (fromQuery) { pendingInvite = fromQuery.toUpperCase(); history.replaceState(null, '', location.pathname); }
} catch { /* no URL access */ }
desktop.onDeepLink(({ url } = {}) => rememberInvite(inviteFromUrl(url)));
void desktop.deepLinkPending().then((url) => rememberInvite(inviteFromUrl(url)));

function enterWorkspace(ready) {
  store.applyReady(ready);
  loadThemes(ready.themes);
  net.token = ready.token || net.token;
  if (ready.mediaToken) { net.mediaToken = ready.mediaToken; setSettings({ mediaToken: ready.mediaToken }); }
  if (pendingInvite) setTimeout(() => void consumePendingInvite(), 300);

  document.body.classList.add('is-authed');
  document.getElementById('screenAuth').hidden = true;
  document.getElementById('screenWorkspace').hidden = false;

  applyReduceFlashing();

  if (!workspaceMounted) {
    mountSidebar();
    mountChat();
    mountMembers();
    mountShortcuts();
    hydrateIcons();
    store.on('self', applyReduceFlashing);
    store.on('unreads', updateBadge);
    // Remember where you were, so a restart reopens it.
    store.on('view', () => closePopover());
  store.on('view', ({ view }) => {
      if (view.channelId) setSetting('lastChannelId', view.channelId);
    });
    desktop.onNotificationClick(({ channelId }) => {
      if (channelId) void openConversation(channelId);
    });
    // A non-Steam game (Minecraft, Roblox, ...) the main process's process
    // scanning just noticed starting or stopping — tell the server so
    // friends see it exactly like a Steam game (see gateway.js presence:game).
    desktop.onGameDetected((game) => {
      net.request('presence:game', { game }).catch(() => {});
      callui.noteLocalGame(game);
    });
    // Sync anything the main process already noticed before this listener
    // existed (its first scan can easily land before sign-in finishes).
    desktop.currentGame().then((game) => {
      if (game) net.request('presence:game', { game }).catch(() => {});
      callui.noteLocalGame(game);
    });
    workspaceMounted = true;
  mountWebNudge();
    maybeStartTour();
  } else {
    // A resume after a dropped connection: refresh every view in place.
    store.emit('guilds');
    store.emit('users');
    store.emit('unreads');
    store.emit('self');
  }

  // Name the server so the status pill and About pane can refer to it.
  document.body.dataset.serverName = store.server?.name || '';

  restoreLastLocation();
  applyLayout();
  updateBadge();
  setConnectionState(net.isOpen ? 'online' : 'connecting');
}

function restoreLastLocation() {
  // Prefer this session's channel, then the one from the last run.
  const candidates = [store.view.channelId, getSetting('lastChannelId')];
  for (const candidate of candidates) {
    if (candidate && (store.channel(candidate) || store.dm(candidate))) {
      void openConversation(candidate, { focusComposer: false });
      return;
    }
  }
  const firstGuild = [...store.guilds.keys()][0];
  if (firstGuild) openGuild(firstGuild);
  else openHome();
}

function updateBadge() {
  desktop.setBadge(store.totalMentions());
}

// Photosensitivity: when the account has "reduce flashing" on, stop animated
// content from autoplaying and kill app animations (see reduce-flashing CSS).
function applyReduceFlashing() {
  document.body.classList.toggle('reduce-flashing', Boolean(store.self?.reduceFlashing));
}

// --------------------------------------------------------------- network

const PILL_STATE = {
  idle: 'offline',
  connecting: 'connecting',
  open: 'online',
  reconnecting: 'reconnecting',
  closed: 'offline',
  failed: 'offline',
};

function wireNetwork() {
  net.on('status', ({ status }) => {
    renderConnectionBanner(status);
    setConnectionState(PILL_STATE[status] || 'offline');
  });
  net.on('resumed', (ready) => {
    renderConnectionBanner('open');
    enterWorkspace(ready);
    // Re-register in the voice channel we were in; the server dropped us
    // from it when the socket went, and the fresh ready payload shows that.
    callui.onResumed();
    toast({ body: 'Reconnected.', kind: 'success', timeout: 2500 });
  });
  // A session the server no longer recognises: stop retrying, ask for a sign-in.
  net.on('resume-failed', () => {
    setSettings({ token: null, mediaToken: null });
    net.disconnect();
    showAuthScreen('Your session expired. Please sign in again.');
  });
  net.on('event', handleServerEvent);
}

function renderConnectionBanner(status) {
  const banner = document.getElementById('connectionBanner');
  if (!banner) return;

  if (status === 'open' || status === 'idle') {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.classList.toggle('connection-banner--error', status === 'failed' || status === 'closed');
  banner.textContent = {
    connecting: 'Connecting…',
    reconnecting: 'Connection lost — reconnecting…',
    closed: 'Disconnected from the server.',
    failed: 'Could not reach the server.',
  }[status] || '';
}

function handleServerEvent({ op, data }) {
  switch (op) {
    // The server has ended this session (e.g. the account was suspended). Drop
    // the token, stop reconnecting, and return to the sign-in screen with why.
    case 'session:ended': {
      setSettings({ token: null, mediaToken: null });
      net.disconnect();
      showAuthScreen(data?.message || 'You have been signed out.');
      break;
    }

    case 'call:incoming': { callui.onIncoming(data); break; }
    case 'call:peer-joined': { callui.onPeerJoined(data); break; }
    case 'call:signal': { callui.onSignal(data); break; }
    case 'call:declined': { callui.onDeclined(data); break; }
    case 'call:peer-left': { callui.onPeerLeft(data); break; }
    case 'voice:state': {
      const before = store.voiceSharers(data.channelId);
      store.setVoiceState(data.channelId, data.users || [], data.sharing || []);
      callui.onVoiceSharing(data.channelId, before, data.sharing || []);
      break;
    }
    case 'voice:kicked': { callui.onVoiceKicked(data); break; }
    case 'voice:moved': { callui.onVoiceMoved(data); break; }

    case 'message:new': {
      const { message, nonce } = data;
      const mine = message.authorId === store.selfId;
      const active = message.channelId === store.view.channelId && document.hasFocus();

      store.addMessage(message, { nonce: mine ? nonce : null });

      const dm = store.dm(message.channelId);
      if (dm) {
        dm.lastMessageId = message.id;
        store.emit('guilds');
      }

      let mentionsMe = Array.isArray(message.mentions) && message.mentions.includes(store.selfId);
      // If this is an @everyone/@here in a space you've muted for that, it only
      // counts as a ping when it also names you directly by @username.
      if (mentionsMe && message.everyone) {
        const gid = store.guildOfChannel(message.channelId)?.id;
        const uname = store.self?.username || '';
        const directlyMe = uname && new RegExp(`(^|[^\\w@])@${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(message.content || '');
        if (gid && spaceEveryoneMuted(gid) && !directlyMe) mentionsMe = false;
      }
      if (!mine && mentionsMe) {
        // Keep the mention inbox live without a round-trip.
        store.inbox.mentions.unshift({
          id: message.id, channelId: message.channelId, messageId: message.id,
          authorId: message.authorId, at: message.createdAt || Date.now(),
        });
        store.emit('inbox');
      }

      if (!mine && !active) {
        store.bumpUnread(message.channelId, { mention: Boolean(dm) || mentionsMe });
        notifyIfNeeded(message);
      } else if (active) {
        markRead(message.channelId);
      }
      break;
    }

    case 'message:update':
      store.updateMessage(data.message);
      break;

    case 'message:delete':
      store.removeMessage(data.channelId, data.messageId);
      break;

    case 'thread:new':
    case 'thread:delete': {
      const wasOpen = store.view.channelId === data.threadId;
      store.removeThread(data.threadId);
      if (wasOpen) void openConversation(data.parentChannelId, { guildId: data.guildId });
      break;
    }

    case 'thread:update':
      store.upsertThread(data.thread);
      // A lock/unlock on the open thread changes its header and whether you can type.
      if (data.thread?.id === store.view.channelId) { renderHeader(); renderComposerState(); }
      break;

    case 'typing':
      store.noteTyping(data.channelId, data.userId);
      break;

    case 'presence':
      store.setPresence(data.userId, data.status, data.customStatus);
      break;

    case 'user:update':
      store.upsertUser(data.user);
      if (data.user.id === store.selfId) {
        store.self = { ...store.self, ...data.user };
        store.emit('self');
      }
      break;

    case 'reminder:due': {
      store.markReminderDue(data.bookmark);
      const preview = data.bookmark.snapshot?.preview || 'a saved message';
      toast({ title: 'Reminder', body: preview.slice(0, 120), kind: 'info' });
      desktop.flash?.();
      break;
    }

    case 'schedule:sent':
      // The message itself arrives as a normal message:new. A one-off leaves
      // the queue; a recurring one rolls forward to its next send time.
      store.removeScheduled(data.id);
      if (data.next) store.addScheduled(data.next);
      break;

    case 'schedule:failed':
      store.removeScheduled(data.id);
      toast({ title: 'Scheduled message not sent', body: 'You no longer have access to that channel.', kind: 'error' });
      break;

    case 'self:age':
      // The card check finished in the browser: 18+ areas open up right away.
      store.self = { ...store.self, adult: data.adult, over18: data.over18, ageVerified: data.ageVerified, ageVerifiedAt: data.ageVerifiedAt };
      store.emit('self');
      store.emit('guilds');
      renderMessages({ jump: true });
      renderComposerState();
      toast({ title: 'Age verified', body: 'Your account is marked as 18+. Age-restricted spaces and channels are open to you now.', kind: 'success' });
      break;

    case 'self:steam':
      store.self = { ...store.self, steam: data.steam, steamLinked: Boolean(data.steam) };
      store.emit('self');
      toast({ title: 'Steam linked', body: 'Friends can now see your games and wishlist.', kind: 'success' });
      break;

    case 'themes:updated':
      loadThemes(data.themes);
      break;

    case 'friend:playing':
      if (data.game) store.steamPlaying.set(data.userId, { game: data.game, appid: data.appid });
      else store.steamPlaying.delete(data.userId);
      store.emit('friends');
      break;

    case 'card:earned':
      if (store.cards) {
        store.cards.owned = { ...store.cards.owned, [data.card.id]: data.count };
        store.cards.unique = Object.keys(store.cards.owned).length;
        store.emit('cards');
      }
      if (data.isNew) toast({ title: 'New card', body: `You earned “${data.card.name}”.`, kind: 'success' });
      break;

    case 'steam:deal':
      store.inbox.deals = [data.deal, ...(store.inbox.deals || []).filter((d) => d.appid !== data.deal.appid)];
      store.emit('inbox');
      toast({ title: 'Wishlist deal', body: `${data.deal.name} is ${data.deal.discount}% off — ${data.deal.price}`, kind: 'success' });
      break;

    case 'themes:pending':
      store.pendingThemes = data.count || 0;
      store.emit('themes');
      break;

    case 'theme:reviewed':
      toast(data.status === 'approved'
        ? { title: 'Theme approved', body: `“${data.name}” is now on the list for everyone.`, kind: 'success' }
        : { title: 'Theme not added', body: `“${data.name}” wasn't added to the list.`, kind: 'info' });
      break;

    case 'self:premium':
      // Voxara Plus was granted or removed for this account — light it up (or
      // dim it) without a reconnect.
      store.self = { ...store.self, premium: data.premium, subscription: data.subscription };
      if (store.selfId) store.upsertUser({ id: store.selfId, premium: data.premium });
      store.emit('self');
      break;

    case 'guild:new':
      store.upsertUsers(data.users);
      store.upsertGuild(data.guild);
      break;

    case 'guild:update': {
      const guild = store.guild(data.guildId);
      if (guild) {
        guild.name = data.name ?? guild.name;
        guild.iconColor = data.iconColor ?? guild.iconColor;
        if ('iconUrl' in data) guild.iconUrl = data.iconUrl;
        if ('bannerUrl' in data) guild.bannerUrl = data.bannerUrl;
        if (Array.isArray(data.categories)) guild.categories = data.categories;
        if (Array.isArray(data.roles)) guild.roles = data.roles;
        if (data.everyoneRole) guild.everyoneRole = data.everyoneRole;
        if (data.memberRoles) guild.memberRoles = data.memberRoles;
        if (Array.isArray(data.channels)) guild.channels = data.channels;
        if (Array.isArray(data.blockedWords)) guild.blockedWords = data.blockedWords;
        if (data.timeouts) guild.timeouts = data.timeouts;
        if (Array.isArray(data.emojis)) { guild.emojis = data.emojis; store.emit('emojis'); }
        if (typeof data.verification === 'string') guild.verification = data.verification;
        if (data.antiRaid) guild.antiRaid = data.antiRaid;
        if (data.lockdown) {
          const wasActive = guild.lockdown?.active;
          guild.lockdown = data.lockdown;
          if (data.lockdown.active && !wasActive && guild.id === store.view.guildId) {
            toast({ title: 'Lockdown', body: 'Only moderators can post here right now.', kind: 'info' });
          }
        }
        store.emit('guilds');
      }
      break;
    }

    case 'guild:remove': {
      const wasOpen = store.view.guildId === data.guildId;
      store.removeGuild(data.guildId);
      if (wasOpen) openHome();
      break;
    }

    case 'member:add': {
      const guild = store.guild(data.guildId);
      store.upsertUser(data.user);
      if (guild && !guild.memberIds.includes(data.user.id)) {
        guild.memberIds.push(data.user.id);
        store.emit('guilds');
        store.emit('users');
      }
      break;
    }

    case 'member:remove': {
      const guild = store.guild(data.guildId);
      if (guild) {
        guild.memberIds = guild.memberIds.filter((id) => id !== data.userId);
        store.emit('guilds');
        store.emit('users');
      }
      break;
    }

    case 'channel:new':
      store.addChannel(data.channel);
      break;

    case 'channel:update':
      store.updateChannel(data.channel);
      break;

    case 'channel:delete': {
      const wasOpen = store.view.channelId === data.channelId;
      store.removeChannel(data.guildId, data.channelId);
      if (wasOpen) openGuild(data.guildId);
      break;
    }

    case 'friend:request':
      store.addIncomingRequest(data.request, data.user);
      toast({
        title: 'Friend request',
        body: `${data.user.displayName} wants to be friends.`,
        kind: 'info',
        timeout: 8000,
      });
      desktop.flash();
      break;

    case 'message:pinned': {
      // Keep the loaded copy in step so the pin button reflects reality.
      const target = store.message(data.channelId, data.messageId);
      if (target) {
        target.pinnedAt = data.pinnedAt;
        target.pinnedBy = data.pinnedBy;
        store.emit('messages', { channelId: data.channelId, reason: 'pin' });
      }
      break;
    }

    case 'friend:added':
      store.addFriend(data.user);
      break;

    case 'friend:removed':
      store.removeFriend(data.userId);
      break;

    case 'friend:request-removed':
      store.removeRequest(data.requestId);
      break;

    case 'dm:new':
      store.upsertUsers(data.users);
      store.upsertDm(data.dm);
      break;

    case 'read:update':
      store.reads[data.channelId] = data.messageId;
      store.clearUnread(data.channelId);
      break;

    case 'read:seen':
      store.setSeen(data.channelId, data.userId, data.messageId);
      break;

    case 'error':
      toast({ body: data.message, kind: 'error' });
      break;

    default:
      break;
  }
}

// ------------------------------------------------------- delegated clicks

function wireDelegatedClicks() {
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('.md-link');
    if (link) {
      event.preventDefault();
      desktop.openExternal(link.dataset.href || link.textContent);
      return;
    }

    const spoiler = event.target.closest?.('.md-spoiler');
    if (spoiler) {
      spoiler.classList.toggle('is-revealed');
      return;
    }

    const chan = event.target.closest?.('.md-chan');
    if (chan) {
      const id = chan.dataset.channel;
      const guild = store.guildOfChannel(id);
      if (guild) openConversation(id, { guildId: guild.id });
      return;
    }

    const mention = event.target.closest?.('.md-mention');
    if (mention) {
      const handle = mention.dataset.mention;
      const user = [...store.users.values()].find((u) => u.username.toLowerCase() === handle);
      if (user) showUserPopover(mention, user.id);
    }
  });

  // Coming back to the window means you have seen what is on screen.
  window.addEventListener('focus', () => {
    if (store.view.channelId) markRead(store.view.channelId);
  });

  // If a channel gained messages while its history was never loaded, fetch it
  // the moment it is opened — handled in actions — but also refresh on resume.
  net.on('resumed', () => {
    const channelId = store.view.channelId;
    if (channelId) void loadHistory(channelId).then(() => renderMessages({ jump: true }));
  });
}

boot().catch((err) => {
  console.error('[pulse] failed to start:', err);
  document.getElementById('authError').textContent = `Voxara failed to start: ${err.message}`;
  document.getElementById('authError').hidden = false;
});

/**
 * Downloading a build takes a while, so say so. Before this the update dialog
 * closed and nothing visible happened until the app restarted itself.
 */
