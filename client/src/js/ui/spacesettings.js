import { el, clear, initials } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { AUTOMOD_PACKS } from './automodpacks.js';
import { showCategoryModal, showCategoryPermissions, submitButton, cancelButton } from './modals.js';
import { mediaUrl } from '../client.js';
import {
  updateGuild, uploadSpaceImage, deleteGuild, leaveGuild,
  createChannel, updateChannel, deleteChannel, reorderChannels,
  kickMember, resetInvite, inviteLink, openDm, renameCategory, deleteCategory, reorderCategories, setSpaceNotifyLevel, moveChannelToCategory,  banMember, unbanMember, fetchBans, fetchAudit, createRole, updateRole, deleteRole, reorderRoles, setMemberRoles, fetchModReports, resolveModReport, copyToClipboard, setAutomodWords,
  addSpaceEmoji, deleteSpaceEmoji,
  setVerification, setAntiRaid, setLockdown, timeoutMember, modDeleteMessage,
  fetchNotes, addNote, deleteNote, fetchAppeals, resolveAppeal,
  listTasks, addTask, toggleTask, deleteTask} from '../actions.js';
import { openSettingsShell, section, choiceRow, toggleRow} from './settingsshell.js';
import { confirmDialog, openPopover, openModal, menuItem } from './overlay.js';
import { avatar, labelledField, textInput, editableImage, AVATAR_COLORS } from './bits.js';
import { toastSuccess, toastError } from './toast.js';
import { fileToJpegDataUrl, fileToPngDataUrl, fileToRawDataUrl, AVATAR_SPEC, BANNER_SPEC } from '../imagepick.js';

const CREATED_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

// Mirrors the server's MOD_PERMISSIONS — any one of these (or ownership) makes
// someone a moderator who can see the Moderation section.
const MOD_PERMISSIONS = ['manageChannels', 'manageMessages', 'kickMembers', 'banMembers', 'moveMembers', 'manageSpace', 'manageRoles'];

/** Everything about one space, grouped the way people go looking for it. */
// Who may open the settings cog: the owner, or anyone with a management
// permission from a role. Plain members cannot.
const CONFIGURE_PERMS = ['manageSpace', 'manageChannels', 'manageRoles', 'manageMessages', 'kickMembers', 'banMembers', 'moveMembers'];
export function canConfigureSpace(guild) {
  if (!guild) return false;
  if (guild.ownerId === store.selfId) return true;
  return CONFIGURE_PERMS.some((perm) => canManage(guild, perm));
}

/** Mirrors the server's rule: the owner passes everything, else any role grants it. */
export function canManage(guild, permission) {
  if (!guild) return false;
  if (guild.ownerId === store.selfId) return true;
  const ids = (guild.memberRoles || {})[store.selfId] || [];
  return (guild.roles || []).some((r) => ids.includes(r.id) && r.permissions?.[permission] === true);
}

/**
 * Whether a member may do `permission` in one channel, mirroring the
 * server's resolveChannelPermission so the UI shows what the server will
 * actually allow: base grant (@everyone or a held role) -> category
 * overwrite -> channel overwrite, everyone's overwrite first and a role
 * allow beating a role deny at the same tier. The owner bypasses all of it.
 */
export function channelPermission(guild, channel, permission, userId = store.selfId) {
  if (!guild || !channel) return false;
  // Age-restricted content is a hard line the server enforces too: nobody
  // under 18 sees an 18+ space or channel, whatever their roles.
  if (permission === 'viewChannel' && userId === store.selfId && !store.self?.adult) {
    if (guild.adult) return false;
    const gate = channel.type === 'thread' ? (guild.channels || []).find((c) => c.id === channel.parentChannelId) : channel;
    if (gate?.nsfw) return false;
  }
  if (guild.ownerId === userId) return true;
  if (channel.type === 'thread') {
    const parent = (guild.channels || []).find((c) => c.id === channel.parentChannelId);
    if (!parent) return false;
    channel = parent;
  }
  const roleIds = (guild.memberRoles || {})[userId] || [];
  const held = (guild.roles || []).filter((r) => roleIds.includes(r.id));
  const everyone = guild.everyoneRole?.permissions;
  let allowed = (everyone ? everyone[permission] === true : true) || held.some((r) => r.permissions?.[permission] === true);
  const tier = (overwrites) => {
    if (!overwrites) return;
    const ev = overwrites.everyone;
    if (ev?.deny?.includes(permission)) allowed = false;
    if (ev?.allow?.includes(permission)) allowed = true;
    let roleDeny = false; let roleAllow = false;
    for (const id of roleIds) {
      const ow = overwrites[id];
      if (ow?.deny?.includes(permission)) roleDeny = true;
      if (ow?.allow?.includes(permission)) roleAllow = true;
    }
    if (roleAllow) allowed = true; else if (roleDeny) allowed = false;
  };
  const category = channel.categoryId ? (guild.categories || []).find((c) => c.id === channel.categoryId) : null;
  if (category) tier(category.permissionOverwrites);
  tier(channel.permissionOverwrites);
  return allowed;
}

/** The colour someone's name should show in this space: from their highest
 * role that has a colour set, or null for the plain text colour. */
export function roleColor(guild, userId) {
  if (!guild) return null;
  return rolesOf(guild, userId).find((r) => r.color)?.color || null;
}

/** Every role held by someone, highest first. */
export function rolesOf(guild, userId) {
  const ids = (guild.memberRoles || {})[userId] || [];
  return (guild.roles || [])
    .filter((r) => ids.includes(r.id))
    .sort((a, b) => b.position - a.position);
}

export function showSpaceSettings(guildId, initial = 'overview') {
  const isOwner = () => store.guild(guildId)?.ownerId === store.selfId;
  // The cog is for people who can edit the space; the entry points are hidden
  // from everyone else, and this is the backstop.
  if (!canConfigureSpace(store.guild(guildId))) return { select() {}, close() {} };
  const guildNow = store.guild(guildId);
  // Owner, or anyone whose roles grant a moderation permission — mirrors the
  // server's canModerate. Only they see the Moderation section.
  const canModerate = isOwner()
    || MOD_PERMISSIONS.some((p) => canManage(guildNow, p));

  // Grouped by what you came to do, not by which server field it touches.
  // Channels and categories are one job, so they are one pane.
  const groups = [
    { group: 'Space', items: [
      { id: 'overview', label: 'Overview', icon: 'info', desc: 'Name, picture and details' },
      { id: 'channels', label: 'Channels', icon: 'hash', desc: 'Channels and categories' },
      { id: 'emoji', label: 'Emoji', icon: 'smile', desc: 'Custom emoji for this space' },
      { id: 'tasks', label: 'Tasks', icon: 'check', desc: 'A shared to-do board' },
      { id: 'notifications', label: 'Notifications', icon: 'bell', desc: 'Alerts for this space' },
    ] },
    { group: 'People', items: [
      { id: 'members', label: 'Members', icon: 'users', desc: 'Everyone in this space' },
      { id: 'roles', label: 'Roles', icon: 'tag', desc: 'Roles and permissions' },
      { id: 'invite', label: 'Invite', icon: 'link', desc: 'Bring people in' },
    ] },
    ...(canModerate ? [{ group: 'Moderation', items: [
      { id: 'reports', label: 'Reports', icon: 'flag', desc: 'Reports from members' },
      { id: 'safety', label: 'Safety', icon: 'shield', desc: 'Verification, raid protection, lockdown' },
      { id: 'automod', label: 'Automod', icon: 'shield', desc: 'Block words automatically' },
      { id: 'bans', label: 'Bans', icon: 'ban', desc: 'Banned people' },
      { id: 'appeals', label: 'Appeals', icon: 'flag', desc: 'Ban appeals to review' },
      { id: 'audit', label: 'Log', icon: 'list', desc: 'Recent moderation actions' },
    ] }] : []),
    { group: '', items: [
      { id: 'advanced', label: 'Advanced', icon: 'sliders', desc: 'Space ID and facts' },
      { id: 'danger',
        label: isOwner() ? 'Delete space' : 'Leave space',
        icon: isOwner() ? 'trash' : 'exit',
        danger: true,
        desc: isOwner() ? 'Remove this space for everyone' : 'Leave this space' },
    ] },
  ];

  const shell = openSettingsShell({
    title: 'Space settings',
    subtitle: store.guild(guildId)?.name || '',
    groups,
    initial,
    panes: {
      overview: (pane, handle, ctx) => overviewPane(guildId, pane, handle, ctx),
      channels: (pane, handle, ctx) => channelsPane(guildId, pane, handle, ctx),
      emoji: (pane, handle, ctx) => emojiPane(guildId, pane, handle, ctx),
      tasks: (pane, handle, ctx) => tasksPane(guildId, pane, handle, ctx),
      roles: (pane, handle, ctx) => rolesPane(guildId, pane, handle, ctx),
      notifications: (pane, handle, ctx) => notificationsPane(guildId, pane, handle, ctx),
      members: (pane, handle, ctx) => membersPane(guildId, pane, handle, ctx),
      invite: (pane, handle, ctx) => invitePane(guildId, pane, handle, ctx),
      reports: (pane, handle, ctx) => reportsPane(guildId, pane, handle, ctx),
      safety: (pane, handle, ctx) => safetyPane(guildId, pane, handle, ctx),
      automod: (pane, handle) => automodPane(guildId, pane, handle),
      bans: (pane, handle, ctx) => bansPane(guildId, pane, handle, ctx),
      appeals: (pane, handle, ctx) => appealsPane(guildId, pane, handle, ctx),
      audit: (pane, handle) => auditPane(guildId, pane, handle),
      advanced: (pane, handle) => advancedPane(guildId, pane, handle),
      danger: (pane, handle) => dangerPane(guildId, pane, handle),
    },
  });

  // Keep the open pane truthful if someone else changes the space.
  const off = store.on('guilds', () => {
    if (!store.guild(guildId)) shell.handle.close();
  });
  const originalClose = shell.handle.close;
  shell.handle.close = (...args) => {
    off();
    return originalClose.apply(shell.handle, args);
  };

  return shell;
}

