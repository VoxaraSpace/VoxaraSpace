import { el, clear, debounce } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { net, setSettings, mediaUrl } from '../client.js';
import {
  openConversation, updateProfile, openDm, setSidebarMode, openHome, openGuild,
  acceptFriend, dismissFriendRequest, removeFriend, setPref, moveFriendToGroup, moveVoiceMember } from '../actions.js';
import { openPopover, menuItem, menuSeparator, menuLabel, confirmDialog, closePopover, pointAnchor} from './overlay.js';
import { avatar, STATUS_LABEL, STATUS_COLOR } from './bits.js';
import { toastError } from './toast.js';
import {
  showCreateServer, showJoinServer, showCreateChannel, showAddFriend,
} from './modals.js';
import { showSettings } from './settings.js';
import { showSpaceSettings, canConfigureSpace, canManage, roleColor, channelPermission } from './spacesettings.js';
import { showDiscover } from './discover.js';
import { officialBadge } from './bits.js';
import { showUserPopover } from './profile.js';
import { openGuildMenu, openChannelMenu, openCategoryMenu, openSpaceBackgroundMenu, openUserMenu, openFriendGroupMenu, openFriendsBackgroundMenu, openVoiceMemberMenu } from './menus.js';
import { startVoiceChannel, currentVoiceChannel, leaveVoiceChannel, watchStream } from './call.js';

let scrollHost;
let filterInput;

export function mountSidebar() {
  scrollHost = document.getElementById('sidebarScroll');
  filterInput = document.getElementById('sidebarFilter');
  listHost = document.getElementById('spaceList');
  spaceHead = document.getElementById('spaceHead');

  document.getElementById('modeFriends').addEventListener('click', () => setMode('friends'));
  document.getElementById('modeSpaces').addEventListener('click', () => setMode('spaces'));

  // The header buttons act on whichever section you are in.
  document.getElementById('sidebarCreate').addEventListener('click', () => {
    if (store.ui.sidebarMode === 'friends') showAddFriend();
    else showCreateServer();
  });
  document.getElementById('sidebarJoin').addEventListener('click', showJoinServer);
  document.getElementById('sidebarDiscover').addEventListener('click', () => showDiscover());
  // The Steam store: only offered when the server has the integration on.
  const storeBtn = document.getElementById('sidebarStore');
  storeBtn.addEventListener('click', () => {
    void import('./steamstore.js').then((m) => m.showSteamStore());
  });
  storeBtn.hidden = !store.server.steam;
  document.getElementById('sidebarCards').addEventListener('click', () => {
    void import('./cards.js').then((m) => m.showCards());
  });
  document.getElementById('sidebarCompact').addEventListener('click', () => {
    setPref('spacesCollapsed', !store.ui.spacesCollapsed);
  });

  filterInput.addEventListener('input', debounce(() => {
    store.filter = filterInput.value.trim().toLowerCase();
    renderSidebar();
  }, 90));

  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      filterInput.value = '';
      store.filter = '';
      renderSidebar();
      filterInput.blur();
    }
    if (event.key === 'Enter') {
      const first = scrollHost.querySelector('.row[data-channel-id]');
      if (first) first.click();
    }
  });

  document.getElementById('userbarMe').addEventListener('click', openStatusMenu);
  document.getElementById('userbarSettings').addEventListener('click', () => showSettings());
  document.getElementById('userbarLogout').addEventListener('click', signOut);

  store.on('guilds', renderSidebar);
  store.on('friends', renderSidebar);
  store.on('ui', renderSidebar);
  store.on('unreads', renderSidebar);
  store.on('view', renderSidebar);
  store.on('voice', renderSidebar);
  store.on('users', () => {
    renderSidebar();
    renderUserbar();
  });
  store.on('self', renderUserbar);

  renderSidebar();
  renderUserbar();
}

/**
 * Friends and Spaces are separate sections, never mixed in one list — so
 * switching section moves the conversation pane there too.
 */
function setMode(mode) {
  if (store.ui.sidebarMode === mode) return;
  store.filter = '';
  if (filterInput) filterInput.value = '';
  setSidebarMode(mode);

  if (mode === 'friends') {
    openHome();
    return;
  }
  const guildId = store.guild(store.view.guildId) ? store.view.guildId : [...store.guilds.keys()][0];
  if (guildId) openGuild(guildId);
  else store.setView({ kind: 'guild', guildId: null, channelId: null });
}

// ---------------------------------------------------------------- rendering

let listHost;
let spaceHead;

const matches = (text) => !store.filter || String(text).toLowerCase().includes(store.filter);

