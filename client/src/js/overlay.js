// The in-game voice overlay page. Draws whatever the app sends over the
// bridge; it holds no state of its own and never talks to the server.
(() => {
  const root = document.getElementById('overlay');
  const title = document.getElementById('ovTitle');
  const rows = document.getElementById('ovRows');
  const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  function row(r) {
    const node = document.createElement('div');
    node.className = `ovrow${r.speaking ? ' is-speaking' : ''}${r.muted ? ' is-muted' : ''}`;
    node.dataset.id = r.id;
    const av = document.createElement('span');
    av.className = 'ovrow__avatar';
    av.style.background = r.color || '#4d7cfe';
    if (r.avatarUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = r.avatarUrl;
      img.addEventListener('error', () => { img.remove(); av.textContent = initials(r.name); });
      av.appendChild(img);
    } else av.textContent = initials(r.name);
    const name = document.createElement('span');
    name.className = 'ovrow__name';
    name.textContent = r.name;
    node.append(av, name);
    if (r.sharing) { const t = document.createElement('span'); t.className = 'ovrow__tag ovrow__tag--live'; t.textContent = 'LIVE'; node.appendChild(t); }
    if (r.muted) { const t = document.createElement('span'); t.className = 'ovrow__tag ovrow__tag--muted'; t.textContent = 'MUTED'; node.appendChild(t); }
    return node;
  }

  let lastKey = '';
  window.pulse?.overlay?.onState((state) => {
    if (!state) return;
    root.hidden = false;
    root.classList.toggle('is-right', /right/.test(state.corner || ''));
    title.textContent = state.title || '';
    title.hidden = !state.title;
    // Only speaking/muted flags change most ticks: toggle classes in place so
    // avatars are not re-fetched forty times a second.
    const key = state.rows.map((r) => `${r.id}|${r.name}|${r.avatarUrl || ''}|${r.color || ''}|${r.sharing ? 1 : 0}|${r.muted ? 1 : 0}`).join('\n');
    if (key !== lastKey) { lastKey = key; rows.replaceChildren(...state.rows.map(row)); }
    for (const r of state.rows) rows.querySelector(`[data-id="${CSS.escape(r.id)}"]`)?.classList.toggle('is-speaking', Boolean(r.speaking));
  });
})();
