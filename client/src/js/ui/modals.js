import { el, clear, debounce } from '../utils.js';
import { icon } from '../icons.js';
import {
  createGuild, joinGuild, inviteLink, inviteCodeFrom, createChannel, updateChannel,
  searchUsers, addFriend, uploadSpaceImage, createCategory, renameCategory, reportToAdmin, createFriendGroup, renameFriendGroup, moveFriendToGroup, submitAppeal, peekGuild, copyToClipboard,
  setChannelOverwrite, setCategoryOverwrite,
  createWebhook, fetchWebhooks, renameWebhook, resetWebhookToken, deleteWebhook} from '../actions.js';
import { net } from '../client.js';
import { store } from '../state.js';
import { openModal } from './overlay.js';
import { avatar, labelledField, textInput, key, editableImage } from './bits.js';
import { SHORTCUT_SECTIONS } from './shortcutdata.js';
import { fileToJpegDataUrl, AVATAR_SPEC } from '../imagepick.js';
import { initials } from '../utils.js';
import { toastSuccess, toastError } from './toast.js';
import { buildTagManager } from './forum.js';

/** Wraps an async submit handler with busy state and inline error reporting. */
export function submitButton(label, handle, run) {
  const button = el('button', { class: 'btn btn--primary', type: 'button' }, label);
  button.addEventListener('click', async () => {
    handle.setError('');
    button.classList.add('is-busy');
    try {
      await run();
    } catch (err) {
      handle.setError(err.message || 'That did not work.');
    } finally {
      button.classList.remove('is-busy');
    }
  });
  return button;
}

export const cancelButton = (handle, label = 'Cancel') =>
  el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => handle.close() }, label);

// ------------------------------------------------------------------ spaces

export function showCreateServer() {
  const name = textInput({ id: 'newServerName', placeholder: 'e.g. Design Team', maxLength: 48 });
  const picker = el('div', { class: 'space-setup' });
  let pickedImage = null;

  function renderPicker() {
    clear(picker);
    picker.append(
      editableImage({
        shape: 'square',
        url: pickedImage,
        fallback: el('div', { class: 'editable__fill editable__initials' },
          initials(name.value.trim() || '?')),
        label: 'space picture',
        onPick: async (file) => {
          try {
            pickedImage = await fileToJpegDataUrl(file, AVATAR_SPEC, '#1c1c20');
            renderPicker();
          } catch (err) {
            handle.setError(err.message);
          }
        },
        onRemove: pickedImage ? () => { pickedImage = null; renderPicker(); } : null,
      }),
      el('p', { class: 'field__hint' }, 'Optional. Members see this beside the space name.'),
    );
  }

  name.addEventListener('input', () => { if (!pickedImage) renderPicker(); });

  const handle = openModal({
    title: 'Create a space',
    subtitle: 'A space has its own picture, channels and members.',
    body: [
      picker,
      labelledField({ id: 'newServerName', label: 'Space name', input: name }),
      el('p', { class: 'field__hint' },
        'You will get an invite link to share once it is created. A ', el('strong', {}, '#general'),
        ' channel is set up for you.'),
    ],
    actions: [],
    initialFocus: '#newServerName',
  });

  renderPicker();

  const create = submitButton('Create space', handle, async () => {
    const guild = await createGuild(name.value.trim());
    if (pickedImage) await uploadSpaceImage(guild.id, pickedImage);
    handle.close();
    showInviteModal(guild);
  });

  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') create.click();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), create));
}

