import { el, clear } from '../utils.js';

/**
 * Lightweight `:shortcode` autocomplete for a plain <textarea> — typing
 * `:thumbsu` offers `:thumbsup:` (and anything else matching) to pick from,
 * mirroring createMentionAutocomplete() in mentionpicker.js. Kept as its own
 * small controller rather than generalising that one, since the trigger
 * character and what gets inserted on pick differ (a built-in resolves
 * straight to its glyph; a custom space emoji keeps its `:name:` form so it
 * still renders as an image — see emoji.js and markdown.js).
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {(query:string) => Array<{label:string, sub?:string, insert:string, match:string, node?:HTMLElement}>} getCandidates
 */
export function createEmojiAutocomplete(textarea, getCandidates) {
  let popup = null;
  let items = [];
  let active = 0;
  let range = null; // { start, end } of the :token being replaced

  // The :token immediately before the caret, or null. Requires at least one
  // character after the colon (a bare ":" would otherwise match every time
  // someone types a colon for punctuation) and no closing colon yet.
  function tokenAtCaret() {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const before = textarea.value.slice(0, caret);
    const match = before.match(/(?:^|\s):([a-z0-9_+-]{1,32})$/i);
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
    items = getCandidates(token.query.toLowerCase()).slice(0, 8);
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
    const inserted = `${chosen.insert} `;
    textarea.value = before + inserted + after;
    const caret = (before + inserted).length;
    textarea.setSelectionRange(caret, caret);
    close();
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
      popup = el('div', { class: 'mention-ac emoji-ac', role: 'listbox' });
      (textarea.closest('.composer') || textarea.parentElement).appendChild(popup);
    }
    clear(popup);
    items.forEach((item, i) => {
      const row = el('button', {
        type: 'button',
        class: `mention-ac__item${i === active ? ' is-active' : ''}`,
        role: 'option',
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