export function renderSidebar() {
  if (!scrollHost) return;
  scrollHost.oncontextmenu = null;
  clear(scrollHost);
  renderModeSwitch();

  const friendsMode = store.ui.sidebarMode === 'friends';
  // Side-rail layout: the space strip becomes a column down the left and also
  // carries the friends, Steam, cards, create and join buttons, so the header
  // row and the two tabs are not needed.
  const rail = store.ui.sidebarLayout === 'rail';
  document.getElementById('sidebar')?.classList.toggle('is-rail', rail);

  document.getElementById('sidebarCreate')?.setAttribute(
    'title', friendsMode ? 'Add a friend' : 'Create a space');
  document.getElementById('sidebarCreate')?.setAttribute(
    'aria-label', friendsMode ? 'Add a friend' : 'Create a space');
  document.getElementById('sidebarJoin').hidden = friendsMode;
  document.getElementById('sidebarDiscover').hidden = friendsMode;
  const compactBtn = document.getElementById('sidebarCompact');
  compactBtn.hidden = friendsMode;
  compactBtn.setAttribute('aria-pressed', String(Boolean(store.ui.spacesCollapsed)));
  filterInput.placeholder = 'Filter friends';

  // A space shows only its own channels, so a filter box would be filtering a
  // handful of rows. Ctrl+K still jumps to any channel from anywhere.
  const searchRow = document.getElementById('sidebarSearchRow');
  if (searchRow) searchRow.hidden = !friendsMode;
  if (!friendsMode && store.filter) {
    store.filter = '';
    filterInput.value = '';
  }

  listHost.hidden = friendsMode && !rail;
  spaceHead.hidden = true;
  if (rail && friendsMode) renderSpaceList();

  if (friendsMode) {
    renderRequestsGroup();
    renderFriendsGroup();
    renderOtherDmsGroup();
    scrollHost.oncontextmenu = (event) => {
      if (event.target.closest('.row, .cathead, .request')) return;
      event.preventDefault();
      openFriendsBackgroundMenu(pointAnchor(event.clientX, event.clientY));
    };
  } else {
    renderSpaceList();
    // One space at a time: the rail is how you move between them, so the list
    // below only has to explain the space you are actually in.
    const current = store.guild(store.view.guildId) || [...store.guilds.values()][0];
    if (current) {
      renderSpaceHead(current);
      renderGuildGroup(current, { soloView: true });
      // Right-clicking the empty list is the quickest route to adding things.
      scrollHost.oncontextmenu = (event) => {
        if (event.target.closest('.row, .cathead')) return;
        event.preventDefault();
        openSpaceBackgroundMenu(pointAnchor(event.clientX, event.clientY), current);
      };
    }
    renderNoSpacesPrompt();
  }

  if (scrollHost.children.length === 0) {
    scrollHost.appendChild(el('div', { class: 'sidebar__empty' },
      el('strong', {}, 'No matches'),
      `Nothing here contains “${store.filter}”.`));
  }
}

function renderModeSwitch() {
  const friendsMode = store.ui.sidebarMode === 'friends';
  const friendsTab = document.getElementById('modeFriends');
  const spacesTab = document.getElementById('modeSpaces');
  if (!friendsTab) return;

  friendsTab.classList.toggle('is-active', friendsMode);
  spacesTab.classList.toggle('is-active', !friendsMode);
  friendsTab.setAttribute('aria-selected', String(friendsMode));
  spacesTab.setAttribute('aria-selected', String(!friendsMode));

  // Each tab carries the unread weight of the section you cannot currently see.
  const dmUnread = store.dmTotals().unread + store.incoming.size;
  let spaceUnread = 0;
  for (const guildId of store.guilds.keys()) spaceUnread += store.guildUnread(guildId).mentions;

  for (const [tab, count] of [[friendsTab, dmUnread], [spacesTab, spaceUnread]]) {
    const badge = tab.querySelector('.modeswitch__badge');
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count);
  }
}

/**
 * Section heading: LABEL ────────── count, with the collapse toggle on the
 * label and per-group actions revealed on hover.
 */