export function showJoinServer() {
  const code = textInput({ id: 'inviteCode', placeholder: 'https://voxaraspace.com/invite/ABCD2345', maxLength: 120 });

  const handle = openModal({
    title: 'Join a space',
    subtitle: 'Paste the invite link someone shared with you.',
    body: labelledField({
      id: 'inviteCode',
      label: 'Invite link',
      hint: 'A link like voxaraspace.com/invite/ABCD2345, or just the 8-character code at the end.',
      input: code,
    }),
    initialFocus: '#inviteCode',
  });

  const join = submitButton('Join', handle, async () => {
    const value = inviteCodeFrom(code.value);
    if (!value) throw new Error('Paste an invite link first.');
    try {
      await joinGuild(value);
      handle.close();
    } catch (err) {
      // A banned member can plead their case instead of just bouncing off.
      if (err.code === 'banned') {
        handle.close();
        showAppeal(value.toUpperCase());
        return;
      }
      throw err;
    }
  });

  const peek = el('button', { class: 'btn', type: 'button' }, 'Peek inside');
  peek.addEventListener('click', async () => {
    const value = code.value.trim();
    if (!value) return;
    peek.classList.add('is-busy');
    try {
      const preview = await peekGuild(value);
      handle.close();
      showPeek(preview);
    } catch (err) {
      peek.classList.remove('is-busy');
      // A space can turn previews off; nudge them to just join instead.
      handle.setError(err.code === 'no_peek' ? 'This space has previews off — go ahead and join.' : (err.message || 'Could not preview that space.'));
    }
  });

  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join.click();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), peek, join));
}

/** A read-only look inside a space before joining it. */
export function showPeek(data) {
  const g = data.guild;
  const nameOf = (id) => data.users[id]?.displayName || 'Someone';
  const messages = el('div', { class: 'peek__messages' });
  if (!data.preview.length) {
    messages.append(el('p', { class: 'field__hint' }, 'No messages here yet.'));
  } else {
    for (const m of data.preview) {
      messages.append(el('div', { class: 'peek__msg' },
        el('span', { class: 'peek__author' }, nameOf(m.authorId)),
        el('span', { class: 'peek__text' }, m.content || '')));
    }
  }

  const handle = openModal({
    title: g.name,
    subtitle: `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}${data.channelName ? ` · #${data.channelName}` : ''}`,
    body: el('div', { class: 'peek' },
      g.description ? el('p', { class: 'peek__desc' }, g.description) : null,
      el('p', { class: 'field__hint' }, 'A read-only preview. Join to take part.'),
      messages),
  });

  const joinBtn = submitButton(data.alreadyMember ? 'Open' : 'Join this space', handle, async () => {
    await joinGuild(g.invite);
    handle.close();
  });
  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), joinBtn));
}

/** For someone banned from a space: submit an appeal its moderators will see. */
export function showAppeal(invite) {
  const text = el('textarea', {
    class: 'field__input field__textarea', rows: 4,
    placeholder: 'Explain why the ban should be lifted…',
  });
  const handle = openModal({
    title: 'You’re banned from this space',
    subtitle: 'Send an appeal to its moderators',
    body: el('div', {},
      el('p', { class: 'field__hint' }, 'A moderator will see this and can lift the ban. You can only have one appeal pending.'),
      text,
    ),
    initialFocus: 'textarea',
  });
  const submit = submitButton('Send appeal', handle, async () => {
    const value = text.value.trim();
    if (!value) throw new Error('Write your appeal first.');
    await submitAppeal(invite, value);
    handle.close();
    toastSuccess('Appeal sent. A moderator will review it.');
  });
  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), submit));
}

