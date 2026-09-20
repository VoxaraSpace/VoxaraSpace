import { el } from '../utils.js';
import { icon } from '../icons.js';
import { normalizeServerUrl } from '../net.js';
import { openModal } from './overlay.js';
import { setConnectionState } from './titlebar.js';
import { net, getSetting, setSettings, runtime, desktop} from '../client.js';
import { toast } from './toast.js';

// The address is part of the build; nobody types it in. Read lazily because
// loadRuntime() replaces the runtime object after this module is imported.
const serverUrl = () => normalizeServerUrl(runtime.defaultServerUrl);

let mode = 'login';

/** Whole years old from a YYYY-MM-DD string. */
function ageFromInput(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return 0;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age;
}
/** Set from the server's rejection, so the field appears exactly when needed. */
let inviteRequired = false;
let onAuthenticated = () => {};
let busy = false;

const fields = {};

export function mountAuth(callback) {
  onAuthenticated = callback;

  fields.form = document.getElementById('authForm');
  fields.title = document.getElementById('authTitle');
  fields.subtitle = document.getElementById('authSubtitle');
  fields.early = document.getElementById('authEarly');
  fields.displayNameGroup = document.getElementById('fieldDisplayName');
  fields.displayName = document.getElementById('authDisplayName');
  fields.emailGroup = document.getElementById('fieldEmail');
  fields.email = document.getElementById('authEmail');
  fields.birthdateGroup = document.getElementById('fieldBirthdate');
  fields.birthdate = document.getElementById('authBirthdate');
  fields.username = document.getElementById('authUsername');
  fields.password = document.getElementById('authPassword');
  fields.error = document.getElementById('authError');
  fields.status = document.getElementById('authStatus');
  fields.submit = document.getElementById('authSubmit');
  fields.switch = document.getElementById('authSwitch');
  fields.switchText = document.getElementById('authSwitchText');
  fields.reveal = document.getElementById('authReveal');
  fields.inviteGroup = document.getElementById('fieldInviteCode');
  fields.referralGroup = document.getElementById('fieldReferral');
  fields.referral = document.getElementById('authReferral');
  // A referral code carried in by a link (/r/CODE -> /app/?ref=CODE) or the download page.
  try { const ref = new URLSearchParams(location.search).get('ref') || localStorage.getItem('voxara:ref'); if (ref && /^[A-Za-z0-9]{8}$/.test(ref)) { fields.referral.value = ref.toUpperCase(); localStorage.setItem('voxara:ref', ref.toUpperCase()); } } catch { /* no storage */ }
  fields.inviteCode = document.getElementById('authInviteCode');
  fields.recoveryGroup = document.getElementById('fieldRecoveryCode');
  fields.recoveryCode = document.getElementById('authRecoveryCode');
  fields.forgotRow = document.getElementById('authForgotRow');
  fields.forgot = document.getElementById('authForgot');

  fields.username.value = getSetting('lastUsername', '');
  if (fields.username.value) fields.password.focus();

  void findServer();

  fields.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });

  fields.switch.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
  fields.forgot.addEventListener('click', () => setMode(mode === 'recover' ? 'login' : 'recover'));
  // The other way back in: a reset link by email, when the server can send mail.
  document.getElementById('authEmailReset')?.addEventListener('click', async () => {
    const username = fields.username.value.trim();
    if (!username) { showError('Enter your username (or email address) first.'); fields.username.focus(); return; }
    setBusy(true); showError('');
    try {
      if (!net.isOpen) await net.connect(serverUrl());
      const result = await net.request('auth:forgot', { username });
      if (result.available === false) {
        showError('Email resets are not switched on for this server yet. Use one of your recovery codes, or contact support@voxaraspace.com.');
      } else {
        setStatus('If that account has an email address, a reset link is on its way. It works once and expires in 30 minutes.');
      }
    } catch (err) {
      showError(err.message || 'Could not request a reset link.');
    } finally {
      setBusy(false);
    }
  });

  // The title bar is hidden while signed out, so the card carries its own.
  document.getElementById('authWinMinimize').addEventListener('click', () => desktop.minimize());
  document.getElementById('authWinClose').addEventListener('click', () => desktop.close());

  fields.reveal.addEventListener('click', () => {
    const showing = fields.password.type === 'text';
    fields.password.type = showing ? 'password' : 'text';
    fields.reveal.textContent = showing ? 'Show' : 'Hide';
    fields.reveal.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    fields.password.focus();
  });

  setMode('login');
}

const TITLES = {
  login: ['Welcome back', 'Sign in to pick up where you left off.', 'Sign in'],
  register: ['Create your account', 'A few details and you are in.', 'Create account'],
  recover: ['Reset your password', 'Use one of the recovery codes you saved.', 'Reset password'],
};

