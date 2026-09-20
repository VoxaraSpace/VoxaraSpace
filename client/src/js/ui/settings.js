import { el, clear, initials } from '../utils.js';
import { store } from '../state.js';
import {
  updateProfile, changePassword, signOutEverywhere, uploadProfileImage, setPref, copyToClipboard,
  getBilling, exportMyData, linkSteam, unlinkSteam, fetchSteamProfile, PREF_DEFAULTS, startAgeVerification,
} from '../actions.js';
import { showGamingProfile } from './gaming.js';
import { referralCard } from './referrals.js';
import { pushSupported, pushState, enablePush, disablePush } from '../push.js';
import { themeGallery } from './themes.js';
import { icon } from '../icons.js';
import { mediaUrl, desktop, net, setSettings } from '../client.js';
import { fileToJpegDataUrl, fileToRawDataUrl, AVATAR_SPEC, BANNER_SPEC } from '../imagepick.js';
import { openSettingsShell, section, choiceRow, toggleRow } from './settingsshell.js';
import { labelledField, textInput, AVATAR_COLORS, STATUS_LABEL, editableImage, key } from './bits.js';
import { toastSuccess, toastError } from './toast.js';
import { confirmDialog, openModal } from './overlay.js';
import { showOneTimeCodes, showAuthScreen } from './auth.js';
import { qrSvg } from '../qr.js';
import { checkForUpdatesUI, showWhatsNew, switchVersionUI } from './update.js';
import { SHORTCUT_SECTIONS } from './shortcutdata.js';

const JOINED_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

