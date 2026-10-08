/* ui/hud.js — DOM HUD, floating labels, combat log and the two minimaps. Reads the sim state only. */
(function (SS) {
  'use strict';
  const C = SS.CFG, P = SS.plane, M = SS.math;
  const U = SS.ui = {};
  const $ = id => document.getElementById(id);
  const css = C.css;
  let labels, secC, secX, secBase, topC, topX, topBase, topVer = -1, camera, canvas;
  let underOpen = null, underVer = -1, underLevel = 5;
  const wl = new Map(); // worm -> label element
  let fuseEl, lavaVer = 0, waterVer = 0;
  // DOM writes only on change (the HUD is rebuilt as strings every frame; an unchanged innerHTML still re-parses)
  const lastHTML = {};
  // names come from the network (guest team names): everything interpolated into HTML is escaped
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const setHTML = (id, s) => { if (lastHTML[id] !== s) { lastHTML[id] = s; $(id).innerHTML = s; } };
  const setText = (el, s) => { if (el._s !== s) { el._s = s; el.textContent = s; } };

  U.init = function (cam, cv) {
    camera = cam; canvas = cv;
    labels = $('labels'); secC = $('secmap'); secX = secC.getContext('2d'); secBase = document.createElement('canvas');
    topC = $('topmap'); topX = topC.getContext('2d'); topBase = document.createElement('canvas');
    fuseEl = document.createElement('div'); fuseEl.className = 'fuse'; labels.appendChild(fuseEl);
    $('bRematch').onclick = () => U.onRematch && U.onRematch();
    $('bSetup').onclick = () => U.onSetup && U.onSetup();
  };

  const v3 = new THREE.Vector3();
  function project(p) { v3.set(p.x, p.y, p.z).project(camera); return { x: (v3.x + 1) / 2 * canvas.clientWidth, y: (1 - v3.y) / 2 * canvas.clientHeight, front: v3.z < 1 }; }

  /* speech bubbles (PoC say(); original lines): a dying worm's last words, a few yelps, a turn opener */
  const SAY = {
    die: ['Back to the soil…', 'Tell the compost heap I loved it', 'I regret nothing!', 'Make it quick', 'Not like this…', 'Plant something nice over me'],
    ouch: ['Ow!', 'Hey!', 'That stung', 'My segments!', 'Watch it!', 'Rude.'],
    start: ['My turn!', 'Watch this', 'Steady…', 'Here goes', 'Leave it to me', 'Hold my dirt'],
    // P24.12 (PoC say() coverage; original lines): fire, crates, a shock, a wave, a pass, a fall
    fire: ['Fire in the burrow!', 'Incoming!', 'Eat dirt!', 'Special delivery', 'Duck!'],
    hot: ['Hot hot hot!', 'I\'m cooking!', 'Too toasty!'],
    crate: ['Ooh, {w}!', 'A {w}! Mine!', 'Shiny {w}…'],
    health: ['Ahh, better.', 'Much better', 'Mmm, mulch'],
    shock: ['Bzzzt!', 'My hair!', 'Tingly…'],
    wash: ['Pfft! Salty!', 'I can\'t swim!', 'Blub!'],
    pass: ['Hmm… pass.', 'Not now', 'I\'ll wait'],
    fall: ['Aaaah!', 'Whoaaa!', 'Not again!']
  };
  function say(w, kind, arg) {
    for (const o of labels.querySelectorAll('.bubble')) if (o._w === w) o.remove();      // one bubble per worm
    const L = SAY[kind], el = document.createElement('div'); el.className = 'pop bubble';
    el.textContent = L[Math.floor(Math.random() * L.length)].replace('{w}', arg || ''); labels.appendChild(el); el._w = w; el._t = curS ? curS.time : 0; el._bub = 1;
  }
  let curS = null;
  function banner(title, sub, color) {
    const b = $('banner'); b.innerHTML = ''; b.appendChild(document.createTextNode(title));
    if (sub) { const sm = document.createElement('small'); sm.textContent = sub; b.appendChild(sm); }
    b.style.color = color; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }
  U.onEvent = function (S, e) {
    curS = S;
    if (e.type === 'dying' && e.worm) say(e.worm, 'die');
    if (e.type === 'hurt' && e.worm && !e.worm.dead && e.worm.hp > 0 && e.amount >= 5 && Math.random() < 0.45) say(e.worm, 'ouch');
    if (e.type === 'turn' && e.worm) say(e.worm, 'start');                                            // PoC: every turn
    if (e.type === 'fire' && S.active && Math.random() < 0.3) say(S.active, 'fire');
    if (e.type === 'hurt' && e.worm && !e.worm.dead && /fire|lava|oil|burn|hot/.test(e.why || '') && Math.random() < 0.3) say(e.worm, 'hot');
    if (e.type === 'zap' && e.worm && !e.worm.dead) say(e.worm, 'shock');
    if (e.type === 'wash' && e.worm) say(e.worm, 'wash');
    if (e.type === 'use' && e.weapon === 'skip' && S.active) say(S.active, 'pass');
    if (e.type === 'spring' && e.worm) say(e.worm, 'fall');
    if (e.type === 'pickup' && e.worm) say(e.worm, e.kind === 'health' ? 'health' : 'crate', e.weapon && C.ARSENAL[e.weapon] ? C.ARSENAL[e.weapon].name : '');
    if (e.type === 'reset') U.clear();
    if (e.type === 'hurt') {
      const el = document.createElement('div'); el.className = 'pop'; el.textContent = '-' + e.amount; el.style.color = css(C.TEAMS[e.worm.team].rgb);
      labels.appendChild(el); el._w = e.worm; el._t = S.time;
    }
    if (e.type === 'turn') banner(`${SS.sim.team_name(S, e.worm.team)} · ${e.worm.name}`, SS.game && SS.game.is_cpu(S, e.worm.team) ? 'CPU' : 'is up', css(C.TEAMS[e.worm.team].rgb));
    if (e.type === 'banner') banner(e.title, e.sub, 'var(--accent)');
    if (e.type === 'pickup' && e.worm) {
      const el = document.createElement('div'); el.className = 'pop'; el.textContent = e.kind === 'health' ? '+' + e.amount : C.ARSENAL[e.weapon].name; el.style.color = e.kind === 'health' ? '#79d98b' : '#ffb02e';
      labels.appendChild(el); el._w = e.worm; el._t = S.time;
    }
    if (e.type === 'reset') { overShown = null; for (const k in gridBtn) gridBtn[k].s = ''; }
  };

  /* drop every worm label, damage pop and speech bubble (they hold worm objects: a replay restore / a new game
   * replaces those, the old ones would stay frozen on screen next to the new ones) */
  U.clear = function () {
    for (const el of wl.values()) el.remove(); wl.clear();
    for (const el of labels.querySelectorAll('.pop, .bubble')) el.remove();
  };
  function label(w) {
    let el = wl.get(w);
    if (!el) {
      el = document.createElement('div'); el.className = 'wlabel';
      el.innerHTML = '<span class="nm"></span><span class="off"></span><div class="hpbar"><i></i></div><b class="hpn"></b>';
      el.style.setProperty('--team', css(C.TEAMS[w.team].rgb));
      labels.appendChild(el); wl.set(w, el);
    }
    return el;
  }

  // P24.12 network panel (PoC L5581): link type, ping, sync state (in sync / checking / no signal / DESYNC)
  let netEl = null, netLast = '';
  function netPanel() {
    const NT = SS.net; if (!NT || !NT.active) { if (netEl) netEl.style.display = 'none'; return; }
    if (!netEl) { netEl = document.createElement('div'); netEl.id = 'netpanel'; document.body.appendChild(netEl); }
    const st = NT.stats(), now = performance.now(), quiet = st.lastRecv ? now - st.lastRecv : 1e9, rtt = st.rtt ? Math.round(st.rtt) : null;
    const state = st.desync > 0 ? ['DESYNC', 'bad'] : quiet > 4000 ? ['no signal', 'bad'] : st.hashOk > 0 ? ['in sync', 'ok'] : ['checking', 'warn'];
    const ping = rtt == null ? '—' : rtt + ' ms', cls = state[1] === 'bad' || (rtt != null && rtt > 250) ? 'bad' : (rtt != null && rtt > 120) || state[1] === 'warn' ? 'warn' : 'ok';
    const txt = `🌐 ${st.mode === 'lan' ? 'LAN' : 'room'} · ${st.peers + 1} players · ${ping} · ${state[0]}`;
    if (txt !== netLast) { netEl.textContent = txt; netEl.className = cls; netLast = txt; }
    netEl.style.display = 'block';
  }
  U.draw = function (S) {
    netPanel();
    const a = S.active, insp = M.clamp(S.inspect, 0, 1);
    for (const w of S.worms) {
      const el = label(w);
      if (w.dead) { el.style.display = 'none'; continue; }
      const inSec = SS.view.inSlab(S, w.pos) || w === a, show = inSec || insp > 0.05;
      const sp = project({ x: w.pos.x, y: w.pos.y + 0.85, z: w.pos.z });
      el.style.display = show && sp.front ? 'block' : 'none';
      if (!show) continue;
      setText(el.children[0], (w === a ? '▸ ' : '') + w.name);
      setText(el.children[1], inSec ? '' : ` ${Math.abs(P.to_plane(S, w.pos).t).toFixed(1)} m off`);
      el.children[2].firstChild.style.width = Math.max(0, Math.min(100, 100 * w.hp / (w.hp0 || 100))) + '%';
      setText(el.children[3], String(Math.max(0, Math.round(w.hp))));                                   // PoC: the HP number
      el.style.opacity = inSec ? 1 : insp;
      el.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%)`;
      el.classList.toggle('ghost', !inSec); el.classList.toggle('active', w === a);
    }
    for (const el of labels.querySelectorAll('.pop')) {
      const age = S.time - el._t;
      if (age > (el._bub ? 1.9 : 1.6) || age < 0) { el.remove(); continue; }
      if (el._bub) { const bp = project({ x: el._w.pos.x, y: el._w.pos.y + 1.25, z: el._w.pos.z }); el.style.transform = `translate(${bp.x}px,${bp.y}px) translate(-50%,-100%)`; el.style.opacity = Math.min(1, (1.9 - age) * 3); continue; }
      const sp = project({ x: el._w.pos.x, y: el._w.pos.y + 1.5 + age * 0.8, z: el._w.pos.z });
      el.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%) scale(${1 + Math.max(0, 0.3 - age)})`; el.style.opacity = 1 - age / 1.6;
    }
    const g = S.proj.find(p => p.type === 'grenade');
    if (g) {
      const wp = P.to_world(S, g.s, g.y), sp = project({ x: wp.x, y: wp.y + 0.6, z: wp.z });
      fuseEl.style.display = 'block'; setText(fuseEl, Math.max(0, g.fuse).toFixed(1));
      fuseEl.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%)`;
    } else fuseEl.style.display = 'none';
    // the lava layer moves slowly: refresh the section map base every ~2 s of sim time while it changes
    if (S.section && ((S.lava && S.lava.ver - lavaVer >= 20) || (S.water && S.water.ver - waterVer >= 15))) U.sectionChanged(S);
    drawHUD(S); drawSectionMap(S); drawTopMap(S);
  };

  function bearing(th) { return ((90 + th * 180 / Math.PI) % 360 + 360) % 360; }
  function teamHP(S, t) { return S.worms.filter(w => w.team === t).reduce((s, w) => s + Math.max(0, w.hp), 0); }
  /* dry worlds (Step D): the active worm on hot sand → which way to walk back (along the section, or rotate first) */
  function hotRow(S, a) {
    const W = SS.world, D = C.DRY;
    if (!W.dry) return '';
    const r = SS.sim.arena_r(a.pos.x, a.pos.z);
    if (r <= S.playR) return '';
    const back = r - S.playR, dx = D.CX - a.pos.x, dz = D.CZ - a.pos.z, l = Math.hypot(dx, dz) || 1, d = P.dir(S);
    const along = (dx * d.x + dz * d.z) / l;              // cos of the angle between the section and the way home
    const how = Math.abs(along) > 0.5 ? `walk ${along > 0 ? '▶ right' : '◀ left'}` : 'rotate the section toward the centre';
    return `<div class="hot">Hot sand · −1 HP / 5 s · ${back.toFixed(1)} m out · ${how}</div>`;
  }
  /* 5f: wind + weather. The bar shows the in-plane component (what a shot feels: +s = screen right; grenades take
   * 0.6 of it, bazookas all), the arrow the full wind relative to the view (up = into the screen), numbers in m/s at
   * 10 m (gusts included). */
  const WX_ICON = { clear: '☀', cloudy: '☁', rain: '☂', storm: '⚡', snow: '❄', blizzard: '❄❄', ashfall: '▒', fog: '≋' };
  function windRow(S) {
    const w = S.wind, we = S.weather; if (!w || !we || SS.world.under) return '';
    const d = P.dir(S), n = P.nrm(S), mx = w.mean.x, mz = w.mean.z, sp = Math.hypot(mx, mz);
    const along = mx * d.x + mz * d.z, toward = mx * n.x + mz * n.z;
    const ang = Math.atan2(along, -toward) * 180 / Math.PI;                  // 0 = into the screen, 90 = right
    const nb = Math.min(5, Math.round(Math.abs(along) / 2.4)), bars = Array.from({ length: 5 }, (_, i) => `<i class="${i < nb ? 'on' : ''}"></i>`).join('');
    const name = (C.WEATHER_NAME && C.WEATHER_NAME[we.kind]) || we.kind;
    return `<div class="wind"><span class="wx">${WX_ICON[we.kind] || ''} ${name}</span>
      <span class="wa" style="transform:rotate(${ang.toFixed(0)}deg)">↑</span>
      <span class="ws">${sp.toFixed(1)} m/s</span>
      <span class="wb ${along < 0 ? 'l' : 'r'}">${along < 0 ? '◀' : ''}<b>${bars}</b>${along >= 0 ? '▶' : ''}</span>
      <span class="wn">${along >= 0 ? '+' : '−'}${Math.abs(along).toFixed(1)} in plane</span></div>`;
  }
  /* Step I: on sea ice: its thickness and the highest fall it survives (Gold capacity vs the landing load) */
  function iceRow(S, a) {
    if (!SS.ice || !S.ice) return '';
    const top = SS.ice.top_at(S, a.pos.x, a.pos.z);
    if (top < -1e8 || Math.abs(a.pos.y - a.foot - top) > 0.2) return '';
    const K = C.ICE, hcm = S.ice.h[SS.ice.cell(S, a.pos.x, a.pos.z)], r = 2 * SS.ice.cap(hcm) / K.WORM_KG - 1;
    const Hs = r <= 1 ? 0 : K.STOP_D * (r * r - 1) / 2;
    return `<div class="wind"><span class="wx">❄ ice ${hcm.toFixed(0)} cm</span><span class="wn">${Hs <= 0.05 ? 'too thin to stand on' : 'safe falls < ' + (Hs < 10 ? Hs.toFixed(1) : '10+') + ' m'}</span></div>`;
  }
  /* P9 top bar (PoC): turn · time · wind · weather */
  function drawTop(S, a, team, tc) {
    setHTML('tbTurn', `<div class="lbl">Turn</div><div class="tn" style="--team:${tc}">${esc(team.name)}</div><div class="wn">${esc(a.name)}${SS.game && SS.game.is_cpu(S, a.team) ? ' · CPU' : SS.net && SS.net.active ? (a.team === SS.net.team ? ' · you' : ' · friend') : ''}</div>`);
    const retreat = S.retreatT > 0, place = S.phase === 'place', t = place ? S.placeT : retreat ? S.retreatT : S.turnT, lim = S.settings.turnTime > 0;
    setHTML('tbTime', `<div class="lbl">${place ? 'Deploy' : retreat ? 'Retreat' : S.sudden ? 'Sudden death' : 'Time'}</div><b class="${retreat || ((lim || place) && t < 10) ? 'low' : ''}">${place || retreat || (lim && S.phase === 'play') ? Math.max(0, Math.ceil(t)) : S.phase === 'play' ? '∞' : '–'}</b>`);
    const w = S.wind, d = P.dir(S); let along = 0, sp = 0;
    if (w && !SS.world.under) { along = w.mean.x * d.x + w.mean.z * d.z; sp = Math.hypot(w.mean.x, w.mean.z); }
    const f = Math.min(1, Math.abs(along) / 12) * 50;
    setHTML('tbWind', `<div class="lbl">Wind</div><div class="wbar"><i style="left:${along < 0 ? 50 - f : 50}%;width:${f.toFixed(1)}%"></i></div><div class="wt">${Math.abs(along) < 0.3 ? 'calm' : (along < 0 ? '◀ ' : '') + Math.abs(along).toFixed(1) + ' m/s' + (along > 0 ? ' ▶' : '')}</div>`);
    const we = S.weather, name = we ? ((C.WEATHER_NAME && C.WEATHER_NAME[we.kind]) || we.kind) : 'Caves';
    setHTML('tbWx', `<div class="lbl">Weather</div><div class="wxn">${SS.world.under ? 'Underground' : (WX_ICON[we && we.kind] || '') + ' ' + name}</div><div class="wxs">${SS.world.under ? 'no wind' : (SS.ice && SS.ice.air_temp ? Math.round(SS.ice.air_temp(S)) + ' °C · ' : '') + sp.toFixed(1) + ' m/s full wind'}${SS.view.timeOfDay && !SS.world.under && SS.view.timeOfDay(S) !== 'day' ? ' · ' + SS.view.timeOfDay(S) : ''}</div>`);
  }
  /* P9 weapon grid (built per match), info line */
  let gridBuilt = null; const gridBtn = {};
  // ASSET: weapon_icons, hud_panels (ui/icons/*.png, ui/hud/*.png)
  function buildGrid(S) {
    const vector = S && S.settings.art === 'procedural' && SS.icons;     // PoC "Artwork": painted icons / original vector icons
    const el = $('weapons'); el.innerHTML = '';
    for (const k of C.ARSENAL_ORDER) {
      const d = C.ARSENAL[k], b = document.createElement('button');
      b.className = 'wpn'; b.type = 'button'; b.title = `${d.name} (${d.key}): ${d.info}`;
      const ico = vector && SS.icons[k] ? `<svg viewBox="0 0 24 24" class="vi">${SS.icons[k]}</svg>` : `<img src="assets/icons/icon-${k}.webp" alt="">`;
      b.innerHTML = `${ico}<span class="k">${d.key}</span><span class="a"></span><span class="n">${d.name.replace('Baseball ', '').replace(' Rifle', '').replace('Pocket ', '').replace('Fuse ', '')}</span>`;
      b.onclick = () => { if (U.onPick) U.onPick(k); b.blur(); };
      el.appendChild(b); gridBtn[k] = { b, a: b.querySelector('.a'), s: '' };
    }
    gridBuilt = S ? S.settings.art || 'painted' : 'painted';
  }
  function drawWeapons(S, a) {
    if (gridBuilt !== (S.settings.art || 'painted')) buildGrid(S);
    const mine = !(SS.game && SS.game.is_cpu(S, a.team)) && !(SS.net && SS.net.active && a.team !== SS.net.team);
    for (const k of C.ARSENAL_ORDER) {
      const g = gridBtn[k], n = SS.game ? SS.game.ammo(S, a.team, k) : Infinity, usable = n > 0 && !(SS.weapons.needs_storm(k) && !(S.weather && S.weather.storm));
      const key = (S.weapon === k ? 's' : '') + (usable ? '' : 'e') + n;
      if (g.s === key) continue;
      g.s = key; g.b.classList.toggle('sel', S.weapon === k); g.b.classList.toggle('empty', !usable); g.a.textContent = n === Infinity ? '' : '×' + n;
    }
    const d = C.ARSENAL[S.weapon] || {}, pd = C.PROJ[S.weapon] || {};
    let hint = '';
    if (d.kind === 'target') hint = S.weapon === 'girder' ? ' · <em>click to place · ↑↓ turn</em>' : ' · <em>click the target on the section</em>' + (d.strike ? ` · <em>${S.strikeDir > 0 ? 'from the left ▶' : '◀ from the right'}</em> (← →)` : '');
    else if (d.target) hint = S.tgt ? ' · <em>target set</em>' : ' · <em>click a target first</em>';
    if (S.rope && d.payload) hint += ' · <em>Enter drops it</em>';
    if (SS.sim.can_switch && SS.sim.can_switch(S)) hint = ` · <em>Tab: switch worm (${Math.max(0, Math.ceil(10 - (S.time - S.turnStart)))} s)</em>` + hint;
    if (S.phase === 'place') { setHTML('winfo', mine ? `Deploy <em>${esc(a.name)}</em>: click a free spot on the section · Q / E rotate it · Enter auto-places` : `${esc(a.name)} is being deployed…`); return; }
    const shot = S.weapon === 'shotgun' && C.ARMS && C.ARMS.SHOTGUN ? ` · shot ${Math.min(C.ARMS.SHOTGUN.SHOTS, (S.shots || 0) + 1)} of ${C.ARMS.SHOTGUN.SHOTS}` : '';
    setHTML('winfo', S.phase === 'play' && mine ? `${d.name || ''}${pd.fuseSet ? ' · fuse ' + S.fuse + ' s (F)' : ''}${shot} — ${d.info || ''}${hint}` : '');
  }
  /* P9 game over (PoC #over): winner, rounds, Rematch / Change setup */
  let overShown = false;
  function drawOver(S) {
    const show = S.phase === 'over';
    if (show === overShown) return;
    overShown = show; const el = $('over'); el.classList.toggle('hidden', !show);
    if (!show) return;
    const t = S.over, names = S.worms.filter(w => !w.dead).map(w => w.name).join(', ');
    el.style.setProperty('--team', t >= 0 ? css(SS.sim.team_rgb(S, t)) : 'var(--accent)');
    el.querySelector('h2').textContent = t >= 0 ? `${SS.sim.team_name(S, t)} win` : 'Nobody wins';
    el.querySelector('p').textContent = t >= 0 ? `${names} ${names.indexOf(',') > 0 ? 'are' : 'is'} the last worm${names.indexOf(',') > 0 ? 's' : ''} standing after ${S.round} round${S.round > 1 ? 's' : ''}.` : 'Everyone went down together.';
    const guest = SS.net && SS.net.active && !SS.net.isHost;
    $('bRematch').style.display = guest ? 'none' : ''; $('bSetup').style.display = guest ? 'none' : '';
    if (guest) el.querySelector('p').textContent += ' The host starts the next map.';
  }
  function drawHUD(S) {
    const a = S.active;
    if (!a) return;
    const ap = P.to_plane(S, a.pos), team = { name: SS.sim.team_name(S, a.team), rgb: SS.sim.team_rgb(S, a.team) }, tc = css(team.rgb);
    const tg = S.target && !S.target.dead ? S.target : null;
    const wp = C.WEAPONS[S.weapon];
    const brg = bearing(S.theta);
    drawTop(S, a, team, tc); drawWeapons(S, a); drawOver(S);
    const vmax = wp.vmax || 28, pd = C.PROJ[S.weapon] || {};
    setHTML('hud', `
      <div class="power ${S.charging ? 'on' : ''}"><i style="width:${(S.power * 100).toFixed(0)}%"></i><span>${S.charging ? (vmax * Math.max(C.WORM_DYN.MIN_POWER, S.power)).toFixed(1) + ' m/s' : pd.W ? pd.W.toFixed(2) + ' kg TNT-eq' + (pd.fuse ? ' · ' + (pd.fuseSet ? S.fuse : pd.fuse) + ' s fuse' : ' · contact fuse') : wp.kind === 'rope' ? 'reach ' + C.ROPE_MAX + ' m' : wp.name}</span></div>
      <div class="row"><div class="compass"><div class="needle" style="transform:rotate(${brg}deg)"></div><span>${brg.toFixed(0).padStart(3, '0')}°</span></div>
        <div class="facts">
          <div>Section ${S.phase !== 'play' ? '<span class="lock">locked · attack resolving</span>' : SS.sim.heading_window && SS.sim.heading_window(S) ? '<span class="ok">turns only toward the play area or a worm</span>' : '<span class="ok">free to rotate</span>'}</div>
          <div>Aim ${Math.round(S.aim * 180 / Math.PI)}° · alt ${a.pos.y.toFixed(1)} m · s ${ap.s.toFixed(1)} m</div>
          <div>Target ${tg ? `<b>${esc(tg.name)}</b> ${M.v3_dist(tg.pos, a.pos).toFixed(1)} m · ${Math.abs(P.to_plane(S, tg.pos).t).toFixed(1)} m off` : '–'}</div>
          ${S.rope ? `<div>Rope ${S.rope.hooked ? 'hooked' : '<span class="lock">re-hooking…</span>'} · ${S.rope.len.toFixed(1)} m</div>` : ''}
        </div></div>
      ${iceRow(S, a)}
      ${hotRow(S, a)}
      `);
    const tot = (S.teams || []).map((t, i) => teamHP(S, i));
    // P1: N teams; bars relative to the team's starting total (worms x starting HP)
    setHTML('teams', (S.teams || []).map((t, i) => { const max = S.worms.filter(w => w.team === i).reduce((s, w) => s + (w.hp0 || 100), 0) || 1; return `<div class="tm${a.team === i ? ' cur' : ''}" style="--team:${css(t.rgb)}"><span>${esc(t.name)}${t.ctl === 'cpu' ? ' · CPU' : ''}</span><div class="bar"><i style="width:${(100 * tot[i] / max).toFixed(1)}%"></i></div><b>${tot[i]}</b></div>`; }).join(''));
    // the log fades in 0.05 steps (so the string, and the DOM, change a few times per line instead of every frame)
    setHTML('log', S.log.map(l => `<div style="color:${css(l.rgb)};opacity:${Math.max(0.35, Math.round((1 - (S.time - l.t) / 14) * 20) / 20)}">${esc(l.text)}</div>`).join(''));
  }

  /* Section minimap base: rebuilt when the section changes. Solid has red channel > 90, air/sea do not. */
  U.sectionChanged = function (S) {
    const { ns, ny, V } = S.section;
    secBase.width = ns; secBase.height = ny;
    const bx = secBase.getContext('2d'), img = bx.createImageData(ns, ny), sea = SS.world.SEA;
    // open lava (sim/lava.js layer) along the section: surface height per section column (-1 = none)
    const lavaY = new Float32Array(ns).fill(-1), d = SS.plane.dir(S);
    if (SS.lava && S.lava) for (let i = 0; i < ns; i++) { const s = S.section.s0 + i * 0.5; lavaY[i] = SS.lava.surface_at(S, S.O.x + s * d.x, S.O.z + s * d.z); }
    lavaVer = S.lava ? S.lava.ver : 0;
    // water surface along the section (sim/water.js; -99 = dry), else the still sea level
    const waterY = new Float32Array(ns).fill(sea);
    if (SS.water && S.water) for (let i = 0; i < ns; i++) { const s = S.section.s0 + i * 0.5; waterY[i] = SS.water.surface(S, S.O.x + s * d.x, S.O.z + s * d.z); }
    waterVer = S.water ? S.water.ver : 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < ns; i++) {
      const v = V[j * ns + i], o = ((ny - 1 - j) * ns + i) * 4, y = j * 0.5;
      const above = V[Math.min(ny - 1, j + 1) * ns + i];
      let r, g, b;
      if (v > 0) {
        const m = S.section.M[j * ns + i];
        if (m === C.MAT.LAVA) { r = 255; g = 110; b = 30; }
        else if (v < 0.6 && above <= 0) { r = 118; g = 186; b = 84; }
        else { r = 168 + (j % 6) * 5 - Math.min(40, v * 6); g = 120 + (j % 6) * 4; b = 82; }
      } else if (y < lavaY[i]) { r = 255; g = 120; b = 36; }
      else if (y < waterY[i]) { r = 40; g = 96; b = 140; }
      else { const k = j / ny; r = 24 + k * 20; g = 38 + k * 30; b = 58 + k * 40; }
      const D = img.data; D[o] = r; D[o + 1] = g; D[o + 2] = b; D[o + 3] = 255;
    }
    bx.putImageData(img, 0, 0);
  };
  function drawSectionMap(S) {
    if (!S.section) return;
    const { s0, s1 } = S.section, len = s1 - s0, Wd = 320, sc = Wd / len, Hh = Math.round(40 * sc);
    if (secC.height !== Hh + 16) secC.height = Hh + 16;
    const x = secX; x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, Wd, secC.height); x.drawImage(secBase, 0, 0, Wd, Hh);
    const Pp = (s, y) => [(s - s0) * sc, Hh - y * sc];
    for (const w of S.worms) {
      if (w.dead) continue;
      const pp = P.to_plane(S, w.pos), q = Pp(pp.s, w.pos.y), tc = css(C.TEAMS[w.team].rgb);
      if (SS.view.inSlab(S, w.pos) || w === S.active) {
        x.fillStyle = tc; x.beginPath(); x.arc(q[0], q[1], 3.4, 0, 7); x.fill();
        if (w === S.active) { x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.beginPath(); x.arc(q[0], q[1], 6, 0, 7); x.stroke(); }
      } else if (q[0] >= 0 && q[0] <= Wd) {
        // off-section worms: hollow ticks in the gutter below the map, never drawn on playable terrain
        x.strokeStyle = tc; x.lineWidth = 1.5; x.beginPath(); x.moveTo(q[0], Hh + 3); x.lineTo(q[0] - 4, Hh + 11); x.lineTo(q[0] + 4, Hh + 11); x.closePath(); x.stroke();
      }
    }
    for (const p of S.proj) { const q = Pp(p.s, p.y); x.fillStyle = '#fff'; x.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3); }
    if (S.rope && S.active) { const ap = P.to_plane(S, S.active.pos), A = Pp(ap.s, S.active.pos.y), B = Pp(S.rope.s, S.rope.y); x.strokeStyle = '#ffe08a'; x.lineWidth = 1; x.beginPath(); x.moveTo(A[0], A[1]); x.lineTo(B[0], B[1]); x.stroke(); }
    x.fillStyle = '#e8eef5'; x.fillRect(Wd - 10 * sc - 8, 8, 10 * sc, 2); x.font = '10px system-ui,sans-serif'; x.fillText('10 m', Wd - 10 * sc - 8, 20);
  }

  function buildTopBase(S) {
    const vs = SS.view.state, H = vs.heightmap, n = 97, W = SS.world, sea = W.SEA, surf = vs.surf, sn = vs.surfN;
    topBase.width = n; topBase.height = n;
    const bx = topBase.getContext('2d'), img = bx.createImageData(n, n);
    if (W.under) {                                           // U: an x-ray plan of the caves, the active worm's level bright
      const ya = underLevel * 3, L = Math.ceil(W.SY - 2.5);
      // open (air) samples per column at y = 1.5, 2.5, ... (one terrain scan per heightVer, not per level change)
      if (underVer !== vs.heightVer || !underOpen) {
        underOpen = new Uint8Array(n * n * L); underVer = vs.heightVer;
        for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
          const x = Math.min(W.SX, i), z = Math.min(W.SZ, k), o = (k * n + i) * L;
          for (let l = 0; l < L; l++) underOpen[o + l] = W.sample(x, 1.5 + l, z) <= 0 ? 1 : 0;
        }
      }
      for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const q = (k * n + i) * L; let any = false, lev = false;
        for (let l = 0; l < L; l++) if (underOpen[q + l]) { any = true; if (Math.abs(1.5 + l - ya) < 3) { lev = true; break; } }
        const c = lev ? [205, 192, 168] : any ? [96, 86, 76] : [34, 30, 28], o = (k * n + i) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
      bx.putImageData(img, 0, 0);
      return;
    }
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const h = H[k * n + i];
      // hill shading from the heightmap gradient
      const hx = H[k * n + Math.min(n - 1, i + 1)] - H[k * n + Math.max(0, i - 1)], hz = H[Math.min(n - 1, k + 1) * n + i] - H[Math.max(0, k - 1) * n + i];
      const shade = M.clamp(1 - (hx * 0.5 + hz * 0.35) * 0.12, 0.6, 1.3);
      let c;
      const cc = W.circ, far = cc && Math.hypot(i - cc.x, k - cc.z) > cc.r;      // (map pixel = 1 m) D6: beyond the disc
      if (h < sea) c = [34, 88, 132];
      else if (far) {                                         // the far dunes: plain sand, a little dimmer (not destructible)
        const rgb = C.MATS[C.MAT.SAND].rgb, lift = 0.72 + h * 0.012; c = [((rgb >> 16) & 255) * lift, ((rgb >> 8) & 255) * lift, (rgb & 255) * lift];
      } else {
        const ci = Math.min(W.NX - 1, i * 2), ck = Math.min(W.NZ - 1, k * 2), j = W.topJ[ck * W.NX + ci];
        const m = j >= 0 ? W.mat[(ck * W.NY + j) * W.NX + ci] : 0, rgb = C.MATS[m].rgb;
        c = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
        if (surf) { const g = surf[(Math.min(sn - 1, ck) * sn + Math.min(sn - 1, ci)) * 4] / 255, dry = surf[(Math.min(sn - 1, ck) * sn + Math.min(sn - 1, ci)) * 4 + 1] / 255; const gc = [96 + dry * 90, 140 + dry * 30, 60]; for (let q = 0; q < 3; q++) c[q] = c[q] * (1 - g) + gc[q] * g; }
        const lift = 0.85 + h * 0.012; c = [c[0] * lift, c[1] * lift, c[2] * lift];
      }
      img.data.set([c[0] * shade, c[1] * shade, c[2] * shade, 255], (k * n + i) * 4);
    }
    bx.putImageData(img, 0, 0);
  }
  function drawTopMap(S) {
    const vs = SS.view.state;
    if (!vs.heightmap) return;
    // U: the worm's level in 3 m bands, with hysteresis (a worm bobbing at a band edge does not flicker the map)
    if (SS.world.under && S.active) { const f = S.active.pos.y / 3; if (Math.abs(f - underLevel) > 0.7) underLevel = Math.round(f); }
    const tv = vs.heightVer * 65536 + (vs.surfUploads | 0) + (SS.world.under ? underLevel * 7919 : 0);   // terrain / surface changed (U: the worm's level)
    if (topVer !== tv) { buildTopBase(S); topVer = tv; }
    const x = topX, Z = topC.width, sc = Z / 96, n = P.nrm(S);
    x.imageSmoothingEnabled = true; x.drawImage(topBase, 0, 0, Z, Z);
    const L = 140, ox = S.O.x * sc, oz = S.O.z * sc;
    if (SS.world.dry) {                                       // play area of a dry world: beyond it the sand is hot
      x.strokeStyle = 'rgba(255,140,60,0.85)'; x.lineWidth = 1.5; x.setLineDash([4, 3]);
      x.beginPath(); x.arc(C.DRY.CX * sc, C.DRY.CZ * sc, S.playR * sc, 0, 7); x.stroke(); x.setLineDash([]);
      x.strokeStyle = 'rgba(70,40,20,0.45)'; x.lineWidth = 1;   // D6: the edge of the destructible disc
      x.beginPath(); x.arc(C.DRY.CX * sc, C.DRY.CZ * sc, C.DRY.LAT_R * sc, 0, 7); x.stroke();
    }
    x.save(); x.translate(ox, oz); x.rotate(S.theta);
    // visible slab: from slice zero (t = 0) back to -uBack (rotated frame: +y = plane normal = camera side)
    const bk = Math.min(L, SS.terrain.uniforms.uBack.value);
    x.fillStyle = 'rgba(255,243,176,0.35)'; x.fillRect(-L * sc, -bk * sc, 2 * L * sc, bk * sc);
    x.strokeStyle = 'rgba(255,243,176,0.9)'; x.lineWidth = 1; x.strokeRect(-L * sc, -bk * sc, 2 * L * sc, bk * sc);
    x.fillStyle = '#fff3b0'; x.beginPath(); x.moveTo(Z * 0.42, 0); x.lineTo(Z * 0.36, -5); x.lineTo(Z * 0.36, 5); x.fill();
    x.restore();
    x.fillStyle = 'rgba(255,255,255,0.7)'; x.beginPath(); x.arc(ox + n.x * 10 * sc, oz + n.z * 10 * sc, 2.5, 0, 7); x.fill();
    // the map's mines (user 2026-10-07): flickering red arrows while they are still unburied, then gone
    if (S.mapMinesUntil >= 0 && S.time < S.mapMinesUntil && Math.sin(S.time * 9) > -0.2) {
      x.fillStyle = '#ff3b30';
      for (const b of S.bodies) if (b.prop === 'mine' && b.team === -1 && !b.disarmed) {
        const mx = b.pos.x * sc, mz = b.pos.z * sc; x.beginPath(); x.moveTo(mx, mz); x.lineTo(mx - 4, mz - 8); x.lineTo(mx + 4, mz - 8); x.closePath(); x.fill();
      }
    }
    for (const w of S.worms) {
      if (w.dead) continue;
      const px = w.pos.x * sc, pz = w.pos.z * sc, inSec = SS.view.inSlab(S, w.pos);
      x.fillStyle = css(C.TEAMS[w.team].rgb); x.globalAlpha = inSec || w === S.active ? 1 : 0.8;
      x.beginPath(); x.arc(px, pz, w === S.active ? 4.5 : 3.5, 0, 7); x.fill(); x.globalAlpha = 1;
      if (w === S.active) { x.strokeStyle = '#fff'; x.lineWidth = 2; x.beginPath(); x.arc(px, pz, 7, 0, 7); x.stroke(); }
      if (w === S.target) { x.strokeStyle = '#ffe14a'; x.lineWidth = 1.5; x.beginPath(); x.arc(px, pz, 7, 0, 7); x.stroke(); }
    }
    x.fillStyle = '#e8eef5'; x.font = 'bold 10px system-ui,sans-serif'; x.fillText('N', Z / 2 - 3, 11);
  }

  /* top-map click → nearest worm (for alignment) */
  U.pickTop = function (S, e) {
    const r = topC.getBoundingClientRect(), sc = topC.width / 96;
    const mx = (e.clientX - r.left) * topC.width / r.width, mz = (e.clientY - r.top) * topC.height / r.height;
    let best = null, bd = 9;
    for (const w of S.worms) if (!w.dead && w !== S.active) { const dd = Math.hypot(w.pos.x * sc - mx, w.pos.z * sc - mz); if (dd < bd) { bd = dd; best = w; } }
    return best;
  };
})(window.SS = window.SS || {});
