// GIF picker: a search box and a grid of previews, fetched through the server
// (gif:search + /gif-proxy/) so nothing on your device ever talks to Tenor.
import { el } from '../utils.js';
import { openPopover, closePopover } from './overlay.js';
import { net, mediaUrl } from '../client.js';
import { toastError } from './toast.js';

export function openGifPicker(anchor, onPick) {
  const input = el('input', { class: 'field__input gifpick__search', type: 'search', placeholder: 'Search GIFs…', 'aria-label': 'Search GIFs' });
  const grid = el('div', { class: 'gifpick__grid' });
  const status = el('div', { class: 'gifpick__status' }, 'Loading…');
  const panel = el('div', { class: 'gifpick' }, input, status, grid);
  let seq = 0;
  async function search(q) {
    const mine = ++seq;
    status.textContent = 'Loading…'; status.hidden = false; grid.replaceChildren();
    try {
      const { results } = await net.request('gif:search', { q });
      if (mine !== seq) return;
      status.hidden = results.length > 0;
      status.textContent = results.length ? '' : 'Nothing for that. Try another word.';
      for (const g of results) {
        const img = el('img', { class: 'gifpick__item', src: mediaUrl(g.preview), alt: '', loading: 'lazy', style: { aspectRatio: `${g.width} / ${g.height}` } });
        img.addEventListener('click', () => { closePopover(); onPick(g); });
        grid.appendChild(img);
      }
    } catch (err) { if (mine === seq) { status.hidden = false; status.textContent = err.message || 'GIF search failed.'; } }
  }
  let timer = null;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(input.value.trim()), 250); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  openPopover(anchor, panel, { placement: 'top-end' });
  setTimeout(() => input.focus(), 30);
  search('');
}