const TABS = [
  { group: 'You', items: [
    { id: 'profile', label: 'Profile', icon: 'user', desc: 'Your name, picture and bio' },
    { id: 'account', label: 'Account', icon: 'lock', desc: 'Password and sign-in' },
    { id: 'privacy', label: 'Privacy', icon: 'shield', desc: 'Who can reach you' },
  ] },
  { group: 'App', items: [
    { id: 'appearance', label: 'Appearance', icon: 'palette', desc: 'Theme, density and sidebar' },
    { id: 'chat', label: 'Chat', icon: 'chat', desc: 'How messages send and load' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', desc: 'Alerts and previews' },
    { id: 'advanced', label: 'Advanced', icon: 'sliders', desc: 'Developer mode, IDs, reset' },
  ] },
  { group: 'Membership', items: [
    { id: 'invite', label: 'Invite friends', icon: 'users', desc: 'Your link, and the Recruiter badge' },
    { id: 'plus', label: 'Voxara Plus', icon: 'sparkle', desc: 'Support Voxara — a few optional extras' },
  ] },
  { group: 'Build', items: [
    { id: 'bots', label: 'Bots', icon: 'bot', desc: 'Manage bots in the Developer Portal' },
  ] },
  { group: 'Help', items: [
    { id: 'guide', label: 'Take the tour', icon: 'compass', desc: 'A quick tour of the app' },
    { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', desc: 'Every keyboard shortcut' },
  ] },
];

const PANES = {};

/**
 * The settings surface: a left rail of sections against a scrolling pane.
 * Appearance and notification changes apply immediately; profile and password
 * changes are explicit submissions, because they hit the server.
 */
export function showSettings(initialTab = 'profile') {
  return openSettingsShell({
    title: 'Settings',
    groups: TABS,
    panes: PANES,
    initial: initialTab,
  }).handle;
}

const prefToggle = (key, label, hint) => toggleRow({
  label,
  hint,
  value: store.ui[key],
  onChange: (value) => setPref(key, value),
});

// ------------------------------------------------------------------ profile

function profilePane(pane, handle) {
  const self = store.self;
  let chosenColor = self.avatarColor;

  const displayName = textInput({ id: 'setDisplayName', value: self.displayName, maxLength: 32 });
  const customStatus = textInput({
    id: 'setStatus', value: self.customStatus || '', maxLength: 80, placeholder: 'What are you up to?',
  });
  const bio = el('textarea', {
    class: 'field__input field__textarea',
    id: 'setBio',
    rows: 3,
    maxlength: 190,
    placeholder: 'A short line about you. Shown on your profile card.',
    value: self.bio || '',
  });

  const preview = el('div', { class: 'card-preview' });

  /** Applies one picked image, then repaints the card. */
  async function applyImage(kind, file, spec) {
    handle.setError('');
    try {
      // A GIF goes up as is so it keeps moving (the server bounds its size);
      // anything else is resized and re-encoded here first.
      const dataUrl = file
        ? (file.type === 'image/gif' ? await fileToRawDataUrl(file, 8 * 1024 * 1024) : await fileToJpegDataUrl(file, spec, chosenColor))
        : null;
      await uploadProfileImage(kind, dataUrl);
      renderPreview();
      toastSuccess(file ? 'Picture updated.' : 'Picture removed.');
    } catch (err) {
      handle.setError(err.message);
    }
  }

  /**
   * Mirrors the card other people see, and doubles as the editor: the pencils
   * on the banner and the picture are how you change them.
   */
  function renderPreview() {
    clear(preview);

    const banner = editableImage({
      shape: 'wide',
      url: mediaUrl(store.self.bannerUrl),
      fallback: el('div', { class: 'editable__fill', style: { background: chosenColor } }),
      label: 'banner',
      onPick: (file) => applyImage('banner', file, BANNER_SPEC),
      onRemove: store.self.bannerUrl ? () => applyImage('banner', null) : null,
    });

    const face = editableImage({
      shape: 'round',
      url: mediaUrl(store.self.avatarUrl),
      fallback: el('div', {
        class: 'editable__fill editable__initials',
        style: { background: chosenColor },
      }, initials(displayName.value || self.displayName)),
      label: 'profile picture',
      onPick: (file) => applyImage('avatar', file, AVATAR_SPEC),
      onRemove: store.self.avatarUrl ? () => applyImage('avatar', null) : null,
    });
    face.classList.add('profile-card__avatar');

    preview.append(
      banner,
      el('div', { class: 'profile-card__inner' },
        face,
        el('div', { class: 'profile-card__name' }, displayName.value || self.displayName),
        el('div', { class: 'profile-card__handle' }, `@${self.username}`),
        bio.value ? el('p', { class: 'profile-card__bio' }, bio.value) : null,
        customStatus.value
          ? el('div', { class: 'profile-card__status' }, customStatus.value)
          : null),
    );
  }

  for (const input of [displayName, customStatus, bio]) {
    input.addEventListener('input', renderPreview);
  }

  const swatches = el('div', { class: 'swatches' });
  for (const color of AVATAR_COLORS) {
    const swatch = el('button', {
      class: `swatch${color === chosenColor ? ' is-selected' : ''}`,
      type: 'button',
      style: { background: color },
      title: color,
      'aria-label': `Accent colour ${color}`,
      onClick: () => {
        chosenColor = color;
        for (const node of swatches.children) node.classList.remove('is-selected');
        swatch.classList.add('is-selected');
        renderPreview();
      },
    });
    swatches.appendChild(swatch);
  }

  // Voxara Plus unlocks any colour, via a native picker beside the presets.
  if (self.premium) {
    const custom = el('input', {
      type: 'color',
      class: 'swatch swatch--custom',
      value: /^#[0-9a-fA-F]{6}$/.test(chosenColor) ? chosenColor : '#4d7cfe',
      title: 'Custom colour (Plus)',
      'aria-label': 'Custom accent colour',
    });
    custom.addEventListener('input', () => {
      chosenColor = custom.value;
      for (const node of swatches.children) node.classList.remove('is-selected');
      renderPreview();
    });
    swatches.appendChild(custom);
  }

  renderPreview();

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save profile');
  save.addEventListener('click', async () => {
    const name = displayName.value.trim();
    if (!name) return handle.setError('Display name cannot be empty.');
    handle.setError('');
    save.classList.add('is-busy');
    try {
      await updateProfile({
        displayName: name,
        customStatus: customStatus.value.trim(),
        bio: bio.value.trim(),
        avatarColor: chosenColor,
      });
      toastSuccess('Profile updated.');
    } catch (err) {
      handle.setError(err.message);
    } finally {
      save.classList.remove('is-busy');
    }
  });

  pane.append(
    section('How you appear',
      preview,
      el('p', { class: 'field__hint' },
        'Use the pencils to change your banner and picture. Images are cropped '
        + 'and resized on this computer before upload.')),
    section('Details',
      labelledField({ id: 'setDisplayName', label: 'Display name', input: displayName }),
      labelledField({ id: 'setStatus', label: 'Custom status', input: customStatus }),
      labelledField({
        id: 'setBio',
        label: 'About you',
        hint: '190 characters maximum.',
        input: bio,
      })),
    section('Accent colour', swatches,
      self.premium
        ? null
        : el('p', { class: 'field__hint' }, 'Custom colours are a Voxara Plus perk.')),
    el('div', { class: 'settings__actions' }, save),
  );
}

// ------------------------------------------------------------------ account

function accountPane(pane, handle) {
  const self = store.self;

  const current = textInput({ id: 'pwCurrent', placeholder: 'Current password' });
  const next = textInput({ id: 'pwNext', placeholder: 'New password' });
  const confirm = textInput({ id: 'pwConfirm', placeholder: 'Repeat new password' });
  for (const input of [current, next, confirm]) input.type = 'password';

  const change = el('button', { class: 'btn btn--primary', type: 'button' }, 'Change password');
  change.addEventListener('click', async () => {
    handle.setError('');
    if (!current.value) return handle.setError('Enter your current password.');
    if (next.value.length < 8) return handle.setError('New passwords must be at least 8 characters.');
    if (next.value !== confirm.value) return handle.setError('The new passwords do not match.');

    change.classList.add('is-busy');
    try {
      await changePassword(current.value, next.value);
      for (const input of [current, next, confirm]) input.value = '';
    } catch (err) {
      handle.setError(err.message);
    } finally {
      change.classList.remove('is-busy');
    }
  });

  pane.append(
    section('Account',
      el('dl', { class: 'facts' },
        el('dt', {}, 'Username'), el('dd', {}, `@${self.username}`),
        el('dt', {}, 'Display name'), el('dd', {}, self.displayName),
        el('dt', {}, 'Status'), el('dd', {}, STATUS_LABEL[self.status] || 'Online'),
        el('dt', {}, 'Member since'), el('dd', {}, JOINED_FMT.format(new Date(self.createdAt || Date.now()))),
      ),
      el('p', { class: 'field__hint' },
        'Your username identifies you to everyone on this Voxara server and cannot be changed.')),
    section('Connections', steamCard()),
    section('Age verification', ageCard()),
    store.self?.emailVerified === false ? section('Confirm your email', verifyCard()) : document.createComment('email confirmed'),
    section('Two-factor authentication', mfaCard()),
    section('Change password',
      labelledField({ id: 'pwCurrent', label: 'Current password', input: current }),
      labelledField({ id: 'pwNext', label: 'New password', input: next }),
      labelledField({
        id: 'pwConfirm',
        label: 'Confirm new password',
        hint: 'Changing your password signs out your other devices.',
        input: confirm,
      }),
      el('div', { class: 'settings__actions' }, change)),
    section('Devices',
      el('p', { class: 'field__hint' },
        'Left yourself signed in somewhere, or lost a device? This signs out every other device and cancels their saved sign-ins. This one stays signed in.'),
      el('div', { class: 'settings__actions' },
        el('button', { class: 'btn', type: 'button', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await signOutEverywhere(); } catch (err) { toastError(err.message || 'Could not sign out other devices.'); } finally { b.disabled = false; } } }, 'Sign out of other devices'))),
    section('Delete account',
      el('p', { class: 'field__hint' },
        'Deleting your account removes your profile, pictures, every message you sent, your friendships and your bots. '
        + 'Spaces where you were the only person are deleted too. Spaces you own with other people in them must be handed over or deleted first. This cannot be undone.'),
      el('div', { class: 'settings__actions' },
        el('button', { class: 'btn btn--danger', type: 'button', onClick: () => startAccountDeletion() }, 'Delete my account…'))),
  );
}