function groupHead({ key, name, chipColor, chipUrl, count, badge, collapsed, onToggle, onMenu, action, onDropFriend }) {
  const toggle = el('button', {
    class: 'group__toggle',
    type: 'button',
    'aria-expanded': String(!collapsed),
    onClick: onToggle,
    onContextmenu: onMenu
      ? (event) => {
        event.preventDefault();
        onMenu(toggle);
      }
      : null,
  },
  icon('chevron-down'),
  chipColor
    ? el('span', {
      class: 'group__chip',
      style: chipUrl
        ? { backgroundImage: `url("${chipUrl}")` }
        : { background: chipColor },
    })
    : null,
  el('span', { class: 'group__name' }, name));

  const head = el('div', { class: 'group__head' }, toggle, el('span', { class: 'group__rule' }));

  // Dropping a friend on the Friends heading takes them out of any category.
  if (onDropFriend) {
    const isFriendDrag = (event) => [...(event.dataTransfer?.types || [])].includes('text/pulse-friend');
    head.addEventListener('dragover', (event) => {
      if (!isFriendDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      head.classList.add('is-droptarget');
    });
    head.addEventListener('dragleave', () => head.classList.remove('is-droptarget'));
    head.addEventListener('drop', (event) => {
      if (!isFriendDrag(event)) return;
      event.preventDefault();
      head.classList.remove('is-droptarget');
      const userId = event.dataTransfer.getData('text/pulse-friend');
      if (userId) onDropFriend(userId);
    });
  }

  if (action) {
    head.appendChild(el('button', {
      class: 'group__action',
      type: 'button',
      title: action.title,
      'aria-label': action.title,
      onClick: (event) => {
        event.stopPropagation();
        action.onSelect(event.currentTarget);
      },
    }, icon(action.iconName)));
  }

  if (badge > 0) {
    head.appendChild(el('span', {
      class: 'group__badge',
      title: `${badge} unread`,
    }, badge > 99 ? '99+' : String(badge)));
  } else if (count !== undefined) {
    head.appendChild(el('span', { class: 'group__count' }, String(count)));
  }

  return head;
}

function isCollapsed(key) {
  return store.ui.collapsedCategories.has(key);
}

function toggleCollapsed(key) {
  if (store.ui.collapsedCategories.has(key)) store.ui.collapsedCategories.delete(key);
  else store.ui.collapsedCategories.add(key);
  renderSidebar();
}

/** Incoming friend requests, shown only when there are some. */
function renderRequestsGroup() {
  const requests = [...store.incoming.values()];
  if (requests.length === 0 || store.filter) return;

  const key = '@requests';
  const collapsed = isCollapsed(key);
  const section = el('div', { class: `group${collapsed ? ' is-collapsed' : ''}` });

  section.appendChild(groupHead({
    name: 'Friend requests',
    badge: requests.length,
    collapsed,
    onToggle: () => toggleCollapsed(key),
  }));

  const body = el('div', { class: 'group__body' });
  for (const request of requests) {
    const from = store.user(request.fromId);
    body.appendChild(el('div', { class: 'request' },
      avatar(from, { size: 'sm' }),
      el('span', { class: 'request__name', title: from ? `@${from.username}` : '' },
        store.userName(request.fromId)),
      el('button', {
        class: 'request__btn request__btn--yes',
        type: 'button',
        title: 'Accept',
        'aria-label': `Accept ${store.userName(request.fromId)}`,
        onClick: () => acceptFriend(request.id),
      }, icon('check')),
      el('button', {
        class: 'request__btn',
        type: 'button',
        title: 'Decline',
        'aria-label': `Decline ${store.userName(request.fromId)}`,
        onClick: () => dismissFriendRequest(request.id),
      }, icon('close'))));
  }
  section.appendChild(body);
  scrollHost.appendChild(section);
}

/**
 * Friends double as the direct-message list: each row opens the DM, and rows
 * sort unread first, then by who is online.
 */
function renderFriendsGroup() {
  const friends = store.friendList().filter((f) => matches(f.displayName) || matches(f.username));
  const outgoing = [...store.outgoing.values()];

  if (friends.length === 0 && outgoing.length === 0 && store.filter) return;

  const key = '@friends';
  const collapsed = isCollapsed(key) && !store.filter;
  const section = el('div', { class: `group${collapsed ? ' is-collapsed' : ''}` });

  section.appendChild(groupHead({
    name: 'Friends',
    count: friends.length,
    badge: store.dmTotals().unread,
    collapsed,
    onToggle: () => toggleCollapsed(key),
    action: { title: 'Add a friend', iconName: 'plus', onSelect: showAddFriend },
    onDropFriend: (userId) => moveFriendToGroup(userId, null),
  }));

  const body = el('div', { class: 'group__body' });

  if (friends.length === 0 && outgoing.length === 0) {
    body.appendChild(el('div', { class: 'sidebar__empty', style: { padding: '8px 16px 4px' } },
      'Nobody yet. Add someone by their username to start talking.',
      el('div', { style: { marginTop: '10px' } },
        el('button', {
          class: 'btn btn--sm btn--primary',
          type: 'button',
          onClick: showAddFriend,
        }, 'Add a friend'))));
  }

  const friendRow = (friend) => {
    const dm = store.dmWith(friend.id);
    const playing = store.ui.showFriendGames ? store.playing(friend.id) : null;
    const row = conversationRow({
      id: dm?.id || `friend:${friend.id}`,
      label: friend.displayName,
      subtitle: playing ? `In-game · ${playing.game}` : null,
      leading: avatar(friend, { size: 'sm' }),
      unread: dm ? store.unreadFor(dm.id) : 0,
      onOpen: () => (dm ? openConversation(dm.id) : openDm(friend.id)),
      onMenu: (anchor) => openFriendMenu(anchor, friend),
      onContext: (event) => openUserMenu(pointAnchor(event.clientX, event.clientY), friend, {
        groups: store.friendGroups || [],
      }),
    });

    // Dragging a friend onto a category heading files them into it.
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/pulse-friend', friend.id);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    return row;
  };

  const byUnread = (a, b) =>
    store.unreadFor(store.dmWith(b.id)?.id) - store.unreadFor(store.dmWith(a.id)?.id);

  const groups = store.friendGroups || [];
  const placed = new Set();
  for (const group of groups) for (const id of group.memberIds) placed.add(id);

  // Anyone not in a category belongs to the Friends list itself — no heading,
  // because "Friends" above already is the heading.
  for (const friend of friends.filter((f) => !placed.has(f.id)).sort(byUnread)) {
    body.appendChild(friendRow(friend));
  }

  for (const group of groups) {
    const inGroup = friends.filter((f) => group.memberIds.includes(f.id));
    if (inGroup.length === 0 && store.filter) continue;

    const groupKey = `fgroup:${group.id}`;
    const groupCollapsed = isCollapsed(groupKey) && !store.filter;

    body.appendChild(categoryHead({
      guild: null,
      category: group,
      owner: true,
      collapsed: groupCollapsed,
      count: inGroup.length,
      key: groupKey,
      onMenu: (event) => openFriendGroupMenu(
        pointAnchor(event.clientX, event.clientY), group),
      onDropFriend: (userId) => moveFriendToGroup(userId, group.id),
    }));
    if (groupCollapsed) continue;
    for (const friend of inGroup.sort(byUnread)) body.appendChild(friendRow(friend));
  }



  for (const request of outgoing) {
    const to = store.user(request.toId);
    body.appendChild(el('div', { class: 'request request--pending' },
      avatar(to, { size: 'sm' }),
      el('span', { class: 'request__name' }, store.userName(request.toId)),
      el('span', { class: 'request__tag' }, 'Pending'),
      el('button', {
        class: 'request__btn',
        type: 'button',
        title: 'Cancel request',
        'aria-label': 'Cancel request',
        onClick: () => dismissFriendRequest(request.id),
      }, icon('close'))));
  }

  section.appendChild(body);
  scrollHost.appendChild(section);
}

/**
 * Conversations with people who are not (or are no longer) friends: a
 * message from someone in a shared space, or a friend you removed. Without
 * this section their unread count would show on the Friends tab with no
 * row anywhere to open it from.
 */
function renderOtherDmsGroup() {
  const rows = [];
  for (const dm of store.dms.values()) {
    const partnerId = store.dmPartnerId(dm.id);
    if (!partnerId || partnerId === store.selfId || store.isFriend(partnerId)) continue;
    const user = store.user(partnerId);
    if (!user || user.webhook) continue;
    if (!matches(user.displayName) && !matches(user.username)) continue;
    rows.push({ dm, user });
  }
  if (!rows.length) return;
  rows.sort((x, y) => store.unreadFor(y.dm.id) - store.unreadFor(x.dm.id));

  const key = '@otherdms';
  const collapsed = isCollapsed(key) && !store.filter;
  const section = el('div', { class: `group${collapsed ? ' is-collapsed' : ''}` });
  section.appendChild(groupHead({
    name: 'Direct messages',
    count: rows.length,
    badge: rows.reduce((n, r) => n + store.unreadFor(r.dm.id), 0),
    collapsed,
    onToggle: () => toggleCollapsed(key),
  }));
  const body = el('div', { class: 'group__body' });
  for (const { dm, user } of rows) {
    body.appendChild(conversationRow({
      id: dm.id,
      label: user.displayName,
      subtitle: user.deleted ? 'Deleted account' : 'Not a friend',
      leading: avatar(user, { size: 'sm' }),
      unread: store.unreadFor(dm.id),
      onOpen: () => openConversation(dm.id),
      onContext: (event) => openUserMenu(pointAnchor(event.clientX, event.clientY), user, { groups: [] }),
    }));
  }
  section.appendChild(body);
  scrollHost.appendChild(section);
}

function openFriendMenu(anchor, friend) {
  openPopover(anchor, [
    menuLabel(friend.displayName),
    menuItem({ label: 'Message', iconName: 'dm', onSelect: () => openDm(friend.id) }),
    menuSeparator(),
    menuItem({
      label: 'Remove friend',
      iconName: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `Remove ${friend.displayName}?`,
          message: 'You will both drop off each other\'s friend lists. Your conversation stays.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (ok) removeFriend(friend.id);
      },
    }),
  ], { placement: 'bottom-start' });
}