// ----------------------------------------------------------------- overview

function overviewPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const owner = guild.ownerId === store.selfId;

  const name = textInput({ id: 'spaceName', value: guild.name, maxLength: 48 });
  const description = el('textarea', {
    class: 'field__input field__textarea',
    id: 'spaceDescription',
    rows: 2,
    maxlength: 200,
    placeholder: 'What is this space for?',
    value: guild.description || '',
  });
  name.disabled = !owner;
  description.disabled = !owner;

  async function applyImage(kind, file) {
    handle.setError('');
    try {
      const spec = kind === 'banner' ? BANNER_SPEC : AVATAR_SPEC;
      const dataUrl = file
        ? (file.type === 'image/gif' ? await fileToRawDataUrl(file, 8 * 1024 * 1024) : await fileToJpegDataUrl(file, spec, guild.iconColor))
        : null;
      await uploadSpaceImage(guildId, dataUrl, kind);
      ctx.refresh();
      toastSuccess(file
        ? (kind === 'banner' ? 'Space banner updated.' : 'Space picture updated.')
        : (kind === 'banner' ? 'Space banner removed.' : 'Space picture removed.'));
    } catch (err) {
      handle.setError(err.message);
    }
  }

  const bannerArt = owner
    ? editableImage({
      shape: 'wide',
      url: mediaUrl(guild.bannerUrl),
      fallback: el('div', {
        class: 'editable__fill',
        style: { background: `linear-gradient(135deg, ${guild.iconColor}, transparent)` },
      }),
      label: 'space banner',
      onPick: (file) => applyImage('banner', file),
      onRemove: guild.bannerUrl ? () => applyImage('banner', null) : null,
    })
    : el('div', { class: 'editable editable--wide' },
      guild.bannerUrl
        ? el('img', { class: 'editable__img', src: mediaUrl(guild.bannerUrl), alt: '' })
        : el('div', {
          class: 'editable__fill',
          style: { background: `linear-gradient(135deg, ${guild.iconColor}, transparent)` },
        }));

  const art = owner
    ? editableImage({
      shape: 'square',
      url: mediaUrl(guild.iconUrl),
      fallback: el('div', {
        class: 'editable__fill editable__initials',
        style: { background: guild.iconColor },
      }, initials(guild.name)),
      label: 'space picture',
      onPick: (file) => applyImage('icon', file),
      onRemove: guild.iconUrl ? () => applyImage('icon', null) : null,
    })
    : el('div', { class: 'editable editable--square' },
      guild.iconUrl
        ? el('img', { class: 'editable__img', src: mediaUrl(guild.iconUrl), alt: '' })
        : el('div', {
          class: 'editable__fill editable__initials',
          style: { background: guild.iconColor },
        }, initials(guild.name)));

  // A live preview of how the space appears in the sidebar: the banner with
  // the picture overlapping it, both edited by the pencil on the image itself.
  art.classList.add('space-preview__icon');
  const picture = el('div', { class: 'space-preview' },
    bannerArt,
    el('div', { class: 'space-preview__inner' },
      art,
      el('div', { class: 'space-preview__text' },
        el('span', { class: 'space-preview__name' }, guild.name),
        el('span', { class: 'space-preview__meta' },
          `${guild.memberIds.length} member${guild.memberIds.length === 1 ? '' : 's'}`))));

  const swatches = el('div', { class: 'swatches' });
  let chosenColor = guild.iconColor;
  for (const color of AVATAR_COLORS) {
    const swatch = el('button', {
      class: `swatch${color === chosenColor ? ' is-selected' : ''}`,
      type: 'button',
      style: { background: color },
      title: color,
      'aria-label': `Space colour ${color}`,
      disabled: !owner,
      onClick: () => {
        chosenColor = color;
        for (const node of swatches.children) node.classList.remove('is-selected');
        swatch.classList.add('is-selected');
      },
    });
    swatches.appendChild(swatch);
  }

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save changes');
  save.addEventListener('click', async () => {
    handle.setError('');
    if (!name.value.trim()) return handle.setError('A space needs a name.');
    save.classList.add('is-busy');
    try {
      await updateGuild(guildId, {
        name: name.value.trim(),
        description: description.value.trim(),
        iconColor: chosenColor,
      });
      toastSuccess('Space updated.');
      ctx.refresh();
    } catch (err) {
      handle.setError(err.message);
    } finally {
      save.classList.remove('is-busy');
    }
  });

  pane.append(
    section('Picture',
      picture,
      el('p', { class: 'field__hint' },
        owner
          ? 'Click a pencil to change the banner or the space picture. '
            + 'The picture is what identifies this space in your list.'
          : 'You do not have permission to change these.')),
    section('Details',
      labelledField({ id: 'spaceName', label: 'Space name', input: name }),
      labelledField({
        id: 'spaceDescription',
        label: 'Description',
        hint: 'Shown to members. 200 characters maximum.',
        input: description,
      })),
    section('Colour', swatches,
      el('p', { class: 'field__hint' }, 'Marks this space in your list, and stands in for the picture when there is none.')),
    section('Facts',
      el('dl', { class: 'facts' },
        el('dt', {}, 'Owner'), el('dd', {}, store.userName(guild.ownerId)),
        el('dt', {}, 'Members'), el('dd', {}, String(guild.memberIds.length)),
        el('dt', {}, 'Channels'), el('dd', {}, String(guild.channels.length)),
        el('dt', {}, 'Created'), el('dd', {}, CREATED_FMT.format(new Date(guild.createdAt || Date.now()))),
      )),
    owner ? el('div', { class: 'settings__actions' }, save) : null,
  );
}

// ------------------------------------------------------------------ channels

function channelsPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const owner = canManage(guild, 'manageChannels');
  const list = el('div', { class: 'manage-list' });

  async function move(index, delta) {
    const ids = guild.channels.map((c) => c.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await reorderChannels(guildId, ids);
      ctx.refresh();
    } catch (err) {
      handle.setError(err.message);
    }
  }

  guild.channels.forEach((channel, index) => {
    const nameInput = textInput({ id: `chan-${channel.id}`, value: channel.name, maxLength: 32 });
    const topicInput = textInput({
      id: `topic-${channel.id}`, value: channel.topic || '', maxLength: 200, placeholder: 'Topic (optional)',
    });
    nameInput.disabled = !owner;
    topicInput.disabled = !owner;

    // Which category a channel sits under is part of managing channels, so it
    // belongs on the row rather than only in a right-click menu.
    const categoryPicker = el('select', {
      class: 'field__input field__input--select',
      'aria-label': `Category for ${channel.name}`,
      disabled: !owner,
      onChange: async (event) => {
        try {
          await moveChannelToCategory(channel.id, event.target.value);
          ctx.refresh();
        } catch (err) {
          handle.setError(err.message);
        }
      },
    }, ...(guild.categories || []).map((c) => el('option', {
      value: c.id,
      selected: c.id === channel.categoryId ? '' : null,
    }, c.name)));

    const row = el('div', { class: 'manage-row' },
      el('span', { class: 'manage-row__hash' }, '#'),
      el('div', { class: 'manage-row__fields' }, nameInput, topicInput, categoryPicker),
      owner
        ? el('div', { class: 'manage-row__actions' },
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Move up', 'aria-label': 'Move up',
            disabled: index === 0,
            onClick: () => move(index, -1),
          }, icon('arrow-up')),
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Move down', 'aria-label': 'Move down',
            disabled: index === guild.channels.length - 1,
            onClick: () => move(index, 1),
          }, icon('arrow-down')),
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Save channel', 'aria-label': 'Save channel',
            onClick: async () => {
              handle.setError('');
              try {
                await updateChannel(channel.id, {
                  name: nameInput.value.trim(),
                  topic: topicInput.value.trim(),
                });
                toastSuccess('Channel updated.');
                ctx.refresh();
              } catch (err) {
                handle.setError(err.message);
              }
            },
          }, icon('check')),
          el('button', {
            class: 'icon-btn icon-btn--danger', type: 'button', title: 'Delete channel',
            'aria-label': 'Delete channel',
            onClick: async () => {
              const ok = await confirmDialog({
                title: `Delete #${channel.name}?`,
                message: 'Every message in this channel goes with it. This cannot be undone.',
                confirmLabel: 'Delete channel',
                danger: true,
              });
              if (!ok) return;
              try {
                await deleteChannel(channel.id);
                ctx.refresh();
              } catch (err) {
                handle.setError(err.message);
              }
            },
          }, icon('trash')))
        : null);
    list.appendChild(row);
  });

  const newName = textInput({ id: 'newChan', placeholder: 'new-channel', maxLength: 32 });
  const add = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Add channel');
  add.addEventListener('click', async () => {
    handle.setError('');
    if (!newName.value.trim()) return handle.setError('Give the channel a name.');
    try {
      await createChannel(guildId, newName.value.trim());
      newName.value = '';
      ctx.refresh();
    } catch (err) {
      handle.setError(err.message);
    }
  });

  pane.append(
    section(`Channels — ${guild.channels.length}`, list),
    owner
      ? section('Add a channel',
        el('div', { class: 'inline-form' }, newName, add),
        el('p', { class: 'field__hint' }, 'Names can include spaces, letters, numbers and emoji.'))
      : el('p', { class: 'field__hint' }, 'Only the space owner can change channels.'),
  );
  // Categories are part of arranging channels, so they share this screen
  // rather than hiding behind a separate tab.
  categoriesPane(guildId, pane, handle, ctx);
}

// ------------------------------------------------------------------- members

/** Create, rename, reorder and delete the categories channels live in. */
function categoriesPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const owner = canManage(guild, 'manageChannels');
  const categories = guild.categories || [];

  const countIn = (id) => guild.channels.filter((c) => c.categoryId === id).length;

  async function move(index, delta) {
    const ids = categories.map((c) => c.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await reorderCategories(guildId, ids);
      ctx.refresh();
    } catch (err) {
      handle.setError(err.message);
    }
  }

  const list = el('div', { class: 'manage-list' });

  categories.forEach((category, index) => {
    const nameInput = textInput({ id: `cat-${category.id}`, value: category.name, maxLength: 32 });
    nameInput.disabled = !owner;

    const save = async () => {
      const value = nameInput.value.trim();
      if (!value || value === category.name) {
        nameInput.value = category.name;
        return;
      }
      try {
        await renameCategory(guildId, category.id, value);
        ctx.refresh();
      } catch (err) {
        handle.setError(err.message);
      }
    };
    nameInput.addEventListener('blur', save);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); nameInput.blur(); }
    });

    const count = countIn(category.id);
    list.appendChild(el('div', { class: 'manage-row' },
      el('div', { class: 'manage-row__fields' },
        nameInput,
        el('p', { class: 'field__hint' },
          `${count} channel${count === 1 ? '' : 's'}`)),
      owner
        ? el('div', { class: 'manage-row__actions' },
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Permissions', 'aria-label': `Permissions for ${category.name}`,
            onClick: () => showCategoryPermissions(guild, category),
          }, icon('shield')),
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Move up', 'aria-label': 'Move up',
            disabled: index === 0,
            onClick: () => move(index, -1),
          }, icon('arrow-up')),
          el('button', {
            class: 'icon-btn', type: 'button', title: 'Move down', 'aria-label': 'Move down',
            disabled: index === categories.length - 1,
            onClick: () => move(index, 1),
          }, icon('arrow-down')),
          el('button', {
            class: 'icon-btn icon-btn--danger',
            type: 'button',
            title: categories.length <= 1 ? 'A space needs one category' : 'Delete category',
            'aria-label': 'Delete category',
            disabled: categories.length <= 1,
            onClick: async () => {
              const ok = await confirmDialog({
                title: `Delete ${category.name}?`,
                message: count
                  ? `Its ${count} channel${count === 1 ? '' : 's'} are kept and moved into the category above.`
                  : 'This category is empty.',
                confirmLabel: 'Delete',
                danger: true,
              });
              if (!ok) return;
              await deleteCategory(guildId, category.id);
              ctx.refresh();
            },
          }, icon('trash')))
        : null));
  });

  pane.appendChild(section('Categories',
    el('p', { class: 'field__hint' },
      owner
        ? 'Channels are grouped under these. Deleting one keeps its channels.'
        : 'You do not have permission to change these.'),
    list,
    owner
      ? el('button', {
        class: 'btn btn--sm',
        type: 'button',
        onClick: () => showCategoryModal(guild),
      }, 'New category')
      : null));
}

/** How loudly this one space is allowed to interrupt you. */
function notificationsPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;

  const stored = (store.ui.spaceNotify || {})[guildId] || 'inherit';
  const globalLabel = { all: 'every message', mentions: 'mentions only', none: 'nothing' }[store.ui.notifications];

  pane.appendChild(section('Notifications for this space',
    el('p', { class: 'field__hint' },
      `Your overall setting is ${globalLabel}. This space can differ.`),
    choiceRow([
      { value: 'inherit', label: 'Use my overall setting' },
      { value: 'all', label: 'Every message' },
      { value: 'mentions', label: 'Only @mentions' },
      { value: 'none', label: 'Nothing — mute' },
    ], stored, (value) => {
      setSpaceNotifyLevel(guildId, value);
      ctx.refresh();
    })));

  pane.appendChild(section('What this affects',
    el('p', { class: 'field__hint' },
      'Desktop notifications and taskbar flashing only. Unread marks still appear '
      + 'in the sidebar, so a muted space is quiet rather than hidden.')));
}

const PERMISSION_LABELS = {
  manageChannels: ['Manage channels', 'Create, edit and delete channels and categories'],
  manageMessages: ['Manage messages', 'Pin messages and delete anyone\'s messages'],
  kickMembers: ['Remove members', 'Kick people out of the space'],
  banMembers: ['Ban members', 'Ban people and lift bans'],
  moveMembers: ['Move members', 'Move people between voice channels and disconnect them'],
  manageSpace: ['Manage the space', 'Change the name, pictures and invite'],
  manageRoles: ['Manage roles', 'Create roles and assign them'],
};