/** The confirm dialog for account deletion: username typed back, password, and a 2FA code when it is on. */
function startAccountDeletion() {
  const username = store.self?.username || '';
  const typed = el('input', { id: 'delName', class: 'field__input', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: username });
  const password = el('input', { id: 'delPw', class: 'field__input', type: 'password', autocomplete: 'current-password', placeholder: 'Your password' });
  const code = el('input', { id: 'delCode', class: 'field__input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'Code from your app, or a backup code', maxlength: '11' });
  const go = el('button', { class: 'btn btn--danger', type: 'button', disabled: true }, 'Delete my account');
  typed.addEventListener('input', () => { go.disabled = typed.value.trim().toLowerCase() !== username.toLowerCase(); });
  const handle = openModal({
    title: 'Delete your account?',
    body: el('div', {},
      el('p', { class: 'field__hint' }, 'This is permanent. Your messages disappear from every space and conversation, and your username becomes free for someone else.'),
      labelledField({ id: 'delName', label: `Type your username (${username}) to confirm`, input: typed }),
      labelledField({ id: 'delPw', label: 'Password', input: password }),
      store.self?.mfaEnabled ? labelledField({ id: 'delCode', label: 'Two-factor code', input: code }) : null),
    initialFocus: '#delName',
    actions: [el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => handle.close() }, 'Keep my account'), go],
  });
  go.addEventListener('click', async () => {
    go.disabled = true; handle.setError('');
    try {
      await net.request('me:delete', { password: password.value, code: code.value.trim() });
      handle.close();
      setSettings({ token: null, mediaToken: null });
      net.disconnect();
      showAuthScreen('Your account has been deleted.');
    } catch (err) {
      handle.setError(err.message || 'Could not delete the account.');
      go.disabled = false;
    }
  });
}

// ------------------------------------------------------------------- voice

function sensitivityRow() {
  const value = Number(store.ui.inputSensitivity ?? 50);
  const out = el('span', { class: 'menu-slider__value' }, `${value}`);
  const slider = el('input', { class: 'menu-slider__input', type: 'range', min: '0', max: '100', step: '5', value: String(value), 'aria-label': 'Input sensitivity' });
  slider.addEventListener('input', () => { out.textContent = slider.value; });
  slider.addEventListener('change', () => setPref('inputSensitivity', Number(slider.value)));
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-row__text' },
      el('span', { class: 'setting-row__label' }, 'Input sensitivity'),
      el('span', { class: 'setting-row__hint' }, 'How easily your voice lights the green ring. Lower it if the ring lights on background noise; raise it if it misses quiet speech.')),
    el('div', { class: 'menu-slider', style: { padding: '0', minWidth: '200px' } }, slider, out));
}

function pushToTalkRow() {
  const current = String(store.ui.pushToTalk || '');
  const btn = el('button', { class: 'btn btn--sm', type: 'button' }, current ? `Key: ${current}` : 'Open mic (no key)');
  const clear = el('button', { class: 'btn btn--sm btn--ghost', type: 'button', hidden: !current }, 'Use open mic');
  btn.addEventListener('click', () => {
    btn.textContent = 'Press a key…';
    const onKey = (e) => { e.preventDefault(); window.removeEventListener('keydown', onKey, true); if (e.key === 'Escape') { btn.textContent = current ? `Key: ${current}` : 'Open mic (no key)'; return; } setPref('pushToTalk', e.key); btn.textContent = `Key: ${e.key}`; clear.hidden = false; };
    window.addEventListener('keydown', onKey, true);
  });
  clear.addEventListener('click', () => { setPref('pushToTalk', ''); btn.textContent = 'Open mic (no key)'; clear.hidden = true; });
  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-row__text' },
      el('span', { class: 'setting-row__label' }, 'Push to talk'),
      el('span', { class: 'setting-row__hint' }, 'Hold a key to transmit instead of an open microphone. Works while Voxara is the focused window.')),
    el('div', { style: { display: 'flex', gap: '8px' } }, btn, clear));
}

// ------------------------------------------------------------ email confirm

function verifyCard() {
  const card = el('div', { class: 'mfa-card' });
  const btn = el('button', { class: 'btn btn--sm btn--primary', type: 'button' }, 'Resend the email');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await net.request('auth:resend-verification');
      if (r.available === false) toastError('Email is not switched on for this server yet.');
      else toastSuccess(r.verified ? 'Already confirmed.' : 'Sent. Check your inbox and spam folder.');
    } catch (err) { toastError(err.message); btn.disabled = false; }
  });
  card.append(el('div', { class: 'mfa-card__row' },
    el('span', { class: 'mfa-card__dot' }),
    el('div', { class: 'mfa-card__text' },
      el('div', { class: 'mfa-card__title' }, 'Not confirmed yet'),
      el('div', { class: 'field__hint' }, 'We sent a link to your email address when you signed up. Confirming it means password resets and account notices can reach you.')),
    el('div', { class: 'mfa-card__actions' }, btn)));
  return card;
}

// ---------------------------------------------------------------- two-factor

/** Password + code prompt used by every change to an enabled setup. */
function mfaConfirm({ title, hint, confirmLabel, run }) {
  return new Promise((resolve) => {
    const password = el('input', { id: 'mfaPw', class: 'field__input', type: 'password', autocomplete: 'current-password', placeholder: 'Your password' });
    const code = el('input', { id: 'mfaCode', class: 'field__input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'Code from your app, or a backup code', maxlength: '11' });
    const go = el('button', { class: 'btn btn--primary', type: 'button' }, confirmLabel);
    const handle = openModal({
      title,
      body: el('div', {},
        hint ? el('p', { class: 'field__hint' }, hint) : null,
        labelledField({ id: 'mfaPw', label: 'Password', input: password }),
        labelledField({ id: 'mfaCode', label: 'Verification code', input: code })),
      initialFocus: 'input',
      actions: [el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => { handle.close(); resolve(false); } }, 'Cancel'), go],
    });
    go.addEventListener('click', async () => {
      go.disabled = true; handle.setError('');
      try { await run({ password: password.value, code: code.value.trim() }); handle.close(); resolve(true); }
      catch (err) { handle.setError(err.message || 'Something went wrong.'); go.disabled = false; }
    });
  });
}

