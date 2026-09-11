// The in-app Steam store: a personal "For you" shelf (wishlist deals + what
// friends here are actually playing), the storefront's specials / top sellers
// / new releases as art-forward card grids, catalogue search, and full game
// pages — review verdicts, screenshots, your own standing with the game, and
// which friends own it. Every hand-off to the real store goes through
// openSteamStore(), which counts the click for the Valve-pitch metrics.
import { el, clear } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { avatar } from './bits.js';
import { openModal } from './overlay.js';
import {
  fetchSteamStore, fetchSteamForYou, fetchSteamTogether, searchSteamStore, fetchSteamApp,
  openSteamStore, copyToClipboard, setSteamCountry,
} from '../actions.js';
import { steamImageUrl } from '../client.js';

// Art is proxied through our own server (steamImageUrl) so the client never
// touches Valve's CDN directly — the server owns the fallback between capsule
// and header art, and a game with no art returns 404 → the placeholder.
const capsuleArt = (appid) => steamImageUrl(appid, 'capsule');
const headerArt = (appid) => steamImageUrl(appid, 'header');

/** A cover URL (server handles which underlying art exists). */
export const coverCandidates = (appid) => [steamImageUrl(appid, 'header')];

const TABS = [
  ['forYou', 'For you'],
  ['together', 'Play together'],
  ['specials', 'Specials'],
  ['topSellers', 'Top sellers'],
  ['newReleases', 'New releases'],
];

/**
 * Game art with a fallback chain: try each candidate URL in order (the one
 * Steam's API handed us first, then the CDN's usual paths), and when nothing
 * loads, show a designed placeholder instead of an empty tile — some games
 * (delisted, very new) genuinely have no artwork.
 */
export function gameArt(sources, cls) {
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
  const img = el('img', { alt: '', loading: 'lazy', draggable: 'false' });
  const wrap = el('span', { class: cls || 'store__art' }, img);
  let index = 0;
  const next = () => {
    if (index >= list.length) {
      img.remove();
      wrap.classList.add('is-missing');
      wrap.append(icon('steam'));
      return;
    }
    img.src = list[index++];
  };
  img.addEventListener('error', next);
  next();
  return wrap;
}

const art = (src, cls) => gameArt(src, `store__art ${cls || ''}`);

function priceBits(item) {
  return [
    item.discount ? el('span', { class: 'store__discount' }, `−${item.discount}%`) : null,
    item.originalPrice ? el('span', { class: 'store__was' }, item.originalPrice) : null,
    item.price ? el('span', { class: 'store__price' }, item.price) : null,
  ];
}

function sectionLabel(text, meta) {
  return el('div', { class: 'gaming__label' },
    text, meta ? el('span', { class: 'gaming__label-meta' }, meta) : null);
}

