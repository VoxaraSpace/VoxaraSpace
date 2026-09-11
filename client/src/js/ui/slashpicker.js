// Slash-command autocomplete for the composer. Typing "/" at the very start of
// a message lists the commands bots in this space have registered; picking
// one fills in "/name " and the option hints stay visible while you type the
// arguments. Same visual language as the @mention picker.
import { el } from '../utils.js';

export function createSlashAutocomplete(textarea, getCommands) {
  let popup = null;
  let items = [];
  let active = 0;

  /** The "/word" at the start of the text, with the caret still inside it. */
  function tokenAtCaret() {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const value = textarea.value;
    if (!value.startsWith('/')) return null;
    const match = /^\/([a-z0-9_-]*)$/i.exec(value.slice(0, caret));
    if (!match) return null;
    return { query: match[1].toLowerCase(), end: caret };
  }

  function close() {
    if (popup) { popup.remove(); popup = null; }
    items = [];
  }

  function refresh() {
    const token = tokenAtCaret();
    if (!token) { close(); return; }
    items = getCommands()
      .filter((c) => c.name.startsWith(token.query))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
    if (!items.length) { close(); return; }
    active = 0;
    render();
  }

  function insert(index) {
    const chosen = items[index];
    if (!chosen) return;
    textarea.value = `/${chosen.name} `;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    textarea.focus();
  }

  function render() {
    if (!popup) {
      popup = el('div', { class: 'mention-ac slash-ac', role: 'listbox' });
      textarea.parentElement.appendChild(popup);
    }
    popup.replaceChildren();
    popup.appendChild(el('div', { class: 'slash-ac__head' }, 'Commands'));
    items.forEach((item, i) => {
      const row = el('button', {
        class: `mention-ac__item${i === active ? ' is-active' : ''}`,
        type: 'button',
        role: 'option',
        'aria-selected': String(i === active),
        onMousedown: (event) => { event.preventDefault(); insert(i); },
      },
      el('span', { class: 'mention-ac__label' }, `/${item.name}`,
        ...item.options.map((o) => el('span', { class: `slash-ac__opt${o.required ? ' is-required' : ''}` }, o.required ? `<${o.name}>` : `[${o.name}]`))),
      el('span', { class: 'mention-ac__sub' }, `${item.description || ''}${item.bot ? `  ·  ${item.bot}` : ''}`));
      popup.appendChild(row);
    });
  }

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('blur', () => setTimeout(close, 120));
  textarea.addEventListener('keydown', (event) => {
    if (!popup) return;
    const handled = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key);
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation(); // the composer's own Enter must not send while the list is open
    if (event.key === 'ArrowDown') { active = (active + 1) % items.length; render(); }
    else if (event.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; render(); }
    else if (event.key === 'Enter' || event.key === 'Tab') insert(active);
    else close();
  }, true);

  return { close, refresh };
}