/** The enrolment flow: password, then QR + code, then the backup codes. */
async function startMfaEnrolment(redraw) {
  const password = el('input', { id: 'mfaSetupPw', class: 'field__input', type: 'password', autocomplete: 'current-password', placeholder: 'Your password' });
  const next = el('button', { class: 'btn btn--primary', type: 'button' }, 'Continue');
  const first = openModal({
    title: 'Turn on two-factor authentication',
    body: el('div', {},
      el('p', { class: 'field__hint' }, 'You will need an authenticator app on your phone (any TOTP app works: Google Authenticator, Authy, 1Password, Bitwarden, Microsoft Authenticator). Confirm your password to begin.'),
      labelledField({ id: 'mfaSetupPw', label: 'Password', input: password })),
    initialFocus: 'input',
    actions: [el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => first.close() }, 'Cancel'), next],
  });
  let setup = null;
  await new Promise((resolve) => {
    next.addEventListener('click', async () => {
      next.disabled = true; first.setError('');
      try { setup = await net.request('mfa:setup', { password: password.value }); first.close(); resolve(); }
      catch (err) { first.setError(err.message); next.disabled = false; }
    });
    const orig = first.close;
    first.close = (...args) => { orig.apply(first, args); resolve(); };
  });
  if (!setup) return;

  const code = el('input', { id: 'mfaEnableCode', class: 'field__input mfa__input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '000000', maxlength: '7' });
  const verify = el('button', { class: 'btn btn--primary', type: 'button' }, 'Turn on');
  const secretBox = el('code', { class: 'mfa__secret' }, setup.secret.replace(/(.{4})/g, '$1 ').trim());
  const second = openModal({
    title: 'Scan this with your authenticator app',
    wide: true,
    body: el('div', { class: 'mfa__setup' },
      el('div', { class: 'mfa__qr' }, qrSvg(setup.otpauth, 208)),
      el('div', { class: 'mfa__steps' },
        el('p', { class: 'field__hint' }, 'Open your authenticator app, add an account, and scan the code. If you cannot scan, enter this key by hand:'),
        el('div', { class: 'mfa__secretrow' }, secretBox,
          el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onClick: async (e) => { try { await desktop.copyText(setup.secret); e.currentTarget.textContent = 'Copied'; } catch { /* manual */ } } }, 'Copy')),
        el('p', { class: 'field__hint' }, `Then enter the six-digit code the app shows for ${setup.issuer} (${setup.account}).`),
        labelledField({ id: 'mfaEnableCode', label: 'Verification code', input: code }))),
    initialFocus: '.mfa__input',
    actions: [el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => second.close() }, 'Cancel'), verify],
  });
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify.click(); });
  verify.addEventListener('click', async () => {
    verify.disabled = true; second.setError('');
    try {
      const result = await net.request('mfa:enable', { code: code.value.trim() });
      second.close();
      store.self = { ...store.self, ...result.user };
      store.emit('self');
      redraw();
      toastSuccess('Two-factor authentication is on. Your other devices were signed out.');
      await showOneTimeCodes(result.backupCodes, {
        title: 'Your backup codes',
        warn: 'If you lose your phone, one of these signs you in instead of the app. Each works once, and this is the only time they are shown.',
      });
    } catch (err) { second.setError(err.message); verify.disabled = false; code.select(); }
  });
}

function mfaCard() {
  const card = el('div', { class: 'mfa-card' });
  const draw = () => {
    card.replaceChildren();
    const on = Boolean(store.self?.mfaEnabled);
    const left = store.self?.mfaBackupCodesLeft ?? 0;
    const since = store.self?.mfaEnabledAt ? JOINED_FMT.format(new Date(store.self.mfaEnabledAt)) : null;
    card.append(
      el('div', { class: 'mfa-card__row' },
        el('span', { class: `mfa-card__dot${on ? ' is-on' : ''}` }),
        el('div', { class: 'mfa-card__text' },
          el('div', { class: 'mfa-card__title' }, on ? 'On' : 'Off'),
          el('div', { class: 'field__hint' }, on
            ? `Signing in needs a code from your authenticator app${since ? `, since ${since}` : ''}. ${left} backup code${left === 1 ? '' : 's'} left.`
            : 'Add a second step to signing in: a six-digit code from an authenticator app on your phone. Even someone with your password cannot get in without it.')),
        el('div', { class: 'mfa-card__actions' },
          on ? el('button', {
            class: 'btn btn--sm', type: 'button',
            onClick: async () => {
              let codes = null;
              const ok = await mfaConfirm({
                title: 'New backup codes', confirmLabel: 'Generate',
                hint: 'Your current backup codes stop working the moment new ones are made.',
                run: async ({ password, code }) => { const r = await net.request('mfa:backup-codes', { password, code }); codes = r.backupCodes; store.self = { ...store.self, ...r.user }; store.emit('self'); },
              });
              if (ok && codes) { draw(); await showOneTimeCodes(codes, { title: 'Your backup codes', warn: 'Each of these signs you in once if you lose your phone. This is the only time they are shown.' }); }
            },
          }, 'New backup codes') : null,
          on ? el('button', {
            class: 'btn btn--sm btn--danger', type: 'button',
            onClick: async () => {
              const ok = await mfaConfirm({
                title: 'Turn off two-factor authentication', confirmLabel: 'Turn off',
                hint: 'Your password alone will sign you in again. Confirm with your password and a current code.',
                run: async ({ password, code }) => { const r = await net.request('mfa:disable', { password, code }); store.self = { ...store.self, ...r.user }; store.emit('self'); },
              });
              if (ok) { draw(); toastSuccess('Two-factor authentication is off.'); }
            },
          }, 'Turn off') : el('button', {
            class: 'btn btn--sm btn--primary', type: 'button',
            onClick: () => startMfaEnrolment(draw),
          }, 'Turn on'))));
  };
  draw();
  return card;
}

// -------------------------------------------------------------- connections

const STEAM_STATE_LABEL = {
  'in-game': 'In-game', online: 'Online', busy: 'Do not disturb', away: 'Away', offline: 'Offline',
};

/**
 * The Steam connection panel. Unlinked it makes the pitch; linked it becomes
 * a small live card — avatar, presence and headline numbers filled in lazily
 * from the same steam:profile op the Gaming modal uses.
 */
/**
 * Where the account stands on 18+ access, and the one-time credit-card check
 * (Stripe) when the server requires it. Nothing here is a payment.
 */
