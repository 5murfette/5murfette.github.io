/* ui/debug.js — P49: the in-game DEBUG TOOLBOX. A floating panel (F9 or the 🛠 button; ?debug=1 opens it at the start): pick a thing, click the
 * world, and it is dropped there. The panel never touches the sim: a click becomes ONE step's Input command (dbk, dbp0, dbp1, dbs, dby, dbsky;
 * sim/debug.js applies it inside sim.step), so replays stay bit-identical. Local / CPU matches only (main.js: allowed(false) in an online match). */
(function (SS) {
  'use strict';
  const C = SS.CFG, U = SS.dbgui = {};
  const K = () => SS.debug.KIND;
  let root = null, curEl = null, allowed = false, open = false, mini = false, tab = 'Props', item = null, sky = false, pend = null;
  const P = { weapon: 0, tool: 0, hp: 200, size: 1, boom: 3, fire: 1.6, acid: 0.32, whp: 50 };

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* the catalogue: [label, kind name, parameter selector (reads P at pick time), can fall from the sky] */
  function catalogue() {
    const k = K();
    return {
      Props: [['Barrel', k.BARREL], ['Crate', k.CRATE], ['Mine', k.MINE], ['Boulder', k.BOULDER], ['Car', k.CAR], ['Fridge', k.FRIDGE], ['Vending machine', k.VENDING],
        ['Phone booth', k.PHONEBOOTH], ['Column', k.COLUMN], ['Obelisk', k.OBELISK], ['Girder', k.GIRDER]].map(a => ({ label: a[0], kind: a[1], sky: 1 })),
      Crates: [{ label: 'Weapon crate', kind: k.CRATE_WEAPON, sky: 1, ctl: 'weapon' }, { label: 'Health crate', kind: k.CRATE_HEALTH, sky: 1 }, { label: 'Tool crate', kind: k.CRATE_TOOL, sky: 1, ctl: 'tool' }],
      Alien: [{ label: 'Egg (closed)', kind: k.EGG }, { label: 'Egg (about to hatch)', kind: k.EGG_HATCH }, { label: 'Face hugger', kind: k.HUGGER },
        { label: 'Snake alien', kind: k.SNAKE, ctl: 'snake' }],
      Devices: [{ label: 'Sentry gun', kind: k.SENTRY }, { label: 'Claymore', kind: k.CLAYMORE }, { label: 'Force field', kind: k.FFIELD }],
      Effects: [{ label: 'Explosion', kind: k.EXPLODE, ctl: 'boom' }, { label: 'Fire / napalm patch', kind: k.FIRE, ctl: 'fire' }, { label: 'Acid pool', kind: k.ACID, ctl: 'acid' }],
      Worms: [{ label: 'Teleport active worm here', kind: k.W_TELEPORT }, { label: 'Set HP of the worm here', kind: k.W_HP, ctl: 'whp' }, { label: 'Kill the worm here', kind: k.W_KILL },
        { label: 'Infect the worm here', kind: k.W_INFECT }]
    };
  }
  const params = it => {
    switch (it.ctl) {
      case 'weapon': return [P.weapon, 0]; case 'tool': return [P.tool, 0]; case 'snake': return [P.hp, P.size];
      case 'boom': return [P.boom, 0]; case 'fire': return [P.fire, 0]; case 'acid': return [P.acid, 0]; case 'whp': return [P.whp, 0]; default: return [0, 0];
    }
  };
  function ctlHTML(it) {
    if (!it || !it.ctl) return '';
    const num = (id, v, lo, hi, st, lab) => `<label>${lab} <input type="number" data-p="${id}" value="${v}" min="${lo}" max="${hi}" step="${st}"></label>`;
    switch (it.ctl) {
      case 'weapon': return `<label>Weapon <select data-p="weapon">${C.CRATE_POOL.map((w, i) => `<option value="${i}"${i === P.weapon ? ' selected' : ''}>${esc(C.ARSENAL[w].name)}</option>`).join('')}</select></label>`;
      case 'tool': return `<label>Tool <select data-p="tool">${SS.debug.TOOLS.map((w, i) => `<option value="${i}"${i === P.tool ? ' selected' : ''}>${esc(SS.skills.NAMES[w] || w)}</option>`).join('')}</select></label>`;
      case 'snake': return num('hp', P.hp, 1, 1000, 10, 'HP') + num('size', P.size, 0, 3, 0.1, 'Size (0 = newborn)');
      case 'boom': return num('boom', P.boom, 0.5, 40, 0.5, 'Radius m');
      case 'fire': return num('fire', P.fire, 0.4, 8, 0.2, 'Radius m');
      case 'acid': return num('acid', P.acid, 0.2, 0.8, 0.05, 'Radius m');
      case 'whp': return num('whp', P.whp, 1, 999, 5, 'HP');
      default: return '';
    }
  }
  function render() {
    if (!root) return;
    root.classList.toggle('hidden', !(allowed && open)); root.classList.toggle('min', mini);
    if (!allowed || !open) return;
    const cat = catalogue(), items = cat[tab] || [];
    root.innerHTML = `<div class="dh"><b>DEBUG TOOLBOX</b><span>F9</span><button data-a="min" title="Collapse / expand" aria-label="Collapse">${mini ? '+' : '–'}</button><button data-a="close" title="Close (F9)" aria-label="Close">x</button></div>`
      + `<div class="dt">${Object.keys(cat).map(t => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${t}</button>`).join('')}</div>`
      + `<div class="di">${items.map((it, i) => `<button data-i="${i}" class="${item && item.kind === it.kind ? 'on' : ''}">${esc(it.label)}</button>`).join('')}</div>`
      + `<div class="dp">${ctlHTML(item && cat[tab].some(x => x.kind === item.kind) ? item : null)}</div>`
      + `<label class="ds"><input type="checkbox" data-a="sky"${sky ? ' checked' : ''}${item && item.sky ? '' : ' disabled'}> Drop from the sky</label>`
      + `<div class="dm">${item ? `Click the world to drop: <b>${esc(item.label)}</b><br>Esc / right-click cancels` : 'Pick an item, then click in the world.'}</div>`;
  }
  function cursor() { if (curEl) { curEl.classList.toggle('on', !!(allowed && open && item)); curEl.textContent = item ? item.label : ''; } }
  U.armed = () => !!(allowed && item);
  U.cancel = () => { item = null; render(); cursor(); };
  U.toggle = () => { if (!allowed) return; open = !open; if (!open) item = null; render(); cursor(); };
  U.allowed = on => { allowed = !!on; pend = null; if (!allowed) { open = false; item = null; } const b = document.getElementById('dbgbtn'); if (b) b.style.display = allowed ? '' : 'none'; render(); cursor(); };
  U.isOpen = () => allowed && open;
  U.item = () => item;
  /* a world click while armed: remember the drop for the next step's Input */
  U.queue = (s, y) => { if (!U.armed()) return; const it = item, pr = params(it); pend = { kind: it.kind, p0: pr[0], p1: pr[1], s, y, sky: sky && it.sky ? 1 : 0 }; };
  /* fill the Input of the coming step (main.js, after Input.sample): one drop per click, then cleared */
  U.fill = inp => {
    if (!pend) return;
    inp.dbk = pend.kind; inp.dbp0 = pend.p0; inp.dbp1 = pend.p1; inp.dbs = pend.s; inp.dby = pend.y; inp.dbsky = pend.sky; pend = null;
  };
  U.init = function (show) {
    root = document.createElement('div'); root.id = 'dbg'; root.className = 'panel hidden'; document.body.appendChild(root);
    curEl = document.createElement('div'); curEl.id = 'dbgcur'; document.body.appendChild(curEl);
    const btn = document.getElementById('dbgbtn'); if (btn) btn.addEventListener('click', e => { U.toggle(); e.currentTarget.blur(); });
    root.addEventListener('click', e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.a === 'close') U.toggle();
      else if (t.dataset.a === 'min') { mini = !mini; render(); }
      else if (t.dataset.tab) { tab = t.dataset.tab; item = null; render(); cursor(); }
      else if (t.dataset.i != null) { const it = catalogue()[tab][+t.dataset.i]; item = item && item.kind === it.kind ? null : it; render(); cursor(); }
      t.blur();
    });
    root.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.a === 'sky') { sky = t.checked; return; }
      const id = t.dataset.p; if (!id) return;
      P[id] = t.tagName === 'SELECT' ? (t.value | 0) : (parseFloat(t.value) || 0);
      t.blur();
    });
    addEventListener('mousemove', e => { if (curEl) { curEl.style.left = e.clientX + 14 + 'px'; curEl.style.top = e.clientY + 12 + 'px'; } });
    const cv = document.getElementById('view'); let rd = null;
    if (cv) {
      cv.addEventListener('mousedown', e => { if (e.button === 2) rd = { x: e.clientX, y: e.clientY }; });
      addEventListener('mouseup', e => { if (e.button === 2 && rd && U.armed() && Math.hypot(e.clientX - rd.x, e.clientY - rd.y) < 5) U.cancel(); rd = null; });
    }
    if (show) open = true;
  };
})(window.SS = window.SS || {});
