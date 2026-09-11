// The theme gallery and the "make your own" editor, both shown inside Settings
// → Appearance. Picking a card applies it instantly; submitting one shares it
// with everyone on the server.
import { el, clear } from '../utils.js';
import { icon } from '../icons.js';
import { store } from '../state.js';
import { openModal, confirmDialog } from './overlay.js';
import { toastSuccess, toastError } from './toast.js';
import {
  selectTheme, submitTheme, deleteTheme,
  fetchPendingThemes, approveThemeSubmission, rejectThemeSubmission,
} from '../actions.js';
import { allThemes, getTheme, deriveTokens, currentThemeId } from '../theme.js';
import { chooseImageFile, fileToJpegDataUrl } from '../imagepick.js';

/** A resolved token value for a theme, falling back to the base-mode default. */
function tokenOf(theme, name, fallbackDark, fallbackLight) {
  return theme.tokens?.[name] || (theme.base === 'light' ? fallbackLight : fallbackDark);
}

/** A little swatch strip previewing a theme's key colours. */
function preview(theme) {
  const chips = [
    tokenOf(theme, '--bg-app', '#0d0d0f', '#ffffff'),
    tokenOf(theme, '--bg-sidebar', '#121215', '#fbfbfa'),
    tokenOf(theme, '--bg-surface', '#131316', '#ffffff'),
    tokenOf(theme, '--accent', '#4d7cfe', '#1d4ed8'),
    tokenOf(theme, '--text', '#fafafa', '#111114'),
  ];
  return el('span', { class: 'themecard__preview' },
    ...chips.map((c) => el('span', { class: 'themecard__chip', style: { background: c } })));
}

/** The gallery, rebuilt on every relevant change. Returns the host element. */
export function themeGallery() {
  const grid = el('div', { class: 'theme-grid' });

  const draw = () => {
    clear(grid);
    const active = currentThemeId();
    for (const theme of allThemes()) {
      const isActive = theme.id === active;
      const mine = !theme.builtin && theme.authorId === store.selfId;
      const canRemove = !theme.builtin && (mine || store.isAdmin);

      const pending = theme.status === 'pending';
      const card = el('button', {
        class: `themecard${isActive ? ' is-active' : ''}${pending ? ' themecard--pending' : ''}`, type: 'button',
        onClick: () => { selectTheme(theme.id); draw(); },
      },
        preview(theme),
        el('span', { class: 'themecard__name' }, theme.name),
        el('span', { class: 'themecard__by' },
          theme.builtin ? 'Built in'
            : pending ? 'Awaiting review' : `by ${theme.authorName || 'someone'}`),
        isActive ? el('span', { class: 'themecard__check' }, icon('check', { size: 12 })) : null);

      if (canRemove) {
        card.append(el('span', {
          class: 'themecard__del', role: 'button', title: 'Remove this theme',
          onClick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog({
              title: `Remove “${theme.name}”?`,
              message: theme.authorId === store.selfId
                ? 'This takes your theme off the list for everyone.'
                : 'This removes another member’s theme from the server.',
              confirmLabel: 'Remove', danger: true,
            });
            if (!ok) return;
            try { await deleteTheme(theme.id); } catch (err) { toastError(err.message || 'Could not remove it.'); }
          },
        }, icon('trash', { size: 12 })));
      }
      grid.append(card);
    }

    grid.append(el('button', {
      class: 'themecard themecard--new', type: 'button', onClick: openThemeEditor,
    }, icon('plus', { size: 20 }), el('span', { class: 'themecard__name' }, 'Make your own')));
  };

  const host = el('div', { class: 'theme-section' }, grid);

  // Admins get a review queue for community submissions.
  const reviewBar = el('div', { class: 'theme-review-bar', hidden: true });
  const drawReviewBar = () => {
    const n = store.pendingThemes || 0;
    reviewBar.hidden = !(store.isAdmin && n > 0);
    if (reviewBar.hidden) return;
    reviewBar.replaceChildren(el('button', {
      class: 'btn btn--sm', type: 'button', onClick: openThemeReview,
    }, `Review submissions (${n})`));
  };
  host.append(reviewBar);

  draw();
  drawReviewBar();
  store.on('themes', () => { draw(); drawReviewBar(); });
  store.on('ui', draw);
  return host;
}