export function showInviteModal(guild) {
  const link = inviteLink(guild.invite);
  const copyButton = el('button', { class: 'btn btn--sm btn--primary', type: 'button' }, 'Copy');
  copyButton.addEventListener('click', async () => {
    const ok = await copyToClipboard(link, 'Invite link');
    if (ok) {
      copyButton.textContent = 'Copied';
      setTimeout(() => { copyButton.textContent = 'Copy'; }, 1800);
    }
  });

  // Friends who are not in the space yet, each with a one-click send: the
  // link goes to them as a direct message and shows up as an invite card.
  const candidates = [...(store.friends || [])]
    .filter((id) => !guild.memberIds.includes(id))
    .map((id) => store.user(id))
    .filter(Boolean)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const search = textInput({ id: 'inviteFriendSearch', placeholder: 'Search friends' });
  const list = el('div', { class: 'invitefriends' });
  const sent = new Set();
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const shown = candidates.filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
    if (!shown.length) { list.appendChild(el('p', { class: 'field__hint' }, candidates.length ? 'No friend matches that.' : 'All your friends are already here, or you have none yet. Share the link instead.')); return; }
    for (const u of shown) {
      const btn = el('button', { class: `btn btn--sm${sent.has(u.id) ? '' : ' btn--primary'}`, type: 'button', disabled: sent.has(u.id) }, sent.has(u.id) ? 'Sent' : 'Send');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const { dm } = await net.request('dm:open', { userId: u.id });
          await net.request('message:send', { channelId: dm.id, content: `Join me on ${guild.name}: ${link}` });
          sent.add(u.id); btn.textContent = 'Sent'; btn.classList.remove('btn--primary');
        } catch (err) { btn.disabled = false; toastError(err.message || 'Could not send that.'); }
      });
      list.appendChild(el('div', { class: 'invitefriends__row' }, avatar(u, { size: 'sm' }), el('span', { class: 'invitefriends__name' }, u.displayName, el('span', { class: 'invitefriends__handle' }, ` @${u.username}`)), btn));
    }
  };
  search.addEventListener('input', draw);
  draw();

  const handle = openModal({
    title: `Invite people to ${guild.name}`,
    subtitle: 'Anyone with this link can join. Send it to a friend, or share it anywhere.',
    body: [
      el('div', { class: 'copybox copybox--link' }, el('code', {}, link), copyButton),
      el('p', { class: 'field__label', style: { marginTop: '16px' } }, 'Send to a friend'),
      search,
      list,
      el('p', { class: 'field__hint' }, 'Prefer a code? It is the last part of the link: ', el('strong', {}, guild.invite), '.'),
    ],
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--primary', type: 'button', onClick: () => handle.close() }, 'Done')));
}

// ---------------------------------------------------------------- channels

export function showCreateChannel(guild, categoryId) {
  const name = textInput({ id: 'newChannelName', placeholder: 'new-channel', maxLength: 32 });
  const topic = textInput({ id: 'newChannelTopic', placeholder: 'What is this channel for? (optional)', maxLength: 200 });

  // Text, voice, or forum. A voice channel is one people join to talk, not to
  // post in; a forum has no message list of its own — every post is a thread.
  let type = 'text';
  const topicField = labelledField({ id: 'newChannelTopic', label: 'Topic', input: topic });
  const preview = el('p', { class: 'field__hint' }, 'This will be created as #new-channel');
  const refreshPreview = () => {
    const slug = name.value.trim().replace(/\s+/g, ' ') || 'new-channel';
    if (type === 'voice') preview.textContent = `A voice channel — people join ${slug} to talk`;
    else if (type === 'forum') preview.textContent = `A forum — members post topics in ${slug}, each its own thread`;
    else preview.textContent = `This will be created as #${slug}`;
  };
  name.addEventListener('input', refreshPreview);

  const typeBtn = (value, iconName, label) => el('button', {
    class: `chantype__opt${type === value ? ' is-on' : ''}`,
    type: 'button',
    onClick: () => {
      type = value;
      picker.querySelectorAll('.chantype__opt').forEach((b) => b.classList.toggle('is-on', b === chosen[value]));
      topicField.hidden = value === 'voice';
      refreshPreview();
    },
  }, icon(iconName), el('span', {}, label));
  const chosen = {
    text: typeBtn('text', 'hash', 'Text'),
    voice: typeBtn('voice', 'speaker', 'Voice'),
    forum: typeBtn('forum', 'layers', 'Forum'),
  };
  const picker = el('div', { class: 'chantype' }, chosen.text, chosen.voice, chosen.forum);

  // Private: only the roles ticked here can see the channel (everyone else
  // gets View channel denied). Age-restricted: 18+ by date of birth.
  const privateBox = el('input', { type: 'checkbox', id: 'newChannelPrivate' });
  const roles = (guild.roles || []).slice();
  const roleBoxes = new Map();
  const roleList = el('div', { class: 'checklist', hidden: true },
    roles.length ? roles.map((r) => { const cb = el('input', { type: 'checkbox' }); roleBoxes.set(r.id, cb); return el('label', { class: 'checklist__row' }, cb, el('span', { class: 'role-tag', style: r.color ? { color: r.color, borderColor: r.color } : {} }, r.name)); })
      : [el('p', { class: 'field__hint' }, 'This space has no roles yet. Create one in Space settings, Roles, then come back; until then only you (the owner) and moderators with an allow override would see the channel.')]);
  privateBox.addEventListener('change', () => { roleList.hidden = !privateBox.checked; });
  const nsfwBox = el('input', { type: 'checkbox', id: 'newChannelNsfw' });

  const handle = openModal({
    title: 'Create a channel',
    subtitle: `in ${guild.name}`,
    body: [
      picker,
      labelledField({ id: 'newChannelName', label: 'Channel name', input: name }),
      preview,
      topicField,
      el('label', { class: 'checkline', for: 'newChannelPrivate' }, privateBox, el('span', {}, el('b', {}, 'Private channel'), ' Only the roles you pick can see it.')),
      roleList,
      el('label', { class: 'checkline', for: 'newChannelNsfw' }, nsfwBox, el('span', {}, el('b', {}, 'Age-restricted (18+)'), ' Members under 18 cannot see it; adults are warned before they open it.')),
    ],
    initialFocus: '#newChannelName',
  });

  const create = submitButton('Create channel', handle, async () => {
    const value = name.value.trim();
    if (!value) throw new Error('Give the channel a name.');
    const channel = await createChannel(guild.id, value, topic.value.trim(), categoryId, type, { nsfw: nsfwBox.checked });
    if (privateBox.checked && channel) {
      await setChannelOverwrite(channel.id, 'everyone', 'viewChannel', 'deny');
      for (const [roleId, cb] of roleBoxes) if (cb.checked) await setChannelOverwrite(channel.id, roleId, 'viewChannel', 'allow');
    }
    handle.close();
  });

  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') create.click();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), create));
}

/** A dedicated full-size screen for one category's permission overwrites —
 * every channel inside inherits these unless it overrides them itself. */
export function showCategoryPermissions(guild, category) {
  const editor = buildPermissionEditor(guild, category.permissionOverwrites, async (roleId, permission, value) => {
    const updated = await setCategoryOverwrite(guild.id, category.id, roleId, permission, value);
    if (!updated) return undefined;
    category = updated;
    return updated.permissionOverwrites;
  });

  const handle = openModal({
    title: `Permissions — ${category.name}`,
    subtitle: guild.name,
    xl: true,
    body: [
      el('p', { class: 'field__hint' },
        'Every channel in this category inherits these unless it overrides them itself.'),
      editor,
    ],
  });
  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--primary', type: 'button', onClick: () => handle.close() }, 'Done')));
}

/** Create or rename a category. Passing `category` switches it to renaming. */
export function showCategoryModal(guild, category = null) {
  const renaming = Boolean(category);
  const name = textInput({
    id: 'categoryName',
    value: renaming ? category.name : '',
    placeholder: 'Text channels',
    maxLength: 32,
  });

  const handle = openModal({
    title: renaming ? 'Rename category' : 'Create a category',
    subtitle: `in ${guild.name}`,
    body: [labelledField({ id: 'categoryName', label: 'Category name', input: name })],
    initialFocus: '#categoryName',
  });

  const save = submitButton(renaming ? 'Save' : 'Create category', handle, async () => {
    const value = name.value.trim();
    if (!value) throw new Error('Give the category a name.');
    if (renaming) await renameCategory(guild.id, category.id, value);
    else await createCategory(guild.id, value);
    handle.close();
  });

  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save.click();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    renaming ? el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      onClick: () => { handle.close(); showCategoryPermissions(guild, category); },
    }, 'Permissions') : null,
    el('div', { style: { flex: '1' } }),
    cancelButton(handle),
    save));
}

