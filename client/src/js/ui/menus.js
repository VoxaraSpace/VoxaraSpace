import { el } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { updateGuild, leaveGuild, deleteGuild, deleteChannel, markRead, deleteCategory, openDm, blockUser, unblockUser, copyToClipboard, moveFriendToGroup, deleteFriendGroup, removeFriend, addFriend, timeoutMember, spaceEveryoneMuted, setSpaceEveryoneMuted, kickMember, banMember, deleteMessage, kickFromVoice, moveVoiceMember, setPinned, createThread, openConversation } from '../actions.js';
import { peerAudioFor, setPeerAudio } from './call.js';
import { startEditing, startReply, openForwardPicker } from './chat.js';
import { openPopover, menuItem, menuSeparator, menuLabel, confirmDialog, openModal } from './overlay.js';
import { toastError, toastSuccess } from './toast.js';
import { showInviteModal, showChannelSettings, showChannelPermissions, showChannelWebhooks, showCreateChannel, showCategoryModal, showCategoryPermissions, showReportDialog, showFriendGroupModal, showAddFriend} from './modals.js';
import { showSpaceSettings, canManage, canConfigureSpace, rolesOf } from './spacesettings.js';

/** Context menu for a space (server), from its sidebar heading. */
export function openGuildMenu(anchor, guild, placement = 'bottom-start') {
  const isOwner = guild.ownerId === store.selfId;
  const canConfigure = canConfigureSpace(guild);

  openPopover(anchor, [
    menuLabel(guild.name),
    menuItem({
      label: 'Invite people',
      iconName: 'user',
      onSelect: () => showInviteModal(guild),
    }),
    menuItem({
      label: 'New channel',
      iconName: 'plus',
      onSelect: () => showCreateChannel(guild, guild.categories[0]?.id),
    }),
    menuItem({
      label: 'Mark space as read',
      iconName: 'check',
      onSelect: () => {
        for (const channel of guild.channels) markRead(channel.id);
      },
    }),
    menuItem({
      label: spaceEveryoneMuted(guild.id) ? 'Unmute @everyone & @here' : 'Mute @everyone & @here',
      iconName: spaceEveryoneMuted(guild.id) ? 'bell' : 'bell',
      onSelect: () => {
        setSpaceEveryoneMuted(guild.id, !spaceEveryoneMuted(guild.id));
        toastSuccess(spaceEveryoneMuted(guild.id) ? 'You won’t be pinged by @everyone or @here here.' : 'You’ll be pinged by @everyone and @here again.');
      },
    }),
    canManage(guild, 'manageChannels') ? menuSeparator() : null,
    canManage(guild, 'manageChannels') ? menuItem({
      label: 'Create category',
      iconName: 'plus',
      onSelect: () => showCategoryModal(guild),
    }) : null,
    canConfigure ? menuItem({
      label: guild.discoverable ? 'Unpublish from Space Discovery' : 'Publish to Space Discovery',
      iconName: 'compass',
      onSelect: async () => {
        try {
          await updateGuild(guild.id, { discoverable: !guild.discoverable });
          toastSuccess(guild.discoverable ? `${guild.name} is no longer listed.` : `${guild.name} is now listed in Space Discovery, in the app and on the website.`, guild.discoverable ? 'Unpublished' : 'Published');
        } catch (err) { toastError(err.message || 'Could not change that.'); }
      },
    }) : null,
    canConfigure ? menuItem({
      label: 'Change space picture',
      iconName: 'pencil',
      onSelect: () => showSpaceSettings(guild.id, 'overview'),
    }) : null,
    canConfigure ? menuItem({
      label: 'Space settings',
      iconName: 'settings',
      onSelect: () => showSpaceSettings(guild.id),
    }) : null,
    (canConfigure || isOwner) ? menuSeparator() : null,
    isOwner
      ? menuItem({
        label: 'Delete space',
        iconName: 'trash',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Delete ${guild.name}?`,
            message: 'Every channel and message in this space is removed for everyone. This cannot be undone.',
            confirmLabel: 'Delete space',
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteGuild(guild.id);
          } catch (err) {
            toastError(err.message);
          }
        },
      })
      : menuItem({
        label: 'Leave space',
        iconName: 'exit',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Leave ${guild.name}?`,
            message: 'You will need an invite link to come back.',
            confirmLabel: 'Leave',
            danger: true,
          });
          if (!ok) return;
          try {
            await leaveGuild(guild.id);
          } catch (err) {
            toastError(err.message);
          }
        },
      }),
  ].filter(Boolean), { placement });
}

