import { el, clear } from '../utils.js';

/**
 * Lightweight @-mention autocomplete for a plain <textarea>.
 *
 * The composer owns the textarea and its own key handling, so this returns a
 * small controller the composer drives: `refresh()` after every input event to
 * (re)compute suggestions from the caret, and `handleKeydown(event)` at the top
 * of the composer's keydown handler — it returns true when it has consumed the
 * key (arrows/enter/tab/escape) so the composer knows to stop.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {() => Array<{label:string, sub?:string, insert:string, match:string, kind:string, node?:HTMLElement}>} getCandidates
 */
export function createMentionAutocomplete(textarea, getCandidates) {
  let popup = null;
  let items = [];
  let active = 0;
  let range = null; // { start, end } of the @token being replaced

  // The @token immediately before the caret, or null. It must sit at the start
  // of the text or just after whitespace, so an email address never triggers it.
  function tokenAtCaret() {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const before = textarea.value.slice(0, caret);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;
    return { query: match[1], start: caret - match[1].length - 1, end: caret };
  }

  function close() {
    if (popup) { popup.remove(); popup = null; }
    items = [];
    range = null;
  }

  function refresh() {
    const token = tokenAtCaret();
    if (!token) { close(); return; }
    const query = token.query.toLowerCase();
    items = getCandidates()
      .filter((c) => c.match.includes(query))
      // exact/prefix matches first, then the rest, alphabetically within each
      .sort((a, b) => {
        const ap = a.match.startsWith(query) ? 0 : 1;
        const bp = b.match.startsWith(query) ? 0 : 1;
        return ap - bp || a.label.localeCompare(b.label);
      })
      .slice(0, 8);
    if (!items.length) { close(); return; }
    active = 0;
    range = { start: token.start, end: token.end };
    render();
  }

  function insert(index) {
    const chosen = items[index];
    if (!chosen || !range) return;
    const before = textarea.value.slice(0, range.start);
    const after = textarea.value.slice(range.end);
    const inserted = `@${chosen.insert} `;
    textarea.value = before + inserted + after;
    const caret = (before + inserted).length;
    textarea.setSelectionRange(caret, caret);
    close();
    // Let the composer resize / recount and keep typing.
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  function handleKeydown(event) {
    if (!popup) return false;
    switch (event.key) {
      case 'ArrowDown':
        active = (active + 1) % items.length; render(); event.preventDefault(); return true;
      case 'ArrowUp':
        active = (active - 1 + items.length) % items.length; render(); event.preventDefault(); return true;
      case 'Enter':
      case 'Tab':
        insert(active); event.preventDefault(); return true;
      case 'Escape':
        close(); event.preventDefault(); return true;
      default:
        return false;
    }
  }

  function render() {
    if (!popup) {
      popup = el('div', { class: 'mention-ac', role: 'listbox' });
      // The composer is positioned; anchor the popup to it just above the box.
      (textarea.closest('.composer') || textarea.parentElement).appendChild(popup);
    }
    clear(popup);
    items.forEach((item, i) => {
      const row = el('button', {
        type: 'button',
        class: `mention-ac__item${i === active ? ' is-active' : ''}`,
        role: 'option',
        // mousedown, not click: click would fire after the textarea blurs and
        // the popup is already gone.
        onMousedown: (event) => { event.preventDefault(); insert(i); },
        onMouseenter: () => { active = i; render(); },
      });
      if (item.node) row.appendChild(item.node.cloneNode(true));
      row.appendChild(el('span', { class: 'mention-ac__label' }, item.label));
      if (item.sub) row.appendChild(el('span', { class: 'mention-ac__sub' }, item.sub));
      popup.appendChild(row);
    });
  }

  return { refresh, handleKeydown, close, isOpen: () => Boolean(popup) };
}