/** Sends a report to the server admin, with an optional reason. */
export function showReportDialog({ kind, targetId, channelId = null, messageId = null, who }) {
  // A report goes to the moderators of the space it was raised in; only a
  // report with no space (a DM or a friend) reaches the server host admin.
  const guildId = (channelId && store.guildOfChannel(channelId)?.id)
    || store.conversation()?.guild?.id
    || null;
  const toStaff = guildId ? 'this space’s moderators' : 'the server admin';

  const reason = el('textarea', {
    class: 'field__input field__textarea',
    id: 'reportReason',
    rows: 3,
    maxlength: 300,
    placeholder: 'What is wrong? (optional)',
  });

  const handle = openModal({
    title: kind === 'message' ? 'Report this message' : `Report ${who}`,
    subtitle: `Goes to ${toStaff}`,
    body: [
      el('p', { class: 'field__hint' },
        kind === 'message'
          ? `${guildId ? 'The moderators see' : 'The admin sees'} a copy of the message, so it stays readable even if it is deleted later.`
          : `${guildId ? 'The moderators see' : 'The admin sees'} who you reported and anything you write below.`),
      labelledField({ id: 'reportReason', label: 'Reason', input: reason }),
    ],
    initialFocus: '#reportReason',
  });

  const send = submitButton('Send report', handle, async () => {
    await reportToAdmin({ kind, targetId, guildId, channelId, messageId, reason: reason.value.trim() });
    handle.close();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), send));
}