function ageCard() {
  const self = store.self || {};
  const required = Boolean(self.ageVerification?.required);
  const wrap = el('div', { class: 'agecard' });
  if (self.ageVerified) {
    wrap.append(
      el('p', { class: 'field__hint' }, `Verified as 18 or over on ${JOINED_FMT.format(new Date(self.ageVerifiedAt || Date.now()))} with a credit card. Age-restricted spaces and channels are open to you.`));
    return wrap;
  }
  if (!required) {
    wrap.append(el('p', { class: 'field__hint' },
      self.over18
        ? 'Age-restricted areas use the date of birth you gave at sign-up. This server does not ask for anything more.'
        : 'Your date of birth says you are under 18, so age-restricted spaces and channels stay hidden until then.'));
    return wrap;
  }
  if (!self.over18) {
    wrap.append(el('p', { class: 'field__hint' }, 'Your date of birth says you are under 18. Age-restricted spaces and channels open on your 18th birthday, after a quick credit-card check.'));
    return wrap;
  }
  const btn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Verify with a credit card');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await startAgeVerification(); btn.textContent = 'Finish in your browser…'; }
    catch (err) { btn.disabled = false; toastError(err.message || 'Could not start the check.'); }
  });
  wrap.append(
    el('p', { class: 'field__hint' },
      'Age-restricted spaces and channels need a one-time check that you are 18 or over. '
      + 'A credit card is checked through Stripe: nothing is charged, the card is not saved, and Voxara never sees the number. '
      + 'No photo and no ID. Debit and prepaid cards do not count, because under-18s can hold those.'),
    el('div', { class: 'settings__actions' }, btn));
  return wrap;
}

function steamCard() {
  const card = el('div', { class: 'steam-card' });
  let epoch = 0; // a redraw invalidates any fetch still in flight

  const perk = (text) => el('div', { class: 'steam-card__perk' }, icon('check', { size: 13 }), text);
  const stat = (label) => {
    const value = el('span', { class: 'steam-card__stat-value' }, '—');
    const cell = el('div', { class: 'steam-card__stat' },
      value, el('span', { class: 'steam-card__stat-label' }, label));
    cell.__value = value;
    return cell;
  };

  const draw = () => {
    const mine = ++epoch;
    card.replaceChildren();
    const linked = store.self.steamLinked;

    if (!linked) {
      card.append(
        el('div', { class: 'steam-card__head' },
          el('span', { class: 'steam-card__mark' }, icon('steam', { size: 22 })),
          el('div', { class: 'steam-card__who' },
            el('span', { class: 'steam-card__title' }, 'Steam'),
            el('span', { class: 'steam-card__state' }, 'Not linked'))),
        el('div', { class: 'steam-card__perks' },
          perk('Now-playing presence on your profile'),
          perk('A gaming profile your friends can open'),
          perk('Your wishlist — one click from a gift')),
        el('div', { class: 'steam-card__notice' },
          el('strong', {}, 'Before you link: '),
          'your friends on Voxara will be able to see your Steam profile name, your wishlist, '
          + 'your hours played per game and your hours over the past two weeks.'),
        el('div', { class: 'steam-card__foot' },
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Link your Steam account?',
                message: 'Friends on Voxara will be able to see your Steam profile name, your wishlist, '
                  + 'your hours played on each game and your hours over the past two weeks. '
                  + 'You can unlink at any time from this page.',
                confirmLabel: 'Continue to Steam',
              });
              if (!ok) return;
              try { await linkSteam(); toastSuccess('Finish signing in through Steam in your browser.'); }
              catch (err) { toastError(err.message || 'Steam linking is not enabled on this server.'); }
            },
          }, 'Sign in through Steam'),
          el('span', { class: 'steam-card__fine' },
            'Steam’s own sign-in — we never see your password, and your Steam privacy settings are honoured.')));
      return;
    }

    const steam = store.self.steam || {};
    const mark = el('span', { class: 'steam-card__mark' }, icon('steam', { size: 22 }));
    const title = el('span', { class: 'steam-card__title' }, steam.personaName || 'Steam');
    const presence = el('span', { class: 'steam-card__presence', hidden: true }, el('span', { class: 'steam-card__dot' }), '');
    const cells = [stat('Games'), stat('Hours on record'), stat('Past two weeks')];

    card.append(
      el('div', { class: 'steam-card__head' },
        mark,
        el('div', { class: 'steam-card__who' },
          title,
          el('span', { class: 'steam-card__state' },
            steam.linkedAt ? `Linked ${JOINED_FMT.format(new Date(steam.linkedAt))}` : 'Linked'),
          presence)),
      el('div', { class: 'steam-card__stats' }, ...cells),
      el('div', { class: 'steam-card__foot' },
        el('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: () => showGamingProfile(store.selfId) }, 'Gaming profile'),
        el('button', {
          class: 'btn btn--sm', type: 'button',
          onClick: () => desktop.openExternal(`https://steamcommunity.com/profiles/${steam.id}`),
        }, 'Open on Steam'),
        el('span', { class: 'steam-card__spacer' }),
        el('button', {
          class: 'btn btn--sm btn--ghost steam-card__unlink', type: 'button',
          onClick: async () => { await unlinkSteam(); },
        }, 'Unlink')));

    // Live details — best effort; the card is complete without them.
    void fetchSteamProfile(store.selfId).then((p) => {
      if (mine !== epoch || !card.isConnected) return;
      if (p.avatar) mark.replaceChildren(el('img', { class: 'steam-card__avatar', src: p.avatar, alt: '', draggable: 'false' }));
      if (p.persona) title.textContent = p.persona;
      const state = p.state || (p.nowPlaying ? 'in-game' : null);
      if (state) {
        presence.hidden = false;
        presence.className = `steam-card__presence steam-card__presence--${state}`;
        presence.replaceChildren(el('span', { class: 'steam-card__dot' }),
          p.nowPlaying ? `In-game — ${p.nowPlaying}` : (STEAM_STATE_LABEL[state] || ''));
      }
      cells[0].__value.textContent = p.totalGames.toLocaleString();
      if (p.totalHours != null) cells[1].__value.textContent = p.totalHours.toLocaleString();
      if (p.recentHours != null) cells[2].__value.textContent = `${p.recentHours.toLocaleString()} h`;
    }).catch(() => { /* server can't reach Steam right now — basics stand */ });
  };

  draw();
  store.on('self', draw);
  return card;
}

// --------------------------------------------------------------- appearance

