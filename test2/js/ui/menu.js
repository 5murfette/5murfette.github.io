/* ui/menu.js — map menu (biome, seed, collapse, weather, lava, wind, quality, slice view) and the loading progress bar.
 * DOM only; returns plain settings objects to main.js, which hands them to the sim. */
(function (SS) {
  'use strict';
  const C = SS.CFG;
  const MN = SS.menu = {};
  const KEY = 'burrowBrawl3d.settings';
  let root, panel, prog, bar, lbl, pct, cur, onStart, onResume;

  const BIOME_LOOK = {
    random: 'linear-gradient(135deg,#6b5b95,#3a7bd5 50%,#d76d77)',
    temperate: 'linear-gradient(160deg,#9fd3ff 0%,#7cc36b 45%,#4f7f3a 70%,#8a6a48)',
    alpine: 'linear-gradient(160deg,#dfefff 0%,#f6fbff 40%,#9fc7e8 65%,#5f6f80)',
    canyon: 'linear-gradient(160deg,#ffd8a8 0%,#e08a50 45%,#a8502e 75%,#6e3420)',
    desert: 'linear-gradient(160deg,#fff1cf 0%,#f0d08a 45%,#d8a860 75%,#a07040)',
    volcanic: 'linear-gradient(160deg,#4a4048 0%,#2a2426 45%,#ff5a10 75%,#3a2a24)'
  };
  const OPTS = {
    weather: [['auto', 'Auto (from biome)'], ['clear', 'Clear'], ['cloudy', 'Cloudy'], ['rain', 'Rain'], ['storm', 'Thunderstorm'], ['snow', 'Snow'], ['blizzard', 'Blizzard'], ['ashfall', 'Ash fall'], ['fog', 'Fog']],
    lava: [['auto', 'Auto'], ['on', 'Hidden pockets'], ['off', 'None (volcano keeps its crater lake)']],
    wind: [['auto', 'Auto'], ['calm', 'Calm'], ['breeze', 'Breeze'], ['strong', 'Strong'], ['gale', 'Gale']],
    under: [['off', 'Surface (island / desert)'], ['on', 'Underground (cave system)']],
    skill: [['easy', 'Rookie'], ['normal', 'Soldier'], ['hard', 'Sharpshooter']],
    teams: [['2', '2'], ['3', '3'], ['4', '4']], worms: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']],
    hp: [['80', '80'], ['100', '100'], ['150', '150']],
    onoff: [['off', 'Off'], ['on', 'On']],
    time: [['random', 'Random'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']],
    shape: [['random', 'Random'], ['islands', 'Islands'], ['hills', 'Hills'], ['caverns', 'Caverns'], ['canyon', 'Canyon and bridge']],
    art: [['painted', 'Painted icons'], ['procedural', 'Original vector icons']],
    placement: [['random', 'Random'], ['user', 'You place them (15 s each)']], volcanoes: [['auto', 'Random (70 / 35 / 17 %)'], ['0', 'None'], ['1', 'One (big)'], ['2', 'Two'], ['3', 'Three']], first: [['random', 'Random team (PoC)'], ['0', 'Team 1'], ['1', 'Team 2'], ['2', 'Team 3'], ['3', 'Team 4']], turnTime: [['30', '30 s'], ['45', '45 s'], ['60', '60 s'], ['90', '90 s'], ['0', 'No limit']],
    quality: null,
    slice: [['thin', 'Thin · 1.5 m behind the slice'], ['thick', 'Thick · 6 m behind'], ['full', 'Full · everything behind']]
  };

  MN.load = function () {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { s = {}; }
    // P9: the PoC match defaults (2 teams of 3, 100 HP, 45 s turns, sudden death, team 1 human, others CPU)
    const d = Object.assign({}, C.SETTINGS, { biome: 'random', teams: 2, worms: 3, hp: 100, turnTime: 45, sd: true, skill: 'normal', cpu: 'off', ctl: ['human', 'cpu', 'cpu', 'cpu'], names: C.TEAMS.map(t => t.name),
      first: 'random', volcanoes: 'auto', blood: false, select: false, rooms: false, keepRope: false, time: 'random', shape: 'random', art: 'painted' }, s);
    if (d.under === 'on' && !s.shape) d.shape = 'caverns';            // (older saved settings: World underground)
    d.under = 'off';                                                  // the terrain shape 'caverns' is the underground map now
    d.cpu = 'off';                                       // (the legacy per-map CPU switch is replaced by ctl[])
    return d;
  };
  MN.save = function (s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode */ } };

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function select(name, opts, val, num, onch) {
    const s = el('select'); s.name = name;
    for (const [v, t] of opts) { const o = el('option'); o.value = v; o.textContent = t; if (String(v) === String(val)) o.selected = true; s.appendChild(o); }
    s.onchange = () => { cur[name] = num ? parseInt(s.value, 10) : s.value; if (onch) onch(); };
    return s;
  }

  MN.init = function () {
    root = document.getElementById('menu');
    root.innerHTML = '';
    panel = el('div', 'mpanel');
    root.appendChild(panel);
    prog = el('div', 'mprog', '<h2>BURROW BRAWL</h2><div class="pbar"><i></i></div><div class="plabel"><span></span><b></b></div>');
    root.appendChild(prog);
    bar = prog.querySelector('i'); lbl = prog.querySelector('span'); pct = prog.querySelector('b');
  };

  /* Show the settings form. opts.inGame adds a Resume button. */
  MN.show = function (settings, start, opts) {
    opts = opts || {};
    cur = Object.assign({}, settings);
    onStart = start; onResume = opts.onResume;
    root.classList.remove('gone'); root.classList.add('menu'); root.classList.toggle('ingame', !!opts.inGame); prog.style.display = 'none'; panel.style.display = '';
    panel.innerHTML = '<img class="mlogo" src="assets/logo.webp" alt="Burrow Brawl"><div class="sub">Turn-based worm warfare on a rotatable cross-section of a fully destructible 3D world.</div>';
    // P9 match setup (PoC): teams with names + human / CPU, worms per team, health, turn time, CPU skill, sudden death
    panel.appendChild(el('div', 'msec', 'Match'));
    const mg = el('div', 'mgrid'), tbox = el('div');
    const teamsRow = () => {
      tbox.innerHTML = '';
      cur.ctl = (cur.ctl || []).slice(); cur.names = (cur.names || []).slice();
      for (let i = 0; i < (cur.teams | 0 || 2); i++) {
        const row = el('div', 'tcfg'); row.style.setProperty('--team', C.css(C.TEAMS[i].rgb));
        const nm = el('input'); nm.maxLength = 18; nm.value = cur.names[i] || C.TEAMS[i].name; nm.oninput = () => { cur.names[i] = nm.value; };
        const ct = el('select'); for (const [v, t] of [['human', 'Human'], ['cpu', 'CPU']]) { const o = el('option'); o.value = v; o.textContent = t; if ((cur.ctl[i] || (i ? 'cpu' : 'human')) === v) o.selected = true; ct.appendChild(o); }
        cur.ctl[i] = ct.value; ct.onchange = () => { cur.ctl[i] = ct.value; };
        row.append(el('i'), nm, ct); tbox.appendChild(row);
      }
    };
    const rowsM = [['teams', 'Teams', OPTS.teams, teamsRow], ['worms', 'Worms per team', OPTS.worms], ['hp', 'Worm health', OPTS.hp], ['turnTime', 'Turn time', OPTS.turnTime], ['skill', 'CPU skill', OPTS.skill], ['placement', 'Worm placement', OPTS.placement], ['first', 'Who starts', OPTS.first]];
    for (const [k, t, o, ch] of rowsM) { const l = el('label', '', `<span>${t}</span>`); l.appendChild(select(k, o, cur[k], k !== 'skill' && k !== 'placement' && k !== 'first', ch)); mg.appendChild(l); }
    // the PoC's on / off options (blood, worm select, buried rooms) and the two checkboxes
    for (const [k, t] of [['blood', 'Blood'], ['select', 'Worm select'], ['rooms', 'Buried rooms']]) {
      const l = el('label', '', `<span>${t}</span>`), sl = select(k, OPTS.onoff, cur[k] ? 'on' : 'off'); sl.onchange = () => { cur[k] = sl.value === 'on'; }; l.appendChild(sl); mg.appendChild(l);
    }
    const check = (k, html, dflt) => { const l = el('label', 'check'), c = el('input'); c.type = 'checkbox'; c.checked = cur[k] == null ? dflt : !!cur[k]; c.onchange = () => { cur[k] = c.checked; }; l.append(c, el('span', '', html)); mg.appendChild(l); };
    check('sd', 'Sudden death <em>(the sea rises after every turn from round ~8)</em>', true);
    check('keepRope', 'Keep ropes between turns <em>(a hanging worm stays on its rope)</em>', false);
    panel.appendChild(mg); panel.appendChild(tbox); teamsRow();
    panel.appendChild(el('div', 'msec', 'Battlefield'));
    const cards = el('div', 'biomes');
    for (const b of [{ id: 'random', name: 'Surprise me' }].concat(C.BIOMES)) {
      const c = el('button', 'bcard' + (cur.biome === b.id ? ' on' : ''), `<span>${b.name}</span>`);
      c.style.background = BIOME_LOOK[b.id]; c.type = 'button';
      c.onclick = () => { cur.biome = b.id; for (const x of cards.children) x.classList.remove('on'); c.classList.add('on'); };
      cards.appendChild(c);
    }
    panel.appendChild(cards);
    const grid = el('div', 'mgrid');
    const seedRow = el('label', '', '<span>Seed</span>');
    const seed = el('input'); seed.type = 'number'; seed.min = 0; seed.max = 99999; seed.value = cur.seed;
    seed.oninput = () => { cur.seed = Math.max(0, parseInt(seed.value, 10) || 0); };
    const dice = el('button', 'dice', '⚄'); dice.type = 'button'; dice.title = 'Random seed';
    dice.onclick = () => { cur.seed = Math.floor(Math.random() * 99999); seed.value = cur.seed; };
    const sw = el('div', 'seedrow'); sw.append(seed, dice); seedRow.appendChild(sw); grid.appendChild(seedRow);
    const qOpts = [['auto', 'Auto (' + SS.quality.detect() + ')'], ['low', 'Low · mobile'], ['medium', 'Medium'], ['high', 'High']];
    const rows = [['shape', 'Terrain shape', OPTS.shape], ['volcanoes', 'Volcanoes (volcanic island)', OPTS.volcanoes], ['time', 'Time of day', OPTS.time], ['art', 'Artwork', OPTS.art], ['weather', 'Weather', OPTS.weather], ['wind', 'Wind', OPTS.wind], ['lava', 'Lava', OPTS.lava], ['quality', 'Visual quality', qOpts], ['slice', 'Slice view', OPTS.slice]];
    for (const [k, t, o] of rows) { const l = el('label', '', `<span>${t}</span>`); l.appendChild(select(k, o, cur[k])); grid.appendChild(l); }
    const col = el('label', 'check');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = cur.collapse !== false; cb.onchange = () => { cur.collapse = cb.checked; };
    col.append(cb, el('span', '', 'Unsupported land collapses into pieces <em>(off = classic floating terrain)</em>'));
    grid.appendChild(col);
    panel.appendChild(grid);
    const btns = el('div', 'mbtns');
    if (onResume) { const r = el('button', 'ghost', 'Resume'); r.type = 'button'; r.onclick = () => { MN.hide(); onResume(); }; btns.appendChild(r); }
    if (MN.onOnline) { const on = el('button', 'ghost', 'Play online'); on.type = 'button'; on.onclick = () => { MN.save(cur); MN.onOnline(); }; btns.appendChild(on); }
    const go = el('button', 'go', opts.inGame ? 'New battle' : 'Start battle'); go.type = 'button';
    go.onclick = () => { MN.save(cur); const s = Object.assign({}, cur); if (s.biome === 'random') s.biome = C.BIOMES[Math.floor(Math.random() * C.BIOMES.length)].id; onStart(s); };
    btns.appendChild(go);
    panel.appendChild(btns);
    panel.appendChild(el('div', 'hint', 'Generation runs on this device and may take 10–20 s on phones.'));
    go.focus();
  };
  MN.visible = () => root && !root.classList.contains('gone');

  /* Loading progress (0..1) with a stage label. */
  MN.progress = function (f, label) {
    root.classList.remove('gone'); root.classList.remove('menu'); root.classList.remove('ingame');
    panel.style.display = 'none'; prog.style.display = '';
    bar.style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%';
    if (label) lbl.textContent = label;
    pct.textContent = Math.round(f * 100) + '%';
  };
  MN.error = function (msg) { MN.progress(0, 'Failed to start: ' + msg); prog.classList.add('err'); };
  MN.hide = function (instant) {
    if (instant) { root.style.transition = 'none'; root.classList.add('gone'); void root.offsetWidth; root.style.transition = ''; }
    else root.classList.add('gone');
  };
})(window.SS = window.SS || {});