/** Create or rename a friend category; `alsoAdd` files someone into a new one. */
export function showFriendGroupModal(group = null, alsoAdd = null) {
  const renaming = Boolean(group);
  const name = textInput({
    id: 'friendGroupName',
    value: renaming ? group.name : '',
    placeholder: 'Close friends',
    maxLength: 32,
  });

  const handle = openModal({
    title: renaming ? 'Rename category' : 'New friend category',
    body: [labelledField({ id: 'friendGroupName', label: 'Category name', input: name })],
    initialFocus: '#friendGroupName',
  });

  const save = submitButton(renaming ? 'Save' : 'Create category', handle, async () => {
    const value = name.value.trim();
    if (!value) throw new Error('Give the category a name.');
    if (renaming) {
      await renameFriendGroup(group.id, value);
    } else {
      await createFriendGroup(value);
      if (alsoAdd) {
        const made = (store.friendGroups || []).find((g) => g.name === value);
        if (made) await moveFriendToGroup(alsoAdd, made.id);
      }
    }
    handle.close();
  });

  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save.click();
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' }, cancelButton(handle), save));
}

// --------------------------------------------------- permission overwrites

const BASE_PERMISSION_LABELS = {
  viewChannel: ['View Channel', 'Lets members see this channel and read its messages. Denying this for @everyone makes the channel private to just the roles you allow.'],
  sendMessages: ['Send Messages', 'Lets members post messages in this channel.'],
  attachFiles: ['Attach Files', 'Lets members attach files and images to their messages.'],
  addReactions: ['Add Reactions', 'Lets members react to messages in this channel.'],
  connect: ['Connect', 'Lets members join this voice channel.'],
};

/** Voice-only; hidden when editing a text channel (categories show everything, since they hold both). */
function applicablePermissions(channelType) {
  if (channelType !== 'text') return BASE_PERMISSION_LABELS;
  const { connect, ...rest } = BASE_PERMISSION_LABELS;
  return rest;
}

function overwriteState(overwrites, roleId, permission) {
  const bucket = overwrites?.[roleId];
  if (bucket?.deny?.includes(permission)) return 'deny';
  if (bucket?.allow?.includes(permission)) return 'allow';
  return 'inherit';
}

/**
 * Pick a role on the left, then set each permission directly to deny,
 * inherit or allow on the right — the familiar channel permission
 * editor works, rather than a cramped one-cell-per-role-per-permission grid.
 * `onSet(roleId, permission, value)` persists a change and should return the
 * fresh overwrites object (or undefined to leave the local copy as-is).
 */