/** The base set every member gets from @everyone — overridable per channel
 * or category (see the Permissions section on a channel/category's editor). */
const BASE_PERMISSION_LABELS = {
  viewChannel: ['See channels', 'Can see and read channels by default'],
  sendMessages: ['Send messages', 'Can post in text channels by default'],
  attachFiles: ['Attach files', 'Can attach files and images by default'],
  addReactions: ['Add reactions', 'Can react to messages by default'],
  connect: ['Join voice channels', 'Can join voice channels by default'],
};

const ROLE_COLORS = ['#5b6cff', '#22cc88', '#e9724c', '#a866dc', '#e8b93b', '#39b8d6', '#e0576f', '#8b93a7'];

/** See, create and edit the roles that grant permissions. */
function rolesPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const mayManage = canManage(guild, 'manageRoles');
  // Highest rank first — this is also the order the member list groups
  // hoisted roles in, which is the whole point of being able to drag them.
  const roles = (guild.roles || []).slice().sort((a, b) => b.position - a.position);

  const countFor = (roleId) =>
    Object.values(guild.memberRoles || {}).filter((ids) => ids.includes(roleId)).length;

  const list = el('div', { class: 'rolelist' });
  let dragId = null;

  function renderRows() {
    clear(list);
    for (const role of roles) {
      const card = el('button', {
        class: 'rolecard',
        type: 'button',
        disabled: !mayManage,
        onClick: () => showRoleEditor(guildId, role, ctx),
        onDragStart: (event) => {
          dragId = role.id;
          event.dataTransfer.effectAllowed = 'move';
          card.classList.add('is-dragging');
        },
        onDragEnd: () => card.classList.remove('is-dragging'),
        onDragOver: (event) => {
          if (!dragId || dragId === role.id) return;
          event.preventDefault();
          card.classList.add('is-dragover');
        },
        onDragLeave: () => card.classList.remove('is-dragover'),
        onDrop: async (event) => {
          event.preventDefault();
          card.classList.remove('is-dragover');
          const from = roles.findIndex((r) => r.id === dragId);
          const to = roles.findIndex((r) => r.id === role.id);
          dragId = null;
          if (from === -1 || to === -1 || from === to) return;
          const [moved] = roles.splice(from, 1);
          roles.splice(to, 0, moved);
          renderRows();
          const ok = await reorderRoles(guildId, roles.map((r) => r.id));
          if (!ok) ctx.refresh();
        },
      },
      mayManage ? el('span', { class: 'rolecard__grip' }, icon('grip')) : null,
      el('span', { class: 'rolecard__dot', style: { background: role.color } }),
      el('span', { class: 'rolecard__body' },
        el('span', { class: 'rolecard__name' }, role.name),
        el('span', { class: 'rolecard__meta' },
          `${countFor(role.id)} member${countFor(role.id) === 1 ? '' : 's'} · `
          + `${Object.values(role.permissions || {}).filter(Boolean).length} permission`
          + `${Object.values(role.permissions || {}).filter(Boolean).length === 1 ? '' : 's'}`)),
      mayManage ? el('span', { class: 'rolecard__go' }, icon('pencil')) : null);
      // draggable is a boolean IDL property, not a reflected attribute — el()'s
      // generic prop handling would stringify it wrong, so it's set directly.
      card.draggable = mayManage;
      list.appendChild(card);
    }

    // @everyone always sits last — it's the lowest rank, isn't stored in
    // guild.roles, can't be dragged or deleted, but its permissions are
    // still what every member starts with before any role or overwrite.
    const everyone = guild.everyoneRole?.permissions || {};
    const everyoneCount = Object.values(everyone).filter(Boolean).length;
    const everyoneCard = el('button', {
      class: 'rolecard',
      type: 'button',
      disabled: !mayManage,
      onClick: () => showEveryoneEditor(guildId, ctx),
    },
    el('span', { class: 'rolecard__dot', style: { background: '#8b93a7' } }),
    el('span', { class: 'rolecard__body' },
      el('span', { class: 'rolecard__name' }, '@everyone'),
      el('span', { class: 'rolecard__meta' },
        `Every member · ${everyoneCount} default permission${everyoneCount === 1 ? '' : 's'}`)),
    mayManage ? el('span', { class: 'rolecard__go' }, icon('pencil')) : null);
    list.appendChild(everyoneCard);
  }
  renderRows();

  pane.appendChild(section('Roles',
    el('p', { class: 'field__hint' },
      mayManage
        ? 'A role is a name, a colour and a set of permissions. Someone gets a permission if any of their roles grants it. Drag to reorder — higher roles outrank lower ones, and hoisted roles group the member list in this order.'
        : 'These are the roles in this space. You do not have permission to change them.'),
    list,
    mayManage
      ? el('button', {
        class: 'btn btn--sm',
        type: 'button',
        onClick: () => showRoleEditor(guildId, null, ctx),
      }, 'New role')
      : null));
}

/** Create or edit one role: name, colour, permissions. */
function showRoleEditor(guildId, role, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const creating = !role;
  const name = textInput({ id: 'roleName', value: role?.name || '', maxLength: 32, placeholder: 'Moderator' });
  let color = role?.color || ROLE_COLORS[0];
  let hoist = role?.hoist === true;
  const permissions = { ...(role?.permissions || {}) };

  const swatches = el('div', { class: 'swatches' }, ...ROLE_COLORS.map((value) => {
    const dot = el('button', {
      class: `swatch${value === color ? ' is-current' : ''}`,
      type: 'button',
      style: { background: value },
      title: value,
      'aria-label': `Colour ${value}`,
      onClick: () => {
        color = value;
        for (const node of swatches.children) node.classList.remove('is-current');
        dot.classList.add('is-current');
      },
    });
    return dot;
  }));

  const perms = el('div', { class: 'permlist' }, ...Object.entries(PERMISSION_LABELS).map(([key, [label, hint]]) =>
    toggleRow({
      label,
      hint,
      value: permissions[key] === true,
      onChange: (value) => { permissions[key] = value; },
    })));

  const handle = openModal({
    title: creating ? 'New role' : `Edit ${role.name}`,
    subtitle: guild.name,
    wide: true,
    body: [
      labelledField({ id: 'roleName', label: 'Role name', input: name }),
      el('p', { class: 'field__label' }, 'Colour'),
      swatches,
      el('p', { class: 'field__label', style: { marginTop: '14px' } }, 'Display'),
      toggleRow({
        label: 'Display role members separately',
        hint: 'Members with this role get their own group at the top of the member list.',
        value: hoist,
        onChange: (value) => { hoist = value; },
      }),
      el('p', { class: 'field__label', style: { marginTop: '14px' } }, 'Permissions'),
      perms,
    ],
    initialFocus: '#roleName',
  });

  const save = submitButton(creating ? 'Create role' : 'Save role', handle, async () => {
    const value = name.value.trim();
    if (!value) throw new Error('Give the role a name.');
    const done = creating
      ? await createRole(guildId, value, color, permissions, hoist)
      : await updateRole(guildId, role.id, { name: value, color, permissions, hoist });
    if (!done) return;
    handle.close();
    ctx.refresh();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    !creating
      ? el('button', {
        class: 'btn btn--ghost btn--danger-quiet',
        type: 'button',
        onClick: async () => {
          const ok = await confirmDialog({
            title: `Delete ${role.name}?`,
            message: 'Everyone holding it loses the permissions it granted.',
            confirmLabel: 'Delete role',
            danger: true,
          });
          if (!ok) return;
          if (await deleteRole(guildId, role.id)) {
            handle.close();
            ctx.refresh();
          }
        },
      }, 'Delete')
      : null,
    cancelButton(handle),
    save));
}

/** @everyone isn't a real role — no name, colour or hoist, and it can never
 * be deleted — just the base permissions every member starts with. */
