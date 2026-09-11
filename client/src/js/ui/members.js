import { el, clear } from '../utils.js';
import { store } from '../state.js';
import { avatar } from './bits.js';
import { showUserPopover } from './profile.js';
import { openUserMenu } from './menus.js';
import { pointAnchor } from './overlay.js';
import { roleColor } from './spacesettings.js';

const ORDER = { online: 0, idle: 1, dnd: 2, offline: 3 };

let host;

export function mountMembers() {
  host = document.getElementById('membersScroll');
  store.on('users', renderMembers);
  store.on('view', renderMembers);
  store.on('guilds', renderMembers);
  // A thread's member list is whoever has posted in it, so it grows with the messages.
  store.on('messages', ({ channelId } = {}) => { if (channelId === store.view.channelId && store.conversation()?.kind === 'thread') renderMembers(); });
  renderMembers();
}

/** The highest-positioned "display separately" role a member holds, or null. */
function hoistRoleFor(guild, member, hoistRoles) {
  const ids = (guild.memberRoles || {})[member.id] || [];
  // hoistRoles is already sorted highest-first, so the first match wins.
  return hoistRoles.find((r) => ids.includes(r.id)) || null;
}

export function renderMembers() {
  if (!host) return;
  clear(host);

  const conversation = store.conversation();
  if (!conversation || !conversation.guild) return;
  const guild = conversation.guild;
  if (conversation.kind === 'thread') { renderThreadMembers(conversation, guild); return; }
  if (conversation.kind !== 'channel') return;

  // Webhooks are members on paper (they post into a channel) but not people
  // anyone would look for in this list.
  const members = guild.memberIds
    .map((id) => store.user(id))
    .filter((u) => u && !u.webhook)
    .sort((a, b) => {
      const rank = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3);
      if (rank !== 0) return rank;
      return a.displayName.localeCompare(b.displayName);
    });

  const hoistRoles = (guild.roles || [])
    .filter((r) => r.hoist)
    .sort((a, b) => b.position - a.position);

  const online = members.filter((m) => m.status !== 'offline');
  const offline = members.filter((m) => m.status === 'offline');

  // Online members are grouped under their highest hoisted role; the rest fall
  // into a plain "Online". Offline members always sit together at the bottom.
  const grouped = new Map(hoistRoles.map((r) => [r.id, []]));
  const plainOnline = [];
  for (const member of online) {
    const role = hoistRoleFor(guild, member, hoistRoles);
    if (role) grouped.get(role.id).push(member);
    else plainOnline.push(member);
  }

  for (const role of hoistRoles) {
    const list = grouped.get(role.id);
    if (list.length) host.appendChild(group(`${role.name} — ${list.length}`, list, guild, role.color));
  }
  if (plainOnline.length) host.appendChild(group(`Online — ${plainOnline.length}`, plainOnline, guild));
  if (offline.length) host.appendChild(group(`Offline — ${offline.length}`, offline, guild));
}

/** Everyone in a thread: whoever started it plus everyone who has posted. */
function renderThreadMembers(conversation, guild) {
  const thread = store.channel(conversation.id);
  const ids = new Set();
  if (thread?.createdBy) ids.add(thread.createdBy);
  for (const m of store.messagesFor(conversation.id)) if (m.authorId) ids.add(m.authorId);
  const members = [...ids].map((id) => store.user(id)).filter(Boolean)
    .sort((a, b) => {
      const rank = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3);
      return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
    });
  host.appendChild(group(`In this thread — ${members.length}`, members, guild));
}

function group(title, members, guild, color) {
  const heading = el('h3', color ? { style: { color } } : {}, title);
  const section = el('div', { class: 'members__group' }, heading);
  for (const member of members) section.appendChild(memberRow(member, guild));
  return section;
}

function memberRow(member, guild) {
  const isOwner = guild.ownerId === member.id;
  const row = el('button', {
    class: `member${member.status === 'offline' ? ' is-offline' : ''}`,
    type: 'button',
    title: `@${member.username}`,
    onClick: () => showUserPopover(row, member.id, { placement: 'top-end', guild }),
    onContextMenu: (event) => {
      event.preventDefault();
      openUserMenu(pointAnchor(event.clientX, event.clientY), store.user(member.id), { guild });
    },
  },
  avatar(member, { size: 'sm' }),
  el('span', { class: 'member__text' },
    el('span', { class: 'member__name', ...(roleColor(guild, member.id) ? { style: { color: roleColor(guild, member.id) } } : {}) },
      member.displayName,
      member.bot ? el('span', { class: 'tag-bot' }, 'BOT') : null,
      isOwner ? el('span', { class: 'member__owner', title: 'Space owner' }, '★') : null),
    member.customStatus ? el('span', { class: 'member__sub' }, member.customStatus) : null,
  ));
  return row;
}