function buildPermissionEditor(guild, overwrites, onSet, { channelType } = {}) {
  const roles = [
    { id: 'everyone', name: '@everyone', color: '#8b93a7' },
    ...(guild.roles || []).slice().sort((a, b) => b.position - a.position),
  ];
  let selected = roles[0].id;
  let current = overwrites;

  const roleList = el('div', { class: 'permeditor__roles' });
  const body = el('div', { class: 'permeditor__body' });

  function renderRoles() {
    clear(roleList);
    for (const role of roles) {
      roleList.appendChild(el('button', {
        class: `permeditor__role${role.id === selected ? ' is-selected' : ''}`,
        type: 'button',
        onClick: () => { selected = role.id; renderRoles(); renderBody(); },
      },
      el('span', { class: 'permeditor__roledot', style: { background: role.color || '#8b93a7' } }),
      el('span', { class: 'permeditor__rolename' }, role.name)));
    }
  }

  function stateButton(permKey, target, state) {
    const glyph = target === 'deny' ? 'close' : target === 'allow' ? 'check' : 'minus';
    return el('button', {
      class: `permeditor__state permeditor__state--${target}${state === target ? ' is-active' : ''}`,
      type: 'button',
      title: target === 'inherit' ? 'Inherit (no override)' : target[0].toUpperCase() + target.slice(1),
      'aria-label': `${target} for ${permKey}`,
      onClick: async () => {
        const value = target === 'inherit' ? null : target;
        const result = await onSet(selected, permKey, value);
        if (result !== undefined) current = result;
        renderBody();
      },
    }, icon(glyph));
  }

  function renderBody() {
    clear(body);
    for (const [permKey, [label, hint]] of Object.entries(applicablePermissions(channelType))) {
      const state = overwriteState(current, selected, permKey);
      body.appendChild(el('div', { class: 'permeditor__row' },
        el('div', { class: 'permeditor__text' },
          el('div', { class: 'permeditor__label' }, label),
          el('div', { class: 'permeditor__hint' }, hint)),
        el('div', { class: 'permeditor__states' },
          stateButton(permKey, 'deny', state),
          stateButton(permKey, 'inherit', state),
          stateButton(permKey, 'allow', state))));
    }
  }

  renderRoles();
  renderBody();
  return el('div', { class: 'permeditor' }, roleList, body);
}

/** A dedicated full-size screen for one channel's permission overwrites —
 * separate from the name/topic modal, matching how much room a role-by-role
 * permission list actually needs. */
export function showChannelPermissions(channel) {
  const guild = store.guildOfChannel(channel.id);
  if (!guild) return;

  const editor = buildPermissionEditor(guild, channel.permissionOverwrites, async (roleId, permission, value) => {
    const updated = await setChannelOverwrite(channel.id, roleId, permission, value);
    if (!updated) return undefined;
    channel = updated;
    return updated.permissionOverwrites;
  }, { channelType: channel.type });

  const handle = openModal({
    title: `Permissions — #${channel.name}`,
    subtitle: guild.name,
    xl: true,
    body: [
      el('p', { class: 'field__hint' },
        'Overrides what a role can do just in this channel, on top of what @everyone gets space-wide.'),
      editor,
    ],
  });
  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--primary', type: 'button', onClick: () => handle.close() }, 'Done')));
}

export function showChannelSettings(channel) {
  const guild = store.guildOfChannel(channel.id);
  const name = textInput({ id: 'channelName', value: channel.name, maxLength: 32 });
  const topic = textInput({ id: 'channelTopic', value: channel.topic || '', maxLength: 200 });

  const SLOW_OPTIONS = [
    [0, 'Off'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'],
    [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'],
  ];
  const slowmode = el('select', { id: 'channelSlow', class: 'field__input' },
    ...SLOW_OPTIONS.map(([value, label]) => el('option', {
      value: String(value),
      ...(Number(channel.slowmode || 0) === value ? { selected: true } : {}),
    }, label)));

  const isForum = channel.type === 'forum';
  const nsfwEdit = el('input', { type: 'checkbox', id: 'channelNsfw' });
  nsfwEdit.checked = Boolean(channel.nsfw);

  const handle = openModal({
    title: `Edit #${channel.name}`,
    wide: isForum,
    body: [
      labelledField({ id: 'channelName', label: 'Channel name', input: name }),
      labelledField({
        id: 'channelTopic',
        label: 'Topic',
        hint: 'Shown next to the channel name at the top of the conversation.',
        input: topic,
      }),
      labelledField({
        id: 'channelSlow',
        label: 'Slow mode',
        hint: isForum
          ? 'How long members must wait between replies, in every post here. Moderators are exempt.'
          : 'How long members must wait between messages. Moderators are exempt.',
        input: slowmode,
      }),
      el('label', { class: 'checkline', for: 'channelNsfw' }, nsfwEdit, el('span', {}, el('b', {}, 'Age-restricted (18+)'), ' Members under 18 cannot see this channel; adults are warned before they open it.')),
      isForum ? el('p', { class: 'field__label' }, 'Tags') : null,
      isForum ? el('p', { class: 'field__hint' }, 'Posts can be labelled with these — saved as you edit them.') : null,
      isForum ? buildTagManager(channel) : null,
    ],
    initialFocus: '#channelName',
  });

  const save = submitButton('Save', handle, async () => {
    await updateChannel(channel.id, {
      name: name.value.trim(),
      topic: topic.value.trim(),
      nsfw: nsfwEdit.checked,
      slowmode: Number(slowmode.value),
    });
    handle.close();
    toastSuccess('Channel updated.');
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    guild && channel.type === 'text' ? el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      onClick: () => { handle.close(); showChannelWebhooks(channel); },
    }, 'Webhooks') : null,
    guild ? el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      onClick: () => { handle.close(); showChannelPermissions(channel); },
    }, 'Permissions') : null,
    el('div', { style: { flex: '1' } }),
    cancelButton(handle),
    save));
}