// --------------------------------------------------------------- editor

const FIELDS = [
  ['accent', 'Accent', '#4d7cfe'],
  ['bgApp', 'Background', '#0d0d0f'],
  ['bgSidebar', 'Sidebar', '#121215'],
  ['bgSurface', 'Panels', '#131316'],
  ['bgInput', 'Inputs', '#1a1a1e'],
  ['text', 'Text', '#fafafa'],
];

export function openThemeEditor() {
  // Seed the editor from the currently active theme so tweaking is easy.
  const current = getTheme(currentThemeId());
  const seed = {
    accent: tokenOf(current, '--accent', '#4d7cfe', '#1d4ed8'),
    bgApp: tokenOf(current, '--bg-app', '#0d0d0f', '#ffffff'),
    bgSidebar: tokenOf(current, '--bg-sidebar', '#121215', '#fbfbfa'),
    bgSurface: tokenOf(current, '--bg-surface', '#131316', '#ffffff'),
    bgInput: tokenOf(current, '--bg-input', '#1a1a1e', '#f4f4f2'),
    text: tokenOf(current, '--text', '#fafafa', '#111114'),
  };
  // <input type=color> only understands 6-digit hex; coerce anything else.
  const hex6 = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? v : '#888888');
  const values = { ...seed };

  const nameInput = el('input', { class: 'field__input', type: 'text', maxlength: '32', placeholder: 'Theme name' });

  // A live mini-mock of the app, restyled as the pickers change.
  const swatchRow = el('div', { class: 'themeedit__swatches' });
  const mock = el('div', { class: 'themeedit__mock' },
    el('div', { class: 'themeedit__mock-side' },
      el('span', { class: 'themeedit__mock-brand' }, 'PULSE'),
      el('span', { class: 'themeedit__mock-item' }),
      el('span', { class: 'themeedit__mock-item themeedit__mock-item--on' })),
    el('div', { class: 'themeedit__mock-main' },
      el('span', { class: 'themeedit__mock-line' }),
      el('span', { class: 'themeedit__mock-line themeedit__mock-line--short' }),
      el('span', { class: 'themeedit__mock-btn' }, 'Button')));

  // Optional wallpaper (a data URL until submitted; the server re-hosts it).
  let bgImage = null;   // data: URL
  let overlay = 0.5;

  function repaint() {
    const { tokens } = deriveTokens(values);
    for (const [k, v] of Object.entries(tokens)) mock.style.setProperty(k, v);
    mock.style.background = tokens['--bg-app'];
    mock.style.color = tokens['--text'];
    const main = mock.querySelector('.themeedit__mock-main');
    if (bgImage) {
      main.style.backgroundImage =
        `linear-gradient(color-mix(in srgb, ${tokens['--bg-app']} ${Math.round(overlay * 100)}%, transparent), `
        + `color-mix(in srgb, ${tokens['--bg-app']} ${Math.round(overlay * 100)}%, transparent)), url("${bgImage}")`;
      main.style.backgroundSize = 'cover';
      main.style.backgroundPosition = 'center';
    } else {
      main.style.backgroundImage = '';
    }
  }

  for (const [key, label, fallback] of FIELDS) {
    const input = el('input', {
      class: 'themeedit__color', type: 'color', value: hex6(values[key] || fallback),
      onInput: (e) => { values[key] = e.target.value; repaint(); },
    });
    swatchRow.append(el('label', { class: 'themeedit__field' },
      input, el('span', {}, label)));
  }

  // --- background image controls ---
  const bgName = el('span', { class: 'themeedit__bg-name' }, 'No background image');
  const overlayRow = el('label', { class: 'themeedit__overlay', hidden: true },
    el('span', {}, 'Overlay'),
    el('input', {
      type: 'range', min: '0', max: '85', value: '50',
      onInput: (e) => { overlay = Number(e.target.value) / 100; repaint(); },
    }));
  const clearBtn = el('button', { class: 'btn btn--sm btn--ghost', type: 'button', hidden: true, onClick: () => {
    bgImage = null; bgName.textContent = 'No background image'; overlayRow.hidden = true; clearBtn.hidden = true; repaint();
  } }, 'Remove');
  const pickBtn = el('button', { class: 'btn btn--sm', type: 'button', onClick: async () => {
    const file = await chooseImageFile();
    if (!file) return;
    try {
      // Downscale + JPEG so it lands well under the server's 900 KB cap.
      bgImage = await fileToJpegDataUrl(file, { width: 1280, height: 720, quality: 0.82 }, '#000');
      bgName.textContent = file.name.length > 28 ? `${file.name.slice(0, 26)}…` : file.name;
      overlayRow.hidden = false; clearBtn.hidden = false;
      repaint();
    } catch { toastError('Could not read that image.'); }
  } }, 'Add image…');

  const body = el('div', { class: 'themeedit' },
    el('label', { class: 'themeedit__name' }, el('span', { class: 'field__label' }, 'Name'), nameInput),
    swatchRow,
    el('div', { class: 'field__label' }, 'Background image (optional)'),
    el('div', { class: 'themeedit__bg' }, pickBtn, clearBtn, bgName, overlayRow),
    el('div', { class: 'field__label' }, 'Preview'),
    mock,
    el('p', { class: 'field__hint' },
      'The rest of the palette (hover states, muted text) is derived from these. '
      + 'Submitting shares your theme with everyone on this server.'));

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Share theme');
  const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
  const modal = openModal({ title: 'Make a theme', subtitle: 'Colours are yours to choose', wide: true, body, actions: [cancel, save] });
  cancel.addEventListener('click', () => modal.close());

  save.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (name.length < 2) { modal.setError('Give your theme a name.'); nameInput.focus(); return; }
    save.disabled = true;
    try {
      const { base, tokens } = deriveTokens(values);
      const theme = await submitTheme({ name, base, tokens, image: bgImage, overlay });
      selectTheme(theme.id); // apply it for the author straight away
      toastSuccess('Theme submitted for review — you can use it now; it joins the list once an admin approves it.');
      modal.close();
    } catch (err) {
      save.disabled = false;
      modal.setError(err.message || 'Could not share that theme.');
    }
  });

  repaint();
}

