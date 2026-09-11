// The card collection: everything you can earn, what you own, the daily drop,
// and the cosmetic rewards you redeem for collecting. Owned cards get the same
// holo treatment as the Steam link page; locked ones sit as silhouettes.
import { el, clear } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { openModal } from './overlay.js';
import { toastSuccess, toastError } from './toast.js';
import { fetchCardCollection, claimDailyDrop, redeemCardReward } from '../actions.js';

const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

/** One card face — revealed (owned) or a locked silhouette. */
function cardFace(def, count) {
  const owned = count > 0;
  const face = el('div', {
    class: `pcard pcard--${def.rarity}${owned ? '' : ' pcard--locked'}`,
    title: owned ? `${def.name} · ${RARITY_LABEL[def.rarity]}` : `Locked — ${def.how}`,
  },
    el('div', { class: 'pcard__frame' },
      el('div', { class: 'pcard__art' }, owned ? icon(def.emblem) : icon('help')),
      el('div', { class: 'pcard__plate' },
        el('b', {}, owned ? def.name : '???'),
        el('span', {}, owned ? RARITY_LABEL[def.rarity] : def.how))));
  if (owned && count > 1) face.append(el('span', { class: 'pcard__dupe' }, `×${count}`));
  return face;
}

export function showCards() {
  const body = el('div', { class: 'cards' }, el('p', { class: 'field__hint' }, 'Loading…'));
  const done = el('button', { class: 'btn btn--primary', type: 'button' }, 'Done');
  let ticking = null;
  let unsubscribe = () => {};
  const modal = openModal({
    title: 'Your cards', subtitle: 'Earn them, collect the set, redeem rewards', xl: true, body, actions: [done],
    onClose: () => { clearInterval(ticking); unsubscribe(); },
  });
  done.addEventListener('click', () => modal.close());
  const draw = () => {
    const col = store.cards;
    if (!col) return;
    clear(body);

    // --- header: progress + daily drop + redeem ---
    const nextReward = col.rewards.find((r) => !r.claimed);
    const claimable = col.rewards.find((r) => r.reached && !r.claimed);

    const dropBtn = el('button', { class: 'btn btn--sm btn--primary', type: 'button' });
    const redeemBtn = claimable
      ? el('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: async () => {
        try {
          const r = await redeemCardReward();
          toastSuccess(r.plusDays
            ? `The full set! You’ve unlocked ${r.plusDays} days of Voxara Plus — enjoy.`
            : `Reward claimed — the “${r.label}” badge is yours.`);
          draw();
        } catch (err) { toastError(err.message || 'Could not redeem.'); }
      } }, claimable.plusDays ? `Claim ${claimable.plusDays} days of Plus` : `Redeem: ${claimable.label}`)
      : null;

    const paintDrop = () => {
      const ms = store.cards.dropCooldownMs;
      if (ms <= 0) { dropBtn.disabled = false; dropBtn.textContent = 'Open daily drop'; }
      else {
        dropBtn.disabled = true;
        const h = Math.floor(ms / 3600_000);
        const m = Math.floor((ms % 3600_000) / 60_000);
        dropBtn.textContent = `Next drop in ${h ? `${h}h ` : ''}${m}m`;
      }
    };
    dropBtn.addEventListener('click', async () => {
      dropBtn.disabled = true;
      try { const card = await claimDailyDrop(); draw(); revealDrop(card); }
      catch (err) { toastError(err.message || 'The drop is not ready.'); paintDrop(); }
    });

    body.append(el('div', { class: 'cards__head' },
      el('div', { class: 'cards__progress' },
        el('div', { class: 'cards__count' },
          el('b', {}, String(col.unique)), el('span', {}, `/ ${col.total} collected`)),
        el('div', { class: 'cards__bar' },
          el('span', { class: 'cards__bar-fill', style: { width: `${Math.round((col.unique / col.total) * 100)}%` } })),
        nextReward
          ? el('div', { class: 'cards__nextreward' },
            nextReward.plusDays
              ? `Complete the set (${nextReward.at} cards) for a free month of Voxara Plus`
              : `Next reward: ${nextReward.label} at ${nextReward.at} cards`)
          : el('div', { class: 'cards__nextreward' }, 'Every reward claimed — you legend.')),
      el('div', { class: 'cards__actions' }, redeemBtn, dropBtn)));
    paintDrop();

    // Live-count the cooldown so the button updates without reopening.
    clearInterval(ticking);
    if (store.cards.dropCooldownMs > 0) {
      ticking = setInterval(() => {
        store.cards.dropCooldownMs = Math.max(0, store.cards.dropCooldownMs - 60_000);
        paintDrop();
        if (store.cards.dropCooldownMs <= 0) clearInterval(ticking);
      }, 60_000);
    }

    // --- rewards track ---
    body.append(el('div', { class: 'gaming__label' }, 'Rewards'),
      el('div', { class: 'cards__rewards' },
        ...col.rewards.map((r) => el('div', {
          class: `cards__reward${r.plusDays ? ' cards__reward--plus' : ''}${r.claimed ? ' is-claimed' : r.reached ? ' is-ready' : ''}`,
        },
          el('span', { class: 'cards__reward-at' }, `${r.at}`),
          el('span', { class: 'cards__reward-label' },
            r.plusDays ? el('span', {}, r.label, el('em', { class: 'cards__reward-prize' }, `+ ${r.plusDays} days of Plus`)) : r.label),
          el('span', { class: 'cards__reward-state' },
            r.claimed ? icon('check', { size: 13 }) : r.reached ? 'Ready' : 'Locked')))));

    // --- the collection grid ---
    body.append(el('div', { class: 'gaming__label' }, 'The set'),
      el('div', { class: 'cards__grid' },
        ...col.catalog.map((def) => cardFace(def, col.owned[def.id] || 0))));
  };

  // A little reveal when a drop lands.
  function revealDrop(card) {
    const overlay = el('div', { class: 'cards__reveal', onClick: () => overlay.remove() },
      el('div', { class: 'cards__reveal-inner' },
        el('div', { class: 'field__label' }, 'Daily drop'),
        cardFace(card, 1),
        el('p', { class: `cards__reveal-name pcard--${card.rarity}-text` }, card.name),
        el('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: () => overlay.remove() }, 'Nice')));
    body.append(overlay);
  }

  unsubscribe = store.on('cards', draw);
  fetchCardCollection().then(draw).catch(() => {
    clear(body);
    body.append(el('p', { class: 'field__hint' }, 'Could not load your cards right now.'));
  });
}
