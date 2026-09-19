/**
 * The welcome screen a space shows new members: a greeting from the owner,
 * rules to accept, and roles they can give themselves. Shown once, the first
 * time the member opens the space; the server remembers who has been through.
 */
import { el } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { net } from '../client.js';
import { openModal } from './overlay.js';
import { toastError } from './toast.js';

const shownFor = new Set();

/** True when this member still has to go through the space's welcome. */
export function needsOnboarding(guild) {
  if (!guild?.onboarding?.enabled) return false;
  if (guild.ownerId === store.selfId) return false;
  return !(guild.onboardedIds || []).includes(store.selfId);
}

/** Open the welcome for a space if it is due; once per session per space. */
export function maybeShowOnboarding(guildId) {
  const guild = store.guild(guildId);
  if (!guild || !needsOnboarding(guild) || shownFor.has(guildId)) return;
  shownFor.add(guildId);
  showOnboarding(guild);
}

export function showOnboarding(guild) {
  const o = guild.onboarding || {};
  const picked = new Set();
  const pickable = (o.pickRoles || []).map((id) => (guild.roles || []).find((r) => r.id === id)).filter(Boolean);

  const accept = el('input', { type: 'checkbox', id: 'onboardAccept' });
  const body = el('div', { class: 'onboard' });
  if (o.welcome) body.appendChild(el('p', { class: 'onboard__welcome' }, o.welcome));
  if (o.rules) {
    body.appendChild(el('div', { class: 'onboard__section' },
      el('h4', {}, 'Rules'),
      el('div', { class: 'onboard__rules' }, o.rules),
      o.requireAccept !== false
        ? el('label', { class: 'checkline', for: 'onboardAccept' }, accept, el('span', {}, el('b', {}, 'I have read the rules'), ' and I will follow them.'))
        : null));
  }
  if (pickable.length) {
    const grid = el('div', { class: 'onboard__roles' });
    for (const role of pickable) {
      const chip = el('button', { class: 'onboard__role', type: 'button', style: { '--role': role.color || 'var(--text-muted)' } }, el('span', { class: 'onboard__dot' }), role.name, el('span', { class: 'onboard__check' }, icon('check')));
      chip.addEventListener('click', () => { picked.has(role.id) ? picked.delete(role.id) : picked.add(role.id); chip.classList.toggle('is-on', picked.has(role.id)); });
      grid.appendChild(chip);
    }
    body.appendChild(el('div', { class: 'onboard__section' }, el('h4', {}, 'Pick your roles'), el('p', { class: 'field__hint' }, 'Optional. They tell people a bit about you and can unlock channels. Change them later from your profile in this space.'), grid));
  }

  const go = el('button', { class: 'btn btn--primary', type: 'button' }, 'Enter the space');
  const handle = openModal({
    title: `Welcome to ${guild.name}`,
    subtitle: `${guild.memberIds.length} member${guild.memberIds.length === 1 ? '' : 's'}`,
    body,
    actions: [go],
    dismissable: false,
  });
  go.addEventListener('click', async () => {
    if (o.rules && o.requireAccept !== false && !accept.checked) { handle.setError('Tick the box to accept the rules first.'); return; }
    go.disabled = true;
    try {
      await net.request('guild:onboard', { guildId: guild.id, accept: accept.checked, roleIds: [...picked] });
      const g = store.guild(guild.id);
      if (g) { g.onboardedIds = [...(g.onboardedIds || []), store.selfId]; store.emit('guilds'); }
      handle.close();
    } catch (err) { go.disabled = false; handle.setError(err.message || 'Could not continue.'); }
  });
}
