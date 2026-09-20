/**
 * Invite rewards: your referral link, progress toward the Recruiter badge,
 * and the leaderboard of who has brought the most people to Voxara.
 */
import { el, clear } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { net } from '../client.js';
import { openModal } from './overlay.js';
import { avatar } from './bits.js';
import { userBadges } from './badges.js';
import { toastSuccess, toastError } from './toast.js';
import { copyToClipboard } from '../actions.js';

/** The card shown in Settings: link, copy button, progress. */
export function referralCard() {
  const wrap = el('div', { class: 'refcard' }, el('p', { class: 'field__hint' }, 'Loading…'));
  net.request('referral:me').then((r) => {
    clear(wrap);
    const link = el('input', { class: 'field__input', readonly: true, value: r.link, onClick: (e) => e.target.select() });
    const copy = el('button', { class: 'btn btn--primary', type: 'button', onClick: async () => { await copyToClipboard(r.link); toastSuccess('Link copied. Send it to a friend.'); } }, icon('copy'), ' Copy link');
    const done = Math.min(r.settled, r.threshold);
    const bar = el('div', { class: 'refbar' }, el('span', { class: 'refbar__fill', style: { width: `${Math.round((done / r.threshold) * 100)}%` } }));
    const status = r.badge
      ? el('p', { class: 'refcard__status is-done' }, icon('check'), ` Recruiter badge earned. ${r.settled} people have joined through your link.`)
      : el('p', { class: 'refcard__status' }, `${r.settled} of ${r.threshold} for the Recruiter badge${r.pending ? `, ${r.pending} more settling (they count after their first day)` : ''}.`);
    wrap.append(
      el('p', { class: 'field__hint' }, 'Anyone who signs up through your link is credited to you once they have been here a day. Three earns the Recruiter badge on your profile, and the leaderboard in the official Voxara space shows the top recruiters.'),
      el('div', { class: 'refcard__row' }, link, copy),
      bar, status,
      el('div', { class: 'settings__actions' }, el('button', { class: 'btn', type: 'button', onClick: () => showLeaderboard() }, 'See the leaderboard')));
  }).catch((err) => { clear(wrap); wrap.append(el('p', { class: 'field__hint' }, err.message || 'Could not load your link.')); });
  return wrap;
}

export function showLeaderboard() {
  const list = el('div', { class: 'leaderboard' }, el('p', { class: 'field__hint' }, 'Loading…'));
  const handle = openModal({
    title: 'Recruiters',
    subtitle: 'Who has brought the most people to Voxara',
    body: list,
    actions: [el('button', { class: 'btn', type: 'button', onClick: () => handle.close() }, 'Close')],
  });
  net.request('referral:leaderboard').then((r) => {
    clear(list);
    if (!r.rows.length) { list.append(el('p', { class: 'field__hint' }, 'Nobody has a settled referral yet. Share your link from Settings, Invite friends, and be the first.')); return; }
    for (const row of r.rows) {
      const me = row.user?.id === store.selfId;
      list.append(el('div', { class: `leaderboard__row${me ? ' is-me' : ''}${row.rank <= 3 ? ` leaderboard__row--top${row.rank}` : ''}` },
        el('span', { class: 'leaderboard__rank' }, row.rank <= 3 ? ['🥇', '🥈', '🥉'][row.rank - 1] : String(row.rank)),
        avatar(row.user, { size: 'sm', status: false }),
        el('span', { class: 'leaderboard__name' }, row.user?.displayName || row.user?.username || 'Someone', row.user ? userBadges(row.user) : null),
        el('span', { class: 'leaderboard__count' }, `${row.count} ${row.count === 1 ? 'person' : 'people'}`)));
    }
    list.append(el('p', { class: 'field__hint', style: { marginTop: '10px' } }, `${r.threshold} referrals earn the Recruiter badge. Your link is in Settings, Invite friends.`));
  }).catch((err) => { clear(list); list.append(el('p', { class: 'field__hint' }, err.message || 'Could not load the leaderboard.')); });
  return handle;
}