function appearancePane(pane) {
  pane.append(
    section('Theme', themeGallery(),
      el('p', { class: 'field__hint' },
        'Pick a look, or make your own and share it with everyone on this server.')),

    section('Message density', choiceRow([
      { value: 'comfortable', label: 'Comfortable', hint: 'Roomy spacing' },
      { value: 'compact', label: 'Compact', hint: 'More on screen' },
    ], store.ui.density, (v) => setPref('density', v))),

    section('Sidebar layout', choiceRow([
      { value: 'tiles', label: 'Tiles', hint: 'Icon above the name' },
      { value: 'rows', label: 'Single line', hint: 'One row per space and friend' },
      { value: 'rail', label: 'Side rail', hint: 'Icon column down the left: friends and Steam on top, spaces in the middle, new and join at the bottom' },
    ], store.ui.sidebarLayout, (v) => setPref('sidebarLayout', v))),

    section('Message size', choiceRow([
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ], store.ui.fontSize, (v) => setPref('fontSize', v))),

    section('Layout',
      prefToggle('showMembers', 'Show the member list', 'The panel of members beside a channel.'),
      prefToggle('inlineImages', 'Show images in the conversation',
        'Off shows attachments as file rows instead.')),

    el('p', { class: 'field__hint' }, 'Appearance is saved to this computer, not your account.'),
  );
}

// -------------------------------------------------------------------- chat

function chatPane(pane) {
  pane.append(
    section('Voice',
      prefToggle('noiseSuppression', 'Noise suppression', 'Strip keyboard clatter and background hum from your microphone. Turn off for music.'),
      prefToggle('echoCancellation', 'Echo cancellation', 'Stop your speakers feeding back into your microphone.'),
      sensitivityRow(),
      pushToTalkRow()),
    section('In-game overlay',
      el('p', { class: 'field__hint' },
        'A small corner display over your game showing who is in the call and who is talking, like the voice list in the sidebar. '
        + 'Works over games in windowed or borderless fullscreen mode. Exclusive fullscreen games cover it, so switch the game to borderless if you want it visible while recording.'),
      choiceRow([
        { value: 'game', label: 'While playing', hint: 'Shows when a game is running' },
        { value: 'always', label: 'Every call', hint: 'Whenever you are in a call' },
        { value: 'off', label: 'Off' },
      ], store.ui.gameOverlay || 'game', (v) => setPref('gameOverlay', v)),
      el('p', { class: 'field__label', style: { marginTop: '12px' } }, 'Position'),
      choiceRow([
        { value: 'top-left', label: 'Top left' },
        { value: 'top-right', label: 'Top right' },
        { value: 'bottom-left', label: 'Bottom left' },
        { value: 'bottom-right', label: 'Bottom right' },
      ], store.ui.overlayCorner || 'top-left', (v) => setPref('overlayCorner', v))),
    section('Sending', choiceRow([
      { value: 'enter', label: 'Enter sends', hint: 'Shift+Enter for a new line' },
      { value: 'ctrl-enter', label: 'Ctrl+Enter sends', hint: 'Enter makes a new line' },
    ], store.ui.sendKey, (v) => setPref('sendKey', v))),

    section('Reading',
      prefToggle('groupTimestamps', 'Always show timestamps',
        'Otherwise a time appears when you hover a message.'),
      prefToggle('autoLoadOlder', 'Load older messages automatically',
        'Off adds a button at the top of the conversation instead.')),

    section('Safety',
      prefToggle('confirmDelete', 'Ask before deleting a message',
        'Turning this off deletes immediately.')),
  );
}

// ------------------------------------------------------------ notifications

/** The Web Push switch for the browser, Android and iPhone builds. */
function pushSection() {
  if (!pushSupported()) {
    return section('Notifications when the app is closed',
      el('p', { class: 'field__hint' }, /iphone|ipad/i.test(navigator.userAgent)
        ? 'On iPhone, notifications while Voxara is closed need the app added to your home screen (Share, then Add to Home Screen), then turn this on from the installed app.'
        : 'This browser does not support notifications while the page is closed. The desktop app and the Android app do.'));
  }
  const state = pushState();
  const row = toggleRow({
    label: 'Notify me when Voxara is closed',
    hint: state === 'denied'
      ? 'Notifications are blocked for this site in your browser settings. Allow them there, then turn this on.'
      : 'DMs, mentions and replies arrive as system notifications on this device even when Voxara is not open. Nothing else is sent, and the push service only ever sees encrypted text.',
    value: state === 'on',
    onChange: async (v) => {
      try {
        const next = v ? await enablePush() : await disablePush();
        if (v && next !== 'on') toastError(next === 'denied' ? 'Notifications are blocked in the browser. Allow them for voxaraspace.com and try again.' : 'Permission was not given.');
        else toastSuccess(v ? 'You will be notified on this device.' : 'Notifications on this device are off.');
      } catch (err) { toastError(err.message || 'Could not change that.'); }
    },
  });
  return section('Notifications when the app is closed', row);
}

function notificationsPane(pane) {
  pane.append(
    pushSection(),
    section('Desktop notifications', choiceRow([
      { value: 'all', label: 'Everything', hint: 'Every new message' },
      { value: 'mentions', label: 'Mentions & DMs', hint: 'Recommended' },
      { value: 'none', label: 'Nothing', hint: 'Stay silent' },
    ], store.ui.notifications, (v) => setPref('notifications', v))),

    section('Sound',
      prefToggle('notificationSound', 'Play a sound for DMs, mentions and replies',
        'A short chime whenever a message is addressed to you and you are not looking at that conversation. Works from another tab or window.'),
      el('div', { class: 'settings__actions' },
        el('button', { class: 'btn btn--sm', type: 'button', onClick: () => { import('./sound.js').then((m) => m.playNotificationSound({ force: true })); } }, 'Play the sound'))),

    section('Behaviour',
      prefToggle('notificationPreview', 'Show the message in the notification',
        'Off shows only who it is from.'),
      prefToggle('flashTaskbar', 'Flash the taskbar button',
        'When a notification arrives and Voxara is not focused.'),
      prefToggle('minimizeToTray', 'Keep Voxara in the tray when closed',
        'Closing the window hides it to the system tray instead of quitting.')),

    el('p', { class: 'field__hint' },
      'Notifications never fire for the conversation you are looking at, and '
      + 'Focus mode (the moon, top-right) silences them entirely.'),
  );
}

// ----------------------------------------------------------------- privacy

