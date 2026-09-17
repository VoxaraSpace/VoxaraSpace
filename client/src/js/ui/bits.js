import { el, initials } from '../utils.js';
import { mediaUrl } from '../client.js';
import { icon } from '../icons.js';
import { chooseImageFile } from '../imagepick.js';
import { store } from '../state.js';
import { openPopover, menuItem } from './overlay.js';

const SIZE_CLASS = { sm: 'avatar--sm', md: '', lg: 'avatar--lg' };

/** Must mirror AVATAR_COLORS on the server, which validates the choice. */
export const AVATAR_COLORS = [
  '#5b6cff', '#e0508b', '#2fb0a8', '#e5883a',
  '#8a5cf6', '#3ba55d', '#d9534f', '#4a9df0',
];

/**
 * @param {object|null} user
 * @param {{size?:'sm'|'md'|'lg', status?:boolean, title?:string}} options
 */
export function avatar(user, { size = 'md', status = true, title } = {}) {
  const name = user?.displayName || user?.username || '?';
  const src = mediaUrl(user?.avatarUrl);

  const node = el('span', {
    class: ['avatar', SIZE_CLASS[size], status ? '' : 'avatar--nostatus'].filter(Boolean).join(' '),
    style: { background: user?.avatarColor || 'var(--accent)' },
    dataset: { status: user?.status || 'offline' },
    title: title || name,
    'aria-hidden': 'true',
  }, src ? null : initials(name));

  if (src) {
    // Fall back to initials if the image 404s (server restarted, file pruned).
    const img = el('img', { class: 'avatar__img', src, alt: '' });
    img.addEventListener('error', () => {
      img.remove();
      node.textContent = initials(name);
      node.appendChild(el('span', { class: 'avatar__status' }));
    });
    // Photosensitivity: an animated picture is shown as its first frame.
    if (isGif(src) && store.self?.reduceFlashing) {
      img.addEventListener('load', () => { const still = firstFrame(img); if (still) img.replaceWith(still); });
    }
    node.appendChild(img);
  }

  node.appendChild(el('span', { class: 'avatar__status' }));
  return node;
}

export const isGif = (src) => /\.gif(\?|$)/i.test(String(src || ''));

/** A loaded <img> as a same-sized canvas holding only its first frame. */
export function firstFrame(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    canvas.getContext('2d').drawImage(img, 0, 0);
    canvas.className = img.className;
    return canvas;
  } catch { return null; }
}

/** The still version of an image URL as a data URL, or the URL itself. */
export function stillUrl(src) {
  return new Promise((resolve) => {
    if (!isGif(src) || !store.self?.reduceFlashing) { resolve(src); return; }
    const img = new Image();
    img.onload = () => { const c = firstFrame(img); resolve(c ? c.toDataURL('image/png') : src); };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

export const STATUS_LABEL = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
  offline: 'Offline',
};

export const STATUS_COLOR = {
  online: 'var(--online)',
  idle: 'var(--idle)',
  dnd: 'var(--dnd)',
  invisible: 'var(--offline)',
  offline: 'var(--offline)',
};

/** Full-region empty state with an optional set of call-to-action buttons. */
export function emptyState({ iconName = 'dm', title, body, actions = [] }) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'empty-state__mark' }, icon(iconName)),
    el('h2', {}, title),
    body ? el('p', {}, body) : null,
    actions.length ? el('div', { class: 'empty-state__actions' }, ...actions) : null,
  );
}

export function labelledField({ id, label, hint, input }) {
  return el('div', { class: 'field' },
    el('label', { class: 'field__label', for: id }, label),
    input,
    hint ? el('p', { class: 'field__hint' }, hint) : null,
  );
}

export function textInput({ id, placeholder, value = '', maxLength, onInput, onEnter }) {
  const node = el('input', {
    class: 'field__input',
    id,
    type: 'text',
    value,
    placeholder,
    maxlength: maxLength,
    autocomplete: 'off',
    onInput: onInput ? (event) => onInput(event.target.value, event) : null,
    onKeydown: onEnter
      ? (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onEnter(event.target.value);
        }
      }
      : null,
  });
  // Set as a property: `el` cannot pass a literal `false` through.
  node.spellcheck = false;
  return node;
}

export const key = (text) => el('kbd', { class: 'key' }, text);

/**
 * An image with a pencil in its corner. Clicking the pencil offers Change /
 * Remove. Used for profile pictures, banners and space pictures alike.
 *
 * @param {{shape:'square'|'wide', url:string|null, fallback:Node, label:string,
 *          onPick:(file:File)=>void, onRemove?:()=>void}} options
 */
export function editableImage({ shape = 'square', url, fallback, label, onPick, onRemove }) {
  const frame = el('div', { class: `editable editable--${shape}` });

  if (url) frame.appendChild(el('img', { class: 'editable__img', src: url, alt: '' }));
  else if (fallback) frame.appendChild(fallback);

  const pencil = el('button', {
    class: 'editable__pencil',
    type: 'button',
    title: `Change ${label}`,
    'aria-label': `Change ${label}`,
    onClick: async (event) => {
      event.stopPropagation();
      if (!url) return void pick();
      openPopover(event.currentTarget, [
        menuItem({ label: `Change ${label}`, iconName: 'pencil', onSelect: pick }),
        onRemove
          ? menuItem({ label: `Remove ${label}`, iconName: 'trash', danger: true, onSelect: onRemove })
          : null,
      ].filter(Boolean), { placement: 'bottom-end' });
    },
  }, icon('pencil'));

  async function pick() {
    const file = await chooseImageFile();
    if (file) onPick(file);
  }

  frame.appendChild(pencil);
  return frame;
}

/** The blue check that marks the one space run by the people who make Voxara. */
export function officialBadge() {
  return el('span', { class: 'official', title: 'Official Voxara space: run by the people who make Voxara' }, icon('check'), 'Official');
}