export function showSteamStore() {
  let tab = 'forYou';
  let lists = null;    // featured lists, fetched once
  let forYou = null;   // the personal shelf, fetched once
  let together = null; // co-owned games, fetched on demand

  const results = el('div', { class: 'store__body' });
  const searchInput = el('input', {
    class: 'store__search', type: 'search', placeholder: 'Search the store…',
    'aria-label': 'Search the Steam store',
  });
  const tabsRow = el('div', { class: 'store__tabs', role: 'tablist' });

  // Currency picker: prices come from Steam in the chosen region's currency.
  const countries = store.server.steamCountries || [{ cc: 'gb', label: 'United Kingdom', currency: 'GBP' }];
  const currencySel = el('select', { class: 'store__currency', 'aria-label': 'Currency / region' },
    ...countries.map((c) => el('option', { value: c.cc, selected: c.cc === (store.self.steamCountry || 'gb') },
      `${c.currency} · ${c.label}`)));
  currencySel.addEventListener('change', async () => {
    await setSteamCountry(currencySel.value).catch(() => {});
    lists = null; forYou = null; // prices differ per region — refetch both
    reload();
  });

  // One composed toolbar: sections on the left, currency + search on the right.
  const body = el('div', { class: 'store' },
    el('div', { class: 'store__toolbar' },
      tabsRow,
      currencySel,
      el('label', { class: 'store__searchwrap' }, icon('search', { size: 13 }), searchInput)),
    results);
  const done = el('button', { class: 'btn btn--primary', type: 'button' }, 'Done');
  const modal = openModal({
    title: 'Steam store', subtitle: 'Prices and games live from Steam', xl: true,
    body, actions: [done],
  });
  done.addEventListener('click', () => modal.close());

  function drawTabs() {
    clear(tabsRow);
    for (const [key, label] of TABS) {
      tabsRow.append(el('button', {
        class: `store__tab${key === tab ? ' is-active' : ''}`,
        type: 'button', role: 'tab', 'aria-selected': String(key === tab),
        onClick: () => { tab = key; searchInput.value = ''; drawTabs(); draw(); },
      }, label));
    }
  }

  // ---------------------------------------------------------------- pieces

  /** Header-art card — the browsing unit for every featured grid. */
  function card(item) {
    const cover = art(coverCandidates(item.appid), 'store__art--card');
    if (item.discount) cover.append(el('span', { class: 'store__tag' }, `−${item.discount}%`));
    return el('button', {
      class: 'store__card', type: 'button', title: item.name,
      onClick: () => showSteamApp(item.appid),
    },
      cover,
      el('span', { class: 'store__card-foot' },
        el('span', { class: 'store__card-name' }, item.name),
        el('span', { class: 'store__card-price' },
          item.originalPrice ? el('span', { class: 'store__was' }, item.originalPrice) : null,
          item.price ? el('span', { class: 'store__price' }, item.price) : null)));
  }

  /** Compact row — search results and friend-activity lists. */
  function row(item, metaText) {
    return el('button', {
      class: 'store__row', type: 'button', title: item.name,
      onClick: () => showSteamApp(item.appid),
    },
      art([capsuleArt(item.appid), headerArt(item.appid)], 'store__art--row'),
      el('span', { class: 'store__name' }, item.name),
      metaText ? el('span', { class: 'gaming__meta' }, metaText) : null,
      ...(metaText ? [] : priceBits(item)));
  }

  function grid(items) {
    return el('div', { class: 'store__grid' }, ...items.map(card));
  }

  function blankGrid(n = 6) {
    return el('div', { class: 'store__grid' },
      ...Array.from({ length: n }, () => el('span', { class: 'store__card store__card--blank' })));
  }

  // ----------------------------------------------------------------- tabs

  function drawForYou() {
    clear(results);
    if (!forYou) { results.append(blankGrid(4)); return; }

    const bits = [];
    if (forYou.wishlistDeals.length) {
      bits.push(sectionLabel('Deals on your wishlist', `${forYou.wishlistDeals.length} on sale`),
        grid(forYou.wishlistDeals));
    } else {
      bits.push(sectionLabel('Deals on your wishlist'),
        el('p', { class: 'field__hint' }, forYou.linked
          ? 'Nothing on your wishlist is on sale right now — check back after the next Steam sale.'
          : 'Link Steam in Settings → Account and your wishlist’s sale prices will show up here.'));
    }

    bits.push(sectionLabel('Your friends are playing', 'past two weeks'));
    if (forYou.friendsPlaying.length) {
      bits.push(el('div', { class: 'store__list' },
        ...forYou.friendsPlaying.map((g) => {
          const names = g.friendIds
            .map((id) => store.user(id)?.displayName || 'someone').slice(0, 3).join(', ');
          return row(g, `${names} · ${g.hours.toLocaleString()} h`);
        })));
    } else {
      bits.push(el('p', { class: 'field__hint' },
        'None of your friends here have linked Steam yet (or nobody has played anything lately).'));
    }
    results.append(...bits);
  }

  function drawFeatured(items) {
    clear(results);
    if (!items) { results.append(blankGrid()); return; }
    if (!items.length) {
      results.append(el('p', { class: 'field__hint' }, 'Steam did not answer — try again in a moment.'));
      return;
    }
    results.append(grid(items));
  }

  function drawSearch(items) {
    clear(results);
    if (!items.length) {
      results.append(el('p', { class: 'field__hint' }, 'Nothing found on the store.'));
      return;
    }
    results.append(el('div', { class: 'store__list' }, ...items.map((i) => row(i))));
  }

  let togetherLoading = false;
  function drawTogether() {
    clear(results);
    if (!together) {
      results.append(el('div', { class: 'store__list' },
        ...Array.from({ length: 5 }, () => el('span', { class: 'store__row store__row--blank' }))));
      if (!togetherLoading) {
        togetherLoading = true;
        void fetchSteamTogether()
          .then((d) => { together = d; })
          .catch(() => { together = { linked: false, games: [] }; })
          .finally(() => { togetherLoading = false; if (tab === 'together') draw(); });
      }
      return;
    }
    if (!together.linked) {
      results.append(el('p', { class: 'field__hint' },
        'Link Steam in Settings → Account, and this shows the games you and your friends here all own.'));
      return;
    }
    if (!together.games.length) {
      results.append(el('p', { class: 'field__hint' },
        'No overlap yet — when your friends here link Steam, the games you all own show up so you can pick something to play together.'));
      return;
    }
    results.append(sectionLabel('Games you both own', `across ${together.count} of you`));
    const list = el('div', { class: 'store__list' });
    for (const g of together.games) {
      const names = g.owners.map((o) => store.user(o.userId)?.displayName || 'you').slice(0, 4).join(', ');
      list.append(el('button', {
        class: 'store__row', type: 'button', title: g.name,
        onClick: () => showSteamApp(g.appid),
      },
        art([capsuleArt(g.appid), headerArt(g.appid)], 'store__art--row'),
        el('span', { class: 'store__name' }, g.name),
        el('span', { class: 'gaming__meta' }, `${g.owners.length} own it · ${names}`)));
    }
    results.append(list);
  }

  function draw() {
    if (tab === 'forYou') drawForYou();
    else if (tab === 'together') drawTogether();
    else drawFeatured(lists ? (lists[tab] || []) : null);
  }

  // Search takes over the list while there is a term; clearing it brings the
  // current tab back.
  let searchTimer = null;
  let searchSeq = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = searchInput.value.trim();
    if (term.length < 2) { draw(); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      clear(results);
      results.append(el('div', { class: 'store__list' },
        ...Array.from({ length: 3 }, () => el('span', { class: 'store__row store__row--blank' }))));
      try {
        const { items } = await searchSteamStore(term);
        if (seq !== searchSeq) return; // an older answer must never win
        drawSearch(items);
      } catch {
        if (seq === searchSeq) drawSearch([]);
      }
    }, 300);
  });

  function reload() {
    draw();
    void fetchSteamForYou()
      .then((data) => { forYou = data; if (tab === 'forYou' && searchInput.value.trim().length < 2) draw(); })
      .catch(() => { forYou = { linked: false, wishlistDeals: [], friendsPlaying: [] }; if (tab === 'forYou') draw(); });
    void fetchSteamStore()
      .then((data) => { lists = data; if (tab !== 'forYou' && searchInput.value.trim().length < 2) draw(); })
      .catch(() => { lists = {}; if (tab !== 'forYou') draw(); });
  }

  drawTabs();
  reload();
}