function showEveryoneEditor(guildId, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const base = guild.everyoneRole?.permissions || {};
  const permissions = { ...base };

  const perms = el('div', { class: 'permlist' }, ...Object.entries(BASE_PERMISSION_LABELS).map(([key, [label, hint]]) =>
    toggleRow({
      label,
      hint,
      value: permissions[key] === true,
      onChange: (value) => { permissions[key] = value; },
    })));

  const handle = openModal({
    title: '@everyone',
    subtitle: guild.name,
    body: [
      el('p', { class: 'field__hint' },
        'What every member can do by default, space-wide. A channel or category can still override any of these.'),
      perms,
    ],
  });

  const save = submitButton('Save', handle, async () => {
    const done = await updateRole(guildId, 'everyone', { permissions });
    if (!done) return;
    handle.close();
    ctx.refresh();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), save));
}

function membersPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const owner = guild.ownerId === store.selfId;
  const mayRoles = canManage(guild, 'manageRoles');
  const mayKick = canManage(guild, 'kickMembers');
  const mayBan = canManage(guild, 'banMembers');
  const mayNote = MOD_PERMISSIONS.some((p) => canManage(guild, p));
  const list = el('div', { class: 'manage-list' });

  const members = guild.memberIds
    .map((id) => store.user(id))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.id === guild.ownerId) return -1;
      if (b.id === guild.ownerId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

  for (const member of members) {
    const isOwnerRow = member.id === guild.ownerId;
    const isSelf = member.id === store.selfId;

    list.appendChild(el('div', { class: 'manage-row manage-row--member' },
      avatar(member, { size: 'sm' }),
      el('div', { class: 'manage-row__who' },
        el('span', { class: 'manage-row__name' }, member.displayName),
        el('span', { class: 'manage-row__handle' }, `@${member.username}`)),
      el('div', { class: 'rolechips' },
        isOwnerRow
          ? el('span', { class: 'role-tag role-tag--owner' }, 'Owner')
          : null,
        ...rolesOf(guild, member.id).map((role) => el('span', {
          class: 'role-tag',
          style: { color: role.color, borderColor: role.color },
        }, role.name)),
        (!isOwnerRow && rolesOf(guild, member.id).length === 0)
          ? el('span', { class: 'role-tag role-tag--plain' }, 'Member')
          : null),
      el('div', { class: 'manage-row__actions' },
        mayNote
          ? el('button', {
            class: 'icon-btn',
            type: 'button',
            title: `Notes on ${member.displayName}`,
            'aria-label': `Moderator notes on ${member.displayName}`,
            onClick: () => showMemberNotes(guildId, member),
          }, icon('pencil'))
          : null,
        mayRoles
          ? el('button', {
            class: 'icon-btn',
            type: 'button',
            title: `Roles for ${member.displayName}`,
            'aria-label': `Roles for ${member.displayName}`,
            onClick: (event) => openRolePicker(event.currentTarget, guildId, member, ctx),
          }, icon('user'))
          : null,
        mayBan && !isOwnerRow && !isSelf
          ? el('button', {
            class: 'icon-btn icon-btn--danger',
            type: 'button',
            title: `Ban ${member.displayName}`,
            'aria-label': `Ban ${member.displayName}`,
            onClick: async () => {
              const ok = await confirmDialog({
                title: `Ban ${member.displayName}?`,
                message: 'They are removed and cannot rejoin, even with the invite link. '
                  + 'You can lift this from the Bans list.',
                confirmLabel: 'Ban',
                danger: true,
              });
              if (!ok) return;
              await banMember(guildId, member.id);
              ctx.refresh();
            },
          }, icon('minus'))
          : null,
        !isSelf && store.isFriend(member.id)
          ? el('button', {
            class: 'icon-btn', type: 'button', title: 'Message', 'aria-label': 'Message',
            onClick: () => {
              handle.close();
              openDm(member.id);
            },
          }, icon('dm'))
          : null,
        mayKick && !isOwnerRow && !isSelf
          ? el('button', {
            class: 'icon-btn icon-btn--danger', type: 'button',
            title: `Remove ${member.displayName}`, 'aria-label': `Remove ${member.displayName}`,
            onClick: async () => {
              const ok = await confirmDialog({
                title: `Remove ${member.displayName}?`,
                message: 'They lose access to this space and need a new invite to return.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!ok) return;
              try {
                await kickMember(guildId, member.id);
                toastSuccess(`${member.displayName} was removed.`);
                ctx.refresh();
              } catch (err) {
                handle.setError(err.message);
              }
            },
          }, icon('exit'))
          : null)));
  }

  pane.append(
    section(`Members — ${members.length}`, list),
    el('p', { class: 'field__hint' },
      owner
        ? 'You own this space, so you can remove anyone and delete any message.'
        : 'Only the space owner can remove members.'),
  );
}

// Private moderator notes about one member.
function showMemberNotes(guildId, member) {
  const list = el('div', { class: 'notes-list' }, el('p', { class: 'field__hint' }, 'Loading…'));
  const input = el('textarea', { class: 'field__input field__textarea', rows: 2, placeholder: `Private note about ${member.displayName}…` });
  const add = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Add note');

  const draw = async () => {
    const { notes, users } = await fetchNotes(guildId, member.id);
    list.replaceChildren();
    if (!notes.length) { list.append(el('p', { class: 'field__hint' }, 'No notes yet.')); return; }
    for (const n of notes) {
      const by = users[n.by]?.displayName || 'A moderator';
      list.append(el('div', { class: 'note-item' },
        el('div', { class: 'note-item__text' }, n.text),
        el('div', { class: 'note-item__meta' },
          el('span', {}, `${by} · ${new Date(n.at).toLocaleDateString()}`),
          el('button', {
            class: 'note-item__del', type: 'button', title: 'Delete note', 'aria-label': 'Delete note',
            onClick: async () => { await deleteNote(guildId, member.id, n.id); draw(); },
          }, icon('trash')))));
    }
  };
  draw();

  add.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    add.classList.add('is-busy');
    const note = await addNote(guildId, member.id, text);
    add.classList.remove('is-busy');
    if (note) { input.value = ''; draw(); }
  });

  const done = el('button', { class: 'btn', type: 'button' }, 'Done');
  const modal = openModal({
    title: `Notes · ${member.displayName}`,
    subtitle: 'Only moderators can see these',
    body: el('div', { class: 'notes' }, list, input, el('div', { class: 'settings__actions' }, add)),
    actions: [done],
  });
  done.addEventListener('click', () => modal.close());
}

// -------------------------------------------------------------------- invite

/** Everyone refused re-entry, with a way to lift it. */
function bansPane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;

  const list = el('div', { class: 'manage-list' }, el('p', { class: 'field__hint' }, 'Loading…'));
  pane.appendChild(section('Banned accounts', list));

  void (async () => {
    const { bans, users, records = {} } = await fetchBans(guildId);
    list.replaceChildren();
    if (!bans.length) {
      list.appendChild(el('p', { class: 'field__hint' }, 'Nobody is banned from this space.'));
      return;
    }
    for (const id of bans) {
      const who = users[id] || { displayName: 'Unknown account', username: 'unknown', id };
      const rec = records[id];
      const meta = [];
      if (rec?.reason) meta.push(rec.reason);
      if (rec?.appeal) meta.push(rec.appeal.status === 'pending' ? '· appeal pending' : '· appeal dismissed');
      list.appendChild(el('div', { class: 'manage-row manage-row--member' },
        avatar(who, { size: 'sm' }),
        el('div', { class: 'manage-row__who' },
          el('span', { class: 'manage-row__name' }, who.displayName),
          el('span', { class: 'manage-row__handle' },
            meta.length ? meta.join(' ') : `@${who.username}`)),
        el('div', { class: 'manage-row__actions' },
          el('button', {
            class: 'btn btn--sm',
            type: 'button',
            onClick: async () => {
              await unbanMember(guildId, id);
              ctx.refresh();
            },
          }, 'Lift ban'))));
    }
  })();
}