function privacyPane(pane, handle) {
  const allow = store.self.allowRequests !== false;

  pane.append(
    section('Accessibility',
      toggleRow({
        label: 'Reduce flashing & motion',
        hint: 'For photosensitivity: GIFs and animated emoji won’t autoplay (tap to play), '
          + 'animated link thumbnails are hidden, and app animations are turned off.',
        value: store.self.reduceFlashing === true,
        onChange: async (value) => {
          handle.setError('');
          try {
            await updateProfile({ reduceFlashing: value });
          } catch (err) {
            handle.setError(err.message);
          }
        },
      }),
      el('p', { class: 'field__hint' },
        'This stops flashing content from playing on its own — it is a safeguard, '
        + 'not a medical guarantee. Take your own precautions with anything you choose to play.')),

    section('Friend requests',
      toggleRow({
        label: 'Let anyone send me a friend request',
        hint: 'Off means nobody new can add you; existing friends are unaffected.',
        value: allow,
        onChange: async (value) => {
          handle.setError('');
          try {
            await updateProfile({ allowRequests: value });
          } catch (err) {
            handle.setError(err.message);
          }
        },
      })),

    section('Who can message you',
      choiceRow([
        { value: 'everyone', label: 'Everyone', hint: 'Anyone on the server can start a DM with you.' },
        { value: 'friends', label: 'Friends only', hint: 'Only people you have added as friends.' },
        { value: 'nobody', label: 'No one', hint: 'No new direct messages or calls reach you.' },
      ], store.self.dmPrivacy || 'everyone', async (value) => {
        handle.setError('');
        try { await updateProfile({ dmPrivacy: value }); }
        catch (err) { handle.setError(err.message); }
      }),
      el('p', { class: 'field__hint' },
        'The server enforces this — it is not just hidden in the app. "No one" also '
        + 'stops incoming calls.')),

    section('Gaming activity',
      toggleRow({
        label: 'Show my current game to friends',
        hint: 'Off stops your current Steam game reaching friends at all — the sidebar '
          + 'list and your gaming profile both stop showing it, even to someone who opens it directly.',
        value: store.self.shareGameActivity !== false,
        onChange: async (value) => {
          handle.setError('');
          try {
            await updateProfile({ shareGameActivity: value });
          } catch (err) {
            handle.setError(err.message);
          }
        },
      }),
      toggleRow({
        label: "Show friends' current games",
        hint: 'Off just hides it from your own view — a friend list without the "in-game" line.',
        value: store.ui.showFriendGames,
        onChange: (value) => setPref('showFriendGames', value),
      })),

    section('Your data',
      el('p', { class: 'field__hint' },
        'Everything you send lives only on the Voxara server you are connected to. '
        + 'Nothing is sent anywhere else, and there is no analytics or telemetry.'),
      el('div', { class: 'settings__actions' },
        (() => {
          const btn = el('button', { class: 'btn btn--sm', type: 'button' }, 'Export my data');
          btn.addEventListener('click', async () => {
            btn.classList.add('is-busy');
            try {
              const data = await exportMyData();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = el('a', { href: url, download: `pulse-data-${new Date().toISOString().slice(0, 10)}.json` });
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 2000);
              toastSuccess('Your data was exported.');
            } catch (err) {
              toastError(err.message || 'Could not export your data.');
            } finally {
              btn.classList.remove('is-busy');
            }
          });
          return btn;
        })())),
  );
}

// --------------------------------------------------------------- shortcuts

function guidePane(pane, handle) {
  pane.append(section('The tour',
    el('p', { class: 'field__hint' },
      'A guided walk through the buttons around the app — the sidebar, the titlebar, the composer and more.'),
    el('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: () => {
      handle?.close?.();
      void import('./tour.js').then((m) => m.startTour());
    } }, 'Start the tour')));
}

function shortcutsPane(pane) {
  const grid = el('div', { class: 'shortcut-grid' });
  for (const [heading, rows] of SHORTCUT_SECTIONS) {
    grid.appendChild(el('h4', {}, heading));
    for (const [label, keys] of rows) {
      grid.appendChild(el('div', { class: 'shortcut' },
        el('span', {}, label),
        el('span', { class: 'shortcut__keys' }, ...keys.map((k) => key(k)))));
    }
  }
  pane.append(section('Keyboard', grid));
}


// ----------------------------------------------------------------- advanced

