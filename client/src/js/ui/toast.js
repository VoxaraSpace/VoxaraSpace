import { el } from '../utils.js';
import { icon } from '../icons.js';

const HOST = () => document.getElementById('toasts');
const MAX_VISIBLE = 4;

/**
 * @param {{title?:string, body:string, kind?:'info'|'error'|'success', timeout?:number}} options
 */
export function toast({ title, body, kind = 'info', timeout = 5000 }) {
  const host = HOST();
  if (!host) return () => {};

  const node = el('div', { class: `toast toast--${kind}`, role: 'status' },
    el('div', { class: 'toast__text' },
      title ? el('div', { class: 'toast__title' }, title) : null,
      el('div', { class: 'toast__body' }, body),
    ),
    el('button', {
      class: 'toast__close',
      type: 'button',
      'aria-label': 'Dismiss',
      onClick: () => dismiss(),
    }, icon('close')),
  );

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };

  host.appendChild(node);
  while (host.children.length > MAX_VISIBLE) host.firstElementChild.remove();

  if (timeout > 0) timer = setTimeout(dismiss, timeout);
  return dismiss;
}

export const toastError = (body, title = 'Something went wrong') =>
  toast({ title, body, kind: 'error', timeout: 7000 });

export const toastSuccess = (body, title) =>
  toast({ title, body, kind: 'success', timeout: 3500 });