/** Context menu for a single channel row. */
/** Right-click menu for a category heading. Owner-only actions. */
export function openCategoryMenu(anchor, guild, category) {
  openPopover(anchor, el('div', { class: 'menu' },
    menuItem({
      label: 'New channel here',
      iconName: 'plus',
      onSelect: () => showCreateChannel(guild, category.id),
    }),
    menuItem({
      label: 'Rename category',
      iconName: 'pencil',
      onSelect: () => showCategoryModal(guild, category),
    }),
    menuItem({
      label: 'Permissions',
      iconName: 'shield',
      onSelect: () => showCategoryPermissions(guild, category),
    }),
    menuSeparator(),
    menuItem({
      label: 'Delete category',
      iconName: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `Delete ${category.name}?`,
          message: 'Its channels are kept and moved into the category above it.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) deleteCategory(guild.id, category.id);
      },
    }),
  ), { placement: 'bottom-start' });
}

/**
 * Right-click menu for the empty area of a space's channel list — the fastest
 * way to add something without hunting for a button.
 */
export function openSpaceBackgroundMenu(anchor, guild) {
  const canChannels = canManage(guild, 'manageChannels');
  const canConfigure = canConfigureSpace(guild);
  if (!canChannels && !canConfigure) return;
  openPopover(anchor, el('div', { class: 'menu' },
    canChannels ? menuItem({
      label: 'Create channel',
      iconName: 'plus',
      onSelect: () => showCreateChannel(guild, guild.categories[0]?.id),
    }) : null,
    canChannels ? menuItem({
      label: 'Create category',
      iconName: 'plus',
      onSelect: () => showCategoryModal(guild),
    }) : null,
    (canChannels && canConfigure) ? menuSeparator() : null,
    canConfigure ? menuItem({
      label: 'Change space picture',
      iconName: 'pencil',
      onSelect: () => showSpaceSettings(guild.id, 'overview'),
    }) : null,
    canConfigure ? menuItem({
      label: 'Space settings',
      iconName: 'settings',
      onSelect: () => showSpaceSettings(guild.id),
    }) : null,
  ), { placement: 'bottom-start' });
}

/**
 * The menu for a person, available wherever they appear — a message author, a
 * member row, a friend, the profile card. `context` carries the space when
 * there is one, so moderation entries can appear.
 */
/** Client mirror of the server's canManageMember: you may only moderate
    someone you outrank (the owner outranks everyone; nobody outranks them). */
function canManageMemberLocal(guild, targetId) {
  if (!guild || targetId === store.selfId) return false;
  if (guild.ownerId === store.selfId) return true;
  if (guild.ownerId === targetId) return false;
  const rank = (id) => (rolesOf(guild, id)[0]?.position ?? -1);
  return rank(store.selfId) > rank(targetId);
}

const TIMEOUT_DURATIONS = [
  [5 * 60, '5 minutes'], [10 * 60, '10 minutes'], [60 * 60, '1 hour'],
  [6 * 60 * 60, '6 hours'], [24 * 60 * 60, '1 day'],
];

/** A small picker: choose a duration to time a member out, or lift it. */
function showTimeoutDialog(guild, user) {
  const timedOut = (guild.timeouts || {})[user.id] > Date.now();
  const buttons = el('div', { class: 'timeout-picker' },
    ...TIMEOUT_DURATIONS.map(([seconds, label]) => el('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: async () => { if (await timeoutMember(guild.id, user.id, seconds)) { toastSuccess(`${user.displayName} timed out for ${label}.`); handle.close(); } },
    }, label)));
  const foot = [];
  if (timedOut) {
    foot.push(el('button', {
      class: 'btn btn--danger', type: 'button',
      onClick: async () => { if (await timeoutMember(guild.id, user.id, 0)) { toastSuccess('Timeout removed.'); handle.close(); } },
    }, 'Remove timeout'));
  }
  foot.push(el('button', { class: 'btn', type: 'button', onClick: () => handle.close() }, 'Cancel'));
  const handle = openModal({
    title: `Time out ${user.displayName}`,
    body: el('div', {},
      el('p', { class: 'field__hint' }, 'They will not be able to post in this space until the timeout ends.'),
      buttons),
    actions: foot,
    dismissable: true,
  });
}