function setMode(next) {
  mode = next;
  const registering = mode === 'register';
  const recovering = mode === 'recover';

  const [title, subtitle, submit] = TITLES[mode] || TITLES.login;
  fields.title.textContent = title;
  fields.subtitle.textContent = subtitle;
  fields.submit.textContent = submit;

  fields.displayNameGroup.hidden = !registering;
  fields.emailGroup.hidden = !registering;
  fields.birthdateGroup.hidden = !registering;
  // Only shown once the server has said it is invite only, so an open server
  // never asks for something nobody has.
  fields.inviteGroup.hidden = !(registering && inviteRequired);
  fields.referralGroup.hidden = !registering;
  fields.recoveryGroup.hidden = !recovering;
  fields.forgotRow.hidden = registering;
  fields.forgot.textContent = recovering ? 'Back to sign in' : 'Forgot your password?';

  if (fields.early) fields.early.hidden = true;
  if (registering) void refreshEarlyHint();

  fields.switchText.textContent = registering ? 'Already have an account?' : 'New here?';
  fields.switch.textContent = registering ? 'Sign in instead' : 'Create an account';
  fields.password.placeholder = recovering ? 'Choose a new password' : 'At least 8 characters';
  fields.password.autocomplete = (registering || recovering) ? 'new-password' : 'current-password';

  showError('');
  if (registering) fields.displayName.focus();
  else if (recovering) fields.username.focus();
  else fields.username.focus();
}

function showError(message) {
  fields.error.textContent = message || '';
  fields.error.hidden = !message;
}

// ------------------------------------------------------------- ban appeals
// A suspended account's one channel back in. The appeal op re-checks the
// password server-side, so only the account owner can file one.
function removeAppealPanel() {
  document.getElementById('appealPanel')?.remove();
}

function offerAppeal(username, password) {
  removeAppealPanel();
  const text = el('textarea', {
    class: 'appeal__text', rows: '3', maxLength: '2000',
    placeholder: 'Tell the staff why the ban should be lifted (a sentence or two)…',
  });
  const note = el('p', { class: 'appeal__note' }, '');
  const send = el('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Send appeal');
  const panel = el('div', { class: 'appeal', id: 'appealPanel' },
    el('p', { class: 'appeal__hint' }, 'You can appeal this suspension. Staff read every appeal.'),
    text, el('div', { class: 'appeal__foot' }, note, send));

  const setNote = (message, kind = '') => {
    note.textContent = message || '';
    note.className = `appeal__note${kind ? ` appeal__note--${kind}` : ''}`;
  };
  // Clear a validation note as soon as they start fixing it.
  text.addEventListener('input', () => { if (note.textContent) setNote(''); });

  send.addEventListener('click', async () => {
    const message = text.value.trim();
    if (message.length < 10) {
      setNote('Please write at least a sentence (10 characters or more).', 'err');
      text.focus();
      return;
    }
    send.disabled = true;
    setNote('Sending…');
    try {
      await net.request('appeal:server', { username, password, message });
      panel.replaceChildren(el('p', { class: 'appeal__hint appeal__hint--sent' },
        'Appeal sent. Staff will review it — if the ban is lifted you can just sign in again.'));
    } catch (err) {
      send.disabled = false;
      setNote(err.message || 'Could not send the appeal. Please try again.', 'err');
    }
  });
  fields.error.insertAdjacentElement('afterend', panel);
}

function setStatus(message) {
  fields.status.textContent = message || '';
}

function setBusy(value) {
  busy = value;
  fields.submit.classList.toggle('is-busy', value);
  fields.submit.disabled = value;
}

/**
 * Checks the one server this build talks to. There is no address for anyone to
 * correct, so a failure is reported as what it actually is — the server being
 * unreachable — and retried on its own.
 */
async function findServer() {
  setStatus('Connecting…');
  setConnectionState('connecting');

  if (await canReach(serverUrl())) {
    setStatus('');
    setConnectionState('online');
    return serverUrl();
  }

  setStatus('');
  setConnectionState('offline', 'Server unreachable');
  showError('Cannot reach the Voxara server. Check your internet connection — retrying…');
  scheduleRetry();
  return null;
}

/** Keeps trying quietly, so the app recovers without anyone reloading it. */
let retryTimer = null;
let retryDelay = 3000;
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (await canReach(serverUrl())) {
      retryDelay = 3000;
      showError('');
      setStatus('');
      setConnectionState('online');
      return;
    }
    retryDelay = Math.min(retryDelay * 2, 30000);
    scheduleRetry();
  }, retryDelay);
}

