/* ui/hud.js — DOM HUD, floating labels, combat log and the two minimaps. Reads the sim state only. */
(function (SS) {
  'use strict';
  const C = SS.CFG, P = SS.plane, M = SS.math;
  const U = SS.ui = {};
  const $ = id => document.getElementById(id);
  const css = C.css;
  let overT0 = 0;                                                  // when the results card appeared (P118d: its buttons ignore the first 0.4 s)
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
    if (SS.offscreen) SS.offscreen.init(labels, cam, cv);
    $('bRematch').onclick = () => { if (performance.now() - overT0 > 400) U.onRematch && U.onRematch(); };      // P118d: a key that skipped the celebration (and repeats) must not rematch by itself
    $('bSetup').onclick = () => { if (performance.now() - overT0 > 400) U.onSetup && U.onSetup(); };
  };

  const v3 = new THREE.Vector3();
  /* P38-R4: the canvas size is cached (a read of clientWidth after DOM writes forced a layout per label per frame) */
  let cvW = 0, cvH = 0;
  function sizeCache() { if (canvas) { cvW = canvas.clientWidth; cvH = canvas.clientHeight; } }
  addEventListener('resize', sizeCache); addEventListener('orientationchange', sizeCache);
  function project(p) { if (!cvW) sizeCache(); v3.set(p.x, p.y, p.z).project(camera); return { x: (v3.x + 1) / 2 * cvW, y: (1 - v3.y) / 2 * cvH, front: v3.z < 1 }; }

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
    fall: ['Aaaah!', 'Whoaaa!', 'Not again!'],
    cough: ['*cough cough*', 'Hack! Cough!', 'Ugh… that gas', '*wheeze*'],
    acid: ['Ouch! Ouch!', 'It burns!', 'Ow ow ow!', 'Hot hot hot!'],
    hugged: ['Mmmph! Get it off!', 'MMPH!!', 'Hmmf! Hmmf!'],                                                 // P47: the face hugger
    sick: ['I do not feel so good…', 'Something is moving in my chest', 'Is it hot in here?', 'My tummy hurts…', 'Whoa… dizzy…']
  };
  /* the floating things over the worms (damage numbers, pickups, speech bubbles): one array, no DOM query per frame */
  const pops = []; let popN = 0;
  function dropPop(i) { pops[i].remove(); pops.splice(i, 1); }
  function addPop(el, w, t) { el._w = w; el._t = t; labels.appendChild(el); pops.push(el); return el; }
  function say(w, kind, arg) {
    for (let i = pops.length - 1; i >= 0; i--) if (pops[i]._bub && pops[i]._w === w) dropPop(i);      // one bubble per worm
    const L = SAY[kind], el = document.createElement('div'); el.className = 'pop bubble';
    el.textContent = L[Math.floor(Math.random() * L.length)].replace('{w}', arg || ''); el._bub = 1; addPop(el, w, curS ? curS.time : 0);
  }
  /* P85: speech bubbles of the ACTIVE worm come from its own events (start, fire, pass, pickup); everybody else's only when render/reactq.js
   * lets that worm speak (affected by the attack, one at a time, same moment as its voice and the camera visit) */
  if (SS.reactq) SS.reactq.listen(function (S, it) { const w = S.worms[it.wid]; if (w && it.kind && !(w.dead && it.kind !== 'die') && (it.kind === 'die' || it.kind === 'shock' || it.kind === 'fall' || Math.random() < 0.7)) say(w, it.kind); });
  /* damage number: the team colour of the hurt worm, bigger for hard hits (>= 30) and crits (>= 60), small for burning / poison ticks;
   * a damage-over-time tick is skipped while the previous one of that worm is still fresh; neighbours are spread sideways */
  function damagePop(S, e) {
    const amt = Math.round(e.amount); if (!(amt > 0)) return;
    if (e.dot) for (let i = pops.length - 1; i >= 0; i--) if (pops[i]._dot && pops[i]._w === e.worm && S.time - pops[i]._t < 0.5) return;
    const el = document.createElement('div'); el.className = 'pop' + (e.dot ? ' dot' : amt >= 60 ? ' crit' : amt >= 30 ? ' big' : '');
    el.innerHTML = '<span class="pn">-' + amt + '</span>'; el.style.color = css(C.TEAMS[e.worm.team].rgb);
    el._dx = ((popN++ % 3) - 1) * 24; el._dot = !!e.dot; addPop(el, e.worm, S.time);
  }
  function gainPop(S, e) {
    const el = document.createElement('div'); el.className = 'pop gain';
    el.innerHTML = '<span class="pn">' + esc(e.kind === 'health' ? '+' + e.amount : e.kind === 'tool' ? ((C.SKILL && C.SKILL.NAMES && C.SKILL.NAMES[e.tool]) || 'Tool') : C.ARSENAL[e.weapon].name) + '</span>';
    el.style.color = e.kind === 'health' ? '#79d98b' : e.kind === 'tool' ? '#9fe8ff' : '#ffb02e'; el._dx = 0; addPop(el, e.worm, S.time);
  }
  /* P89: the life jacket inflated: a small orange label over the worm (no speech bubble: the voice rules of P85) */
  function jacketPop(S, e) {
    const el = document.createElement('div'); el.className = 'pop gain';
    el.innerHTML = '<span class="pn">LIFE JACKET</span>'; el.style.color = '#ffa24a'; el._dx = 0; addPop(el, e.worm, S.time);
  }
  /* kill feed (top right under the maps): who went down and how; entries fade by themselves (CSS) and are removed when the animation ends */
  const KILL_VERB = ['was eliminated', 'was blown up', 'was shot', 'was crushed', 'burned to death', 'fell into the lava', 'succumbed to poison', 'drowned', 'was electrocuted', 'fell to their death', 'was eaten by the alien', 'was dissolved by acid', 'was shredded'];
  let feedEl = null;
  function killFeed(S, e) {
    if (!feedEl) { feedEl = $('feed'); feedEl.addEventListener('animationend', ev => { if (ev.animationName === 'kfout' && ev.target.parentNode === feedEl) ev.target.remove(); }); }
    const el = document.createElement('div'); el.className = 'kf'; el.style.setProperty('--team', css(C.TEAMS[e.worm.team].rgb));
    el.innerHTML = '<i>☠</i><b>' + esc(e.worm.name) + '</b><span>' + (KILL_VERB[e.cause | 0] || KILL_VERB[0]) + '</span>';
    feedEl.appendChild(el); while (feedEl.children.length > 3) feedEl.removeChild(feedEl.firstChild);
  }
  let curS = null;
  function banner(title, sub, color) {
    const b = $('banner'); b.innerHTML = ''; b.appendChild(document.createTextNode(title));
    if (sub) { const sm = document.createElement('small'); sm.textContent = sub; b.appendChild(sm); }
    b.style.color = color; b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }
  U.onEvent = function (S, e) {
    curS = S;
    if (SS.offscreen) SS.offscreen.onEvent(S, e);
    if (e.type === 'turn' && e.worm && S.active && e.worm.id === S.active.id) say(e.worm, 'start');                                            // PoC: every turn
    if (e.type === 'fire' && S.active && Math.random() < 0.3) say(S.active, 'fire');
    if (e.type === 'use' && e.weapon === 'skip' && S.active) say(S.active, 'pass');
    if (e.type === 'pickup' && e.worm && S.active && e.worm.id === S.active.id) say(e.worm, e.kind === 'health' ? 'health' : 'crate', e.weapon && C.ARSENAL[e.weapon] ? C.ARSENAL[e.weapon].name : '');
    if (e.type === 'hugger_attach' && e.worm && !e.worm.dead) { say(e.worm, 'hugged'); banner(`${e.worm.name} was face-hugged!`, `Infected: −${SS.alien.K.PARA_HP} HP every ${SS.alien.K.PARA_T} s. Shoot the hugger off, then find a health crate`, '#b6ff4a'); }       // P47
    if (e.type === 'hugger_detach' && e.worm && !e.worm.dead) say(e.worm, 'sick');
    if (e.type === 'chest_burst' && e.wormId != null) banner('Something bursts out!', e.worm ? e.worm.name : '', '#b6ff4a');
    if (e.type === 'reset') U.clear();
    if (e.type === 'hurt' && e.worm) damagePop(S, e);
    if (e.type === 'kill' && e.worm) killFeed(S, e);
    if (e.type === 'turn') {
      const tt = `${SS.sim.team_name(S, e.worm.team)} · ${e.worm.name}`, ts = SS.game && SS.game.is_cpu(S, e.worm.team) ? 'CPU' : 'is up', tc = css(C.TEAMS[e.worm.team].rgb), dl = SS.cine ? SS.cine.turnDelay() : 0;
      if (dl > 0.05) setTimeout(() => banner(tt, ts, tc), dl * 1000); else banner(tt, ts, tc);      // P63: the name appears as the camera move settles
    }
    if (e.type === 'banner') banner(e.title, e.sub, 'var(--accent)');
    if (e.type === 'labbank') banner('Bank shot x' + e.k.toFixed(1), e.bounces + (e.bounces > 1 ? ' ricochets' : ' ricochet'), 'var(--accent)');
    if (e.type === 'pickup' && e.worm) gainPop(S, e);
    if (e.type === 'jacket' && e.worm) jacketPop(S, e);                                           // P89
    if (e.type === 'reset') { overShown = null; teamN = -1; if (feedEl) feedEl.innerHTML = ''; for (const k in gridBtn) gridBtn[k].s = ''; }
  };

  /* drop every worm label, damage pop and speech bubble (they hold worm objects: a replay restore / a new game
   * replaces those, the old ones would stay frozen on screen next to the new ones) */
  U.clear = function () {
    for (const el of wl.values()) el.remove(); wl.clear();
    while (pops.length) dropPop(pops.length - 1);
  };
  function label(w) {
    let el = wl.get(w);
    if (!el) {
      el = document.createElement('div'); el.className = 'wlabel';
      el.innerHTML = '<span class="nm"></span><span class="off"></span><div class="hpbar"><i></i></div><b class="hpn"></b><span class="inf"></span>';
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
    const rsS = NT.resyncState ? NT.resyncState() : 'ok', state = rsS === 'failed' ? ['DESYNC', 'bad'] : rsS === 'wait' ? ['resyncing', 'warn'] : rsS === 'verify' ? ['checking', 'warn'] : quiet > 4000 ? ['no signal', 'bad'] : st.hashOk > 0 ? ['in sync', 'ok'] : ['checking', 'warn'];
    const ping = rtt == null ? '—' : rtt + ' ms', cls = state[1] === 'bad' || (rtt != null && rtt > 250) ? 'bad' : (rtt != null && rtt > 120) || state[1] === 'warn' ? 'warn' : 'ok';
    const txt = `🌐 ${st.mode === 'lan' ? 'LAN' : 'room'} · ${st.peers + 1} players · ${ping} · ${state[0]}`;
    if (txt !== netLast) {
      netEl.textContent = txt; netEl.className = cls; netLast = txt;
      if (!NT.isHost) { const bt = document.createElement('button'); bt.textContent = 'Resync'; bt.title = 'Fetch the host\'s game state'; bt.style.cssText = 'margin-left:8px;padding:1px 8px;border-radius:6px;border:0;background:rgba(255,255,255,.18);color:inherit;font:inherit;cursor:pointer'; bt.onclick = () => NT.resync_request(); netEl.appendChild(bt); }      // P103: a guest may pull the host's state by hand
    }
    netEl.style.display = 'block';
  }
  /* P37-6: "ROTATE NOW" splash with the countdown of the free rotation window (sim/rotlock.js), display font */
  let rotEl = null, rotTxt = '';
  function rotSplash(S) {
    if (!rotEl) { rotEl = document.createElement('div'); rotEl.id = 'rotnow'; document.body.appendChild(rotEl); }
    const a = S.active, mine = a && !(SS.game && SS.game.is_cpu(S, a.team)) && !(SS.net && SS.net.active && a.team !== SS.net.team);
    const l = mine && SS.rotlock && SS.rotlock.enabled(S) ? SS.rotlock.left(S) : -1, txt = l > 0 ? 'ROTATE NOW<b>' + Math.ceil(l) + '</b>' : '';
    if (txt !== rotTxt) { rotTxt = txt; if (txt) rotEl.innerHTML = txt; rotEl.classList.toggle('on', !!txt); }
    rotEl.classList.toggle('low', l > 0 && l <= 3);
  }
  /* P86: End of the World: the jetpack chips, one per team (charges left, ON / OFF); a click / key J toggles the active team's (sim: S.eow.jet) */
  let jetEl = null, jetTxt = '';
  function jetChips(S) {
    if (!jetEl) {
      jetEl = document.createElement('div'); jetEl.id = 'eowJet';
      jetEl.style.cssText = 'position:fixed;left:12px;bottom:118px;z-index:12;display:none;font:700 12px/1 "Barlow Semi Condensed",system-ui,sans-serif;color:#dbe9ff;pointer-events:auto';
      jetEl.addEventListener('click', () => { if (SS.input) SS.input.jetReq = 1; });
      document.body.appendChild(jetEl);
    }
    const J = S.eow && S.eow.jet; if (!J) { if (jetTxt) { jetTxt = ''; jetEl.style.display = 'none'; } return; }
    const a = S.active; let txt = '';
    for (let t = 0; t < J.length; t++) txt += '<div style="display:flex;gap:6px;align-items:center;margin:2px 0;padding:4px 8px;border-radius:6px;background:rgba(8,12,22,.72);border:1px solid ' + (a && a.team === t ? '#9fd0ff' : 'rgba(255,255,255,.12)') + ';cursor:pointer"><i style="width:9px;height:9px;border-radius:50%;background:' + css(C.TEAMS[t].rgb) + '"></i>JETPACK <b style="color:' + (J[t].on && J[t].n > 0 ? '#9fd0ff' : '#ff9a7a') + '">' + (J[t].n > 0 ? (J[t].on ? 'ON' : 'OFF') : 'EMPTY') + '</b> x' + J[t].n + (a && a.team === t ? ' <span style="opacity:.6">[J]</span>' : '') + '</div>';
    if (txt !== jetTxt) { jetTxt = txt; jetEl.innerHTML = txt; jetEl.style.display = 'block'; }
  }
  /* P42: the Lab badge: the active experimental mechanics (sim/lab.js) */
  let labEl = null, labTxt = '';
  function labBadge(S) {
    if (!labEl) labEl = $('labbadge'); if (!labEl) return;
    const txt = SS.lab ? SS.lab.badge(S) : '';
    if (txt !== labTxt) { labTxt = txt; labEl.textContent = txt ? 'Lab: ' + txt : ''; labEl.style.display = txt ? 'block' : 'none'; }
  }
  /* P47: the parasite line under a worm's label: a face hugger on, or the infection with the countdown to the next hit (red when that hit kills) */
  const INF = { stage: 0, left: 0, ttd: 0, sev: 0, pulses: 0 };
  function infoLabel(S, w, el) {
    SS.alien.infection(S, w, INF);
    let txt = '', cls = 'inf';
    if (INF.stage === 1) { const s1 = Math.ceil(INF.left); txt = '☣ FACE HUGGER · −' + SS.alien.K.PARA_HP + ' HP in ' + Math.floor(s1 / 60) + ':' + String(s1 % 60).padStart(2, '0'); cls += ' hug'; }
    else if (INF.stage === 2) {
      const s = Math.ceil(INF.left), lethal = w.hp <= SS.alien.K.PARA_HP;
      txt = `☣ ${lethal ? 'BURSTING' : '−' + SS.alien.K.PARA_HP + ' HP'} in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      cls += lethal ? ' lethal' : ' sick'; if (INF.left < 10) cls += ' soon';
    }
    setText(el, txt); if (el._c !== cls) { el._c = cls; el.className = cls; }
  }
  /* P47: the hatching bar under every opening egg and the alien's own label (kills, HP) */
  const eggEls = [], xenoEls = [], sleepEls = [];
  function alienLabels(S) {
    const A = S.alien; let ne = 0, nx = 0, ns = 0;
    if (A && SS.alien) {
      for (const e of A.eggs) {
        if (e.st !== 1) continue;
        const p = SS.alien.egg_progress(S, e), pt = { x: e.x, y: e.y + 0.02, z: e.z };
        let el = eggEls[ne]; if (!el) { el = eggEls[ne] = document.createElement('div'); el.className = 'eggbar'; el.innerHTML = '<div class="eb"><i></i></div><b></b>'; labels.appendChild(el); }
        ne++;
        const sp = project(pt), shown = SS.view.shownAt(S, pt, 0.6) && sp.front;
        el.style.display = shown ? 'block' : 'none'; if (!shown) continue;
        const hue = Math.round(92 - 92 * M.sat((p - 0.72) / 0.28)), pct = Math.floor(p * 100);
        el.firstChild.firstChild.style.width = (p * 100).toFixed(1) + '%'; el.firstChild.firstChild.style.background = `hsl(${hue},85%,50%)`;
        setText(el.lastChild, 'EGG ' + pct + '%'); el.classList.toggle('ripe', p > 0.92);
        el.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,6px)`;
      }
      for (const X of A.xenos) {
        let el = xenoEls[nx]; if (!el) { el = xenoEls[nx] = document.createElement('div'); el.className = 'alabel'; el.innerHTML = '<span class="nm">ALIEN</span><div class="hpbar"><i></i></div><b class="hpn"></b>'; labels.appendChild(el); }
        nx++;
        if (X.st === 7) {                                                // P51: the sleep bar under the curled-up alien (same bar as the egg's)
          const h7 = X.n[X.n.length >> 1], p7 = M.sat((S.time - X.t0) / SS.alien.K.SLEEP_T), pt7 = { x: X.home.x, y: h7.y - 0.1, z: X.home.z }, sp7 = project(pt7);
          let eb = sleepEls[ns]; if (!eb) { eb = sleepEls[ns] = document.createElement('div'); eb.className = 'eggbar'; eb.innerHTML = '<div class="eb"><i></i></div><b></b>'; labels.appendChild(eb); }
          ns++;
          const sh7 = SS.view.shownAt(S, h7, 0.6) && sp7.front; eb.style.display = sh7 ? 'block' : 'none';
          if (sh7) {
            const woke = X.wkT - X.t0 < SS.alien.K.SLEEP_T - 0.01 && X.gp === 0;
            eb.firstChild.firstChild.style.width = (p7 * 100).toFixed(1) + '%'; eb.firstChild.firstChild.style.background = woke ? 'hsl(8,85%,50%)' : 'hsl(205,80%,58%)';
            setText(eb.lastChild, woke ? 'WAKING!' : 'ZZZ ' + Math.floor(p7 * 100) + '%'); eb.style.transform = `translate(${sp7.x}px,${sp7.y}px) translate(-50%,6px)`;
          }
        }
        const h = X.n[0], pt = { x: h.x, y: h.y + 0.9 * X.size + 0.3, z: h.z }, sp = project(pt), shown = SS.view.shownAt(S, h, 0.6) && sp.front;
        el.style.display = shown ? 'block' : 'none'; if (!shown) continue;
        el.firstChild.nextSibling.firstChild.style.width = Math.max(0, Math.min(100, 100 * X.hp / X.hpMax)) + '%';
        setText(el.lastChild, Math.max(0, Math.round(X.hp)) + (X.kills ? ' · ' + X.kills + ' kill' + (X.kills > 1 ? 's' : '') : ''));
        el.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%)`;
      }
    }
    for (let i = ne; i < eggEls.length; i++) eggEls[i].style.display = 'none';
    for (let i = nx; i < xenoEls.length; i++) xenoEls[i].style.display = 'none';
    for (let i = ns; i < sleepEls.length; i++) sleepEls[i].style.display = 'none';
  }
  /* P50: the perk draft overlay (sim/lab.js, phase 'perk'): three cards for the picking team (1 / 2 / 3 or a click = Input.fuse), the others wait */
  let pkEl = null, pkSig = '';
  function perkPanel(S) {
    if (!pkEl) { pkEl = $('perkui'); if (!pkEl) return; pkEl.addEventListener('click', e => { const c = e.target.closest ? e.target.closest('.pk-card') : null; if (c && !c.classList.contains('off')) SS.input.perkPick = +c.dataset.n; }); }
    const D = S.lab && S.lab.draft, on = S.phase === 'perk' && D && D.on;
    if (!on) { if (pkSig) { pkSig = ''; pkEl.classList.remove('on'); } return; }
    const team = D.team, cpu = SS.game.is_cpu(S, team), mine = !cpu && !(SS.net && SS.net.active && team !== SS.net.team), L = SS.lab;
    const left = Math.max(0, Math.ceil(D.t)), sig = [team, D.opts.join(), mine, cpu ? 0 : left, S.lab.perks.join()].join('|');
    if (sig === pkSig) return; pkSig = sig;
    let h = `<div class="pk-h" style="--team:${css(SS.sim.team_rgb(S, team))}">${esc(SS.sim.team_name(S, team))} · PERK DRAFT<small>${cpu ? 'CPU is choosing…' : mine ? `Pick one: press 1 / 2 / 3 or click · ${left} s` : 'Waiting for the pick…'}</small></div><div class="pk-row" style="--team:${css(SS.sim.team_rgb(S, team))}">`;
    for (let i = 0; i < D.nopt; i++) h += `<div class="pk-card${mine ? '' : ' off'}" data-n="${i + 1}"><span class="pk-key">${i + 1}</span><div class="pk-name">${L.PERK_NAMES[D.opts[i]]}</div><div class="pk-txt">${L.PERK_TEXT[D.opts[i]]}</div></div>`;
    h += '</div>';
    const got = []; for (let t = 0; t < S.teams.length; t++) { const n = L.perk_list(S, t); if (n) got.push(`${esc(SS.sim.team_name(S, t))}: ${n}`); }
    if (got.length) h += `<div class="pk-foot">${got.join(' &nbsp;·&nbsp; ')}</div>`;
    pkEl.innerHTML = h; pkEl.classList.add('on');
  }
  /* the team panel chip: the perks (initials) and the streak of team t */
  function labTeam(S, t) {
    if (!SS.lab || !S.lab || !SS.lab.flags(S)) return '';
    const pk = SS.lab.perk_list(S, t, true), st = S.lab.streak[t] | 0;
    return (pk ? ` <em class="tperk" title="perks: ${esc(SS.lab.perk_list(S, t))}">${pk}</em>` : '') + (st > 0 ? ` <em class="tstreak" title="streak: +${st * 10} % blast damage">x${st}</em>` : '');
  }
  U.draw = function (S) {
    netPanel(); rotSplash(S); jetChips(S); labBadge(S); perkPanel(S); alienLabels(S);
    if (SS.offscreen) SS.offscreen.draw(S);
    const a = S.active, insp = M.clamp(S.inspect, 0, 1);
    const placed = [];                                                                                   // P102: labels of stacked worms never overlap: the later one moves up
    for (const w of S.worms) {
      const el = label(w);
      if (w.dead || w.eaten) { el.style.display = 'none'; continue; }
      const inSec = SS.view.inSlab(S, w.pos) || w === a, show = inSec || insp > 0.05;
      const sp = project({ x: w.pos.x, y: w.pos.y + 0.85, z: w.pos.z });
      el.style.display = show && sp.front ? 'block' : 'none';
      if (!show) continue;
      setText(el.children[0], w.name);
      infoLabel(S, w, el.children[4]);
      setText(el.children[1], inSec ? '' : ` ${Math.abs(P.to_plane(S, w.pos).t).toFixed(1)} m off`);
      el.children[2].firstChild.style.width = Math.max(0, Math.min(100, 100 * w.hp / (w.hp0 || 100))) + '%';
      setText(el.children[3], String(Math.max(0, Math.round(w.hp))));                                   // PoC: the HP number
      el.style.opacity = inSec ? 1 : insp;
      let ly = sp.y;
      for (let g = 0; g < 4; g++) { let hit = false; for (let j = 0; j < placed.length; j++) if (Math.abs(placed[j].x - sp.x) < 84 && Math.abs(placed[j].y - ly) < 40) { ly = placed[j].y - 40; hit = true; } if (!hit) break; }
      placed.push({ x: sp.x, y: ly });
      el.style.transform = `translate(${sp.x}px,${ly}px) translate(-50%,-100%)`;
      el.classList.toggle('ghost', !inSec); el.classList.toggle('active', w === a); el.classList.toggle('low', w.hp > 0 && w.hp <= 0.3 * (w.hp0 || 100));
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const el = pops[i], age = S.time - el._t;
      if (age > (el._bub ? 1.9 : 1.6) || age < 0) { dropPop(i); continue; }
      if (el._bub) { const bp = project({ x: el._w.pos.x, y: el._w.pos.y + 1.25, z: el._w.pos.z }); el.style.transform = `translate(${bp.x}px,${bp.y - 58}px) translate(-50%,-100%)`; el.style.opacity = Math.min(1, (1.9 - age) * 3); continue; }
      const sp = project({ x: el._w.pos.x, y: el._w.pos.y + 1.5 + age * 0.8, z: el._w.pos.z });
      el.style.transform = `translate(${sp.x + el._dx}px,${sp.y}px) translate(-50%,-100%)`; el.style.opacity = age < 1 ? 1 : Math.max(0, 1 - (age - 1) / 0.6);
    }
    const g = S.proj.find(p => p.type === 'grenade' || p.type === 'gas');
    if (g) {
      const wp = P.to_world(S, g.s, g.y), sp = project({ x: wp.x, y: wp.y + 0.6, z: wp.z });
      fuseEl.style.display = 'block'; setText(fuseEl, Math.max(0, g.fuse).toFixed(1));
      fuseEl.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%)`;
    } else fuseEl.style.display = 'none';
    // the lava layer moves slowly: refresh the section map base every ~2 s of sim time while it changes
    if (S.section && ((S.lava && S.lava.ver - lavaVer >= 20) || (S.water && S.water.ver - waterVer >= 15))) U.sectionChanged(S);
    drawHUD(S); drawSectionMap(S); drawTopMap(S); gadgetLabels(S);
  };

  function bearing(th) { return ((90 + th * 180 / Math.PI) % 360 + 360) % 360; }
  /* P47: a team with infected (or face-hugged) worms shows a lime count in the team panel */
  function infTeam(S, t) { let n = 0; for (const w of S.worms) if (w.team === t && !w.dead && (w.embryo || (w.hug != null && w.hug >= 0))) n++; return n ? ` <em class="tinf" title="infected by the alien parasite">☣${n}</em>` : ''; }
  function teamHP(S, t) { let h = 0; for (let i = 0; i < S.worms.length; i++) if (S.worms[i].team === t) h += Math.max(0, S.worms[i].hp); return h; }
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
  /* Step I: on sea ice: its thickness and the highest fall it survives (Gold capacity vs the landing load) */
  function iceRow(S, a) {
    if (!SS.ice || !S.ice) return '';
    const top = SS.ice.top_at(S, a.pos.x, a.pos.z);
    if (top < -1e8 || Math.abs(a.pos.y - a.foot - top) > 0.2) return '';
    const K = C.ICE, hcm = S.ice.h[SS.ice.cell(S, a.pos.x, a.pos.z)], r = 2 * SS.ice.cap(hcm) / K.WORM_KG - 1;
    const Hs = r <= 1 ? 0 : K.STOP_D * (r * r - 1) / 2;
    return `<div class="wind"><span class="wx">❄ ice ${hcm.toFixed(0)} cm</span><span class="wn">${Hs <= 0.05 ? 'too thin to stand on' : 'safe falls < ' + (Hs < 10 ? Hs.toFixed(1) : '10+') + ' m'}</span></div>`;
  }
  // P84: the slow, continuous sudden death shown quietly next to the label: how far the sea has come up (dry worlds: the play circle's radius left)
  function sdTrend(S) {
    const w = SS.world; if (!w || w.under || w.eow) return '';
    if (w.dry) return ` <span class="sdt">◌ ${Math.round(S.playR)} m</span>`;
    return (S.sdRise || 0) >= 0.05 ? ` <span class="sdt">▲ ${(S.sdRise).toFixed(1)} m</span>` : '';
  }
  /* P9 top bar (PoC): turn · time · wind · weather */
  function drawTop(S, a, team, tc) {
    setHTML('tbTurn', `<div class="lbl">Turn</div><div class="tn" style="--team:${tc}">${esc(team.name)}</div><div class="wn">${esc(a.name)}${SS.game && SS.game.is_cpu(S, a.team) ? ' · CPU' : SS.net && SS.net.active ? (a.team === SS.net.team ? ' · you' : ' · friend') : ''}</div>`);
    const retreat = S.retreatT > 0, place = S.phase === 'place', t = place ? S.placeT : retreat ? S.retreatT : S.turnT, lim = S.settings.turnTime > 0;
    const tlow = retreat || ((lim || place) && t < 10), tfrac = lim && S.phase === 'play' && !retreat && !place ? Math.max(0, Math.min(1, Math.ceil(t) / S.settings.turnTime)) : 0;
    setHTML('tbTime', `<div class="lbl">${place ? 'Deploy' : retreat ? 'Retreat' : S.sudden ? 'Sudden death' + sdTrend(S) : 'Time'}</div><b class="${tlow ? 'low' : ''}">${place || retreat || (lim && S.phase === 'play') ? Math.max(0, Math.ceil(t)) : S.phase === 'play' ? '∞' : '–'}</b>${tfrac > 0 ? `<i class="tbar${tlow ? ' low' : ''}" style="width:${(tfrac * 100).toFixed(1)}%"></i>` : ''}`);
    const w = S.wind, d = P.dir(S); let along = 0, sp = 0;
    if (w && !SS.world.under) { along = w.mean.x * d.x + w.mean.z * d.z; sp = Math.hypot(w.mean.x, w.mean.z); }
    const f = Math.min(1, Math.abs(along) / 12) * 50;
    setHTML('tbWind', `<div class="lbl">Wind</div><div class="wbar"><i class="${along < 0 ? 'l' : 'r'}" style="left:${along < 0 ? 50 - f : 50}%;width:${f.toFixed(1)}%"></i></div><div class="wt">${Math.abs(along) < 0.3 ? (SS.world.eow ? 'no air' : 'calm') : (along < 0 ? '◀ ' : '') + Math.abs(along).toFixed(1) + ' m/s' + (along > 0 ? ' ▶' : '')}</div>`);
    const we = S.weather, name = we ? ((C.WEATHER_NAME && C.WEATHER_NAME[we.kind]) || we.kind) : 'Caves';
    setHTML('tbWx', `<div class="lbl">Weather</div><div class="wxn">${SS.world.eow ? 'Open space' : SS.world.under ? 'Underground' : (WX_ICON[we && we.kind] || '') + ' ' + name}</div><div class="wxs">${SS.world.eow ? 'vacuum, no wind' : SS.world.under ? 'no wind' : (SS.ice && SS.ice.air_temp ? Math.round(SS.ice.air_temp(S)) + ' °C · ' : '') + sp.toFixed(1) + ' m/s full wind'}${SS.view.timeOfDay && !SS.world.under && !SS.world.eow && SS.view.timeOfDay(S) !== 'day' ? ' · ' + SS.view.timeOfDay(S) : ''}</div>`);
  }
  /* P9 weapon grid (built per match), info line */
  let gridBuilt = null; const gridBtn = {};
  /* P75: the weapon bar shows one category at a time (large tiles) instead of a wall of 42 small icons. Keys still pick any weapon: the bar follows
   * the selection to its category (not on the "All" tab, the old dense grid). Skip Go lives on the Core tab. */
  const W_CATS = [
    { id: 'core', n: 'Core', ks: ['bazooka', 'grenade', 'cluster', 'shotgun', 'rope', 'airstrike', 'skip'] },
    { id: 'throw', n: 'Thrown', ks: ['homing', 'banana', 'holy', 'boulder', 'blackhole', 'mortar', 'acid', 'gas', 'boomerang', 'foam', 'gravgun', 'flamethrower'] },
    { id: 'place', n: 'Placed', ks: ['dynamite', 'sheep', 'mine', 'magnet', 'spring', 'dog', 'sentry', 'claymore', 'ffield'] },
    { id: 'strike', n: 'Strikes', ks: ['napalm', 'tesla', 'moai', 'raven'] },
    { id: 'gun', n: 'Guns', ks: ['sniper', 'handgun', 'minigun', 'bat', 'punch'] },
    { id: 'tool', n: 'Tools', ks: ['drill', 'parachute', 'zipline', 'teleport', 'girder', 'bellows', 'scrambler'] },
    { id: 'all', n: 'All', ks: null },
  ];
  const W_CAT_OF = {}; for (const c of W_CATS) if (c.ks) for (const k of c.ks) W_CAT_OF[k] = c.id;
  let wTab = 'core', wLast = '';
  function showTab(id) {
    wTab = id; const el = $('weapons'); if (!el) return;
    const cat = W_CATS.find(c => c.id === id) || W_CATS[0], grid = el.querySelector('.wgrid'); if (!grid) return;
    grid.dataset.m = id === 'all' ? 'all' : id === 'core' ? 'big' : 'mid';
    const ord = cat.ks || C.ARSENAL_ORDER;
    for (const k of C.ARSENAL_ORDER) { const g = gridBtn[k]; if (g) { g.b.classList.toggle('off', !!cat.ks && cat.ks.indexOf(k) < 0); g.b.style.order = ord.indexOf(k); } }
    for (const t of el.querySelectorAll('.wtab')) { const on = t.dataset.c === id; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); }
    fitGH();
  }
  /* --gh = the bar's height: the info line, the debug panel and the tooltip sit above it (the tab and the window size change it) */
  function fitGH() { const el = $('weapons'); if (el && el.offsetHeight > 0) document.documentElement.style.setProperty('--gh', (el.offsetHeight + 12) + 'px'); }
  if (typeof addEventListener === 'function') addEventListener('resize', () => setTimeout(fitGH, 0));

  // ASSET: weapon_icons, hud_panels (ui/icons/*.png, ui/hud/*.png)
  function buildGrid(S) {
    const vector = S && S.settings.art === 'procedural' && SS.icons;     // PoC "Artwork": painted icons / original vector icons
    const el = $('weapons'); el.innerHTML = '<div class="wtabs" role="tablist"></div><div class="wgrid"></div>';
    const tabs = el.firstChild, grid = el.lastChild;
    for (const c of W_CATS) { const t = document.createElement('button'); t.type = 'button'; t.className = 'wtab'; t.dataset.c = c.id; t.setAttribute('role', 'tab'); t.textContent = c.n; tabs.appendChild(t); }
    for (const k of C.ARSENAL_ORDER) {
      const d = C.ARSENAL[k], b = document.createElement('button');
      b.className = 'wpn'; b.type = 'button'; b.dataset.k = k; b.setAttribute('aria-label', `${d.name} (${d.key}): ${d.info}`);
      const ico = (vector || !(SS.iconsArt && SS.iconsArt[k])) && SS.icons[k] ? `<svg viewBox="0 0 24 24" class="vi">${SS.icons[k]}</svg>` : `<img src="assets/icons/icon-${k}.webp" alt="">`;
      b.innerHTML = `${ico}<span class="k">${d.key}</span><span class="a"></span><span class="n">${d.name.replace('Baseball ', '').replace(' Rifle', '').replace('Pocket ', '').replace('Fuse ', '').replace('Flamethrower', 'Flamer')}</span>`;
      b.onclick = () => { if (U.onPick) U.onPick(k); b.blur(); };
      grid.appendChild(b); gridBtn[k] = { b, a: b.querySelector('.a'), s: '' };
    }
    showTab(wTab);
    gridBuilt = S ? S.settings.art || 'painted' : 'painted';
    if (!el._tip) {                                                       // (once: the grid element stays, its buttons are rebuilt)
      el._tip = 1;
      el.addEventListener('click', e => { const t = e.target.closest ? e.target.closest('.wtab') : null; if (t) { showTab(t.dataset.c); t.blur(); } });
      el.addEventListener('pointerover', e => { const b = e.target.closest ? e.target.closest('.wpn') : null; if (b) showTip(b.dataset.k, b); });
      el.addEventListener('pointerleave', hideTip);
      el.addEventListener('focusin', e => { const b = e.target.closest ? e.target.closest('.wpn') : null; if (b) showTip(b.dataset.k, b); });
      el.addEventListener('focusout', hideTip);
    }
  }
  /* weapon tooltip: name, key, the weapon's info and the numbers that matter (ammo, blast, fuse, how it is used). Event driven: built on hover only */
  const KIND_TXT = { charge: 'Hold to charge', target: 'Click a target', drop: 'Dropped at your feet', stream: 'Hold to spray', melee: 'Melee', hitscan: 'Instant shot', utility: 'Utility', rope: 'Swing', zip: 'Zipline', dig: 'Digs', chute: 'Glide', skip: 'Ends the turn' };
  let tipEl = null, tipK = null, lastS = null, lastA = null;
  function showTip(k, btn) {
    const S = lastS, a = lastA; if (!k || !S || !a) return;
    if (!tipEl) tipEl = $('wtip');
    const d = C.ARSENAL[k], pd = C.PROJ[k] || {}, n = SS.game ? SS.game.ammo(S, a.team, k) : Infinity, g = gridBtn[k];
    const img = g && g.b.querySelector('img') ? `<img src="${g.b.querySelector('img').getAttribute('src')}" alt="">` : '';
    let m = S.eow && SS.eow.no_air(k) ? '<span class="no">No air in space</span>' : '';
    { const jw = SS.jacket ? SS.jacket.no_weapon(S, k) : ''; if (jw) m += `<span class="no">${esc(jw)} (on the life jacket)</span>`; }
    m += `<span class="${n > 0 ? 'am' : 'no'}">${n === Infinity ? 'Unlimited' : n > 0 ? 'Ammo ×' + n : 'Out of ammo'}</span>`;
    if (KIND_TXT[d.kind]) m += `<span>${KIND_TXT[d.kind]}</span>`;
    if (pd.W) m += `<span>${pd.W.toFixed(2)} kg TNT-eq</span>`;
    if (pd.fuse || pd.fuseSet) m += `<span>Fuse ${SS.weaponsA && SS.weaponsA.fuse_of ? SS.weaponsA.fuse_of(S, k) : pd.fuseSet ? S.fuse : pd.fuse} s</span>`;
    tipEl.innerHTML = `<div class="th">${img}<b>${esc(d.name)}</b><kbd>${esc(d.key)}</kbd></div><div class="ti">${esc(d.info || '')}</div><div class="tm">${m}</div>`;
    const r = btn.getBoundingClientRect(), gr = $('weapons').getBoundingClientRect(), w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'; tipEl.style.top = Math.max(8, gr.top - hh - 10) + 'px';
    tipEl.classList.add('on'); tipK = k;
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('on'); tipK = null; }
  function drawWeapons(S, a) {
    if (gridBuilt !== (S.settings.art || 'painted')) buildGrid(S);
    lastS = S; lastA = a;
    if (S.weapon !== wLast) { wLast = S.weapon; const c = W_CAT_OF[S.weapon]; if (c && wTab !== 'all' && c !== wTab) showTab(c); }
    const mine = !(SS.game && SS.game.is_cpu(S, a.team)) && !(SS.net && SS.net.active && a.team !== SS.net.team);
    for (const k of C.ARSENAL_ORDER) {
      const g = gridBtn[k], n = SS.game ? SS.game.ammo(S, a.team, k) : Infinity, usable = n > 0 && !(SS.weapons.needs_storm(k) && !(S.weather && S.weather.storm)) && !(S.eow && SS.eow.no_air(k)) && !(SS.jacket && SS.jacket.no_weapon(S, k));     // P107: greyed afloat in a life jacket when it needs a footing
      const key = (S.weapon === k ? 's' : '') + (usable ? '' : 'e') + n;
      if (g.s === key) continue;
      g.s = key; g.b.classList.toggle('sel', S.weapon === k); g.b.classList.toggle('empty', !usable); g.a.textContent = n === Infinity ? '' : '×' + n;
      if (tipK === k) showTip(k, g.b);
    }
    const d = C.ARSENAL[S.weapon] || {}, pd = C.PROJ[S.weapon] || {};
    let hint = '';
    if (d.twostep) hint = S.tgt ? ' · <em>target set: ↑↓ aim, Space releases the bird</em>' : ' · <em>click the target on the section</em>';
    else if (d.kind === 'target') hint = S.weapon === 'girder' ? ` · <em>click to place · hold ↑↓ to turn (${Math.round(((S.plateAng || 0) * 180 / Math.PI + 360) % 360)}°)</em>` : ' · <em>click the target on the section</em>' + (d.strike ? ` · <em>${S.strikeDir > 0 ? 'from the left ▶' : '◀ from the right'}</em> (← →)` : '');
    else if (S.weapon === 'gravgun') hint = S.grab ? ' · <em>hold fire and release to throw it</em>' : ' · <em>fire grabs the outlined object</em>';
    else if (d.target) hint = S.tgt ? ' · <em>target set</em>' : ' · <em>click a target first</em>';
    if (S.rope && d.payload) hint += ' · <em>Enter drops it</em>';
    if (SS.sim.can_switch && SS.sim.can_switch(S)) hint = ` · <em>\\: switch worm (${Math.max(0, Math.ceil(10 - (S.time - (S.selStart != null ? S.selStart : S.turnStart))))} s)</em>` + hint;
    if (S.phase === 'place') { setHTML('winfo', mine ? `Deploy <em>${esc(a.name)}</em>: click a free spot on the section · Q / E rotate it · Enter auto-places` : `${esc(a.name)} is being deployed…`); return; }
    const shot = S.weapon === 'shotgun' && C.ARMS && C.ARMS.SHOTGUN ? ` · shot ${Math.min(C.ARMS.SHOTGUN.SHOTS, (S.shots || 0) + 1)} of ${C.ARMS.SHOTGUN.SHOTS}` : '';
    if (!(S.phase === 'play' && mine)) { setHTML('winfo', ''); return; }
    const par = SS.weaponsA && SS.weaponsA.param(S, S.weapon), nA = SS.game ? SS.game.ammo(S, a.team, S.weapon) : Infinity;
    let line = `<b>${esc(d.name || '')}</b>`;
    if (nA !== Infinity) line += ` <span class="chip">×${nA}</span>`;
    if (par) line += ` <span class="chip">${esc(par.name)} ${esc(String(par.value))} ${esc(par.unit)} <kbd>+ −</kbd></span>`;
    else if (pd.fuseSet) line += ` <span class="chip">fuse ${S.fuse} s <kbd>F</kbd></span>`;
    if (shot) line += ` <span class="chip">${shot.replace(/^ · /, '')}</span>`;
    setHTML('winfo', `${line}<span class="di"> ${esc(d.info || '')}</span>${hint}`);
  }
  /* P37 W4: the active worm's skills (tool deliveries): icon + turns left (the hat: for the rest of the game) */
  const SKILL_ORDER = ['freerot', 'laser', 'fastwalk', 'lowgrav', 'tinfoil'];
  function skillsRow(a) {
    const s = a.skills; if (!s || !SS.icons) return '';
    let out = '';
    for (const k of SKILL_ORDER) if (s[k] > 0) out += `<span class="sk" title="${esc(C.SKILL.NAMES[k])}: ${esc(C.SKILL.INFO[k])}"><svg viewBox="0 0 24 24" class="vi">${SS.icons['skill_' + k]}</svg><b>${k === 'tinfoil' ? '∞' : s[k]}</b><i>${esc(C.SKILL.NAMES[k])}</i></span>`;
    return out ? `<div class="skills">${out}</div>` : '';
  }
  /* P37 W4: small labels over the planted gadgets: the dog's timer, the claymore's arming countdown, the sentry's rounds */
  const gadgetEls = [];
  function gadgetLabels(S) {
    const list = [];
    for (const d of S.dogs || []) { const wp = P.to_world(S, d.s, d.y); list.push([wp.x, wp.y + 0.7, wp.z, Math.max(0, d.life).toFixed(1), 'fuse']); }
    for (const c of S.claymores || []) { const t = c.armAt - S.time; if (SS.view.shownAt(S, c.pos, 0.6)) list.push([c.pos.x, c.pos.y + 0.55, c.pos.z, t > 0 ? 'arms ' + Math.ceil(t) : 'armed', t > 0 ? 'fuse' : 'fuse armed']); }
    for (const s of S.sentries || []) if (s.state === 0 && SS.view.shownAt(S, s.pos, 0.8)) list.push([s.pos.x, s.pos.y + 1.15, s.pos.z, s.ammo + '', 'fuse sentry']);
    for (let i = 0; i < list.length || i < gadgetEls.length; i++) {
      let el = gadgetEls[i];
      if (i >= list.length) { if (el) el.style.display = 'none'; continue; }
      if (!el) { el = gadgetEls[i] = document.createElement('div'); labels.appendChild(el); }
      const q = list[i], sp = project({ x: q[0], y: q[1], z: q[2] });
      el.className = q[4]; setText(el, q[3]); el.style.display = sp.front ? 'block' : 'none'; el.style.transform = `translate(${sp.x}px,${sp.y}px) translate(-50%,-100%)`;
    }
  }
  /* P9 game over (PoC #over): winner, rounds, Rematch / Change setup.
   * P118d (Q-25): a title strip at once (no dimming, the camera frames the winners: render/view.js 'victory', confetti and fireworks: render/fx.js celebrate); the results
   * card (standings, Rematch, Change setup) slides in when the celebration is over (SS.cine.panelReady: ~5 s, or any click / key skips it); nothing covers the picture. */
  let overShown = false, overRes = false, overGuest = false, overFocusT = 0;
  function drawOver(S) {
    const show = S.phase === 'over', el = $('over');
    if (show !== overShown) {
      overShown = show; overRes = false; clearTimeout(overFocusT); el.classList.toggle('hidden', !show); el.classList.remove('res');
      if (!show) return;
      const t = S.over, names = S.worms.filter(w => !w.dead).map(w => w.name).join(', ');
      el.style.setProperty('--team', t >= 0 ? css(SS.sim.team_rgb(S, t)) : 'var(--accent)');
      el.classList.toggle('draw', t < 0);
      el.querySelector('h2').textContent = t >= 0 ? `${SS.sim.team_name(S, t)} win` : 'Nobody wins';
      el.querySelector('p').textContent = t >= 0 ? `${names} ${names.indexOf(',') > 0 ? 'are' : 'is'} the last worm${names.indexOf(',') > 0 ? 's' : ''} standing after ${S.round} round${S.round > 1 ? 's' : ''}.` : 'Everyone went down together.';
      el.querySelector('.stand').innerHTML = (S.teams || []).map((tm, i) => {
        const alive = S.worms.filter(w => w.team === i && !w.dead), hp = alive.reduce((s, w) => s + Math.max(0, Math.round(w.hp)), 0);
        return `<div class="st${i === t ? ' win' : ''}" style="--team:${css(tm.rgb)}"><span>${esc(SS.sim.team_name(S, i))}</span><em>${alive.length} left · ${hp} HP</em></div>`;
      }).join('');
      overGuest = !!(SS.net && SS.net.active && !SS.net.isHost);
      $('bRematch').style.display = overGuest ? 'none' : ''; $('bSetup').style.display = overGuest ? 'none' : '';
      el.querySelector('.hint').textContent = overGuest ? 'The host starts the next map.' : 'Enter: rematch';
    }
    if (!show) return;
    const ready = !SS.cine || SS.cine.panelReady(S);
    if (ready !== overRes) {
      overRes = ready; el.classList.toggle('res', ready);
      if (ready) { overT0 = performance.now(); overFocusT = setTimeout(() => { if (overShown && overRes && !overGuest) $('bRematch').focus(); }, 500); }
    }
  }
  /* the team panel: persistent rows (the bars animate); only the parts that changed are written */
  let teamEls = [], teamN = -1;
  function teamMax(S, t) { let m = 0; for (let i = 0; i < S.worms.length; i++) if (S.worms[i].team === t) m += S.worms[i].hp0 || 100; return m || 1; }      // (a loop: this runs every frame, no temporary arrays)
  function drawTeams(S, a, tot) {
    const T = S.teams || [], root = $('teams');
    if (teamN !== T.length) {
      root.innerHTML = ''; teamEls = []; teamN = T.length;
      for (let i = 0; i < T.length; i++) {
        const row = document.createElement('div'); row.className = 'tm'; row.style.setProperty('--team', css(T[i].rgb));
        row.innerHTML = '<span></span><button type="button" class="jk"></button><div class="bar"><i></i></div><b></b>'; root.appendChild(row);
        const jk = row.children[1]; jk.onclick = () => { const q = lastS; if (q && q.active && q.active.team === i && U.onGear) U.onGear(0); jk.blur(); };       // P89: the active team's own life jacket switch
        teamEls.push({ row, nm: row.children[0], jk, bar: row.children[2].firstChild, hp: row.children[3], n: '', w: '', v: -1, c: '', j: '' });
      }
    }
    for (let i = 0; i < T.length; i++) {
      const t = T[i], g = teamEls[i], max = teamMax(S, i);
      const n = esc(t.name) + (t.ctl === 'cpu' ? ' · CPU' : '') + infTeam(S, i) + labTeam(S, i), w = (100 * tot[i] / max).toFixed(1) + '%', c = 'tm' + (a.team === i ? ' cur' : '') + (tot[i] <= 0 ? ' out' : '');
      if (g.n !== n) { g.n = n; g.nm.innerHTML = n; }
      if (g.w !== w) { g.w = w; g.bar.style.width = w; }
      if (g.v !== tot[i]) { g.v = tot[i]; g.hp.textContent = tot[i]; }
      if (g.c !== c) { g.c = c; g.row.className = c; }
      const jh = jacketChip(S, i, a);
      if (g.j !== jh) { g.j = jh; g.jk.className = 'jk ' + jh.split('|')[0]; g.jk.title = jh.split('|')[1]; g.jk.innerHTML = jh.split('|')[2]; g.jk.style.display = jh.charAt(0) === '-' ? 'none' : ''; }
    }
  }
  /* P89: the team's life jacket chip: vest icon + charges; 'on' lit orange, 'off' grey (switched off), 'none' (no charges); the active human team's chip is a button (key ;) */
  const VEST = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.2 1.8h3L8 3.6l1.8-1.8h3l1.1 4.2-2 1V14H4.1V7l-2-1z"/><path fill="#fff" opacity=".55" d="M5.6 8.6h4.8v1H5.6z"/></svg>';
  function jacketChip(S, t, a) {
    const G = SS.gear; if (!G || S.eow) return '-|||';          // (P98: no water in space: the jetpack chips are the rescue gear there)
    const g = G.get(S, t, G.JACKET); if (!g || (g.n === 0 && g.ch === 0 && !S.settings.jackets)) return '-|||';
    const mine = a && a.team === t && S.teams[t].ctl !== 'cpu', st = g.n <= 0 ? 'none' : g.on ? 'on' : 'off';
    const tip = 'Life jackets: ' + g.n + ' left, ' + (g.on ? 'on' : 'off') + (mine ? ' (click or ; to switch)' : '') + '. A worm that lands in water inflates one and swims back to the shore.';
    return st + (mine ? ' mine' : '') + '|' + tip + '|' + VEST + '<em>' + g.n + '</em>';
  }
  function drawHUD(S) {
    const a = S.active;
    if (!a) return;
    const ap = P.to_plane(S, a.pos), team = { name: SS.sim.team_name(S, a.team), rgb: SS.sim.team_rgb(S, a.team) }, tc = css(team.rgb);
    const tg = S.target && !S.target.dead ? S.target : null;
    const wp = C.WEAPONS[S.weapon];
    const brg = bearing(S.theta), flat = SS.world.flat;                // P68a: 2D = one fixed plane
    drawTop(S, a, team, tc); drawWeapons(S, a); drawOver(S);
    const vmax = wp.vmax || 28, pd = C.PROJ[S.weapon] || {};
    setHTML('hud', `
      <div class="power ${S.charging ? 'on' : ''}"><i style="width:${(S.power * 100).toFixed(0)}%"></i><span>${S.charging ? (vmax * Math.max(C.WORM_DYN.MIN_POWER, S.power)).toFixed(1) + ' m/s' : pd.W ? pd.W.toFixed(2) + ' kg TNT-eq' + (pd.mortar ? ' · burst ' + S.wa.mortarH + ' m (+ / −)' : pd.fuse ? ' · ' + (SS.weaponsA ? SS.weaponsA.fuse_of(S, S.weapon) : pd.fuseSet ? S.fuse : pd.fuse) + ' s fuse' + (pd.fuseSet ? ' (+ / −)' : '') : ' · contact fuse') : wp.kind === 'rope' ? 'reach ' + C.ROPE_MAX + ' m' : wp.name}</span></div>
      <div class="hrow">${flat ? '' : `<div class="compass"><div class="needle" style="transform:rotate(${brg}deg)"></div><span>${brg.toFixed(0).padStart(3, '0')}°</span></div>`}
        <div class="facts">
          <div>${flat ? '2D slice <span class="ok">fixed side view</span>' : 'Section ' + (S.phase !== 'play' ? '<span class="lock">locked · attack resolving</span>' : SS.sim.heading_window && SS.sim.heading_window(S) ? '<span class="ok">turns only toward the play area or a worm</span>' : '<span class="ok">free to rotate</span>')}</div>
          <div>Aim ${Math.round(S.aim * 180 / Math.PI)}° · alt ${a.pos.y.toFixed(1)} m · s ${ap.s.toFixed(1)} m</div>
          <div>Target ${tg ? `<b>${esc(tg.name)}</b> ${M.v3_dist(tg.pos, a.pos).toFixed(1)} m · ${Math.abs(P.to_plane(S, tg.pos).t).toFixed(1)} m off` : '–'}</div>
          ${S.rope ? `<div>Rope ${S.rope.hooked ? 'hooked' : '<span class="lock">re-hooking…</span>'} · ${S.rope.len.toFixed(1)} m</div>` : ''}
        </div></div>
      ${iceRow(S, a)}
      ${hotRow(S, a)}
      ${skillsRow(a)}
      `);
    const tot = (S.teams || []).map((t, i) => teamHP(S, i));
    // P1: N teams; bars relative to the team's starting total (worms x starting HP)
    drawTeams(S, a, tot);
    drawLog(S);
  }

  /* P75: the combat log. Collapsed: at most 3 short lines, each fading out after ~7 s (important events: deaths, crates, sudden death, the result stay
   * 12 s); verbose setup / hint lines are dropped. The "log" chip expands the full list (all 7 kept lines, wrapped, no fading). */
  const LOG_KEEP = /sudden death|final stand|crate|win after|nobody survived|\bdies\b|\bdied\b|killed|buried|sank|drifted|wandered|head off|escaped|infected|bursts out|collaps|streak|void|explod|take over|weather turns|moon phase|meteor/i;
  const LOG_NOISE = /^(rope|nothing within|no terrain|cannot drop|the line|stand on|click a target|view locked|section locked|section aligned|debug|the parachute opens)|section aligned with|rotate with|on the map: get in|ruined buildings|on the island|a \d+ m side-on|a crashed derelict|magnetic suits|no room there/i;
  let logOpen = false;
  function drawLog(S) {
    const el = $('log'); if (!el) return;
    if (!el._tog) { el._tog = 1; el.addEventListener('click', e => { if (e.target.closest && e.target.closest('.lt')) { logOpen = !logOpen; if (lastS) drawLog(lastS); } }); }
    let out = '', n = 0;
    for (const l of S.log) {
      const age = S.time - l.t, imp = LOG_KEEP.test(l.text);
      if (!logOpen) {
        if (LOG_NOISE.test(l.text) && !imp) continue;
        const life = imp ? 12 : 7; if (age > life || n >= 3) continue;
        const op = Math.min(1, Math.max(0, (life - age) / 2.5));
        out += `<div class="${imp ? 'imp' : ''}" style="color:${css(l.rgb)};opacity:${Math.round(op * 20) / 20}">${esc(l.text)}</div>`; n++;
      } else out += `<div class="full" style="color:${css(l.rgb)}">${esc(l.text)}</div>`;
    }
    el.classList.toggle('quiet', !logOpen && n === 0); el.classList.toggle('open', logOpen);
    setHTML('log', S.log.length ? out + `<button type="button" class="lt" title="Show or hide the full event log">${logOpen ? 'hide log' : 'log'}</button>` : '');
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
    const vs = SS.view.state, H = vs.heightmap, W = SS.world, n = W.SX + 1, sea = W.SEA, surf = vs.surf, sn = vs.surfN;
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
      let cr, cg, cb;                                          // (scalars: this loop ran once per map pixel with array literals)
      const cc = W.circ, far = cc && Math.hypot(i - cc.x, k - cc.z) > cc.r;      // (map pixel = 1 m) D6: beyond the disc
      if (h < sea) { cr = 34; cg = 88; cb = 132; }
      else if (far) {                                         // the far dunes: plain sand, a little dimmer (not destructible)
        const rgb = C.MATS[C.MAT.SAND].rgb, lift = 0.72 + h * 0.012; cr = ((rgb >> 16) & 255) * lift; cg = ((rgb >> 8) & 255) * lift; cb = (rgb & 255) * lift;
      } else {
        const ci = Math.min(W.NX - 1, i * 2), ck = Math.min(W.NZ - 1, k * 2), j = W.topJ[ck * W.NX + ci];
        const m = j >= 0 ? W.mat[(ck * W.NY + j) * W.NX + ci] : 0, rgb = C.MATS[m].rgb;
        cr = (rgb >> 16) & 255; cg = (rgb >> 8) & 255; cb = rgb & 255;
        if (surf) { const so = (Math.min(sn - 1, ck) * sn + Math.min(sn - 1, ci)) * 4, g = surf[so] / 255, dry = surf[so + 1] / 255; cr = cr * (1 - g) + (96 + dry * 90) * g; cg = cg * (1 - g) + (140 + dry * 30) * g; cb = cb * (1 - g) + 60 * g; }
        const lift = 0.85 + h * 0.012; cr *= lift; cg *= lift; cb *= lift;
      }
      const o4 = (k * n + i) * 4, D = img.data; D[o4] = cr * shade; D[o4 + 1] = cg * shade; D[o4 + 2] = cb * shade; D[o4 + 3] = 255;
    }
    bx.putImageData(img, 0, 0);
  }
  function drawTopMap(S) {
    const fig = topC.parentNode, hide = !!SS.world.flat;               // P68a: no plan view of a one-slice map
    if (fig && fig.style && (fig.style.display === 'none') !== hide) fig.style.display = hide ? 'none' : '';
    if (hide) return;
    const vs = SS.view.state;
    if (!vs.heightmap) return;
    // U: the worm's level in 3 m bands, with hysteresis (a worm bobbing at a band edge does not flicker the map)
    if (SS.world.under && S.active) { const f = S.active.pos.y / 3; if (Math.abs(f - underLevel) > 0.7) underLevel = Math.round(f); }
    const tv = vs.heightVer * 65536 + (vs.surfUploads | 0) + (SS.world.under ? underLevel * 7919 : 0);   // terrain / surface changed (U: the worm's level)
    if (topVer !== tv) { buildTopBase(S); topVer = tv; }
    const x = topX, Z = topC.width, sc = Z / SS.world.SX, n = P.nrm(S);
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
    const r = topC.getBoundingClientRect(), sc = topC.width / SS.world.SX;
    const mx = (e.clientX - r.left) * topC.width / r.width, mz = (e.clientY - r.top) * topC.height / r.height;
    let best = null, bd = 9;
    for (const w of S.worms) if (!w.dead && w !== S.active) { const dd = Math.hypot(w.pos.x * sc - mx, w.pos.z * sc - mz); if (dd < bd) { bd = dd; best = w; } }
    return best;
  };
})(window.SS = window.SS || {});