export function openUserMenu(anchor, user, { guild = null, groups = null, placement = 'bottom-start' } = {}) {
  if (!user) return;
  openPopover(anchor, el('div', { class: 'menu' }, ...userMenuItems(user, { guild, groups })), { placement });
}

/** Right-click on someone in a voice channel: what you hear of them, then
 * the voice-moderation actions, then the usual person menu. */
export function openVoiceMemberMenu(anchor, { guild, channel, userId }) {
  const user = store.user(userId);
  if (!user) return;
  const isSelf = userId === store.selfId;
  const items = [menuLabel(user.displayName)];
  if (!isSelf) {
    const prefs = peerAudioFor(userId);
    items.push(menuItem({
      label: prefs.muted ? 'Unmute for me' : 'Mute for me',
      iconName: prefs.muted ? 'mic' : 'mic-off',
      onSelect: () => setPeerAudio(userId, { muted: !prefs.muted }),
    }));
    items.push(volumeRow(userId, prefs));
  }
  if (guild && canManage(guild, 'moveMembers') && (isSelf || canManageMemberLocal(guild, userId))) {
    const others = (guild.channels || []).filter((c) => c.type === 'voice' && c.id !== channel.id);
    if (others.length) {
      items.push(menuSeparator(), menuLabel('Move to'));
      for (const c of others) {
        items.push(menuItem({ label: c.name, iconName: 'speaker', onSelect: () => moveVoiceMember(c.id, userId) }));
      }
    }
    if (!isSelf) {
      items.push(menuItem({
        label: 'Kick from voice',
        iconName: 'phone',
        danger: true,
        onSelect: async () => { if (await kickFromVoice(channel.id, userId)) toastSuccess(`${user.displayName} was disconnected.`); },
      }));
    }
  }
  items.push(menuSeparator(), ...userMenuItems(user, { guild }));
  openPopover(anchor, el('div', { class: 'menu' }, ...items), { placement: 'bottom-start' });
}

function volumeRow(userId, prefs) {
  const pct = Math.round(prefs.volume * 100);
  const value = el('span', { class: 'menu-slider__value' }, `${pct}%`);
  const slider = el('input', {
    class: 'menu-slider__input', type: 'range', min: '0', max: '100', step: '1', value: String(pct), 'aria-label': 'Volume',
  });
  slider.addEventListener('input', () => {
    value.textContent = `${slider.value}%`;
    setPeerAudio(userId, { volume: Number(slider.value) / 100 });
  });
  return el('div', { class: 'menu-slider', onClick: (event) => event.stopPropagation() }, icon('speaker'), slider, value);
}