// ------------------------------------------------------------- webhooks

function webhookTokenBox(token) {
  return el('div', { class: 'copyfield' },
    el('code', { class: 'copyfield__value', style: 'user-select:all' }, token),
    el('button', { class: 'btn btn--sm', type: 'button', onClick: () => copyToClipboard(token, 'Webhook token') }, 'Copy'));
}

export function showChannelWebhooks(channel) {
  // The server's public address (its domain), not the socket address the
  // app happens to be connected on.
  const httpBase = (store.server?.publicUrl || (net.url || '').replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')).replace(/\/+$/, '');
  // Short form when the server gave the webhook a path id (all new ones).
  const urlFor = (hook, token) => (hook?.webhookSlug ? `${httpBase}/wh/${hook.webhookSlug}/${token}` : `${httpBase}/webhook/${hook?.id || hook}/${token}`);

  const nameInput = textInput({ placeholder: `${channel.name} webhook`, maxLength: 40 });
  const createBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Create webhook');
  const list = el('div', { class: 'botlist' }, el('p', { class: 'field__hint' }, 'Loading webhooks…'));

  const handle = openModal({
    title: `Webhooks — #${channel.name}`,
    subtitle: 'Post into this channel with a plain HTTPS request — no bot process required.',
    wide: true,
    body: [
      el('p', { class: 'field__hint' },
        'POST JSON to the URL below: ', el('code', {}, '{"content": "your message"}'), '. Anyone with the URL can post as this webhook.'),
      el('div', { class: 'settings__actions', style: { display: 'flex', gap: '8px' } },
        nameInput, createBtn),
      list,
    ],
  });

  async function refresh() {
    try {
      const webhooks = await fetchWebhooks(channel.id);
      clear(list);
      if (!webhooks.length) { list.append(el('p', { class: 'field__hint' }, 'No webhooks yet.')); return; }
      for (const webhook of webhooks) list.append(webhookRow(webhook));
    } catch (err) { clear(list); list.append(el('p', { class: 'field__hint' }, err.message)); }
  }

  function webhookRow(webhook) {
    const nameField = textInput({ value: webhook.displayName, maxLength: 40 });
    nameField.addEventListener('change', async () => {
      if (nameField.value.trim() && nameField.value.trim() !== webhook.displayName) {
        await renameWebhook(webhook.id, nameField.value.trim());
        toastSuccess('Webhook renamed.');
      }
    });

    const resetBtn = el('button', { class: 'btn btn--sm', type: 'button' }, 'Reset token');
    resetBtn.addEventListener('click', async () => {
      const result = await resetWebhookToken(webhook.id);
      if (!result) return;
      const box = el('div', {}, el('p', { class: 'field__hint' }, 'New URL — copy it now, it is not shown again:'), webhookTokenBox(urlFor({ ...webhook, webhookSlug: result.slug || webhook.webhookSlug }, result.token)));
      resetBtn.replaceWith(box);
    });

    const delBtn = el('button', { class: 'btn btn--danger btn--sm', type: 'button' }, 'Delete');
    delBtn.addEventListener('click', async () => {
      if (await deleteWebhook(webhook.id)) { toastSuccess('Webhook deleted.'); refresh(); }
    });

    return el('div', { class: 'botrow' },
      el('div', { class: 'botrow__head' },
        el('div', {},
          nameField,
          el('span', { class: 'tag-bot' }, 'BOT')),
        el('div', { class: 'botrow__btns' }, resetBtn, delBtn)));
  }

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const result = await createWebhook(channel.id, nameInput.value.trim());
      if (result) {
        nameInput.value = '';
        toastSuccess('Webhook created.');
        // Appended directly rather than via refresh(), which would clear()
        // the list and take this one-time reveal down with it.
        const reveal = el('div', { class: 'bot-token-reveal' },
          el('p', {}, el('strong', {}, 'Save this URL now.'), ' It is shown only once. Anyone with it can post here.'),
          webhookTokenBox(urlFor(result.webhook, result.token)));
        if (list.children.length === 1 && list.textContent === 'No webhooks yet.') clear(list);
        list.prepend(reveal, webhookRow(result.webhook));
      }
    } finally { createBtn.disabled = false; }
  });

  refresh();
}

