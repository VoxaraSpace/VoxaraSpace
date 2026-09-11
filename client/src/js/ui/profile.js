import { el } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { mediaUrl } from '../client.js';
import { openDm, unblockUser, setMemberRoles } from '../actions.js';
import { openPopover, closePopover, pointAnchor, openModal } from './overlay.js';
import { toggleRow } from './settingsshell.js';
import { stillUrl, avatar, STATUS_LABEL } from './bits.js';
import { openUserMenu } from './menus.js';
import { showSettings } from './settings.js';
import { userBadges } from './badges.js';
import { showGamingProfile } from './gaming.js';
const JOINED_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/** Hover-card style profile, anchored to whatever was clicked. */
export function showUserPopover(anchor, userId, { placement = 'bottom-start', guild = null } = {}) {
  const user = store.user(userId);
  if (!user) return;

  const isSelf = userId === store.selfId;
  const isFriend = store.isFriend(userId);
  const pending = [...store.outgoing.values()].some((r) => r.toId === userId);

  // Banner: uploaded art if there is any, otherwise the chosen accent colour.
  const bannerSrc = mediaUrl(user.bannerUrl);
  // Reduce-flashing shows an animated banner as its first frame.
  if (bannerSrc) void stillUrl(bannerSrc).then((u) => { if (u !== bannerSrc) banner.style.backgroundImage = `url("${u}")`; });
  const banner = el('div', {
    class: 'profile-card__banner',
    style: bannerSrc
      ? { backgroundImage: `url("${bannerSrc}")` }
      : { background: user.avatarColor },
  });

  const face = avatar(user, { size: 'lg' });
  face.classList.add('profile-card__avatar');

  // Everything except messaging lives behind the ⋯ in the corner, so the card
  // stays a card rather than a row of buttons.
  const more = el('button', {
    class: 'profile-card__more',
    type: 'button',
    title: 'More options',
    'aria-label': `More options for ${user.displayName}`,
    onClick: (event) => {
      event.stopPropagation();
      // Opening the menu closes this card, which detaches the button — so its
      // position has to be read now, while it is still on screen. Anchoring to
      // the button itself would measure a detached node and land at 0,0.
      const box = event.currentTarget.getBoundingClientRect();
      // Anchored to the button's right edge: the ⋯ sits in the top-right, so a
      // menu growing leftwards from it stays on screen without being clamped.
      openUserMenu(pointAnchor(box.right, box.bottom + 4), user, {
        groups: store.friendGroups || [],
        placement: 'bottom-end',
      });
    },
  }, icon('dots'));

  const card = el('div', { class: 'profile-card' },
    banner,
    isSelf ? null : more,
    el('div', { class: 'profile-card__inner' },
      face,
      el('div', { class: 'profile-card__name' }, user.displayName),
      (() => { const b = userBadges(user); return b.length ? el('div', { class: 'profile-card__badges' }, ...b) : null; })(),
      el('div', { class: 'profile-card__handle' }, `@${user.username}`),
      user.bio ? el('p', { class: 'profile-card__bio' }, user.bio) : null,
      user.bot && Array.isArray(user.botScopes) && user.botScopes.length ? el('p', { class: 'profile-card__bio profile-card__scopes' },
        'This bot can: ', user.botScopes.map((s) => ({ read: 'read messages', post: 'post', dm: 'send DMs', moderate: 'moderate', voice: 'manage voice', external: 'send data outside Voxara' }[s] || s)).join(', '), '.') : null,
      user.customStatus ? el('div', { class: 'profile-card__status' }, user.customStatus) : null,
      el('div', { class: 'profile-card__meta' },
        `${STATUS_LABEL[user.status] || 'Offline'} · joined ${JOINED_FMT.format(new Date(user.createdAt || Date.now()))}`),
      roleChips(guild, user),
      el('div', { class: 'profile-card__actions' }, ...actionsFor({ user, isSelf, guild })),
    ),
  );

  openPopover(anchor, card, { placement, className: 'profile-popover' });
}

/** One round icon button, the way a profile card reads at a glance. */
function cardAction({ label, iconName, danger = false, primary = false, onSelect }) {
  return el('button', {
    class: `cardaction${danger ? ' cardaction--danger' : ''}${primary ? ' cardaction--primary' : ''}`,
    type: 'button',
    title: label,
    'aria-label': label,
    onClick: onSelect,
  }, icon(iconName));
}