function userMenuItems(user, { guild = null, groups = null } = {}) {
  const isSelf = user.id === store.selfId;
  const blocked = store.isBlocked(user.id);

  const items = [];

  if (!isSelf) {
    items.push(menuItem({
      label: 'Message',
      iconName: 'dm',
      onSelect: () => openDm(user.id),
    }));
    if (store.isFriend(user.id)) {
      items.push(menuItem({
        label: 'Remove friend',
        iconName: 'minus',
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Remove ${user.displayName}?`,
            message: 'You will both drop off each other\'s friend lists.',
            confirmLabel: 'Remove',
            danger: true,
          });
          if (ok) removeFriend(user.id);
        },
      }));
    } else if (!blocked) {
      items.push(menuItem({
        label: 'Add friend',
        iconName: 'plus',
        onSelect: () => addFriend(user.username).catch((err) => toastError(err.message)),
      }));
    }
    items.push(menuItem({
      label: 'Report user',
      iconName: 'alert',
      onSelect: () => showReportDialog({ kind: 'user', targetId: user.id, who: user.displayName }),
    }));
    // Timing out is a space-moderation action, so it only appears when this
    // menu was opened inside a space the viewer can moderate this member in.
    if (guild && canManage(guild, 'kickMembers') && canManageMemberLocal(guild, user.id)) {
      const timedOut = (guild.timeouts || {})[user.id] > Date.now();
      items.push(menuItem({
        label: timedOut ? 'Manage timeout…' : 'Time out…',
        iconName: 'ban',
        onSelect: () => showTimeoutDialog(guild, user),
      }));
      items.push(menuItem({
        label: 'Kick from space',
        iconName: 'minus',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Kick ${user.displayName}?`,
            message: `They will be removed from ${guild.name}. They can come back with a new invite.`,
            confirmLabel: 'Kick',
            danger: true,
          });
          if (!ok) return;
          try { await kickMember(guild.id, user.id); toastSuccess(`${user.displayName} was kicked.`); }
          catch (err) { toastError(err.message || 'Could not kick them.'); }
        },
      }));
    }
    if (guild && canManage(guild, 'banMembers') && canManageMemberLocal(guild, user.id)) {
      items.push(menuItem({
        label: 'Ban from space',
        iconName: 'ban',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: `Ban ${user.displayName}?`,
            message: `They will be removed from ${guild.name} and cannot rejoin with the invite. You can lift the ban later from the space's settings.`,
            confirmLabel: 'Ban',
            danger: true,
          });
          if (ok) banMember(guild.id, user.id);
        },
      }));
    }
    items.push(menuItem({
      label: blocked ? 'Unblock' : 'Block',
      iconName: 'minus',
      danger: !blocked,
      onSelect: () => (blocked ? unblockUser(user.id) : blockUser(user.id)),
    }));
    items.push(menuSeparator());
  }

  // Only friends can be filed into a category, and only where we were handed
  // the list — the same menu is used on message authors and space members.
  if (groups && store.isFriend(user.id)) {
    const current = groups.find((g) => g.memberIds.includes(user.id));
    items.push(menuLabel('Move to category'));
    for (const group of groups) {
      items.push(menuItem({
        label: group.name,
        iconName: current?.id === group.id ? 'check' : null,
        onSelect: () => moveFriendToGroup(user.id, group.id),
      }));
    }
    if (current) {
      items.push(menuItem({
        label: 'Remove from category',
        iconName: 'minus',
        onSelect: () => moveFriendToGroup(user.id, null),
      }));
    }
    items.push(menuItem({
      label: 'New category…',
      iconName: 'plus',
      onSelect: () => showFriendGroupModal(null, user.id),
    }));
    items.push(menuSeparator());
  }

  items.push(menuItem({
    label: 'Copy username',
    iconName: 'copy',
    onSelect: () => copyToClipboard(`@${user.username}`, 'Username'),
  }));
  items.push(menuItem({
    label: 'Copy user ID',
    iconName: 'copy',
    onSelect: () => copyToClipboard(user.id, 'User ID'),
  }));

  return items;
}

