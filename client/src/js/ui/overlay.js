import { el, clear, append } from '../utils.js';
import { icon } from '../icons.js';

const root = () => document.getElementById('overlayRoot');

let openPopoverEl = null;
let popoverCleanup = null;
const modalStack = [];

// ------------------------------------------------------------------ modals

/**
 * @param {{title:string, subtitle?:string, body?:Node|Node[], actions?:Node[],
 *          wide?:boolean, onClose?:Function, initialFocus?:string}} options
 */
export function openModal(options) {
  const overlay = el('div', { class: 'overlay' });
  const modal = el('div', {
    class: `modal${options.wide ? ' modal--wide' : ''}${options.xl ? ' modal--xl' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
  });

  const head = el('div', { class: 'modal__head' },
    el('h2', { class: 'modal__title' }, options.title),
    options.subtitle ? el('p', { class: 'modal__subtitle' }, options.subtitle) : null,
  );
  modal.appendChild(head);

  const body = el('div', { class: 'modal__body' });
  if (options.body) append(body, [options.body]);
  modal.appendChild(body);

  const errorLine = el('p', { class: 'modal__error', hidden: true, role: 'alert' });
  body.appendChild(errorLine);

  if (options.actions?.length) {
    modal.appendChild(el('div', { class: 'modal__foot' }, ...options.actions));
  }

  overlay.appendChild(modal);

  const previouslyFocused = document.activeElement;
  const handle = {
    overlay,
    modal,
    body,
    close(result) {
      const index = modalStack.indexOf(handle);
      if (index === -1) return;
      modalStack.splice(index, 1);
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      options.onClose?.(result);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    },
    setError(message) {
      errorLine.textContent = message || '';
      errorLine.hidden = !message;
    },
  };

  function onKeyDown(event) {
    if (modalStack[modalStack.length - 1] !== handle) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      // Some dialogs show something that cannot be recovered once dismissed.
      if (options.dismissable !== false) handle.close();
      return;
    }
    if (event.key === 'Tab') trapFocus(event, modal);
  }

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && options.dismissable !== false) handle.close();
  });
  document.addEventListener('keydown', onKeyDown, true);

  modalStack.push(handle);
  root().appendChild(overlay);

  const focusTarget = options.initialFocus
    ? modal.querySelector(options.initialFocus)
    : modal.querySelector('input, textarea, button.btn--primary, button');
  requestAnimationFrame(() => focusTarget?.focus());

  return handle;
}

function trapFocus(event, container) {
  const focusables = [...container.querySelectorAll(
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Yes/no dialog. Resolves true when confirmed. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const handle = openModal({
      title,
      body: el('p', { style: { color: 'var(--text-muted)', fontSize: '13.5px', lineHeight: '1.6' } }, message),
      actions: [
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => { finish(false); handle.close(); } }, 'Cancel'),
        el('button', {
          class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
          type: 'button',
          onClick: () => { finish(true); handle.close(); },
        }, confirmLabel),
      ],
      onClose: () => finish(false),
    });
  });
}

// ---------------------------------------------------------------- popovers

/**
 * Anchored floating panel. Only one is ever open; opening another (or a click
 * elsewhere, Escape, or a resize) closes the previous one.
 */
/**
 * A stand-in anchor at an exact point, so a context menu opens under the
 * pointer instead of at the corner of whatever element was clicked. It reports
 * `contains() === false`, which also means any click at all dismisses it.
 */
export function pointAnchor(x, y) {
  return {
    getBoundingClientRect: () => ({
      top: y, bottom: y, left: x, right: x, width: 0, height: 0, x, y,
    }),
    contains: () => false,
  };
}

export function openPopover(anchor, content, { placement = 'bottom-start', offset = 6, className = '' } = {}) {
  closePopover();

  const popover = el('div', { class: `popover ${className}`.trim(), role: 'menu' });
  append(popover, [content]);
  root().appendChild(popover);
  openPopoverEl = popover;

  position(popover, anchor, placement, offset);

  const onDocumentDown = (event) => {
    if (popover.contains(event.target)) return;
    // A point anchor reports contains() === false, so a context menu is
    // dismissed by a click anywhere at all — including inside whatever element
    // it was opened over.
    if (anchor.contains?.(event.target)) return;
    closePopover();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePopover();
      if (anchor instanceof HTMLElement) anchor.focus();
    }
  };
  const onScroll = () => position(popover, anchor, placement, offset);

  // `capture: true` so a click on another button closes this before it opens its own.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocumentDown, true);
    document.addEventListener('contextmenu', onDocumentDown, true);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);

  popoverCleanup = () => {
    document.removeEventListener('mousedown', onDocumentDown, true);
    document.removeEventListener('contextmenu', onDocumentDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
  };

  return { element: popover, close: closePopover };
}

function position(popover, anchor, placement, offset) {
  const rect = anchor.getBoundingClientRect();
  const size = popover.getBoundingClientRect();
  const margin = 8;
  let top;
  let left;

  switch (placement) {
    case 'right-start':
      top = rect.top;
      left = rect.right + offset;
      break;
    case 'top-start':
      top = rect.top - size.height - offset;
      left = rect.left;
      break;
    case 'top-end':
      top = rect.top - size.height - offset;
      left = rect.right - size.width;
      break;
    case 'bottom-end':
      top = rect.bottom + offset;
      left = rect.right - size.width;
      break;
    default:
      top = rect.bottom + offset;
      left = rect.left;
  }

  // Keep the panel fully on screen, flipping vertically when there is no room.
  if (top + size.height > window.innerHeight - margin) {
    const flipped = rect.top - size.height - offset;
    top = flipped >= margin ? flipped : Math.max(margin, window.innerHeight - size.height - margin);
  }
  top = Math.max(margin, top);
  left = Math.min(Math.max(margin, left), window.innerWidth - size.width - margin);

  popover.style.top = `${Math.round(top)}px`;
  popover.style.left = `${Math.round(left)}px`;
}

export function closePopover() {
  if (popoverCleanup) {
    popoverCleanup();
    popoverCleanup = null;
  }
  if (openPopoverEl) {
    openPopoverEl.remove();
    openPopoverEl = null;
  }
}

export function isPopoverOpen() {
  return Boolean(openPopoverEl);
}

// ------------------------------------------------------------- menu pieces

export function menuItem({ label, iconName, hint, danger = false, onSelect }) {
  return el('button', {
    class: `menu-item${danger ? ' menu-item--danger' : ''}`,
    type: 'button',
    role: 'menuitem',
    onClick: (event) => {
      event.preventDefault();
      closePopover();
      onSelect?.(event);
    },
  },
  iconName ? icon(iconName) : null,
  el('span', {}, label),
  hint ? el('span', { class: 'menu-item__hint' }, hint) : null);
}

export const menuSeparator = () => el('div', { class: 'menu-sep', role: 'separator' });
export const menuLabel = (text) => el('div', { class: 'menu-label' }, text);

export function closeEverything() {
  closePopover();
  while (modalStack.length) modalStack[modalStack.length - 1].close();
}

export function hasOpenOverlay() {
  return modalStack.length > 0 || Boolean(openPopoverEl);
}

export { clear };
