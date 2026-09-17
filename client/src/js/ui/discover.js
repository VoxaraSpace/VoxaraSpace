/**
 * Space Discovery: the public spaces whose owners published them, searchable,
 * with member and online counts. Join straight from the list, or open a space
 * you are already in. The same list is on the website at /discover/.
 */
import { el, clear, debounce, initials } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { net, mediaUrl } from '../client.js';
import { openModal } from './overlay.js';
import { textInput } from './bits.js';
import { toastError } from './toast.js';
import { joinGuild, openGuild } from '../actions.js';
import { officialBadge } from './bits.js';

let handle = null;

export function showDiscover(initialQuery = '') {
  if (handle) { try { handle.close(); } catch { /* gone */ } }
  const list = el('div', { class: 'discover__list' });
  const status = el('p', { class: 'field__hint discover__status' }, 'Loading…');
  const search = textInput({ id: 'discoverSearch', placeholder: 'Search by name or description', value: initialQuery, maxLength: 60, onInput: () => load() });

  handle = openModal({
    title: 'Discover spaces',
    subtitle: 'Public spaces that welcome new people',
    wide: true,
    body: el('div', { class: 'discover' },
      el('div', { class: 'discover__search' }, icon('search'), search),
      status,
      list),
    actions: [
      el('button', { class: 'btn', type: 'button', onClick: () => handle?.close() }, 'Close'),
    ],
    onClose: () => { handle = null; },
  });
  const own = handle;

  let seq = 0;
  const load = debounce(async () => {
    const mine = ++seq;
    const query = search.value.trim();
    try {
      const result = await net.request('guild:discover', { query, limit: 60 });
      if (mine !== seq || handle !== own) return;
      render(result.spaces || []);
      status.textContent = result.spaces?.length
        ? `${result.spaces.length} space${result.spaces.length === 1 ? '' : 's'}${query ? ` matching “${query}”` : ''}. Owners publish a space from its settings.`
        : query ? `Nothing matches “${query}”.` : 'No spaces are published yet. Own one? Publish it from the space settings.';
    } catch (err) {
      if (handle !== own) return;
      status.textContent = err.message || 'Could not load the list.';
    }
  }, 180);

  function render(spaces) {
    clear(list);
    for (const s of spaces) {
      const joined = store.guilds.has(s.id);
      const face = el('span', { class: 'discover__icon', style: { background: s.iconColor || 'var(--accent)' } },
        s.iconUrl ? el('img', { src: mediaUrl(s.iconUrl), alt: '' }) : initials(s.name));
      const action = el('button', { class: `btn btn--sm${joined ? '' : ' btn--primary'}`, type: 'button' }, joined ? 'Go to space' : 'Join');
      action.addEventListener('click', async () => {
        if (joined) { own.close(); openGuild(s.id); return; }
        action.disabled = true;
        try { await joinGuild(s.invite); own.close(); }
        catch (err) { action.disabled = false; toastError(err.message || 'Could not join.'); }
      });
      list.appendChild(el('div', { class: `discover__row${s.official ? ' discover__row--official' : ''}` },
        face,
        el('div', { class: 'discover__text' },
          el('div', { class: 'discover__name' }, s.name, s.official ? officialBadge() : null, s.adult ? el('span', { class: 'discover__tag' }, '18+') : null),
          el('div', { class: 'discover__meta' },
            `${s.members} member${s.members === 1 ? '' : 's'}`,
            s.online ? el('span', { class: 'discover__online' }, ` · ${s.online} online`) : null),
          s.description ? el('div', { class: 'discover__desc', title: s.description }, s.description) : null),
        action));
    }
  }

  load();
  return own;
}