// --------------------------------------------------------------- review

/** Admin-only: work through the queue of submitted themes. */
export function openThemeReview() {
  const list = el('div', { class: 'theme-review' }, el('p', { class: 'field__hint' }, 'Loading…'));
  const done = el('button', { class: 'btn btn--primary', type: 'button' }, 'Done');
  const modal = openModal({ title: 'Theme submissions', subtitle: 'Approve to add to everyone’s list', wide: true, body: list, actions: [done] });
  done.addEventListener('click', () => modal.close());

  const load = async () => {
    let themes;
    try { ({ themes } = await fetchPendingThemes()); }
    catch (err) { clear(list); list.append(el('p', { class: 'field__hint' }, err.message || 'Could not load submissions.')); return; }
    clear(list);
    if (!themes.length) { list.append(el('p', { class: 'field__hint' }, 'Nothing waiting — the queue is clear.')); return; }

    for (const theme of themes) {
      const row = el('div', { class: 'theme-review__row' });
      const decide = async (fn, err) => {
        row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try { await fn(theme.id); row.remove(); if (!list.querySelector('.theme-review__row')) load(); }
        catch (e) { toastError(e.message || err); row.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
      };
      row.append(
        preview(theme),
        el('div', { class: 'theme-review__meta' },
          el('span', { class: 'theme-review__name' }, theme.name),
          el('span', { class: 'theme-review__by' }, `by ${theme.authorName || 'someone'}`)),
        el('div', { class: 'theme-review__actions' },
          el('button', {
            class: 'btn btn--sm', type: 'button', title: 'Preview on yourself',
            onClick: () => selectTheme(theme.id),
          }, 'Preview'),
          el('button', {
            class: 'btn btn--sm btn--ghost', type: 'button',
            onClick: () => decide(rejectThemeSubmission, 'Could not reject.'),
          }, 'Reject'),
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button',
            onClick: () => decide(approveThemeSubmission, 'Could not approve.'),
          }, 'Approve')));
      list.append(row);
    }
  };
  load();
}