// --------------------------------------------------------------- game page

export function showSteamApp(appid) {
  const body = el('div', { class: 'storeapp' },
    el('span', { class: 'store__art storeapp__hero storeapp__hero--blank' }),
    el('p', { class: 'field__hint' }, 'Loading from Steam…'));

  const share = el('button', { class: 'btn', type: 'button' }, 'Copy link');
  const open = el('button', { class: 'btn btn--primary', type: 'button' }, 'Open in Steam', icon('link', { size: 12 }));
  const done = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Done');
  const modal = openModal({ title: 'Steam', subtitle: 'Store page', wide: true, body, actions: [done, share, open] });
  open.addEventListener('click', () => openSteamStore(appid));
  share.addEventListener('click', () => {
    void copyToClipboard(`https://store.steampowered.com/app/${appid}/`, 'Store link');
  });
  done.addEventListener('click', () => modal.close());

  void (async () => {
    let app;
    try {
      app = await fetchSteamApp(appid);
    } catch (err) {
      clear(body);
      body.append(el('p', { class: 'field__hint' }, err.message || 'Steam is unreachable right now.'));
      return;
    }

    clear(body);

    const hero = gameArt(coverCandidates(app.appid), 'store__art storeapp__hero');
    const heroImg = hero.querySelector('img');

    const metaLine = [
      app.released,
      app.developers?.length ? app.developers.join(', ') : null,
      app.genres?.length ? app.genres.join(' · ') : null,
      app.platforms?.length ? app.platforms.join(' / ') : null,
    ].filter(Boolean).join('  ·  ');

    body.append(
      hero,
      el('div', { class: 'storeapp__head' },
        el('div', { class: 'storeapp__title' },
          el('h3', { class: 'storeapp__name' }, app.name),
          el('span', { class: 'storeapp__meta' }, metaLine),
          app.reviews ? el('span', { class: 'storeapp__reviews' },
            el('span', { class: goodReviews(app.reviews) ? 'storeapp__verdict storeapp__verdict--good' : 'storeapp__verdict' }, app.reviews),
            app.reviewCount ? ` · ${app.reviewCount.toLocaleString()} reviews` : '') : null),
        el('div', { class: 'storeapp__pricing' },
          ...priceBits(app),
          app.metacritic ? el('span', {
            class: `storeapp__score${app.metacritic >= 75 ? ' storeapp__score--good' : ''}`,
            title: 'Metacritic',
          }, String(app.metacritic)) : null)),
    );

    // Your standing with the game — quiet flat chips, only when they apply.
    if (app.you && (app.you.owned || app.you.wishlisted)) {
      body.append(el('div', { class: 'storeapp__you' },
        app.you.owned ? el('span', { class: 'storeapp__chip' }, icon('check', { size: 11 }),
          app.you.hours >= 1 ? `In your library · ${app.you.hours.toLocaleString()} h` : 'In your library') : null,
        app.you.wishlisted ? el('span', { class: 'storeapp__chip storeapp__chip--wish' }, icon('sparkle', { size: 11 }),
          'On your wishlist') : null));
    }

    if (app.description) body.append(el('p', { class: 'storeapp__blurb' }, app.description));

    // Screenshots swap into the hero on click; the hero click restores the art.
    if (app.screenshots?.length) {
      body.append(el('div', { class: 'storeapp__shots' },
        ...app.screenshots.map((_src, i) => {
          const proxied = steamImageUrl(app.appid, 'shot', i);
          const shot = art(proxied, 'store__art--shot');
          shot.classList.add('storeapp__shot');
          shot.setAttribute('role', 'button');
          shot.title = 'View large';
          shot.addEventListener('click', () => { if (heroImg?.isConnected) heroImg.src = proxied; });
          return shot;
        })));
      hero.style.cursor = 'pointer';
      hero.title = 'Back to the cover';
      hero.addEventListener('click', () => { if (heroImg?.isConnected) heroImg.src = headerArt(app.appid); });
    }

    // Friends on this server who own it — hours first, so the person to ask
    // about the game is at the top. Each row opens their gaming profile.
    if (app.friends?.length) {
      body.append(el('div', { class: 'gaming__label' }, 'Friends who play this'),
        el('div', { class: 'storeapp__friends' },
          ...app.friends.map(({ userId, hours }) => {
            const who = store.user(userId);
            return el('button', {
              class: 'storeapp__friend', type: 'button', title: 'Their gaming profile',
              onClick: () => void import('./gaming.js').then((m) => m.showGamingProfile(userId)),
            },
              avatar(who, { size: 'sm', status: false }),
              el('span', { class: 'storeapp__friend-name' }, who?.displayName || 'Someone'),
              el('span', { class: 'gaming__meta' }, hours >= 1 ? `${hours.toLocaleString()} h` : '< 1 h'));
          })));
    }
  })();
}

const GOOD_REVIEWS = /positive/i;
function goodReviews(text) {
  return GOOD_REVIEWS.test(String(text || '')) && !/mostly negative/i.test(String(text || ''));
}