// -------------------------------------------------------------- add friend

export function showAddFriend() {
  const input = textInput({
    id: 'addFriend',
    placeholder: 'username',
    maxLength: 24,
  });
  const results = el('div', { class: 'people-results' });

  const handle = openModal({
    title: 'Add a friend',
    subtitle: 'People are found by their exact username.',
    body: [
      labelledField({
        id: 'addFriend',
        label: 'Username',
        hint: 'Ask them for the @name shown under their display name.',
        input,
      }),
      results,
    ],
    initialFocus: '#addFriend',
  });

  async function send(username) {
    handle.setError('');
    try {
      await addFriend(username);
      handle.close();
    } catch (err) {
      handle.setError(err.message);
    }
  }

  function renderResults(users, message) {
    clear(results);
    if (message) {
      results.appendChild(el('p', { class: 'field__hint', style: { padding: '8px 2px' } }, message));
      return;
    }
    for (const user of users) {
      const already = store.isFriend(user.id);
      results.appendChild(el('div', { class: 'people-row' },
        avatar(user, { size: 'sm' }),
        el('span', { class: 'member__text' },
          el('span', { class: 'member__name' }, user.displayName),
          el('span', { class: 'member__sub' }, `@${user.username}`)),
        already
          ? el('span', { class: 'people-row__tag' }, 'Friend')
          : el('button', {
            class: 'btn btn--sm btn--primary',
            type: 'button',
            onClick: () => send(user.username),
          }, 'Add')));
    }
  }

  renderResults([], 'Type at least two characters to search.');

  const run = debounce(async () => {
    const query = input.value.trim().replace(/^@/, '');
    if (query.length < 2) {
      renderResults([], 'Type at least two characters to search.');
      return;
    }
    const users = await searchUsers(query);
    if (users.length === 0) renderResults([], `Nobody matches “${query}”.`);
    else renderResults(users);
  }, 220);

  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = input.value.trim().replace(/^@/, '');
      if (value) send(value);
    }
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    cancelButton(handle, 'Close'),
    el('button', {
      class: 'btn btn--primary',
      type: 'button',
      onClick: () => send(input.value.trim().replace(/^@/, '')),
    }, 'Send request')));
}

// --------------------------------------------------------------- shortcuts

export function showShortcuts() {
  const grid = el('div', { class: 'shortcut-grid' });
  for (const [section, rows] of SHORTCUT_SECTIONS) {
    grid.appendChild(el('h4', {}, section));
    for (const [label, keys] of rows) {
      grid.appendChild(el('div', { class: 'shortcut' },
        el('span', {}, label),
        el('span', { class: 'shortcut__keys' }, ...keys.map((k) => key(k))),
      ));
    }
  }

  const handle = openModal({
    title: 'Keyboard shortcuts & formatting',
    subtitle: 'Everything you can do without reaching for the mouse.',
    wide: true,
    body: grid,
  });

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--primary', type: 'button', onClick: () => handle.close() }, 'Got it')));
}
