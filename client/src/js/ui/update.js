import { el } from '../utils.js';
import { icon } from '../icons.js';
import { confirmDialog, openModal } from './overlay.js';
import { toastSuccess, toastError } from './toast.js';

/**
 * The in-app update experience: a styled "update available" card, a real
 * progress bar while it downloads and applies, and clear failure. Replaces the
 * old native OS dialog + a plain progress toast.
 */

let desk = null;
let modal = null;
let barFill = null;
let statusText = null;

export function initUpdates(desktop) {
  if (!desktop?.updates) return;
  desk = desktop;
  desktop.updates.onAvailable?.((info) => showAvailable(info));
  desktop.updates.onProgress?.((progress) => onProgress(progress));
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Switch to another build the server offers (older or newer). Same download
 * and checksum path as an update; the app restarts into the chosen build.
 */
export async function switchVersionUI(entry) {
  if (!desk?.updates) return;
  const going = entry.newer ? 'Update to' : 'Go back to';
  const ok = await confirmDialog({
    title: `${going} Voxara ${entry.version}?`,
    message: entry.newer
      ? 'The app restarts to finish.'
      : 'You will run an older version until you choose to update again. It stays on that version even as newer ones come out, unless a security update makes updating required. The app restarts to finish.',
    confirmLabel: going.split(' ')[0] === 'Update' ? 'Update' : 'Go back',
  });
  if (!ok) return;
  closeModal();
  barFill = el('div', { class: 'update__fill' });
  statusText = el('p', { class: 'update__status' }, 'Starting…');
  modal = openModal({
    title: `Switching to ${entry.version}`,
    body: el('div', { class: 'update' }, el('div', { class: 'update__bar' }, barFill), statusText),
  });
  const result = await desk.updates.rollback(entry.serial).catch((err) => ({ status: 'error', message: err.message }));
  if (result?.status === 'error') fail(result.message);
}

/** "What's new": the last few releases, with a link out to the full page. */
export async function showWhatsNew() {
  if (!desk?.updates?.changelog) return;
  const list = el('div', { class: 'whatsnew__list' },
    el('p', { class: 'field__hint' }, 'Loading…'));
  const body = el('div', { class: 'whatsnew' }, list);
  const modal = openModal({
    title: 'What’s new',
    body,
    actions: [el('button', { class: 'btn', type: 'button', onClick: () => modal.close() }, 'Close')],
    dismissable: true,
  });

  const data = await desk.updates.changelog().catch(() => ({ entries: [], moreUrl: '' }));
  list.replaceChildren();
  const entries = (data.entries || []).slice(0, 5);
  if (!entries.length) {
    list.appendChild(el('p', { class: 'field__hint' }, 'No release notes yet — check back after the next update.'));
  } else {
    for (const entry of entries) {
      list.appendChild(el('div', { class: 'whatsnew__item' },
        el('div', { class: 'whatsnew__head' },
          el('span', { class: 'whatsnew__ver' }, `Voxara ${entry.version}`),
          entry.date ? el('span', { class: 'whatsnew__date' }, DATE_FMT.format(new Date(entry.date))) : null),
        el('p', { class: 'whatsnew__notes' },
          entry.notes && entry.notes.trim() ? entry.notes : 'Improvements and fixes.')));
    }
  }
  // Link out to the full updates page, when one is configured.
  if (data.moreUrl) {
    list.appendChild(el('button', {
      class: 'whatsnew__more', type: 'button',
      onClick: () => desk.openExternal?.(data.moreUrl),
    }, 'See all updates', icon('link')));
  }
}

/** Manual "Check for updates" (from Settings). */
export async function checkForUpdatesUI() {
  if (!desk?.updates) return { status: 'unsupported' };
  let result;
  try {
    result = await desk.updates.check();
  } catch (err) {
    toastError(err.message || 'Could not check for updates.');
    return { status: 'error' };
  }
  if (result?.status === 'available') {
    const current = await desk.updates.version().catch(() => '');
    showAvailable({ version: result.version, notes: result.notes || '', current });
  } else if (result?.status === 'current') {
    toastSuccess('You’re on the latest version.');
  } else if (result?.status === 'error') {
    toastError(result.message || 'Could not check for updates.');
  } else {
    toastSuccess('Updates apply to the installed app only.');
  }
  return result;
}

function closeModal() {
  if (modal) modal.close();
  modal = null;
  barFill = null;
  statusText = null;
}

function showAvailable(info) {
  closeModal();
  modal = openModal({
    title: 'Update available',
    subtitle: `Version ${info.version}`,
    body: el('div', { class: 'update' },
      el('div', { class: 'update__badge' }, icon('arrow-down')),
      el('p', { class: 'update__lead' }, `Voxara ${info.version} is ready to install.`),
      el('p', { class: 'update__meta' },
        `${info.current ? `You’re on ${info.current}. ` : ''}Voxara will restart to finish.`),
      info.notes ? el('p', { class: 'update__notes' }, info.notes) : null),
    actions: [
      el('button', { class: 'btn', type: 'button', onClick: () => closeModal() }, 'Later'),
      el('button', {
        class: 'btn btn--primary', type: 'button',
        onClick: () => startInstall(info),
      }, 'Update & restart'),
    ],
    dismissable: true,
  });
}

function startInstall(info) {
  closeModal();
  barFill = el('span', { class: 'update-bar__fill' });
  statusText = el('p', { class: 'update__status' }, 'Starting…');
  modal = openModal({
    title: 'Updating Voxara',
    subtitle: `Version ${info.version}`,
    body: el('div', { class: 'update' },
      el('div', { class: 'update-bar' }, barFill),
      statusText,
      el('p', { class: 'update__meta' }, 'Keep Voxara open — it will restart on its own.')),
    dismissable: false,
  });
  desk.updates.install()
    .then((result) => { if (result?.status === 'error') fail(result.message); })
    .catch((err) => fail(err.message));
}

function setBar(percent) {
  if (barFill) barFill.style.width = `${Math.max(3, Math.min(100, percent))}%`;
}

function onProgress(progress) {
  if (!modal || !statusText) return;
  switch (progress.phase) {
    case 'downloading':
      setBar(progress.percent || 0);
      statusText.textContent = `Downloading… ${Math.round(progress.percent || 0)}%`;
      break;
    case 'verifying':
      setBar(100);
      statusText.textContent = 'Checking the download…';
      break;
    case 'restarting':
      setBar(100);
      statusText.textContent = 'Restarting to finish…';
      break;
    case 'failed':
      fail(progress.message);
      break;
    default:
      break;
  }
}

function fail(message) {
  closeModal();
  modal = openModal({
    title: 'Update failed',
    body: el('div', { class: 'update' },
      el('p', { class: 'update__lead' }, message || 'The update could not be applied.'),
      el('p', { class: 'update__meta' },
        'Voxara is still running on the current version. You can try again, or '
        + 'download the latest installer from the server.')),
    actions: [
      el('button', { class: 'btn btn--primary', type: 'button', onClick: () => closeModal() }, 'OK'),
    ],
    dismissable: true,
  });
}