// The highest role position the viewer holds here (owner outranks everything).
function viewerRank(guild) {
  if (!guild) return 0;
  if (guild.ownerId === store.selfId) return Infinity;
  const ids = (guild.memberRoles || {})[store.selfId] || [];
  const held = (guild.roles || []).filter((r) => ids.includes(r.id));
  return held.length ? Math.max(...held.map((r) => r.position)) : 0;
}
function rolesHeld(guild, userId) {
  const ids = (guild.memberRoles || {})[userId] || [];
  return (guild.roles || []).filter((r) => ids.includes(r.id)).sort((a, b) => b.position - a.position);
}
function memberRank(guild, userId) {
  const ids = (guild.memberRoles || {})[userId] || [];
  const held = (guild.roles || []).filter((r) => ids.includes(r.id));
  return held.length ? Math.max(...held.map((r) => r.position)) : 0;
}
/** May the viewer assign roles to this member here? */
function canGrantRoles(guild, userId) {
  if (!guild || userId === store.selfId || guild.ownerId === userId) return false;
  const hasPerm = guild.ownerId === store.selfId
    || (guild.roles || []).some((r) => ((guild.memberRoles || {})[store.selfId] || []).includes(r.id) && r.permissions?.manageRoles === true);
  return hasPerm && viewerRank(guild) > memberRank(guild, userId);
}

/** A small modal to add or remove this member's roles (only ones below your rank). */
function showRolePicker(guild, user) {
  const ceiling = viewerRank(guild);
  const assignable = (guild.roles || [])
    .filter((r) => r.position < ceiling)
    .sort((a, b) => b.position - a.position);
  const held = new Set((guild.memberRoles || {})[user.id] || []);
  const wanted = new Set(held);

  const rows = assignable.length
    ? assignable.map((role) => toggleRow({
      label: role.name,
      value: held.has(role.id),
      onChange: (on) => { if (on) wanted.add(role.id); else wanted.delete(role.id); },
    }))
    : [el('p', { class: 'field__hint' }, 'There are no roles you can assign here.')];

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save roles');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
  const modal = openModal({ title: `Roles · ${user.displayName}`, subtitle: guild.name, body: rows, actions: [cancel, save] });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    save.disabled = true;
    // Keep any roles the member already holds above your rank (you can't touch those).
    const keepAbove = ((guild.memberRoles || {})[user.id] || []).filter((id) => {
      const r = (guild.roles || []).find((x) => x.id === id);
      return r && r.position >= ceiling;
    });
    const ok = await setMemberRoles(guild.id, user.id, [...new Set([...wanted, ...keepAbove])]);
    if (ok) modal.close(); else save.disabled = false;
  });
}

/** The member's roles as chips, with inline add/remove if you may manage them. */
function roleChips(guild, user) {
  if (!guild || user.id === store.selfId) return null;
  const held = rolesHeld(guild, user.id);
  const manage = canGrantRoles(guild, user.id);
  if (!held.length && !manage) return null;
  const ceiling = viewerRank(guild);

  const row = el('div', { class: 'profile-card__roles' });
  const setRoles = (ids) => setMemberRoles(guild.id, user.id, ids);

  for (const role of held) {
    const removable = manage && role.position < ceiling;
    const chip = el('span', { class: 'rolechip', style: { '--rc': role.color || '#8b93a7' } },
      el('span', { class: 'rolechip__dot' }),
      el('span', { class: 'rolechip__name' }, role.name),
      removable ? el('button', {
        class: 'rolechip__x', type: 'button', title: `Remove ${role.name}`, 'aria-label': `Remove ${role.name}`,
        onClick: async (e) => {
          e.stopPropagation();
          const next = rolesHeld(guild, user.id).map((r) => r.id).filter((id) => id !== role.id);
          if (await setRoles(next)) chip.remove();
        },
      }, '×') : null);
    row.append(chip);
  }

  if (manage) {
    row.append(el('button', {
      class: 'rolechip rolechip--add', type: 'button', title: 'Add a role',
      onClick: () => { closePopover(); showRolePicker(guild, user); },
    }, '+'));
  }
  return row;
}

function actionsFor({ user, isSelf, guild }) {
  const roles = canGrantRoles(guild, user.id)
    ? cardAction({
      label: 'Roles',
      iconName: 'tag',
      onSelect: () => { closePopover(); showRolePicker(guild, user); },
    })
    : null;

  const gaming = user.steamLinked && (isSelf || store.isFriend(user.id))
    ? cardAction({
      label: 'Gaming',
      iconName: 'sparkle',
      onSelect: () => {
        closePopover();
        showGamingProfile(user.id);
      },
    })
    : null;

  if (isSelf) {
    return [cardAction({
      label: 'Edit profile',
      iconName: 'pencil',
      primary: true,
      onSelect: () => {
        closePopover();
        showSettings('profile');
      },
    }), gaming].filter(Boolean);
  }

  if (store.isBlocked(user.id)) {
    return [cardAction({
      label: 'Unblock',
      iconName: 'check',
      primary: true,
      onSelect: () => {
        closePopover();
        unblockUser(user.id);
      },
    })];
  }

  return [cardAction({
    label: 'Message',
    iconName: 'dm',
    primary: true,
    onSelect: () => {
      closePopover();
      openDm(user.id);
    },
  }), roles, gaming].filter(Boolean);
}