/** The server refused this build: fetch the current one and install it. */
async function forceUpdate() {
  try {
    const r = await desktop.updates.check();
    if (r?.status === 'available') await desktop.updates.install();
    else showError('This version of Voxara is no longer supported. Download the current version from voxaraspace.com/download.');
  } catch { /* the message above stays on screen */ }
}

/** A cheap liveness probe that does not disturb the real connection. */
function canReach(url) {
  return new Promise((resolve) => {
    let socket;
    const done = (ok) => {
      try {
        socket?.close();
      } catch { /* ignore */ }
      resolve(ok);
    };
    try {
      socket = new WebSocket(url);
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => done(false), 1200);
    socket.onopen = () => {
      clearTimeout(timer);
      done(true);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      done(false);
    };
  });
}

// Best-effort: show how many Early Supporter badges are left, to nudge sign-ups.
async function refreshEarlyHint() {
  if (!fields.early) return;
  try {
    if (!net.isOpen) await net.connect(serverUrl());
    const info = await net.request('early-supporter:status');
    if (info && info.remaining > 0) {
      fields.early.textContent = `Be one of the first — ${info.remaining} of ${info.limit} Early Supporter badges left.`;
      fields.early.hidden = false;
    } else {
      fields.early.hidden = true;
    }
  } catch {
    fields.early.hidden = true; // offline or unsupported — no nudge, no error
  }
}

async function submit() {
  if (busy) return;
  showError('');
  removeAppealPanel();

  const url = serverUrl();
  const username = fields.username.value.trim().toLowerCase();
  const password = fields.password.value;

  if (!username) return showError('Enter your username.');
  if (!password) return showError(mode === 'recover' ? 'Choose a new password.' : 'Enter your password.');
  if (mode === 'register') {
    const email = fields.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Enter a valid email address.');
    if (!fields.birthdate.value) return showError('Enter your date of birth.');
    if (ageFromInput(fields.birthdate.value) < 13) return showError('You must be at least 13 to sign up.');
  }
  if (mode === 'register' && !fields.displayName.value.trim()) {
    return showError('Pick a display name — it is how people will see you.');
  }
  if (mode === 'recover' && !fields.recoveryCode.value.trim()) {
    return showError('Enter one of your recovery codes.');
  }

  setBusy(true);
  setStatus('Connecting…');

  try {
    if (!net.isOpen || net.url !== url) {
      net.disconnect();
      await net.connect(url);
    }

    setStatus({
      register: 'Creating your account…',
      recover: 'Checking your recovery code…',
      login: 'Signing in…',
    }[mode]);

    let ready;
    if (mode === 'register') {
      ready = await net.request('auth:register', {
        client: net.clientInfo || undefined,
        username,
        displayName: fields.displayName.value.trim(),
        email: fields.email.value.trim(),
        birthdate: fields.birthdate.value,
        password,
        inviteCode: fields.inviteCode.value.trim(),
        ref: fields.referral.value.trim().toUpperCase() || undefined,
      });
      try { localStorage.removeItem('voxara:ref'); } catch { /* no storage */ }
    } else if (mode === 'recover') {
      ready = await net.request('auth:recover', {
        username,
        code: fields.recoveryCode.value.trim(),
        newPassword: password,
      });
    } else {
      ready = await net.request('auth:login', { username, password, client: net.clientInfo || undefined });
      // Two-factor: the password was right, now the code from the app.
      if (ready?.mfaRequired) {
        setStatus('');
        ready = await promptMfaCode(ready.ticket);
        if (!ready) return; // cancelled
        setStatus('Signing in…');
      }
    }

    net.token = ready.token;
    net.mediaToken = ready.mediaToken || null;
    setSettings({ lastUsername: username, token: ready.token, mediaToken: ready.mediaToken || null });
    setStatus('');
    fields.password.value = '';
    fields.recoveryCode.value = '';
    fields.inviteCode.value = '';

    // These exist only in this reply and are never retrievable again.
    if (Array.isArray(ready.recoveryCodes) && ready.recoveryCodes.length) {
      await showRecoveryCodes(ready.recoveryCodes);
    }
    const gotEarlyBadge = mode === 'register' && ready.user?.earlySupporter;
    onAuthenticated(ready);
    if (gotEarlyBadge) {
      toast({ title: 'Early Supporter', body: 'You’re one of the first on Voxara — the badge on your profile is permanent.', kind: 'success', timeout: 8000 });
    }
  } catch (err) {
    setStatus('');
    if (err.code === 'invite_required' && !inviteRequired) {
      inviteRequired = true;
      setMode('register');
      fields.inviteCode.focus();
    }
    showError(err.message || 'Could not sign in.');
    if (err.code === 'update_required') void forceUpdate();
    if (err.code === 'account_suspended' && mode === 'login') offerAppeal(username, password);
  } finally {
    setBusy(false);
  }
}

