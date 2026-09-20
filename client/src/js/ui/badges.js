import { el } from '../utils.js';

/**
 * Cosmetic profile badges. `earlySupporter` and `premium` come from their own
 * account fields; the rest are host-granted keys in `user.badges`. Purely
 * decorative — a badge never grants any ability.
 *
 * Each badge is a small round medallion with a glyph; hovering shows a
 * tooltip explaining what it is for. The hue is still the identity.
 */

// Glyph paths, all drawn on a 24x24 grid, stroked in currentColor.
const GLYPHS = {
  code:   'M9 6 4 12l5 6M15 6l5 6-5 6',
  shield: 'M12 3l7 3.5v5c0 4.5-3 7.5-7 9.5-4-2-7-5-7-9.5v-5z',
  gavel:  'M13 5l6 6M10 8l6 6M5 21h8M12 12l-6.5 6.5M14 4l6 6',
  bug:    'M12 8a4 4 0 014 4v3a4 4 0 01-8 0v-3a4 4 0 014-4zM12 8V5M8 11H4M20 11h-4M8 16H5M19 16h-3M9 6L7 4M15 6l2-2',
  branch: 'M6 5a2 2 0 100 4 2 2 0 000-4zM6 15a2 2 0 100 4 2 2 0 000-4zM18 5a2 2 0 100 4 2 2 0 000-4zM6 9v6M18 9c0 5-6 3-9 6',
  globe:  'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z',
  seal:   'M12 3l2.2 1.8 2.8-.3 1 2.6 2.6 1-.3 2.8L22 12l-1.7 2.1.3 2.8-2.6 1-1 2.6-2.8-.3L12 21l-2.2-1.8-2.8.3-1-2.6-2.6-1 .3-2.8L2 12l1.7-2.1-.3-2.8 2.6-1 1-2.6 2.8.3zM9 12l2 2 4-4',
  bot:    'M7 9h10a2 2 0 012 2v5a2 2 0 01-2 2H7a2 2 0 01-2-2v-5a2 2 0 012-2zM12 9V5M12 5h.01M9.5 13.5h.01M14.5 13.5h.01',
  heart:  'M12 20s-7-4.5-9-9c-1.2-2.8.6-6 3.7-6 1.9 0 3.4 1 4.3 2.6C11.9 6 13.4 5 15.3 5c3.1 0 4.9 3.2 3.7 6-2 4.5-7 9-7 9z',
  bolt:   'M13 2L5 13h5l-1 9 8-11h-5z',
  people: 'M16 20v-1.5a4 4 0 00-4-4H6a4 4 0 00-4 4V20M9 3.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM22 20v-1.5a4 4 0 00-3-3.87M16.5 3.6a3.5 3.5 0 010 6.8',
  cards:  'M12 3l8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4',
  flask:  'M9 3h6M10 3v6l-5.5 9.5A2 2 0 006.2 21h11.6a2 2 0 001.7-2.5L14 9V3M8 15h8',
};

export const BADGES = {
  developer:   { label: 'Developer', class: 'badge--developer', glyph: 'code', title: 'Builds Voxara' },
  staff:       { label: 'Staff', class: 'badge--staff', glyph: 'shield', title: 'Works at Voxara' },
  moderator:   { label: 'Moderator', class: 'badge--moderator', glyph: 'gavel', title: 'Keeps Voxara safe' },
  beta:        { label: 'Beta Tester', class: 'badge--beta', glyph: 'flask', title: 'Tested Voxara before launch' },
  bug_hunter:  { label: 'Bug Hunter', class: 'badge--bug', glyph: 'bug', title: 'Squashed bugs in Voxara' },
  contributor: { label: 'Contributor', class: 'badge--contributor', glyph: 'branch', title: 'Contributed to Voxara' },
  translator:  { label: 'Translator', class: 'badge--translator', glyph: 'globe', title: 'Helped translate Voxara' },
  verified:    { label: 'Verified', class: 'badge--verified', glyph: 'seal', title: 'Verified account' },
  recruiter:   { label: 'Recruiter', class: 'badge--recruiter', glyph: 'people', title: 'Brought three or more people to Voxara' },
  bot:         { label: 'Bot', class: 'badge--bot', glyph: 'bot', title: 'An automated account' },
  card_bronze: { label: 'Collector', class: 'badge--bronze', glyph: 'cards', title: 'Collected 3 cards' },
  card_silver: { label: 'Avid Collector', class: 'badge--silver', glyph: 'cards', title: 'Collected 8 cards' },
  card_gold:   { label: 'Card Master', class: 'badge--gold', glyph: 'cards', title: 'Collected the whole card set' },
};

// Display order — most prestigious first.
const ORDER = ['developer', 'staff', 'moderator', 'beta', 'bug_hunter', 'contributor', 'translator', 'verified', 'bot', 'card_gold', 'card_silver', 'card_bronze'];

const SVG_NS = 'http://www.w3.org/2000/svg';
function glyphSvg(d) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  node.appendChild(path);
  return node;
}

function medallion(cls, glyph, label, explain) {
  const badge = el('span', {
    class: `badge ${cls}`,
    'data-tip': `${label} · ${explain}`,
    'aria-label': `${label}. ${explain}`,
    role: 'img',
  });
  badge.appendChild(glyphSvg(GLYPHS[glyph] || GLYPHS.shield));
  return badge;
}

/** Every badge a user should show, in display order. */
export function userBadges(user) {
  const chips = [];
  if (user.earlySupporter) chips.push(medallion('badge--early', 'heart', 'Early Supporter', 'One of the first members of Voxara'));
  if (user.premium) chips.push(medallion('badge--plus', 'bolt', 'Plus', 'Voxara Plus member'));
  for (const key of ORDER) {
    if ((user.badges || []).includes(key)) {
      const b = BADGES[key];
      chips.push(medallion(b.class, b.glyph, b.label, b.title));
    }
  }
  return chips;
}