// ---- Safety: verification level, raid protection, lockdown ----
function safetyPane(guildId, pane) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const canEdit = canManage(guild, 'manageSpace');
  const canLock = canManage(guild, 'kickMembers');

  pane.append(section('Verification level',
    canEdit
      ? choiceRow([
          { value: 'none', label: 'None', hint: 'Anyone can post' },
          { value: 'low', label: 'Low', hint: 'Account 10+ min old' },
          { value: 'medium', label: 'Medium', hint: 'Account 5+ days old' },
          { value: 'high', label: 'High', hint: '10 min in this space' },
        ], guild.verification || 'none', (v) => setVerification(guildId, v))
      : el('p', { class: 'field__hint' }, `Currently: ${guild.verification || 'none'}`),
    el('p', { class: 'field__hint' },
      'How settled an account must be before it can post here. Moderators are always exempt.'),
  ));

  const ar = guild.antiRaid || { enabled: false, threshold: 5, windowSec: 15 };
  const threshold = el('input', { class: 'field__input', type: 'number', value: String(ar.threshold), min: '3', max: '50' });
  const windowSec = el('input', { class: 'field__input', type: 'number', value: String(ar.windowSec), min: '5', max: '120' });
  const controls = el('div', { class: 'safety__raid', hidden: !ar.enabled },
    labelledField({ id: 'raidThreshold', label: 'Joins to trigger', input: threshold }),
    labelledField({ id: 'raidWindow', label: 'Within (seconds)', input: windowSec }),
    el('div', { class: 'settings__actions' },
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onClick: () => setAntiRaid(guildId, { enabled: true, threshold: Number(threshold.value), windowSec: Number(windowSec.value) }),
      }, 'Save')));
  pane.append(section('Raid protection',
    canEdit
      ? toggleRow({
          label: 'Auto-lockdown on a join spike',
          hint: 'Freeze posting automatically when many accounts join at once.',
          value: ar.enabled,
          onChange: (v) => { controls.hidden = !v; setAntiRaid(guildId, { enabled: v, threshold: Number(threshold.value), windowSec: Number(windowSec.value) }); },
        })
      : el('p', { class: 'field__hint' }, ar.enabled ? 'On' : 'Off'),
    controls,
  ));

  if (canEdit) {
    pane.append(section('Previews',
      toggleRow({
        label: 'Allow previews before joining',
        hint: 'Let people peek at this space read-only before they commit to joining.',
        value: guild.allowPeek !== false,
        onChange: (v) => updateGuild(guildId, { allowPeek: v }),
      }),
      toggleRow({
        label: 'Adults only (18+)',
        hint: 'Members must be 18 or over. Under-18s cannot join, and existing under-18 members lose access until they are 18. Where the server requires it, members verify once with a credit card (never a photo or ID). Everyone is told before they enter.',
        value: Boolean(guild.adult),
        onChange: (v) => updateGuild(guildId, { adult: v }).catch((err) => toastError(err.message || 'Could not change that.')),
      }),
      toggleRow({
        label: 'Publish to Space Discovery',
        hint: 'Lists this space in the app (Join a space, Browse public spaces) and on voxaraspace.com/discover: the name, member and online counts, description and the invite. Anyone can join from there. Turn off any time.',
        value: Boolean(guild.discoverable),
        onChange: (v) => updateGuild(guildId, { discoverable: v }),
      })));
  }

  if (canLock) {
    const active = guild.lockdown?.active;
    pane.append(section('Lockdown',
      el('p', { class: 'field__hint' }, active
        ? 'Lockdown is ON — only moderators can post right now.'
        : 'Instantly freeze posting for everyone but moderators — e.g. during a raid.'),
      el('div', { class: 'settings__actions' },
        el('button', {
          class: `btn btn--sm${active ? ' btn--danger' : ''}`, type: 'button',
          onClick: async () => { await setLockdown(guildId, !active); },
        }, active ? 'Lift lockdown' : 'Lock down now')),
    ));
  }
}

// ---- Ban appeals waiting for review ----
function appealsPane(guildId, pane) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const list = el('div', { class: 'manage-list' }, el('p', { class: 'field__hint' }, 'Loading…'));
  pane.append(section('Ban appeals', list));

  const draw = async () => {
    const { appeals, users } = await fetchAppeals(guildId);
    list.replaceChildren();
    const pending = appeals.filter((a) => a.appeal.status === 'pending');
    if (!pending.length) {
      list.append(el('p', { class: 'field__hint' }, 'No appeals waiting for review.'));
      return;
    }
    for (const a of pending) {
      const who = users[a.userId] || { displayName: 'Unknown account', username: 'unknown', id: a.userId };
      list.append(el('div', { class: 'appeal-row' },
        el('div', { class: 'appeal-row__head' },
          avatar(who, { size: 'sm' }),
          el('div', { class: 'manage-row__who' },
            el('span', { class: 'manage-row__name' }, who.displayName),
            el('span', { class: 'manage-row__handle' }, a.reason ? `Banned for: ${a.reason}` : `@${who.username}`))),
        el('p', { class: 'appeal-row__text' }, a.appeal.text),
        el('div', { class: 'settings__actions' },
          el('button', {
            class: 'btn btn--sm', type: 'button',
            onClick: async () => { await resolveAppeal(guildId, a.userId, 'dismiss'); draw(); },
          }, 'Dismiss'),
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button',
            onClick: async () => { await resolveAppeal(guildId, a.userId, 'accept'); toastSuccess('Appeal accepted — ban lifted.'); draw(); },
          }, 'Accept & unban')),
      ));
    }
  };
  draw();
}

// A space's shared to-do board — any member can add and tick items.
function tasksPane(guildId, pane) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const list = el('div', { class: 'tasks-list' }, el('p', { class: 'field__hint' }, 'Loading…'));

  const draw = async () => {
    const tasks = await listTasks(guildId);
    list.replaceChildren();
    if (!tasks.length) { list.append(el('p', { class: 'field__hint' }, 'Nothing on the board yet.')); return; }
    const sorted = [...tasks].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || a.at - b.at);
    for (const t of sorted) {
      const canDelete = t.by === store.selfId || canManage(guild, 'manageMessages');
      list.append(el('div', { class: `task-row${t.done ? ' is-done' : ''}` },
        el('button', {
          class: `task-check${t.done ? ' is-done' : ''}`, type: 'button',
          'aria-label': t.done ? 'Mark not done' : 'Mark done',
          onClick: async () => { await toggleTask(guildId, t.id); draw(); },
        }, t.done ? icon('check') : null),
        el('span', { class: 'task-row__text' }, t.text),
        el('span', { class: 'task-row__by' }, store.userName(t.by)),
        canDelete ? el('button', {
          class: 'icon-btn', type: 'button', title: 'Remove task', 'aria-label': 'Remove task',
          onClick: async () => { await deleteTask(guildId, t.id); draw(); },
        }, icon('trash')) : null));
    }
  };
  draw();

  const input = textInput({ placeholder: 'Add a task…', maxlength: '300' });
  const add = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Add');
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    add.classList.add('is-busy');
    const task = await addTask(guildId, text);
    add.classList.remove('is-busy');
    if (task) { input.value = ''; draw(); }
  };
  add.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  pane.append(
    section('To-do board', list),
    section('Add a task', el('div', { class: 'task-add' }, input, add)),
    el('p', { class: 'field__hint' }, 'Everyone in the space shares this board. Tick items off as they’re done.'),
  );
}

const AUDIT_WORDS = {
  kick: 'removed',
  ban: 'banned',
  unban: 'lifted the ban on',
  promote: 'made a moderator:',
  demote: 'removed moderator from',
  timeout: 'timed out',
  untimeout: 'ended the timeout for',
  automod: 'updated the word filter',
  'roles-set': 'changed roles for',
  verification: 'set verification to',
  lockdown: 'started a lockdown',
  unlock: 'lifted the lockdown',
  appeal: 'received a ban appeal',
  'appeal-dismiss': 'dismissed the appeal from',
};

