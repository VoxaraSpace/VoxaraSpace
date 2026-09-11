import { el, clear } from '../utils.js';
import { icon } from '../icons.js';
import { openModal } from './overlay.js';

/**
 * The settings chrome shared by user settings and space settings.
 *
 * A drill-down: opening shows the list of sections; picking one hides the list
 * and shows that section's pane full-width, with a back arrow in the modal's
 * top-left that returns to the list. One shell, so both user and space settings
 * behave the same for every section.
 *
 * @param {{title:string, subtitle?:string, groups:Array, panes:object,
 *          initial?:string}} options
 *   `groups` is `[{ group:'You', items:[{ id, label }] }]`; `panes` maps an id
 *   to `(pane, handle, ctx) => void`.
 */
export function openSettingsShell({ title, subtitle, groups, panes }) {
  const listView = el('div', { class: 'settings-list' });
  const pane = el('div', { class: 'settings__pane' });
  pane.hidden = true;

  const handle = openModal({
    title,
    subtitle,
    wide: true,
    body: el('div', { class: 'settings settings--drill' }, listView, pane),
  });

  // The back arrow lives in the modal head, shown only inside a section.
  const head = handle.modal.querySelector('.modal__head');
  const titleEl = head.querySelector('.modal__title');
  const backBtn = el('button', {
    class: 'settings__back',
    type: 'button',
    'aria-label': 'Back to settings',
    hidden: true,
    onClick: () => showList(),
  }, icon('arrow-left'));
  head.prepend(backBtn);

  const labelOf = {};
  let currentId = null;

  for (const group of groups) {
    if (!group.items.length) continue;
    if (group.group) listView.appendChild(el('div', { class: 'settings-list__group' }, group.group));
    const card = el('div', { class: 'settings-list__card' });
    for (const item of group.items) {
      labelOf[item.id] = item.label;
      if (!panes[item.id]) continue;
      card.appendChild(el('button', {
        class: `settings-list__row${item.danger ? ' is-danger' : ''}`,
        type: 'button',
        onClick: () => drill(item.id),
      },
      el('span', { class: 'settings-list__icon' }, icon(item.icon || 'settings')),
      el('span', { class: 'settings-list__text' },
        el('span', { class: 'settings-list__label' }, item.label),
        item.desc ? el('span', { class: 'settings-list__desc' }, item.desc) : null),
      el('span', { class: 'settings-list__chev' }, icon('chevron-right'))));
    }
    listView.appendChild(card);
  }

  function showList() {
    currentId = null;
    pane.hidden = true;
    listView.hidden = false;
    backBtn.hidden = true;
    head.classList.remove('has-back');
    titleEl.textContent = title;
    handle.setError('');
  }

  function drill(id) {
    if (!panes[id]) return;
    currentId = id;
    listView.hidden = true;
    pane.hidden = false;
    backBtn.hidden = false;
    head.classList.add('has-back');
    titleEl.textContent = labelOf[id] || title;
    clear(pane);
    handle.setError('');
    panes[id](pane, handle, { select: drill, refresh: () => drill(id) });
    pane.scrollTop = 0;
  }

  handle.modal.appendChild(el('div', { class: 'modal__foot' },
    el('button', { class: 'btn btn--primary', type: 'button', onClick: () => handle.close() }, 'Done')));

  showList();
  return {
    handle,
    select: drill,
    refresh: () => { if (currentId) drill(currentId); },
  };
}

/** A titled block inside a settings pane. */
export function section(title, ...children) {
  return el('section', { class: 'settings__section' },
    el('h3', { class: 'settings__heading' }, title),
    ...children);
}

/** A row of mutually exclusive choices, applied the moment one is picked. */
export function choiceRow(options, current, onPick) {
  const row = el('div', { class: 'choice-row' });
  for (const option of options) {
    const button = el('button', {
      class: `choice${option.value === current ? ' is-active' : ''}`,
      type: 'button',
      dataset: { value: option.value },
      onClick: () => {
        for (const child of row.children) child.classList.remove('is-active');
        button.classList.add('is-active');
        onPick(option.value);
      },
    },
    el('span', { class: 'choice__label' }, option.label),
    option.hint ? el('span', { class: 'choice__hint' }, option.hint) : null);
    row.appendChild(button);
  }
  return row;
}

/** A labelled switch. */
export function toggleRow({ label, hint, value, onChange }) {
  const control = el('button', {
    class: `switch${value ? ' is-on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': String(value),
    onClick: () => {
      const next = !control.classList.contains('is-on');
      control.classList.toggle('is-on', next);
      control.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  }, el('span', { class: 'switch__knob' }));

  return el('div', { class: 'setting-row' },
    el('div', { class: 'setting-row__text' },
      el('span', { class: 'setting-row__label' }, label),
      hint ? el('span', { class: 'setting-row__hint' }, hint) : null),
    control);
}