/** Silent sign-in with the stored token. Resolves false if it did not work. */
export async function tryResume() {
  const token = getSetting('token');
  const url = serverUrl();
  if (!token) return false;

  setStatus('Reconnecting…');
  try {
    await net.connect(url);
    const ready = await net.request('auth:resume', { token, client: net.clientInfo || undefined });
    net.token = token;
    setStatus('');
    onAuthenticated(ready);
    return true;
  } catch (err) {
    net.disconnect();
    setStatus('');
    if (err.code === 'bad_session') setSettings({ token: null, mediaToken: null });
    return false;
  }
}

/**
 * Shows the one-time recovery codes and refuses to close until they have been
 * copied or saved. They cannot be retrieved later, so a dialog that is easy to
 * dismiss would quietly lock people out of their own accounts.
 */
/**
 * The second step of a two-factor sign-in. Resolves with the ready payload,
 * or null if the person backs out. A wrong code stays in the dialog with the
 * server's explanation; an expired ticket sends them back to the password.
 */
export function promptMfaCode(ticket) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'field__input mfa__input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      placeholder: '000000', maxlength: '11', 'aria-label': 'Verification code', spellcheck: 'false',
    });
    const submitBtn = el('button', { class: 'btn btn--primary', type: 'submit' }, 'Verify');
    const form = el('form', { class: 'mfa' },
      el('p', { class: 'field__hint' }, 'Enter the six-digit code from your authenticator app. Lost it? A backup code works here too.'),
      el('div', { class: 'field' }, input));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      submitBtn.disabled = true;
      handle.setError('');
      try {
        const ready = await net.request('auth:mfa', { ticket, code });
        handle.close();
        resolve(ready);
      } catch (err) {
        if (err.code === 'bad_ticket' || err.code === 'rate_limited') {
          handle.close();
          showError(err.message);
          resolve(null);
          return;
        }
        handle.setError(err.message || 'That code is not right.');
        submitBtn.disabled = false;
        input.select();
      }
    });
    const handle = openModal({
      title: 'Two-factor authentication',
      body: form,
      dismissable: false,
      initialFocus: '.mfa__input',
      actions: [
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => { handle.close(); resolve(null); } }, 'Cancel'),
        submitBtn,
      ],
    });
    submitBtn.addEventListener('click', () => form.requestSubmit());
    setTimeout(() => input.focus(), 50);
  });
}

/**
 * One-time codes of any kind (account recovery, two-factor backups): shown
 * once, and the dialog refuses to close until they have been copied or saved.
 */
export function showOneTimeCodes(codes, { title = 'Your recovery codes', warn } = {}) {
  return showCodesDialog(codes, title, warn || 'Save these somewhere safe. Each one can reset your password once, and this is the only time they are shown.');
}

export function showRecoveryCodes(codes) {
  return showOneTimeCodes(codes);
}

function showCodesDialog(codes, title, warnText) {
  return new Promise((resolve) => {
    const grid = el('div', { class: 'reccodes' },
      ...codes.map((c) => el('span', { class: 'reccodes__code' }, c)));

    let acknowledged = false;
    const ackSwitch = el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      onClick: () => setAcknowledged(!acknowledged),
    }, el('span', { class: 'switch__knob' }));

    const continueBtn = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      disabled: true,
      onClick: () => {
        if (!acknowledged) return;
        handle.close();
        resolve();
      },
    }, 'Continue');

    function setAcknowledged(next) {
      acknowledged = next;
      ackSwitch.classList.toggle('is-on', next);
      ackSwitch.setAttribute('aria-checked', String(next));
      continueBtn.disabled = !next;
    }

    const ackRow = el('label', { class: 'reccodes__ack' },
      ackSwitch,
      el('span', {}, "I've saved these codes somewhere safe"));

    const body = el('div', {},
      el('p', { class: 'reccodes__warn' },
        icon('alert'),
        el('span', {}, warnText)),
      grid,
      ackRow);

    const asText = codes.join('\n');

    const handle = openModal({
      title,
      body,
      dismissable: false,
      actions: [
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          onClick: async (event) => {
            const button = event.currentTarget;
            try {
              await desktop.copyText(asText);
              button.textContent = 'Copied';
              setAcknowledged(true);
            } catch {
              button.textContent = 'Select and copy them manually';
            }
          },
        }, 'Copy codes'),
        continueBtn,
      ],
    });
  });
}

export function showAuthScreen(message) {
  document.body.classList.remove('is-authed');
  document.getElementById('screenWorkspace').hidden = true;
  document.getElementById('screenAuth').hidden = false;
  if (message) showError(message);
  setMode(mode);
}