/** Who did what, so moderation is not invisible to the other moderators. */
/** Automod: a list of words that are blocked from messages in this space. */
function emojiPane(guildId, pane) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const canEdit = canManage(guild, 'manageSpace');

  const grid = el('div', { class: 'emoji-manage' });
  const drawGrid = () => {
    grid.replaceChildren();
    const list = store.guild(guildId)?.emojis || [];
    if (list.length === 0) {
      grid.appendChild(el('p', { class: 'field__hint' }, 'No custom emoji yet.'));
      return;
    }
    for (const e of list) {
      grid.appendChild(el('div', { class: 'emoji-manage__item' },
        el('img', { class: 'custom-emoji custom-emoji--lg', src: mediaUrl(e.url), alt: `:${e.name}:` }),
        el('span', { class: 'emoji-manage__name' }, `:${e.name}:`),
        canEdit ? el('button', {
          class: 'icon-btn', type: 'button', title: 'Remove', 'aria-label': `Remove :${e.name}:`,
          onClick: async () => { await deleteSpaceEmoji(guildId, e.id); },
        }, icon('trash')) : null,
      ));
    }
  };
  drawGrid();
  const off = store.on('emojis', drawGrid);
  const off2 = store.on('guilds', drawGrid);

  pane.append(section(`Custom emoji (${(guild.emojis || []).length}/100)`, grid));

  if (canEdit) {
    const name = textInput({ placeholder: 'name (letters, numbers, _)', maxlength: '32' });
    const addBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Upload emoji');
    addBtn.addEventListener('click', async () => {
      const cleaned = name.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (cleaned.length < 2) return toastError('Give the emoji a name (2–32 letters, numbers or _).');
      const input = el('input', { type: 'file', accept: 'image/png,image/gif,image/webp,image/jpeg', hidden: true });
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        addBtn.classList.add('is-busy');
        try {
          // GIFs keep animation (sent as-is if small); others are flattened to a
          // 128px PNG with transparency preserved.
          const dataUrl = file.type === 'image/gif'
            ? await fileToRawDataUrl(file, 256 * 1024)
            : await fileToPngDataUrl(file, 128);
          await addSpaceEmoji(guildId, cleaned, dataUrl);
          name.value = '';
          toastSuccess(`Added :${cleaned}:`);
        } catch (err) {
          toastError(err.message || 'Could not add that emoji.');
        } finally {
          addBtn.classList.remove('is-busy');
        }
      });
      input.click();
    });
    pane.append(section('Add an emoji',
      labelledField({ id: 'emojiName', label: 'Name', input: name }),
      el('p', { class: 'field__hint' }, 'PNG, GIF or WebP, up to 256 KB. Use it anywhere by typing :name:.'),
      el('div', { class: 'settings__actions' }, addBtn),
    ));
  }

  // Detach listeners when the pane is torn down (settingsshell clears the node).
  const observer = new MutationObserver(() => {
    if (!document.body.contains(grid)) { off(); off2(); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function automodPane(guildId, pane, handle) {
  const guild = store.guild(guildId);
  if (!guild) return;

  const words = el('textarea', {
    class: 'field__input field__textarea',
    rows: 8,
    placeholder: 'One word or phrase per line',
    value: (guild.blockedWords || []).join('\n'),
  });

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save filter');
  save.addEventListener('click', async () => {
    save.classList.add('is-busy');
    const list = words.value.split('\n').map((w) => w.trim()).filter(Boolean);
    if (await setAutomodWords(guildId, list)) toastSuccess('Word filter saved.');
    save.classList.remove('is-busy');
  });

  // Preset packs: one click seeds the list, the text box stays editable.
  const packRows = AUTOMOD_PACKS.map((pack) => {
    const btn = el('button', { class: 'btn btn--sm', type: 'button' }, 'Add pack');
    btn.addEventListener('click', () => {
      const current = words.value.split('\n').map((w) => w.trim()).filter(Boolean);
      const have = new Set(current.map((w) => w.toLowerCase()));
      const added = pack.words.filter((w) => !have.has(w));
      words.value = [...current, ...added].join('\n');
      btn.textContent = added.length ? `Added ${added.length}` : 'Already in';
      setTimeout(() => { btn.textContent = 'Add pack'; }, 1800);
    });
    return el('div', { class: 'setting-row' },
      el('div', { class: 'setting-row__text' }, el('div', { class: 'setting-row__label' }, `${pack.label} (${pack.words.length})`), el('div', { class: 'field__hint' }, pack.hint)),
      btn);
  });

  pane.append(
    section('Preset packs',
      el('p', { class: 'field__hint' }, 'Add a pack to put its words into the list below, then remove or add anything you like before saving. Packs never save on their own.'),
      ...packRows),
    section('Blocked words',
      el('p', { class: 'field__hint' },
        'Messages containing any of these are blocked when sent — whole-word, '
        + 'case-insensitive. Moderators are not affected.'),
      words,
      el('div', { class: 'settings__actions' }, save)),
  );
}

/** The queue of user/message reports raised in this space, for its moderators. */
function reportsPane(guildId, pane, handle) {
  const guild = store.guild(guildId);
  const mayTimeout = guild && canManage(guild, 'kickMembers');
  const mayBan = guild && canManage(guild, 'banMembers');
  const mayDelete = guild && canManage(guild, 'manageMessages');

  const list = el('div', { class: 'manage-list' }, el('p', { class: 'field__hint' }, 'Loading…'));
  pane.appendChild(section('Reports',
    el('p', { class: 'field__hint' },
      'People here can report a member or a message to you. Act on one and it clears from the queue.'),
    list));

  const nameOf = (users, id) => users[id]?.displayName || 'Someone';

  const refresh = async () => {
    const { reports, users } = await fetchModReports(guildId);
    render(reports, users);
  };
  void refresh();

  function render(reports, users) {
    list.replaceChildren();
    const open = reports.filter((r) => !r.handled);
    const done = reports.filter((r) => r.handled);
    if (!reports.length) {
      list.appendChild(el('p', { class: 'field__hint' }, 'No reports here. Quiet space.'));
      return;
    }
    for (const report of [...open, ...done]) {
      list.appendChild(reportRow(report, users));
    }
  }

  // Do a moderation action, then resolve the report and refresh the queue.
  const actThenResolve = async (report, fn) => {
    await fn();
    await resolveModReport(report.id);
    await refresh();
  };

  function actionButtons(report) {
    if (report.handled) return el('span', { class: 'report-row__done' }, 'Resolved');
    const buttons = [];
    if (mayDelete && report.kind === 'message' && report.channelId && report.messageId) {
      buttons.push(el('button', {
        class: 'btn btn--sm', type: 'button',
        onClick: () => actThenResolve(report, () => modDeleteMessage(report.channelId, report.messageId)),
      }, 'Delete message'));
    }
    if (mayTimeout) {
      buttons.push(el('button', {
        class: 'btn btn--sm', type: 'button',
        onClick: (event) => {
          const anchor = event.currentTarget;
          openPopover(anchor, el('div', { class: 'menu' },
            ...[['5 minutes', 300], ['1 hour', 3600], ['1 day', 86400]].map(([label, secs]) =>
              menuItem({ label, iconName: 'clock', onSelect: () => actThenResolve(report, () => timeoutMember(guildId, report.targetId, secs)) }))),
            { placement: 'bottom-start' });
        },
      }, 'Timeout'));
    }
    if (mayBan) {
      buttons.push(el('button', {
        class: 'btn btn--sm btn--danger', type: 'button',
        onClick: () => actThenResolve(report, () => banMember(guildId, report.targetId, report.reason || 'From a report')),
      }, 'Ban'));
    }
    buttons.push(el('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: () => actThenResolve(report, () => Promise.resolve()),
    }, 'Dismiss'));
    return el('div', { class: 'report-row__buttons' }, ...buttons);
  }

  function reportRow(report, users) {
    return el('div', { class: `report-row${report.handled ? ' is-resolved' : ''}` },
      el('div', { class: 'report-row__main' },
        el('div', { class: 'report-row__head' },
          el('strong', {}, nameOf(users, report.reporterId)),
          ' reported ',
          el('strong', {}, nameOf(users, report.targetId)),
          el('span', { class: 'report-row__kind' }, report.kind === 'message' ? ' · message' : ' · member')),
        report.reason ? el('div', { class: 'report-row__reason' }, report.reason) : null,
        report.content ? el('div', { class: 'report-row__quote' }, `“${report.content}”`) : null,
        el('div', { class: 'report-row__when' }, new Date(report.at).toLocaleString())),
      el('div', { class: 'report-row__actions' }, actionButtons(report)));
  }
}

function auditPane(guildId, pane) {
  const list = el('div', { class: 'manage-list' }, el('p', { class: 'field__hint' }, 'Loading…'));
  const exportBtn = el('button', { class: 'btn btn--sm', type: 'button' }, 'Copy log');
  pane.appendChild(section('Moderation log',
    el('p', { class: 'field__hint' }, 'The last 100 moderation actions in this space, newest first.'),
    list,
    el('div', { class: 'settings__actions' }, exportBtn)));

  let lines = [];
  void (async () => {
    const { entries, users } = await fetchAudit(guildId);
    list.replaceChildren();
    if (!entries.length) {
      list.appendChild(el('p', { class: 'field__hint' }, 'Nothing has been moderated here yet.'));
      exportBtn.disabled = true;
      return;
    }
    const nameOf = (id) => (id ? (users[id]?.displayName || 'Someone') : 'Auto-moderation');
    lines = entries.map((e) => [
      new Date(e.at).toISOString(),
      nameOf(e.actorId),
      AUDIT_WORDS[e.action] || e.action,
      e.targetId ? nameOf(e.targetId) : '',
      e.detail ? `— ${e.detail}` : '',
    ].filter(Boolean).join(' '));
    for (const entry of entries) {
      list.appendChild(el('div', { class: 'audit-row' },
        el('span', { class: 'audit-row__text' },
          el('strong', {}, nameOf(entry.actorId)),
          ` ${AUDIT_WORDS[entry.action] || entry.action} `,
          entry.targetId ? el('strong', {}, nameOf(entry.targetId)) : null,
          entry.detail ? el('span', { class: 'audit-row__detail' }, ` — ${entry.detail}`) : null),
        el('span', { class: 'audit-row__when' }, new Date(entry.at).toLocaleString())));
    }
  })();

  exportBtn.addEventListener('click', () => copyToClipboard(lines.join('\n'), 'Moderation log'));
}

/** Tick the roles someone holds; saves as you tick. */
function openRolePicker(anchor, guildId, member, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const roles = (guild.roles || []).slice().sort((a, b) => b.position - a.position);
  const held = new Set(((guild.memberRoles || {})[member.id] || []));

  if (!roles.length) {
    openPopover(anchor, el('div', { class: 'menu' },
      el('p', { class: 'field__hint', style: { padding: '10px 12px', margin: 0 } },
        'No roles exist yet. Create one on the Roles screen.')), { placement: 'bottom-end' });
    return;
  }

  const panel = el('div', { class: 'menu rolepicker' },
    el('div', { class: 'rolepicker__head' }, `Roles for ${member.displayName}`),
    ...roles.map((role) => el('button', {
      class: `rolepicker__item${held.has(role.id) ? ' is-on' : ''}`,
      type: 'button',
      onClick: async (event) => {
        const on = held.has(role.id);
        if (on) held.delete(role.id); else held.add(role.id);
        event.currentTarget.classList.toggle('is-on', !on);
        const saved = await setMemberRoles(guildId, member.id, [...held]);
        if (!saved) {
          // Put the tick back where it was; the server refused.
          if (on) held.add(role.id); else held.delete(role.id);
          event.currentTarget.classList.toggle('is-on', on);
          return;
        }
        ctx.refresh();
      },
    },
    el('span', { class: 'rolepicker__dot', style: { background: role.color } }),
    el('span', {}, role.name),
    el('span', { class: 'rolepicker__check' }, icon('check')))));

  openPopover(anchor, panel, { placement: 'bottom-end' });
}

function invitePane(guildId, pane, handle, ctx) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const owner = guild.ownerId === store.selfId;

  const copy = el('button', { class: 'btn btn--sm btn--primary', type: 'button' }, 'Copy');
  copy.addEventListener('click', async () => {
    const ok = await copyToClipboard(inviteLink(guild.invite), 'Invite link');
    if (ok) {
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    }
  });

  pane.append(
    section('Invite link',
      el('div', { class: 'copybox copybox--link' }, el('code', {}, inviteLink(guild.invite)), copy),
      el('p', { class: 'field__hint' },
        'Anyone with this link can join. Opening it in a browser shows a preview with a Join button; '
        + 'pasting it into the compass button at the top of the sidebar also works.')),

    owner
      ? section('Reset',
        el('p', { class: 'field__hint' },
          'Resetting issues a new link and stops the old one working. Members '
          + 'already here are unaffected.'),
        el('div', { class: 'settings__actions' },
          el('button', {
            class: 'btn btn--sm', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Reset the invite link?',
                message: 'The current link stops working immediately.',
                confirmLabel: 'Reset link',
              });
              if (!ok) return;
              try {
                await resetInvite(guildId);
                toastSuccess('New invite link issued.');
                ctx.refresh();
              } catch (err) {
                handle.setError(err.message);
              }
            },
          }, 'Reset invite link')))
      : null,
  );
}