/** Nudge toward creating or joining a space when there are none. */
function renderNoSpacesPrompt() {
  if (store.guilds.size > 0 || store.filter) return;
  scrollHost.appendChild(el('div', { class: 'group' },
    groupHead({ name: 'Spaces', count: 0, collapsed: false, onToggle: () => {} }),
    el('div', { class: 'sidebar__empty', style: { padding: '8px 16px 4px' } },
      'Spaces hold channels for a whole group.',
      el('div', { style: { marginTop: '10px', display: 'flex', gap: '6px' } },
        el('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: showCreateServer }, 'Create'),
        el('button', { class: 'btn btn--sm', type: 'button', onClick: showJoinServer }, 'Join'),
        el('button', { class: 'btn btn--sm', type: 'button', onClick: () => showDiscover() }, 'Discover')))));
}

/**
 * Spaces as a horizontal strip of tiles across the top of the sidebar — avatar
 * above, name beneath, the open one underlined. Reads left-to-right like tabs
 * rather than a vertical icon column, and the name is always visible so nobody
 * has to memorise colours. Ctrl+B drops the names for a compact strip.
 */
function renderSpaceList() {
  clear(listHost);
  const compact = Boolean(store.ui.spacesCollapsed);
  listHost.classList.toggle('is-compact', compact);

  const currentId = store.guild(store.view.guildId)
    ? store.view.guildId
    : [...store.guilds.keys()][0];

  const strip = el('div', { class: 'spacebar__strip' });
  const rail = store.ui.sidebarLayout === 'rail';
  const railTile = (name, iconName, onClick, { badge = 0, active = false, cls = '' } = {}) => {
    const t = el('button', { class: `spacetile spacetile--rail${active ? ' is-current' : ''} ${cls}`.trim(), type: 'button', title: name, 'aria-label': name, onClick });
    const face = el('span', { class: 'spacetile__face spacetile__face--icon' }, icon(iconName));
    if (badge > 0) face.appendChild(el('span', { class: 'spacetile__badge' }, badge > 99 ? '99+' : String(badge)));
    t.append(face, el('span', { class: 'spacetile__name' }, name));
    return t;
  };
  if (rail) {
    const dmUnread = store.dmTotals().unread + store.incoming.size;
    strip.appendChild(railTile('Friends', 'chat', () => setMode('friends'), { badge: dmUnread, active: store.ui.sidebarMode === 'friends' }));
    if (store.server?.steam) strip.appendChild(railTile('Steam', 'steam', () => { void import('./steamstore.js').then((m) => m.showSteamStore()); }));
    strip.appendChild(railTile('Cards', 'layers', () => { void import('./cards.js').then((m) => m.showCards()); }));
    strip.appendChild(el('div', { class: 'spacebar__divider' }));
  }
  const currentGuildActive = store.ui.sidebarMode !== 'friends';

  // The official Voxara space always sits first.
  const ordered = [...store.guilds.values()].sort((a, b) => Number(Boolean(b.official)) - Number(Boolean(a.official)));
  for (const guild of ordered) {
    const isCurrent = guild.id === currentId;
    const totals = store.guildUnread(guild.id);
    const iconUrl = mediaUrl(guild.iconUrl);

    const tile = el('button', {
      // The space colour drives the tile's marker, so it stays meaningful even
      // once a picture is uploaded — otherwise it only ever showed as the
      // fallback nobody sees.
      class: `spacetile${isCurrent && currentGuildActive ? ' is-current' : ''}${guild.official ? ' spacetile--official' : ''}`,
      style: { '--space-color': guild.iconColor },
      type: 'button',
      title: guild.official ? `${guild.name} (official Voxara space)` : guild.name,
      'aria-current': isCurrent && currentGuildActive ? 'true' : null,
      onClick: () => { if (rail && store.ui.sidebarMode === 'friends') setMode('spaces'); openGuild(guild.id); },
      onContextMenu: (event) => {
        event.preventDefault();
        openGuildMenu(pointAnchor(event.clientX, event.clientY), guild);
      },
    });

    const face = el('span', {
      class: 'spacetile__face',
      style: iconUrl ? { backgroundImage: `url("${iconUrl}")` } : { background: guild.iconColor },
    }, iconUrl ? null : initialsOf(guild.name));

    if (totals.mentions > 0) {
      face.appendChild(el('span', { class: 'spacetile__badge' },
        totals.mentions > 99 ? '99+' : String(totals.mentions)));
    } else if (totals.unread > 0) {
      face.appendChild(el('span', { class: 'spacetile__dot', 'aria-label': 'Unread messages' }));
    }
    if (guild.official) face.appendChild(el('span', { class: 'spacetile__official', title: 'Official Voxara space' }, icon('check')));
    tile.appendChild(face);
    tile.appendChild(el('span', { class: 'spacetile__name' }, guild.name));
    strip.appendChild(tile);
  }

  // No create/join tiles here: they would be the first thing scrolled out of
  // reach. The + and compass in the sidebar header do that job and never move.
  if (rail) {
    strip.appendChild(el('div', { class: 'spacebar__divider' }));
    strip.appendChild(railTile('New space', 'plus', () => showCreateServer()));
    strip.appendChild(railTile('Join', 'compass', () => showJoinServer()));
    strip.appendChild(railTile('Discovery', 'globe', () => showDiscover()));
    strip.appendChild(railTile(store.ui.spacesCollapsed ? 'Names' : 'Icons only', store.ui.spacesCollapsed ? 'list' : 'minus', () => document.getElementById('sidebarCompact')?.click(), { cls: 'spacetile--dim' }));
  }

  listHost.appendChild(strip);
}

/** Up to two initials, for a space with no uploaded icon. */
function initialsOf(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}

/** The banner across the top of the channel list, with the icon overlapping. */
function renderSpaceHead(guild) {
  clear(spaceHead);
  spaceHead.hidden = false;

  const bannerUrl = mediaUrl(guild.bannerUrl);
  const iconUrl = mediaUrl(guild.iconUrl);

  const banner = el('div', {
    class: `spacehead__banner${bannerUrl ? '' : ' is-plain'}`,
    style: bannerUrl
      ? { backgroundImage: `url("${bannerUrl}")` }
      : { background: `linear-gradient(135deg, ${guild.iconColor}, transparent)` },
  });
  // Owners and space managers get a pencil in the corner to change the picture
  // and banner without hunting through settings.
  if (canConfigureSpace(guild)) {
    banner.appendChild(el('button', {
      class: 'spacehead__edit',
      type: 'button',
      title: 'Change space picture & banner',
      'aria-label': 'Change space picture and banner',
      onClick: (event) => {
        event.stopPropagation();
        showSpaceSettings(guild.id).select('overview');
      },
    }, icon('pencil')));
  }
  spaceHead.appendChild(banner);

  const bar = el('button', {
    class: 'spacehead__bar',
    type: 'button',
    title: 'Space options',
    'aria-label': `${guild.name} — space options`,
    onClick: (event) => openGuildMenu(event.currentTarget, guild),
    onContextMenu: (event) => {
      event.preventDefault();
      openGuildMenu(pointAnchor(event.clientX, event.clientY), guild);
    },
  });

  bar.appendChild(el('span', {
    class: 'spacehead__icon',
    style: iconUrl ? { backgroundImage: `url("${iconUrl}")` } : { background: guild.iconColor },
  }, iconUrl ? null : initialsOf(guild.name)));

  bar.appendChild(el('span', { class: 'spacehead__text' },
    el('span', { class: 'spacehead__name' }, guild.name, guild.official ? officialBadge() : null),
    el('span', { class: 'spacehead__meta' },
      (() => { const n = guild.memberIds.filter((id) => !store.user(id)?.webhook).length; return `${n} member${n === 1 ? '' : 's'}`; })())));

  const chev = el('span', { class: 'spacehead__chev' }, icon('settings'));
  bar.appendChild(chev);
  spaceHead.appendChild(bar);
}

function renderGuildGroup(guild, { soloView = false } = {}) {
  // Channels the member cannot view are not shown at all, same as the server
  // refusing them; the owner and anyone with an allow overwrite still see them.
  const channels = guild.channels.filter((c) => matches(c.name) && channelPermission(guild, c, 'viewChannel'));
  const guildMatches = matches(guild.name);

  // While filtering, keep a space only if it or one of its channels matches.
  if (store.filter && channels.length === 0 && !guildMatches) return;
  const visible = store.filter && channels.length === 0 ? guild.channels : channels;

  const key = `guild:${guild.id}`;
  const collapsed = !soloView && isCollapsed(key) && !store.filter;
  const totals = store.guildUnread(guild.id);
  const isCurrent = store.view.guildId === guild.id;

  const section = el('div', {
    class: `group${collapsed ? ' is-collapsed' : ''}${isCurrent ? ' is-current' : ''}`,
  });

  if (!soloView) section.appendChild(groupHead({
    key,
    name: guild.name,
    chipColor: guild.iconColor,
    chipUrl: mediaUrl(guild.iconUrl),
    count: guild.channels.length,
    badge: totals.unread,
    collapsed,
    onToggle: () => toggleCollapsed(key),
    onMenu: (anchor) => openGuildMenu(anchor, guild),
    action: {
      title: 'Space options',
      iconName: 'settings',
      onSelect: (anchor) => openGuildMenu(anchor, guild),
    },
  }));

  const body = el('div', { class: 'group__body' });
  const owner = canManage(guild, 'manageChannels');

  const channelRow = (channel) => (channel.type === 'voice'
    ? voiceChannelGroup(guild, channel)
    : conversationRow({
      id: channel.id,
      label: channel.name,
      leading: channel.type === 'forum'
        ? el('span', { class: 'row__forumicon', 'aria-hidden': 'true' }, icon('layers'))
        : el('span', { class: 'row__hash', 'aria-hidden': 'true' }, '#'),
      unread: store.unreadFor(channel.id),
      mentions: store.mentionsFor(channel.id),
      onOpen: () => openConversation(channel.id, { guildId: guild.id }),
      onMenu: (anchor) => openChannelMenu(anchor, guild, channel),
    }));

  if (soloView) {
    // Channels sit under their category, in the order the owner arranged them.
    const categories = guild.categories?.length ? guild.categories : [{ id: null, name: 'Channels' }];
    const placed = new Set();

    for (const category of categories) {
      const inCategory = visible.filter((c) => c.categoryId === category.id);
      for (const c of inCategory) placed.add(c.id);
      const catKey = `cat:${guild.id}:${category.id}`;
      const catCollapsed = isCollapsed(catKey) && !store.filter;

      body.appendChild(categoryHead({
        guild, category, owner, collapsed: catCollapsed, count: inCategory.length, key: catKey,
      }));
      if (catCollapsed) continue;
      for (const channel of inCategory) body.appendChild(channelRow(channel));
    }

    // A channel whose category was removed underneath it still has to appear.
    const orphans = visible.filter((c) => !placed.has(c.id));
    if (orphans.length) {
      body.appendChild(categoryHead({
        guild, category: { id: null, name: 'Uncategorised' }, owner, collapsed: false,
        count: orphans.length, key: `cat:${guild.id}:none`,
      }));
      for (const channel of orphans) body.appendChild(channelRow(channel));
    }
  } else {
    for (const channel of visible) body.appendChild(channelRow(channel));
  }

  if (visible.length === 0) {
    body.appendChild(el('div', { class: 'sidebar__empty', style: { padding: '8px 16px 4px' } },
      'No channels yet.',
      owner
        ? el('div', { style: { marginTop: '8px' } },
          el('button', {
            class: 'btn btn--sm',
            type: 'button',
            onClick: () => showCreateChannel(guild, guild.categories[0]?.id),
          }, 'New channel'))
        : null));
  }

  section.appendChild(body);
  scrollHost.appendChild(section);
}

/** A category heading: collapsible, with add and right-click management. */
function categoryHead({ guild, category, owner, collapsed, count, key, onMenu, onDropFriend }) {
  const head = el('div', {
    class: `cathead${collapsed ? ' is-collapsed' : ''}`,
    onContextMenu: (owner && category.id)
      ? (event) => {
        event.preventDefault();
        if (onMenu) onMenu(event);
        else openCategoryMenu(pointAnchor(event.clientX, event.clientY), guild, category);
      }
      : null,
  });

  head.appendChild(el('button', {
    class: 'cathead__toggle',
    type: 'button',
    'aria-expanded': String(!collapsed),
    title: collapsed ? 'Expand' : 'Collapse',
    onClick: () => toggleCollapsed(key),
  }, el('span', { class: 'cathead__caret' }, icon('chevron-down')), el('span', {}, category.name)));

  if (onDropFriend) {
    const isFriendDrag = (event) => [...(event.dataTransfer?.types || [])].includes('text/pulse-friend');
    head.addEventListener('dragover', (event) => {
      if (!isFriendDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      head.classList.add('is-droptarget');
    });
    head.addEventListener('dragleave', () => head.classList.remove('is-droptarget'));
    head.addEventListener('drop', (event) => {
      if (!isFriendDrag(event)) return;
      event.preventDefault();
      head.classList.remove('is-droptarget');
      const userId = event.dataTransfer.getData('text/pulse-friend');
      if (userId) onDropFriend(userId);
    });
  }

  head.appendChild(el('span', { class: 'cathead__count' }, String(count)));

  if (owner && guild) {
    head.appendChild(el('button', {
      class: 'cathead__add',
      type: 'button',
      title: 'New channel here',
      'aria-label': `New channel in ${category.name}`,
      onClick: () => showCreateChannel(guild, category.id),
    }, icon('plus')));
  }
  return head;
}

// A voice channel: click the row to connect, and everyone currently in it is
// listed underneath. Joining is handled by the call layer.
function voiceChannelGroup(guild, channel) {
  const connected = store.voiceUsers(channel.id);
  const mine = currentVoiceChannel() === channel.id;

  const row = el('button', {
    class: `row row--voice${mine ? ' is-connected' : ''}`,
    type: 'button',
    title: mine ? 'Open voice controls' : `Join ${channel.name}`,
    dataset: { channelId: channel.id },
    onClick: () => { startVoiceChannel(channel.id, channel.name); void openConversation(channel.id, { guildId: channel.guildId, chat: true }); },
    onContextmenu: (event) => { event.preventDefault(); openChannelMenu(row, guild, channel); },
  },
    el('span', { class: 'row__mark' }, icon('speaker')),
    el('span', { class: 'row__label' }, channel.name),
    connected.length ? el('span', { class: 'row__voicecount' }, String(connected.length)) : null,
    // Quick disconnect right on the row — no floating call widget any more
    // to leave from, so this needs to not require opening the full call.
    mine ? el('span', {
      class: 'row__action row__voiceleave', role: 'button', tabindex: '-1', title: 'Disconnect',
      onClick: (event) => { event.stopPropagation(); leaveVoiceChannel(channel.id); },
    }, icon('phone')) : null,
    el('span', {
      class: 'row__action', role: 'button', tabindex: '-1', title: 'Channel options',
      onClick: (event) => { event.stopPropagation(); openChannelMenu(row, guild, channel); },
    }, icon('settings')));

  // With moveMembers you can drag anyone (yourself included) from one voice
  // channel's list and drop them on another voice channel's row.
  const canMove = canManage(guild, 'moveMembers');
  if (canMove) {
    row.addEventListener('dragover', (event) => {
      if (![...event.dataTransfer.types].includes('text/pulse-voice-user')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', (event) => {
      row.classList.remove('is-drop-target');
      const userId = event.dataTransfer.getData('text/pulse-voice-user');
      if (!userId) return;
      event.preventDefault();
      if (connected.includes(userId)) return; // already here
      moveVoiceMember(channel.id, userId);
    });
  }

  const wrap = el('div', { class: 'voicechan' }, row);
  if (connected.length) {
    const list = el('div', { class: 'voicechan__members' });
    for (const uid of connected) {
      const u = store.user(uid) || { id: uid, displayName: 'Someone' };
      const av = avatar(u, { size: 'sm', status: false });
      av.dataset.voiceUid = uid;
      const color = roleColor(guild, uid);
      const open = () => showUserPopover(member, uid, { placement: 'right-start', guild });
      const member = el('div', {
        class: 'voicechan__member', role: 'button', tabindex: '0',
        title: uid === store.selfId ? 'You' : (u.displayName || 'Someone'),
        onClick: (event) => { event.stopPropagation(); open(); },
        onKeydown: (event) => { if (event.key === 'Enter') open(); },
        onContextmenu: (event) => {
          event.preventDefault(); event.stopPropagation();
          openVoiceMemberMenu(pointAnchor(event.clientX, event.clientY), { guild, channel, userId: uid });
        },
      },
      av,
      el('span', { class: 'voicechan__name', ...(color ? { style: { color } } : {}) }, uid === store.selfId ? 'You' : (u.displayName || 'Someone')),
      store.isSharing(channel.id, uid) ? el('span', {
        class: 'voicechan__live', role: 'button', tabindex: '-1',
        title: uid === store.selfId ? 'You are sharing your screen' : `Watch ${u.displayName || 'their'} screen`,
        onClick: (event) => { event.stopPropagation(); watchStream(channel.id, uid); },
      }, icon('screen-share'), 'LIVE') : null);
      if (canMove) {
        member.draggable = true;
        member.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('text/pulse-voice-user', uid);
          event.dataTransfer.effectAllowed = 'move';
          member.classList.add('is-dragging');
        });
        member.addEventListener('dragend', () => member.classList.remove('is-dragging'));
      }
      list.appendChild(member);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

// `unread` marks the row (bold name, dot); `mentions` is the red number. DMs
// pass no `mentions`, so every unread DM counts, the way a ping does.
function conversationRow({ id, label, leading, unread, mentions, onOpen, onMenu, onContext, subtitle }) {
  const pings = mentions === undefined ? unread : mentions;
  const isActive = store.view.channelId === id;

  const row = el('button', {
    class: `row${isActive ? ' is-active' : ''}${unread > 0 ? ' has-unread' : ''}`,
    type: 'button',
    dataset: { channelId: id },
    title: label,
    onClick: onOpen,
    // `onContext` gets the event so its menu can open at the pointer; the
    // older `onMenu` form anchors to the row.
    onContextmenu: (onContext || onMenu)
      ? (event) => {
        event.preventDefault();
        if (onContext) onContext(event);
        else onMenu(row);
      }
      : null,
  });

  row.appendChild(leading.classList?.contains('row__hash')
    ? leading
    : el('span', { class: 'row__mark' }, leading));
  // A subtitle (e.g. a friend's now-playing game) stacks under the name.
  if (subtitle) {
    row.classList.add('row--stacked');
    row.appendChild(el('span', { class: 'row__stack' },
      el('span', { class: 'row__label' }, label),
      el('span', { class: 'row__sub' }, subtitle)));
  } else {
    row.appendChild(el('span', { class: 'row__label' }, label));
  }

  if (pings > 0) {
    row.appendChild(el('span', { class: 'row__badge' }, pings > 99 ? '99+' : String(pings)));
  } else if (unread > 0) {
    row.appendChild(el('span', { class: 'row__dot', 'aria-label': 'Unread' }));
  }
  if (onMenu) {
    row.appendChild(el('span', {
      class: 'row__action',
      role: 'button',
      tabindex: '-1',
      title: 'Channel options',
      onClick: (event) => {
        event.stopPropagation();
        onMenu(row);
      },
    }, icon('settings')));
  }
  return row;
}

// ------------------------------------------------------------------ userbar

export function renderUserbar() {
  const self = store.self;
  if (!self) return;
  const me = store.user(self.id) || self;

  const host = document.getElementById('userbarAvatar');
  const fresh = avatar(me, { size: 'sm' });
  fresh.id = 'userbarAvatar';
  host.replaceWith(fresh);

  document.getElementById('userbarName').textContent = self.displayName;
  document.getElementById('userbarSub').textContent =
    self.customStatus || STATUS_LABEL[self.status] || 'Online';
}

async function signOut() {
  const ok = await confirmDialog({
    title: 'Sign out?',
    message: 'You will need your username and password to get back in.',
    confirmLabel: 'Sign out',
  });
  if (!ok) return;

  try {
    await net.request('auth:logout', {});
  } catch {
    // Signing out locally matters more than the server acknowledging it.
  }
  net.disconnect();
  setSettings({ token: null, mediaToken: null });
  // Nothing typed but unsent should outlive the sign-in on a shared computer.
  try { localStorage.removeItem('voxara:drafts'); } catch { /* storage blocked */ }
  // A reload is the cleanest way to drop every subscription and cached view.
  window.location.reload();
}

function statusRow(value, label, description) {
  const selected = store.self?.status === value;
  return el('button', {
    class: 'menu-item',
    type: 'button',
    onClick: async () => {
      closePopover();
      try {
        await updateProfile({ status: value });
      } catch (err) {
        toastError(err.message);
      }
    },
  },
  el('span', {
    style: {
      width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto',
      background: STATUS_COLOR[value],
    },
  }),
  el('span', {},
    el('strong', { style: { display: 'block', fontWeight: '650' } }, label),
    el('span', { style: { fontSize: '11px', color: 'var(--text-faint)' } }, description)),
  selected ? el('span', { class: 'menu-item__hint' }, '✓') : null);
}

function openStatusMenu() {
  const anchor = document.getElementById('userbarMe');
  openPopover(anchor, [
    menuLabel(store.self?.displayName || 'You'),
    statusRow('online', 'Online', 'Available and reachable'),
    statusRow('idle', 'Idle', 'Around, but not at the keyboard'),
    statusRow('dnd', 'Do not disturb', 'No desktop notifications'),
    statusRow('invisible', 'Invisible', 'Appear offline to everyone'),
    menuSeparator(),
    menuItem({
      label: store.self?.customStatus ? 'Edit custom status' : 'Set a custom status',
      iconName: 'pencil',
      onSelect: () => showSettings('profile'),
    }),
    menuItem({ label: 'Settings', iconName: 'settings', hint: 'Ctrl ,', onSelect: () => showSettings() }),
  ], { placement: 'top-start' });
}
