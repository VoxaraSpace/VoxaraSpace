// A guided tour: a spotlight moves over the real buttons and explains each one.
// Launched on a member's first visit, and any time from Settings → Help.
import { el, clear } from '../utils.js';
import { store } from '../state.js';
import { setPref, setSidebarMode } from '../actions.js';

// Each step points at a real element by id (or a fallback), with a short blurb.
// A `before` hook can nudge the app into the right state first (e.g. show the
// Spaces tab so the space list exists to point at).
const STEPS = [
  {
    sel: '#modeFriends',
    title: 'Friends & Spaces',
    body: 'Voxara has two sides. Friends is your direct messages; Spaces are communities with channels. These tabs switch between them.',
  },
  {
    sel: '#sidebarCreate',
    title: 'Add a friend · Create a space',
    body: 'The + does whichever fits the tab you’re on — add a friend by username, or start a new space.',
  },
  {
    sel: '#sidebarJoin',
    title: 'Join a space',
    body: 'Got an invite link? The compass takes you in.',
    before: () => setSidebarMode('spaces'),
  },
  {
    sel: '#sidebarStore',
    title: 'Steam store',
    body: 'Browse games, deals and what your friends here are playing — right inside Voxara. (Shows when the server has Steam turned on.)',
    optional: true,
  },
  {
    sel: '#sidebarCards',
    title: 'Your cards',
    body: 'Collectible cards you earn just by using Voxara. Complete the set for a free month of Plus.',
  },
  {
    sel: '#titlebarSearch',
    title: 'Jump to anything',
    body: 'The quick switcher (Ctrl+K) jumps to any channel, space or person in a couple of keystrokes.',
  },
  {
    sel: '#titlebarInbox',
    title: 'Your inbox',
    body: 'Saved messages, every mention of you, reminders, and Steam wishlist deals — all collected here.',
  },
  {
    sel: '#titlebarFocus',
    title: 'Focus mode',
    body: 'Silence everything — even mentions — until you turn it back off. A real do-not-disturb.',
  },
  {
    sel: '#composer',
    title: 'The composer',
    body: 'Type here. The + attaches files, the emoji button opens the picker, and Markdown like **bold** just works.',
    optional: true,
  },
  {
    sel: '#chatToggleMembers',
    title: 'Members',
    body: 'Show or hide who’s in a space. Roles set to display separately get their own group up top.',
    optional: true,
  },
  {
    sel: '#userbarMe',
    title: 'You',
    body: 'Set your status — online, away, do-not-disturb, or invisible — from your name down here.',
  },
  {
    sel: '#userbarSettings',
    title: 'Settings',
    body: 'Themes, notifications, your profile, and this tour again live here. That’s the whistle-stop tour — enjoy Voxara.',
  },
];

let active = null;

/** Start the tour. Skips steps whose element isn't on screen right now. */
export function startTour() {
  if (active) return;
  const steps = STEPS.filter((s) => !s.optional || document.querySelector(s.sel));
  let i = 0;

  const backdrop = el('div', { class: 'tour' });
  const hole = el('div', { class: 'tour__hole' });
  const pop = el('div', { class: 'tour__pop' });
  backdrop.append(hole, pop);
  document.body.append(backdrop);

  const end = () => {
    if (!active) return;
    active = null;
    window.removeEventListener('resize', place);
    window.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    setPref('tourSeen', true);
  };
  active = { end };

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
  }

  function place() {
    const step = steps[i];
    const target = document.querySelector(step.sel);
    if (!target) { go(i + 1); return; }
    const r = target.getBoundingClientRect();
    const pad = 6;
    hole.style.left = `${r.left - pad}px`;
    hole.style.top = `${r.top - pad}px`;
    hole.style.width = `${r.width + pad * 2}px`;
    hole.style.height = `${r.height + pad * 2}px`;

    // Place the tooltip on whichever side has room; default below/right.
    pop.style.visibility = 'hidden';
    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 160;
    let left = Math.min(r.left, window.innerWidth - pw - 16);
    let top = r.bottom + 14;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 14);
    if (r.left > window.innerWidth - pw - 40 && r.left - pw - 14 > 12) { left = r.left - pw - 14; top = Math.max(12, r.top); }
    pop.style.left = `${Math.max(12, left)}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = 'visible';
  }

  function go(next) {
    if (next < 0) return;
    if (next >= steps.length) { end(); return; }
    i = next;
    const step = steps[i];
    try { step.before?.(); } catch { /* best effort */ }
    // Let any layout the before() hook triggered settle, then draw.
    requestAnimationFrame(() => {
      const target = document.querySelector(step.sel);
      if (!target) { go(i + 1); return; }
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      draw();
      place();
    });
  }

  function draw() {
    const step = steps[i];
    clear(pop);
    pop.append(
      el('div', { class: 'tour__step' }, `Step ${i + 1} of ${steps.length}`),
      el('h3', { class: 'tour__title' }, step.title),
      el('p', { class: 'tour__body' }, step.body),
      el('div', { class: 'tour__foot' },
        el('button', { class: 'tour__skip', type: 'button', onClick: end }, 'Skip tour'),
        el('div', { class: 'tour__nav' },
          i > 0 ? el('button', { class: 'btn btn--sm', type: 'button', onClick: () => go(i - 1) }, 'Back') : null,
          el('button', { class: 'btn btn--sm btn--primary', type: 'button', onClick: () => go(i + 1) },
            i === steps.length - 1 ? 'Done' : 'Next'))));
  }

  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey, true);
  go(0);
}

/** Offer the tour once, on a member's first time in the app. */
export function maybeStartTour() {
  if (store.ui.tourSeen) return;
  // Give the workspace a beat to finish mounting so the targets exist.
  setTimeout(() => { if (!store.ui.tourSeen) startTour(); }, 900);
}