// -------------------------------------------------------------------- danger

/** Technical details about the space — its own pane, not an inline expander. */
function advancedPane(guildId, pane) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const ownerName = store.user(guild.ownerId)?.displayName || 'Unknown';

  const idField = el('div', { class: 'copyfield' },
    el('code', { class: 'copyfield__value' }, guild.id),
    el('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: () => copyToClipboard(guild.id, 'Space ID'),
    }, 'Copy'));

  pane.append(
    section('Space ID',
      el('p', { class: 'field__hint' },
        'A stable numeric identifier for this space. Handy for support or reporting a bug.'),
      idField),
    section('Facts',
      el('div', { class: 'facts' },
        el('div', { class: 'facts__row' },
          el('span', { class: 'facts__key' }, 'Owner'), el('span', {}, ownerName)),
        el('div', { class: 'facts__row' },
          el('span', { class: 'facts__key' }, 'Members'), el('span', {}, String(guild.memberIds.length))),
        el('div', { class: 'facts__row' },
          el('span', { class: 'facts__key' }, 'Channels'), el('span', {}, String(guild.channels.length))),
        el('div', { class: 'facts__row' },
          el('span', { class: 'facts__key' }, 'Created'),
          el('span', {}, guild.createdAt ? CREATED_FMT.format(new Date(guild.createdAt)) : '—')))),
  );
}

function dangerPane(guildId, pane, handle) {
  const guild = store.guild(guildId);
  if (!guild) return;
  const owner = guild.ownerId === store.selfId;

  pane.append(owner
    ? section('Delete this space',
      el('p', { class: 'field__hint' },
        'Every channel, message and membership is removed for everyone. There is '
        + 'no undo and no export.'),
      el('div', { class: 'settings__actions' },
        el('button', {
          class: 'btn btn--danger', type: 'button',
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${guild.name}?`,
              message: 'This removes the space for every member, permanently.',
              confirmLabel: 'Delete space',
              danger: true,
            });
            if (!ok) return;
            try {
              await deleteGuild(guildId);
              handle.close();
            } catch (err) {
              handle.setError(err.message);
            }
          },
        }, 'Delete space')))
    : section('Leave this space',
      el('p', { class: 'field__hint' },
        'You will need an invite link to come back. Your messages stay.'),
      el('div', { class: 'settings__actions' },
        el('button', {
          class: 'btn btn--danger', type: 'button',
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Leave ${guild.name}?`,
              message: 'You will need an invite link to come back.',
              confirmLabel: 'Leave',
              danger: true,
            });
            if (!ok) return;
            try {
              await leaveGuild(guildId);
              handle.close();
            } catch (err) {
              handle.setError(err.message);
            }
          },
        }, 'Leave space'))));
}
