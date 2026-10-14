/* ui/weaponbar.js — the HUD's weapon bar: one category of weapons at a time as large tiles (Core, Thrown, Placed,
 * Strikes, Guns, Tools, and All: the dense grid of every weapon), the selected weapon and the ammo counts, the
 * hover / focus tooltip with the numbers that matter, and the info line above the bar (the weapon, its parameter or
 * fuse, the hint for how to use it now). Keys pick any weapon; the bar follows the selection to its category (not on
 * the All tab). A tile name never loses letters: the tiles widen, then a word shrinks (tilesFit). Reads the sim state
 * only; a click on a tile goes to SS.ui.onPick.
 * C: the engine UI's weapon menu, built from C.ARSENAL_ORDER and the categories below. */
(function (SS) {
  'use strict';
  const C = SS.CFG, D = SS.dom, PHASE = C.PHASE;
  const WB = SS.weaponbar = {};
  const $ = id => document.getElementById(id);
  let info = null;
  let gridBuilt = null;
  // per weapon: its tile b, the ammo count a, s the state written last ('' = rewrite)
  const gridBtn = {};
  // the categories (ks: the weapons of each, null = every weapon); Skip Go lives on the Core tab
  const W_CATS = [
    { id: 'core', n: 'Core', ks: ['bazooka', 'grenade', 'cluster', 'shotgun', 'rope', 'airstrike', 'skip'] },
    {
      id: 'throw',
      n: 'Thrown',
      ks: ['homing', 'banana', 'holy', 'boulder', 'blackhole', 'mortar', 'acid', 'gas', 'boomerang', 'foam', 'gravgun', 'flamethrower']
    },
    { id: 'place', n: 'Placed', ks: ['dynamite', 'sheep', 'mine', 'magnet', 'spring', 'dog', 'sentry', 'claymore', 'ffield'] },
    { id: 'strike', n: 'Strikes', ks: ['napalm', 'tesla', 'moai', 'raven'] },
    { id: 'gun', n: 'Guns', ks: ['sniper', 'handgun', 'minigun', 'bat', 'punch'] },
    { id: 'tool', n: 'Tools', ks: ['drill', 'parachute', 'zipline', 'teleport', 'girder', 'bellows', 'scrambler'] },
    { id: 'all', n: 'All', ks: null },
  ];
  const W_CAT_OF = {};
  for (const c of W_CATS)
    if (c.ks)
      for (const k of c.ks) W_CAT_OF[k] = c.id;
  let wTab = 'core', wLast = '';
  function showTab(id) {
    wTab = id;
    const el = $('weapons');
    if (!el) return;
    const cat = W_CATS.find(c => c.id === id) || W_CATS[0], grid = el.querySelector('.wgrid');
    if (!grid) return;
    grid.dataset.m = id === 'all' ? 'all' : id === 'core' ? 'big' : 'mid';
    const ord = cat.ks || C.ARSENAL_ORDER;
    for (const k of C.ARSENAL_ORDER) {
      const g = gridBtn[k];
      if (g) {
        g.b.classList.toggle('off', !!cat.ks && cat.ks.indexOf(k) < 0);
        g.b.style.order = ord.indexOf(k);
      }
    }
    for (const t of el.querySelectorAll('.wtab')) {
      const on = t.dataset.c === id;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    fitTiles(); fitGH();
  }
  /* --gh = the bar's height: the info line, the debug panel and the tooltip sit above it (the tab and the window size
   * change it) */
  function fitGH() {
    const el = $('weapons');
    if (!el || el.offsetHeight <= 0) return;
    const gh = innerHeight - el.getBoundingClientRect().top + 2 * D.unit();
    document.documentElement.style.setProperty('--gh', gh + 'px');
  }
  /* A tile label never loses letters. The tiles start square; a name wider than its tile wraps at its space (the .two
   * tiles); when a word still does not fit
   * the tiles of the bar get wider (--wr, up to 1.35 x), and only then a word shrinks (not below 8.5 px). Runs when the
   * tab, the tile size or the font changes. */
  function tilesFit(grid, shrink) {
    let ok = true;
    for (const t of grid.querySelectorAll('.wpn:not(.off)')) {
      const n = t.querySelector('.n');
      if (!n) continue;
      t.classList.remove('two');
      n.style.fontSize = '';
      if (n.scrollWidth <= n.clientWidth + 0.5) continue;
      if (n.textContent.indexOf(' ') > 0) t.classList.add('two');
      if (n.scrollWidth <= n.clientWidth + 0.5) continue;
      if (!shrink) {
        ok = false;
        continue;
      }
      let fs = parseFloat(getComputedStyle(n).fontSize);
      while (n.scrollWidth > n.clientWidth + 0.5 && fs > 8.5) {
        fs -= 0.5;
        n.style.fontSize = fs + 'px';
      }
    }
    return ok;
  }
  function fitTiles() {
    const el = $('weapons'), grid = el && el.querySelector('.wgrid');
    if (!grid || !el.offsetHeight) return;
    for (const wr of [1, 1.12, 1.25, 1.35]) {
      grid.style.setProperty('--wr', wr);
      if (tilesFit(grid, false)) return;
    }
    tilesFit(grid, true);
  }
  /* the size observer must not change the size it observes in the same frame (a "ResizeObserver loop" error): the fit
   * runs in the next frame */
  let fitQueued = false;
  function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      fitGH();
      fitTiles();
    });
  }
  if (typeof addEventListener === 'function') addEventListener('resize', () => setTimeout(() => {
    fitGH();
    fitTiles();
  }, 0));
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) document.fonts.ready.then(fitTiles);

  // ASSET: weapon_icons, hud_panels (ui/icons/*.png, ui/hud/*.png)
  function buildGrid(S) {
    // the setup's "Artwork": the painted icons or the vector ones
    const vector = S && S.settings.art === 'procedural' && SS.icons;
    const el = $('weapons');
    el.innerHTML = '<div class="wtabs" role="tablist"></div><div class="wgrid"></div>';
    const tabs = el.firstChild, grid = el.lastChild;
    for (const c of W_CATS) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'wtab';
      t.dataset.c = c.id;
      t.setAttribute('role', 'tab');
      t.textContent = c.n;
      tabs.appendChild(t);
    }
    for (const k of C.ARSENAL_ORDER) {
      const d = C.ARSENAL[k], b = document.createElement('button');
      b.className = 'wpn';
      b.type = 'button';
      b.dataset.k = k;
      b.setAttribute('aria-label', `${d.name} (${d.key}): ${d.info}`);
      const ico = (vector || !(SS.iconsArt && SS.iconsArt[k])) && SS.icons[k]
        ? `<svg viewBox="0 0 24 24" class="vi">${SS.icons[k]}</svg>`
        : `<img src="assets/icons/icon-${k}.webp" alt="">`;
      // (the tile's short name: no 'Baseball', 'Rifle', 'Pocket', 'Fuse'; the flamethrower is the Flamer)
      const short = d.name.replace('Baseball ', '')
        .replace(' Rifle', '')
        .replace('Pocket ', '')
        .replace('Fuse ', '')
        .replace('Flamethrower', 'Flamer');
      b.innerHTML = `${ico}<span class="k">${d.key}</span><span class="a"></span><span class="n">${short}</span>`;
      b.onclick = () => {
        if (SS.ui.onPick) SS.ui.onPick(k);
        b.blur();
      };
      grid.appendChild(b); gridBtn[k] = { b, a: b.querySelector('.a'), s: '' };
    }
    showTab(wTab);
    gridBuilt = S ? S.settings.art || 'painted' : 'painted';
    if (!el._tip) {                                                       // (once: the grid element stays, its buttons are rebuilt)
      el._tip = 1;
      // the touch bag opens from display: none, and a window or tile size changes the bar
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleFit).observe(el);
      el.addEventListener('click', e => {
        const t = e.target.closest ? e.target.closest('.wtab') : null;
        if (t) {
          showTab(t.dataset.c);
          t.blur();
        }
      });
      el.addEventListener('pointerover', e => {
        const b = e.target.closest ? e.target.closest('.wpn') : null;
        if (b) showTip(b.dataset.k, b);
      });
      el.addEventListener('pointerleave', hideTip);
      el.addEventListener('focusin', e => {
        const b = e.target.closest ? e.target.closest('.wpn') : null;
        if (b) showTip(b.dataset.k, b);
      });
      el.addEventListener('focusout', hideTip);
    }
  }
  /* weapon tooltip: name, key, the weapon's info and the numbers that matter (ammo, blast, fuse, how it is used). Event
   * driven: built on hover only */
  const KIND_TXT = {
    charge: 'Hold to charge',
    target: 'Click a target',
    drop: 'Dropped at your feet',
    stream: 'Hold to spray',
    melee: 'Melee',
    hitscan: 'Instant shot',
    utility: 'Utility',
    rope: 'Swing',
    zip: 'Zipline',
    dig: 'Digs',
    chute: 'Glide',
    skip: 'Ends the turn'
  };
  let tipEl = null, tipK = null, lastS = null, lastA = null;
  function showTip(k, btn) {
    const S = lastS, a = lastA;
    if (!k || !S || !a) return;
    if (!tipEl) tipEl = $('wtip');
    const d = C.ARSENAL[k], pd = C.PROJ[k] || {}, n = SS.game ? SS.game.ammo(S, a.team, k) : Infinity, g = gridBtn[k];
    const img = g && g.b.querySelector('img') ? `<img src="${g.b.querySelector('img').getAttribute('src')}" alt="">` : '';
    let m = S.eow && SS.eow.no_air(k) ? '<span class="no">No air in space</span>' : '';
    {
      const jw = SS.jacket ? SS.jacket.no_weapon(S, k) : '';
      if (jw) m += `<span class="no">${D.esc(jw)} (on the life jacket)</span>`;
    }
    m += `<span class="${n > 0 ? 'am' : 'no'}">${n === Infinity ? 'Unlimited' : n > 0 ? 'Ammo ×' + n : 'Out of ammo'}</span>`;
    if (KIND_TXT[d.kind]) m += `<span>${KIND_TXT[d.kind]}</span>`;
    if (pd.W) m += `<span>${pd.W.toFixed(2)} kg TNT-eq</span>`;
    if (pd.fuse || pd.fuseSet)
      m += `<span>Fuse ${SS.weaponsA && SS.weaponsA.fuse_of ? SS.weaponsA.fuse_of(S, k) : pd.fuseSet ? S.fuse : pd.fuse} s</span>`;
    tipEl.innerHTML = `<div class="th">${img}<b>${D.esc(d.name)}</b><kbd>${D.esc(d.key)}</kbd></div>`
      + `<div class="ti">${D.esc(d.info || '')}</div><div class="tm">${m}</div>`;
    const r = btn.getBoundingClientRect(), gr = $('weapons').getBoundingClientRect(), w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    tipEl.style.top = Math.max(8, gr.top - hh - 10) + 'px';
    tipEl.classList.add('on'); tipK = k;
  }
  function hideTip() {
    if (tipEl) tipEl.classList.remove('on');
    tipK = null;
  }
  function drawWeapons(S, a) {
    if (gridBuilt !== (S.settings.art || 'painted')) buildGrid(S);
    lastS = S; lastA = a;
    if (S.weapon !== wLast) {
      wLast = S.weapon;
      const c = W_CAT_OF[S.weapon];
      if (c && wTab !== 'all' && c !== wTab) showTab(c);
    }
    const mine = !(SS.game && SS.game.is_cpu(S, a.team)) && !(SS.net && SS.net.active && a.team !== SS.net.team);
    for (const k of C.ARSENAL_ORDER) {
      // (greyed afloat in a life jacket when it needs a footing)
      const g = gridBtn[k],
        n = SS.game ? SS.game.ammo(S, a.team, k) : Infinity,
        usable = n > 0
          && !(SS.weapons.needs_storm(k) && !(S.weather && S.weather.storm))
          && !(S.eow && SS.eow.no_air(k))
          && !(SS.jacket && SS.jacket.no_weapon(S, k));
      const key = (S.weapon === k ? 's' : '') + (usable ? '' : 'e') + n;
      if (g.s === key) continue;
      g.s = key;
      g.b.classList.toggle('sel', S.weapon === k);
      g.b.classList.toggle('empty', !usable);
      g.a.textContent = n === Infinity ? '' : '×' + n;
      if (tipK === k) showTip(k, g.b);
    }
    const d = C.ARSENAL[S.weapon] || {}, pd = C.PROJ[S.weapon] || {};
    let hint = '';
    if (d.twostep) hint = S.tgt ? ' · <em>target set: ↑↓ aim, Space releases the bird</em>' : ' · <em>click the target on the section</em>';
    else if (d.kind === 'target')
      hint = S.weapon === 'girder'
        ? ` · <em>click to place · hold ↑↓ to turn (${Math.round(((S.plateAng || 0) * 180 / Math.PI + 360) % 360)}°)</em>`
        : ' · <em>click the target on the section</em>'
          + (d.strike ? ` · <em>${S.strikeDir > 0 ? 'from the left ▶' : '◀ from the right'}</em> (← →)` : '');
    else if (S.weapon === 'gravgun')
      hint = S.grab ? ' · <em>hold fire and release to throw it</em>' : ' · <em>fire grabs the outlined object</em>';
    else if (d.target) hint = S.tgt ? ' · <em>target set</em>' : ' · <em>click a target first</em>';
    if (S.rope && d.payload) hint += ' · <em>Enter drops it</em>';
    if (SS.sim.can_switch && SS.sim.can_switch(S))
      hint = ` · <em>\\: switch worm (${Math.max(0, Math.ceil(10 - (S.time - (S.selStart != null ? S.selStart : S.turnStart))))} s)</em>`
        + hint;
    if (S.phase === PHASE.PLACE) {
      D.html(
        info,
        mine
          ? `Deploy <em>${D.esc(a.name)}</em>: click a free spot on the section · Q / E rotate it · Enter auto-places`
          : `${D.esc(a.name)} is being deployed…`
      );
      return;
    }
    const shot = S.weapon === 'shotgun' && C.ARMS && C.ARMS.SHOTGUN
      ? ` · shot ${Math.min(C.ARMS.SHOTGUN.SHOTS, (S.shots || 0) + 1)} of ${C.ARMS.SHOTGUN.SHOTS}`
      : '';
    if (!(S.phase === PHASE.PLAY && mine)) {
      D.html(info, '');
      return;
    }
    const par = SS.weaponsA && SS.weaponsA.param(S, S.weapon), nA = SS.game ? SS.game.ammo(S, a.team, S.weapon) : Infinity;
    let line = `<b>${D.esc(d.name || '')}</b>`;
    if (nA !== Infinity) line += ` <span class="chip">×${nA}</span>`;
    if (par) line += ` <span class="chip">${D.esc(par.name)} ${D.esc(String(par.value))} ${D.esc(par.unit)} <kbd>+ −</kbd></span>`;
    else if (pd.fuseSet) line += ` <span class="chip">fuse ${S.fuse} s <kbd>F</kbd></span>`;
    if (shot) line += ` <span class="chip">${shot.replace(/^ · /, '')}</span>`;
    D.html(info, `${line}<span class="di"> ${D.esc(d.info || '')}</span>${hint}`);
  }
  // a new world: every tile is written again
  WB.reset = function () {
    for (const k in gridBtn) gridBtn[k].s = '';
  };
  WB.draw = function (S, a) {
    if (!info) info = $('winfo');
    drawWeapons(S, a);
  };
})(window.SS = window.SS || {});
