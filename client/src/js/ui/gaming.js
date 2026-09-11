// The Gaming profile: what someone plays on Steam — presence and now-playing,
// hours on record, recent sessions, most-played library, and their wishlist
// (one click from a gift). Visible to the person themselves and their friends
// only; the server enforces that, and Steam's own privacy settings on top.
//
// Game art comes straight from Steam's public CDN by appid — no key, no auth,
// and a missing image just falls back to a flat tile.
import { el, clear } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { openModal } from './overlay.js';
import { fetchSteamProfile, fetchSteamWishlist } from '../actions.js';
import { showSteamApp, gameArt } from './steamstore.js';
import { desktop, steamImageUrl } from '../client.js';

const capsuleArt = (appid) => steamImageUrl(appid, 'capsule');
const headerArt = (appid) => steamImageUrl(appid, 'header');

const hoursLabel = (h) => (h >= 1 ? `${h.toLocaleString()} h` : '< 1 h');

const STATE_LABEL = {
  'in-game': 'In-game', online: 'Online', busy: 'Do not disturb', away: 'Away', offline: 'Offline',
};

/** Fixed-size art tile with the shared fallback chain and placeholder. */
const art = (sources, cls) => gameArt(sources, `gaming__art ${cls || ''}`);

function statCell(value, label) {
  return el('div', { class: 'gaming__stat' },
    el('span', { class: 'gaming__stat-value' }, value),
    el('span', { class: 'gaming__stat-label' }, label));
}

export function showGamingProfile(userId) {
  const who = store.user(userId);
  const body = el('div', { class: 'gaming' }, skeleton());

  const done = el('button', { class: 'btn btn--primary', type: 'button' }, 'Done');
  const modal = openModal({
    title: `Gaming · ${who?.displayName || 'Profile'}`,
    subtitle: 'Data from Steam',
    wide: true,
    body,
    actions: [done],
  });
  done.addEventListener('click', () => modal.close());

  void (async () => {
    let profile;
    try {
      profile = await fetchSteamProfile(userId);
    } catch (err) {
      clear(body);
      body.append(el('p', { class: 'field__hint' },
        err.code === 'not_linked' ? 'They haven’t linked a Steam account.' : (err.message || 'Steam is unreachable right now.')));
      return;
    }

    clear(body);
    const state = profile.state || (profile.nowPlaying ? 'in-game' : 'offline');

    // ------------------------------------------------------------- hero

    const avatar = profile.avatar
      ? el('img', { class: 'gaming__avatar', src: profile.avatar, alt: '', draggable: 'false' })
      : el('span', { class: 'gaming__avatar gaming__avatar--blank' },
          (profile.persona || who?.displayName || '?').slice(0, 1).toUpperCase());

    body.append(el('div', { class: 'gaming__hero' },
      avatar,
      el('div', { class: 'gaming__persona' },
        el('span', { class: 'gaming__name' }, profile.persona || 'Steam profile'),
        el('span', { class: `gaming__presence gaming__presence--${state}` },
          el('span', { class: 'gaming__dot' }),
          profile.nowPlaying ? `In-game — ${profile.nowPlaying}` : (STATE_LABEL[state] || 'Offline'))),
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onClick: () => desktop.openExternal(profile.profileUrl),
      }, 'Steam profile', icon('link', { size: 12 })),
    ));

    // ------------------------------------------------------------ stats

    body.append(el('div', { class: 'gaming__stats' },
      statCell(profile.totalGames.toLocaleString(), 'Games owned'),
      statCell(profile.totalHours != null ? profile.totalHours.toLocaleString() : '—', 'Hours on record'),
      statCell(profile.recentHours != null ? `${profile.recentHours.toLocaleString()} h` : '—', 'Past two weeks'),
    ));

    // ------------------------------------------------------ now playing

    if (profile.nowPlaying && profile.nowPlayingAppId) {
      body.append(el('button', {
        class: 'gaming__np', type: 'button', title: 'View the store page',
        onClick: () => showSteamApp(profile.nowPlayingAppId),
      },
        art([capsuleArt(profile.nowPlayingAppId), headerArt(profile.nowPlayingAppId)], 'gaming__art--np'),
        el('span', { class: 'gaming__np-text' },
          el('span', { class: 'gaming__np-label' }, 'Now playing'),
          el('span', { class: 'gaming__np-game' }, profile.nowPlaying)),
        icon('link')));
    }

    // ----------------------------------------------------------- recent

    if (profile.recent.length) {
      body.append(sectionLabel('Recently played'),
        el('div', { class: 'gaming__list' },
          ...profile.recent.map((g) => gameRow(g, `${g.recentHours} h past two weeks`))));
    }

    // ------------------------------------------------------ most played

    const maxHours = Math.max(1, ...profile.games.map((g) => g.hours || 0));
    body.append(sectionLabel('Most played', `${profile.totalGames.toLocaleString()} games`),
      el('div', { class: 'gaming__list' },
        ...profile.games.map((g) => gameRow(g, hoursLabel(g.hours), (g.hours || 0) / maxHours))));

    // --------------------------------------------------------- wishlist

    const wishHost = el('div', { class: 'gaming__grid' },
      ...Array.from({ length: 4 }, () => el('span', { class: 'gaming__card gaming__card--blank' })));
    body.append(sectionLabel('Wishlist'), wishHost);
    try {
      const { items } = await fetchSteamWishlist(userId);
      clear(wishHost);
      if (!items.length) {
        wishHost.append(el('p', { class: 'field__hint' }, 'Nothing on the wishlist (or it’s private on Steam).'));
      } else {
        for (const item of items) wishHost.append(wishCard(item));
      }
    } catch {
      clear(wishHost);
      wishHost.append(el('p', { class: 'field__hint' }, 'Could not load the wishlist.'));
    }
  })();

  function sectionLabel(text, meta) {
    return el('div', { class: 'gaming__label' },
      text, meta ? el('span', { class: 'gaming__label-meta' }, meta) : null);
  }

  function gameRow(game, meta, share) {
    return el('button', {
      class: 'gaming__row', type: 'button', title: 'View the store page',
      onClick: () => showSteamApp(game.appid),
    },
      art([capsuleArt(game.appid), headerArt(game.appid)], 'gaming__art--row'),
      el('span', { class: 'gaming__row-main' },
        el('span', { class: 'gaming__game' }, game.name),
        share != null
          ? el('span', { class: 'gaming__bar' },
              el('span', { class: 'gaming__bar-fill', style: { width: `${Math.max(1.5, share * 100)}%` } }))
          : null),
      el('span', { class: 'gaming__meta' }, meta));
  }

  function wishCard(item) {
    return el('button', {
      class: 'gaming__card', type: 'button', title: 'View the store page',
      onClick: () => showSteamApp(item.appid),
    },
      art([headerArt(item.appid)], 'gaming__art--card'),
      el('span', { class: 'gaming__card-row' },
        el('span', { class: 'gaming__card-name' }, item.name),
        item.discount ? el('span', { class: 'gaming__discount' }, `−${item.discount}%`) : null,
        item.price ? el('span', { class: 'gaming__price' }, item.price) : null));
  }

  /** Flat placeholder shapes shown while the first fetch is in flight. */
  function skeleton() {
    return el('div', { class: 'gaming__skel' },
      el('span', { class: 'gaming__skel-avatar' }),
      el('span', { class: 'gaming__skel-line', style: { width: '38%' } }),
      el('span', { class: 'gaming__skel-line', style: { width: '24%' } }),
      el('span', { class: 'gaming__skel-block' }));
  }
}