function advancedPane(pane, handle) {
  const self = store.self;

  const idField = el('div', { class: 'copyfield' },
    el('code', { class: 'copyfield__value' }, self.id),
    el('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: () => copyToClipboard(self.id, 'Account ID'),
    }, 'Copy'));

  const reset = el('button', { class: 'btn btn--danger', type: 'button' }, 'Reset preferences');
  reset.addEventListener('click', () => {
    for (const [key, value] of Object.entries(PREF_DEFAULTS)) {
      // Leave account-scoped groupings alone; this is about display prefs.
      if (key === 'spaceNotify') continue;
      setPref(key, value);
    }
    toastSuccess('Preferences reset to defaults.');
    handle.close();
  });

  const updateRow = el('div', { class: 'update-check' },
    el('span', { class: 'update-check__ver' }, 'Checking version…'),
    el('div', { class: 'update-check__btns' },
      el('button', { class: 'btn btn--sm', type: 'button', onClick: () => showWhatsNew() }, 'What’s new'),
      el('button', { class: 'btn btn--sm', type: 'button' }, 'Check for updates')));
  const verText = updateRow.children[0];
  const checkBtn = updateRow.querySelector('.update-check__btns').children[1];
  desktop.updates?.version?.().then((v) => { verText.textContent = `Voxara ${v}`; })
    .catch(() => { verText.textContent = 'Voxara'; });
  checkBtn.addEventListener('click', async () => {
    checkBtn.classList.add('is-busy');
    try { await checkForUpdatesUI(); } finally { checkBtn.classList.remove('is-busy'); }
  });

  // Other builds the server offers: go back a version after a bad update, or
  // forward again. Everything below the security floor is never listed.
  const versionsBox = el('div', { class: 'versions' }, el('p', { class: 'field__hint' }, 'Loading…'));
  desktop.updates?.versions?.().then((info) => {
    versionsBox.replaceChildren();
    if (!info?.supported) { versionsBox.appendChild(el('p', { class: 'field__hint' }, 'Switching versions applies to the installed Windows app.')); return; }
    if (info.error) { versionsBox.appendChild(el('p', { class: 'field__hint' }, `Could not reach the update server: ${info.error}`)); return; }
    if (info.hold) versionsBox.appendChild(el('p', { class: 'field__hint' }, `You chose to stay on ${info.current.version}. Newer versions wait until you pick one below, unless a security update makes updating required.`));
    if (!info.history.length) { versionsBox.appendChild(el('p', { class: 'field__hint' }, 'No other version is on offer right now.')); return; }
    for (const entry of info.history) {
      versionsBox.appendChild(el('div', { class: 'setting-row' },
        el('div', { class: 'setting-row__text' },
          el('div', { class: 'setting-row__label' }, `Voxara ${entry.version}`, entry.newer ? el('span', { class: 'tag', style: { marginLeft: '8px' } }, 'newer') : null),
          entry.notes ? el('div', { class: 'field__hint' }, entry.notes.slice(0, 160)) : null),
        el('button', { class: `btn btn--sm${entry.newer ? ' btn--primary' : ''}`, type: 'button', onClick: () => switchVersionUI(entry) }, entry.newer ? 'Update' : 'Go back')));
    }
  }).catch(() => { versionsBox.replaceChildren(el('p', { class: 'field__hint' }, 'Could not list versions.')); });

  pane.append(
    section('Software update',
      el('p', { class: 'field__hint' },
        'Voxara checks for a new version on launch. You can also check now.'),
      updateRow),
    section('Other versions',
      el('p', { class: 'field__hint' }, 'If an update broke something for you, go back to the previous version here and wait for the fix. Versions older than the current security floor are not offered.'),
      versionsBox),
    section('Developer mode',
      prefToggle('developerMode', 'Enable developer mode',
        'Shows technical identifiers — like the Copy ID options on people and messages.')),
    section('Your account ID',
      el('p', { class: 'field__hint' },
        'A stable numeric identifier for your account. Handy for support or reporting a bug.'),
      idField),
    section('Reset',
      el('p', { class: 'field__hint' },
        'Put every appearance and behaviour preference on this computer back to its default. '
        + 'Your account, spaces and messages are untouched.'),
      el('div', { class: 'settings__actions' }, reset)),
  );
}

// ------------------------------------------------------------- Voxara Plus

function membershipLine(sub) {
  if (!sub) return 'Thank you for supporting Voxara.';
  if (!sub.expiresAt) return 'Active — thank you for keeping Voxara independent.';
  const until = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(sub.expiresAt));
  return `Active until ${until}.`;
}

function plusPane(pane) {
  const body = el('div', { class: 'plus-page' }, el('p', { class: 'field__hint' }, 'Loading…'));
  pane.append(body);

  getBilling().then(({ premium, subscription, plan }) => {
    clear(body);
    if (!plan) {
      body.append(el('p', { class: 'field__hint' }, 'Voxara Plus is not available on this server.'));
      return;
    }

    const cur = plan.price?.currency === 'USD' ? '$' : '';
    const price = plan.price ? `${cur}${plan.price.amount}/${plan.price.interval}` : '';

    body.append(
      el('div', { class: 'plus-hero' + (premium ? ' plus-hero--member' : '') },
        el('div', { class: 'plus-hero__icon' }, icon('sparkle')),
        el('div', { class: 'plus-hero__text' },
          el('div', { class: 'plus-hero__title' },
            premium ? 'You’re a Voxara Plus member' : plan.name,
            premium ? el('span', { class: 'textbadge badge--plus' }, 'Plus') : null),
          el('div', { class: 'plus-hero__tagline' },
            premium ? membershipLine(subscription) : plan.tagline)),
      ),
    );

    const perks = el('div', { class: 'plus-perks' });
    for (const p of plan.perks) {
      perks.append(el('div', { class: 'plus-perk' + (premium ? ' plus-perk--on' : '') },
        // Prefer the SVG key; an older server without one falls back to the
        // sparkle rather than printing whatever text it sent.
        el('span', { class: 'plus-perk__icon' }, icon(/^[a-z]+$/.test(p.iconKey || '') ? p.iconKey : 'sparkle')),
        el('div', { class: 'plus-perk__body' },
          el('div', { class: 'plus-perk__title' }, p.title),
          el('div', { class: 'plus-perk__desc' }, p.desc)),
      ));
    }
    body.append(section(premium ? 'What you get' : 'What’s included', perks));

    if (!premium) {
      const live = Boolean(plan.checkout?.available);
      const cta = el('button', {
        class: 'btn btn--primary plus-cta',
        type: 'button',
        onClick: () => toastSuccess(live
          ? 'Opening secure checkout…'
          : 'Voxara Plus is coming soon — it’s optional, and everything you need stays free.'),
      }, live ? `Upgrade — ${price}` : 'Notify me when it’s ready');
      // Fine print above the button, so it never sits clipped against the
      // modal's footer.
      body.append(
        el('p', { class: 'field__hint plus-fineprint' },
          'Plus never unlocks anything you need to take part. Every core feature — spaces, '
          + 'messaging, calls, uploads, moderation — is free for everyone, always.'),
        el('div', { class: 'settings__actions' }, cta),
      );
    }
  }).catch(() => {
    clear(body);
    body.append(el('p', { class: 'field__hint' }, 'Could not load Voxara Plus right now.'));
  });
}

// ------------------------------------------------------------------- bots

function botsPane(pane) {
  const portalUrl = `${(store.server?.publicUrl || (net.url || '').replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://')).replace(/\/+$/, '')}/developers/`;
  pane.append(
    section('Bots have moved',
      el('p', { class: 'field__hint' },
        'Creating and managing bots — tokens, resets, adding them to spaces — now happens in the '
        + 'Developer Portal, a separate area outside the app itself, so bot credentials live in one '
        + 'place instead of being split across the app and elsewhere.'),
      el('div', { class: 'settings__actions' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: () => desktop.openExternal(portalUrl),
        }, 'Open Developer Portal'))),
  );
}

Object.assign(PANES, {
  profile: profilePane,
  account: accountPane,
  privacy: privacyPane,
  appearance: appearancePane,
  chat: chatPane,
  notifications: notificationsPane,
  invite: (pane) => pane.append(section('Invite friends', referralCard())),
  plus: plusPane,
  advanced: advancedPane,
  guide: guidePane,
  shortcuts: shortcutsPane,
  bots: botsPane,
});