/** The menu for one message, from a right-click anywhere it appears. */
export function openMessageMenu(anchor, message, { guild = null } = {}) {
  const isMine = message.authorId === store.selfId;
  const author = store.user(message.authorId);
  const space = guild || store.guildOfChannel(message.channelId);
  // Same rules as the hover toolbar and the server: you edit only your own
  // messages; you delete your own anywhere, and anyone's with manageMessages.
  const canDelete = isMine || (space ? canManage(space, 'manageMessages') : false);
  const canPin = space ? canManage(space, 'manageMessages') : true;
  const items = [];

  // The same actions as the hover toolbar, so a right-click never has less.
  items.push(menuItem({ label: 'Reply', iconName: 'reply', onSelect: () => startReply(message) }));
  if (space && store.channel(message.channelId)?.type !== 'thread') {
    const hasThread = Boolean(message.threadId);
    items.push(menuItem({
      label: hasThread ? 'Open thread' : 'Reply in thread',
      iconName: 'chat',
      onSelect: async () => {
        if (hasThread) { openConversation(message.threadId, { guildId: space.id }); return; }
        const thread = await createThread(message.channelId, { messageId: message.id });
        if (thread) openConversation(thread.id, { guildId: space.id });
      },
    }));
  }
  items.push(menuItem({ label: 'Forward', iconName: 'forward', onSelect: () => openForwardPicker(anchor, message) }));
  if (canPin) {
    const pinned = Boolean(message.pinnedAt);
    items.push(menuItem({ label: pinned ? 'Unpin message' : 'Pin message', iconName: 'pin', onSelect: () => setPinned(message.channelId, message.id, !pinned) }));
  }
  items.push(menuSeparator());

  if (isMine) {
    items.push(menuItem({
      label: 'Edit message',
      iconName: 'pencil',
      onSelect: () => startEditing(message.id),
    }));
  }
  if (canDelete) {
    items.push(menuItem({
      label: 'Delete message',
      iconName: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: 'Delete this message?',
          message: 'It will be gone for everyone. This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) deleteMessage(message.channelId, message.id);
      },
    }));
  }
  if (items.length) items.push(menuSeparator());

  items.push(menuItem({
    label: 'Copy text',
    iconName: 'copy',
    onSelect: () => copyToClipboard(message.content || '', 'Message'),
  }));
  items.push(menuItem({
    label: 'Copy message ID',
    iconName: 'copy',
    onSelect: () => copyToClipboard(message.id, 'Message ID'),
  }));

  if (!isMine) {
    items.push(menuSeparator());
    items.push(menuItem({
      label: 'Report message',
      iconName: 'alert',
      onSelect: () => showReportDialog({
        kind: 'message',
        targetId: message.authorId,
        channelId: message.channelId,
        messageId: message.id,
        who: author?.displayName || 'this person',
      }),
    }));
    if (author) {
      items.push(menuItem({
        label: `Copy ${author.displayName}'s ID`,
        iconName: 'copy',
        onSelect: () => copyToClipboard(author.id, 'User ID'),
      }));
    }
  }

  openPopover(anchor, el('div', { class: 'menu' }, ...items), { placement: 'bottom-start' });
}

/** Right-click a friend category heading. */
export function openFriendGroupMenu(anchor, group) {
  openPopover(anchor, el('div', { class: 'menu' },
    menuItem({
      label: 'Rename category',
      iconName: 'pencil',
      onSelect: () => showFriendGroupModal(group),
    }),
    menuSeparator(),
    menuItem({
      label: 'Delete category',
      iconName: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `Delete ${group.name}?`,
          message: 'The people in it stay on your friends list.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) deleteFriendGroup(group.id);
      },
    }),
  ), { placement: 'bottom-start' });
}

/** Right-click the empty part of the friends list. */
export function openFriendsBackgroundMenu(anchor) {
  openPopover(anchor, el('div', { class: 'menu' },
    menuItem({ label: 'Add a friend', iconName: 'plus', onSelect: showAddFriend }),
    menuItem({ label: 'New category', iconName: 'plus', onSelect: () => showFriendGroupModal(null) }),
  ), { placement: 'bottom-start' });
}

export function openChannelMenu(anchor, guild, channel) {
  const canEdit = canManage(guild, 'manageChannels');

  openPopover(anchor, [
    menuLabel(`#${channel.name}`),
    menuItem({ label: 'Mark as read', iconName: 'check', onSelect: () => markRead(channel.id) }),
    menuItem({
      label: 'Copy channel name',
      iconName: 'copy',
      onSelect: () => copyToClipboard(`#${channel.name}`, 'Channel name'),
    }),
    canEdit ? menuSeparator() : null,
    canEdit ? menuItem({
      label: 'Edit channel',
      iconName: 'pencil',
      onSelect: () => showChannelSettings(channel),
    }) : null,
    canEdit ? menuItem({
      label: 'Permissions',
      iconName: 'shield',
      onSelect: () => showChannelPermissions(channel),
    }) : null,
    canEdit && channel.type === 'text' ? menuItem({
      label: 'Webhooks',
      iconName: 'link',
      onSelect: () => showChannelWebhooks(channel),
    }) : null,
    canEdit ? menuItem({
      label: 'Delete channel',
      iconName: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `Delete #${channel.name}?`,
          message: 'Every message in this channel goes with it. This cannot be undone.',
          confirmLabel: 'Delete channel',
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteChannel(channel.id);
        } catch (err) {
          toastError(err.message);
        }
      },
    }) : null,
  ].filter(Boolean), { placement: 'bottom-start' });
}
