/* ui/hud.js — the DOM HUD: the top bar (turn, time, wind, weather), the aim panel and its detail rows, the team
 * panel, the kill feed, the banners, the results card and the small panels (the network link, the rotate-now splash,
 * the End of the World's jetpack chips, the Lab badge, the perk draft). It runs the HUD's parts in order each frame:
 * ui/labels.js (the world labels), ui/offscreen.js (the edge arrows), ui/weaponbar.js (the weapon bar),
 * ui/combatlog.js (the log), ui/minimap.js (the two maps). Reads the sim state only; writes the DOM only on change
 * (ui/dom.js). */
(function (SS) {
  'use strict';
  const C = SS.CFG, P = SS.plane, M = SS.math, D = SS.dom, PHASE = C.PHASE, EV = C.EV;
  const U = SS.ui = {};
  const $ = id => document.getElementById(id);
  const css = C.css;
  // when the results card appeared (its buttons ignore the first 0.4 s)
  let overT0 = 0;
  let labels, view = null;
  // the HUD's panels by id (looked up once); everything interpolated into their HTML is escaped (team names come from
  // the network)
  const byId = {}, node = id => byId[id] || (byId[id] = $(id)), esc = D.esc;
  const setHTML = (id, s) => D.html(node(id), s);

  /* the aim details (angle, height, facing, target distance) show on demand: the small i button on the HUD panel or F3;
   * the choice is kept in this browser */
  const DETAIL_KEY = 'burrowBrawl3d.hudDetail';
  let detailOpen = SS.store.get(DETAIL_KEY, '0') === '1', drawS = null;
  U.toggleDetail = function (on) {
    detailOpen = on == null ? !detailOpen : !!on;
    SS.store.set(DETAIL_KEY, detailOpen ? '1' : '0');
    const b = $('hudtog');
    if (b) {
      b.setAttribute('aria-expanded', detailOpen ? 'true' : 'false');
      b.classList.toggle('on', detailOpen);
    }
    document.body.classList.toggle('dets-on', detailOpen);
    if (drawS) drawHUD(drawS);
  };
  /* the two buttons that belong to the HUD panels: the aim details (i) and, in a compact window, the maps */
  function wireButtons() {
    const tog = $('hudtog');
    tog.addEventListener('click', e => {
      U.toggleDetail();
      e.currentTarget.blur();
    });
    tog.setAttribute('aria-expanded', detailOpen ? 'true' : 'false');
    document.body.classList.toggle('dets-on', detailOpen);
    $('mapbtn').addEventListener('click', e => {
      const on = !document.body.classList.contains('maps-on');
      document.body.classList.toggle('maps-on', on);
      e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
      e.currentTarget.blur();
    });
  }

  /* cam / cv: the camera and the canvas it draws on; v: the view API (render/view.js V.hud: the slab tests, the map's
   * plan, the cinematic camera's timings, the reaction queue) */
  U.init = function (cam, cv, v) {
    view = v;
    labels = $('labels');
    D.unit();
    wireButtons();
    SS.labels.init(labels, cam, cv, view);
    SS.minimap.init(view);
    if (SS.offscreen) SS.offscreen.init(labels, cam, cv);
    // a key that skipped the celebration (and repeats) must not rematch by itself
    $('bRematch').onclick = () => {
      if (performance.now() - overT0 > 400) U.onRematch && U.onRematch();
    };
    $('bSetup').onclick = () => {
      if (performance.now() - overT0 > 400) U.onSetup && U.onSetup();
    };
  };

  /* kill feed (top right under the maps): who went down and how; entries fade by themselves (CSS) and are removed when
   * the animation ends */
  const KILL_VERB = [
    'was eliminated', 'was blown up', 'was shot', 'was crushed', 'burned to death', 'fell into the lava', 'succumbed to poison', 'drowned',
    'was electrocuted', 'fell to their death', 'was eaten by the alien', 'was dissolved by acid', 'was shredded'
  ];
  let feedEl = null;
  function killFeed(S, e) {
    if (!feedEl) {
      feedEl = $('feed');
      feedEl.addEventListener('animationend', ev => {
        if (ev.animationName === 'kfout' && ev.target.parentNode === feedEl) ev.target.remove();
      });
    }
    const el = D.el(
      'div',
      'kf',
      '<i>☠</i><b>' + esc(e.worm.name) + '</b><span>' + (KILL_VERB[e.cause | 0] || KILL_VERB[0]) + '</span>',
      feedEl
    );
    el.style.setProperty('--team', css(C.TEAMS[e.worm.team].rgb));
    while (feedEl.children.length > 3) feedEl.removeChild(feedEl.firstChild);
  }
  function banner(title, sub, color) {
    const b = $('banner');
    b.innerHTML = '';
    b.appendChild(document.createTextNode(title));
    if (sub) D.el('small', '', null, b).textContent = sub;
    b.style.color = color;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    if (!b._end) {
      b._end = 1;
      /* an announcement that is over takes no room in the column */
      b.addEventListener('animationend', e => {
        if (e.animationName !== 'ban') return;
        b.classList.remove('show');
        b.textContent = '';
      });
    }
  }
  U.onEvent = function (S, e) {
    SS.labels.onEvent(S, e);
    if (SS.offscreen) SS.offscreen.onEvent(S, e);
    switch (e.type) {
      // the name of the worm on turn appears as the camera move settles
      case EV.TURN: {
        const tt = `${SS.sim.team_name(S, e.worm.team)} · ${e.worm.name}`,
          ts = SS.game && SS.game.is_cpu(S, e.worm.team) ? 'CPU' : 'is up',
          tc = css(C.TEAMS[e.worm.team].rgb),
          dl = view.turnDelay();
        if (dl > 0.05) setTimeout(() => banner(tt, ts, tc), dl * 1000);
        else banner(tt, ts, tc);
        break;
      }
      case EV.HUGGER_ATTACH:
        if (e.worm && !e.worm.dead)
          banner(
            `${e.worm.name} was face-hugged!`,
            `Infected: −${SS.alien.K.PARA_HP} HP every ${SS.alien.K.PARA_T} s. Shoot the hugger off, then find a health crate`,
            '#b6ff4a'
          );
        break;
      case EV.CHEST_BURST:
        if (e.wormId != null) banner('Something bursts out!', e.worm ? e.worm.name : '', '#b6ff4a');
        break;
      case EV.KILL:
        if (e.worm) killFeed(S, e);
        break;
      case EV.BANNER:
        banner(e.title, e.sub, 'var(--accent)');
        break;
      case EV.LABBANK:
        banner('Bank shot x' + e.k.toFixed(1), e.bounces + (e.bounces > 1 ? ' ricochets' : ' ricochet'), 'var(--accent)');
        break;
      case EV.RESET:
        labFlags = -1;                                             // a new match lists the Lab mechanics again
        overShown = null;
        document.body.classList.remove('over', 'overcard');
        teamN = -1;
        if (feedEl) feedEl.innerHTML = '';
        SS.weaponbar.reset();
        break;
    }
  };

  /* drop the world labels (they hold worm objects: a replay restore or a new game replaces those) */
  U.clear = () => SS.labels.clear();

  // the network panel: link type, players, ping, sync state (in sync / checking / no signal / DESYNC)
  let netEl = null, netLast = '';
  function netPanel() {
    const NT = SS.net;
    if (!NT || !NT.active) {
      if (netEl) netEl.style.display = 'none';
      return;
    }
    if (!netEl) netEl = $('netpanel');
    const st = NT.stats(), now = performance.now(), quiet = st.lastRecv ? now - st.lastRecv : 1e9, rtt = st.rtt ? Math.round(st.rtt) : null;
    const rsS = NT.resyncState ? NT.resyncState() : 'ok',
      state = rsS === 'failed'
        ? ['DESYNC', 'bad']
        : rsS === 'wait'
        ? ['resyncing', 'warn']
        : rsS === 'verify'
        ? ['checking', 'warn']
        : quiet > 4000
        ? ['no signal', 'bad']
        : st.hashOk > 0
        ? ['in sync', 'ok']
        : ['checking', 'warn'];
    const ping = rtt == null ? '—' : rtt + ' ms',
      cls = state[1] === 'bad' || (rtt != null && rtt > 250) ? 'bad' : (rtt != null && rtt > 120) || state[1] === 'warn' ? 'warn' : 'ok';
    const txt = `🌐 ${st.mode === 'lan' ? 'LAN' : 'room'} · ${st.peers + 1} players · ${ping} · ${state[0]}`;
    if (txt !== netLast) {
      netEl.textContent = txt; netEl.className = cls; netLast = txt;
      // a guest may pull the host's state by hand
      if (!NT.isHost) {
        const bt = document.createElement('button');
        bt.textContent = 'Resync';
        bt.title = 'Fetch the host\'s game state';
        bt.style.cssText = 'margin-left:8px;padding:1px 8px;border-radius:6px;border:0;background:rgba(255,255,255,.18);color:inherit;font:inherit;cursor:pointer';
        bt.onclick = () => NT.resync_request();
        netEl.appendChild(bt);
      }
    }
    netEl.style.display = 'block';
  }
  /* the "ROTATE NOW" splash with the countdown of the free rotation window (sim/rotlock.js), display font */
  let rotEl = null, rotTxt = '';
  function rotSplash(S) {
    if (!rotEl) rotEl = $('rotnow');
    const a = S.active, mine = a && !(SS.game && SS.game.is_cpu(S, a.team)) && !(SS.net && SS.net.active && a.team !== SS.net.team);
    const l = mine && SS.rotlock && SS.rotlock.enabled(S) ? SS.rotlock.left(S) : -1,
      txt = l > 0 ? 'ROTATE NOW<b>' + Math.ceil(l) + '</b>' : '';
    if (txt !== rotTxt) {
      rotTxt = txt;
      if (txt) rotEl.innerHTML = txt;
      rotEl.classList.toggle('on', !!txt);
    }
    rotEl.classList.toggle('low', l > 0 && l <= 3);
  }
  /* End of the World: the jetpack chips, one per team (charges left, ON / OFF), a row in the left column; a click / key
   * J toggles the active team's (sim: S.eow.jet) */
  let jetEl = null, jetTxt = '';
  function jetChips(S) {
    if (!jetEl) {
      jetEl = document.createElement('div');
      jetEl.id = 'eowJet';
      jetEl.addEventListener('click', () => {
        if (SS.input) SS.input.jetReq = 1;
      });
      $('lcol').insertBefore(jetEl, $('log'));
    }
    const J = S.eow && S.eow.jet;
    if (!J) {
      if (jetTxt) {
        jetTxt = '';
        jetEl.classList.remove('on');
      }
      return;
    }
    const a = S.active;
    let txt = '';
    for (let t = 0; t < J.length; t++) {
      const state = J[t].n > 0 ? (J[t].on ? 'ON' : 'OFF') : 'EMPTY';
      const mine = a && a.team === t;
      let tip = 'Jetpacks of ' + esc(SS.sim.team_name(S, t)) + ': ' + J[t].n + ' left, ' + state.toLowerCase();
      if (mine) tip += ' (click or J to switch)';
      const color = J[t].on && J[t].n > 0 ? '#9fd0ff' : '#ff9a7a';
      txt += '<div class="jc' + (mine ? ' cur' : '') + '" title="' + tip + '">'
        + '<i style="background:' + css(C.TEAMS[t].rgb) + '"></i>JETPACK '
        + '<b style="color:' + color + '">' + state + '</b> x' + J[t].n + (mine ? ' <span>[J]</span>' : '')
        + '</div>';
    }
    if (txt !== jetTxt) {
      jetTxt = txt;
      jetEl.innerHTML = txt;
      jetEl.classList.add('on');
    }
  }
  /* the Lab badge: the active experimental mechanics (sim/lab.js), listed for LAB_SHOW ms at the start of a match and
   * whenever they change, then gone (the menu's Lab screen lists them); a tap or click on it hides it at once */
  const LAB_SHOW = 10000;
  let labEl = null, labFlags = -1, labOpenAt = -1e9;
  function labBadge(S) {
    if (!labEl) {
      labEl = $('labbadge');
      if (!labEl) return;
      labEl.addEventListener('click', () => {
        labOpenAt = -1e9;
      });
    }
    const fl = SS.lab ? SS.lab.flags(S) : 0, now = performance.now();
    if (fl !== labFlags) {
      labFlags = fl;
      labOpenAt = now;
    }
    // (the text carries live values: fatigue, streaks, meteors)
    const txt = fl && now - labOpenAt < LAB_SHOW ? SS.lab.badge(S) : '';
    D.show(labEl, !!txt);
    D.text(labEl, txt ? 'Lab: ' + txt : '');
  }
  /* the perk draft overlay (sim/lab.js, phase 'perk'): three cards for the picking team (1 / 2 / 3 or a click =
   * Input.fuse), the others wait */
  let pkEl = null, pkSig = '';
  function perkPanel(S) {
    if (!pkEl) {
      pkEl = $('perkui');
      if (!pkEl) return;
      pkEl.addEventListener('click', e => {
        const c = e.target.closest ? e.target.closest('.pk-card') : null;
        if (c && !c.classList.contains('off')) SS.input.perkPick = +c.dataset.n;
      });
    }
    const dr = S.lab && S.lab.draft, on = S.phase === PHASE.PERK && dr && dr.on;
    if (!on) {
      if (pkSig) {
        pkSig = '';
        pkEl.classList.remove('on');
      }
      return;
    }
    const team = dr.team, cpu = SS.game.is_cpu(S, team), mine = !cpu && !(SS.net && SS.net.active && team !== SS.net.team), L = SS.lab;
    const left = Math.max(0, Math.ceil(dr.t)), sig = [team, dr.opts.join(), mine, cpu ? 0 : left, S.lab.perks.join()].join('|');
    if (sig === pkSig) return;
    pkSig = sig;
    const tc = css(SS.sim.team_rgb(S, team)),
      note = cpu ? 'CPU is choosing…' : mine ? `Pick one: press 1 / 2 / 3 or click · ${left} s` : 'Waiting for the pick…';
    let h = `<div class="pk-h" style="--team:${tc}">${esc(SS.sim.team_name(S, team))} · PERK DRAFT<small>${note}</small></div>`
      + `<div class="pk-row" style="--team:${tc}">`;
    for (let i = 0; i < dr.nopt; i++) {
      const o = dr.opts[i];
      h += `<div class="pk-card${mine ? '' : ' off'}" data-n="${i + 1}"><span class="pk-key">${i + 1}</span>`
        + `<div class="pk-name">${L.PERK_NAMES[o]}</div><div class="pk-txt">${L.PERK_TEXT[o]}</div></div>`;
    }
    h += '</div>';
    const got = [];
    for (let t = 0; t < S.teams.length; t++) {
      const n = L.perk_list(S, t);
      if (n) got.push(`${esc(SS.sim.team_name(S, t))}: ${n}`);
    }
    if (got.length) h += `<div class="pk-foot">${got.join(' &nbsp;·&nbsp; ')}</div>`;
    pkEl.innerHTML = h; pkEl.classList.add('on');
  }
  /* the team panel chip: the perks (initials) and the streak of team t */
  function labTeam(S, t) {
    if (!SS.lab || !S.lab || !SS.lab.flags(S)) return '';
    const pk = SS.lab.perk_list(S, t, true), st = S.lab.streak[t] | 0;
    return (pk ? ` <em class="tperk" title="perks: ${esc(SS.lab.perk_list(S, t))}">${pk}</em>` : '')
      + (st > 0 ? ` <em class="tstreak" title="streak: +${st * 10} % blast damage">x${st}</em>` : '');
  }
  U.draw = function (S) {
    drawS = S;
    netPanel();
    rotSplash(S);
    jetChips(S);
    labBadge(S);
    perkPanel(S);
    SS.labels.draw(S);
    if (SS.offscreen) SS.offscreen.draw(S);
    drawHUD(S);
    SS.minimap.draw(S);
  };

  function bearing(th) { return ((90 + th * 180 / Math.PI) % 360 + 360) % 360; }
  /* a team with infected (or face-hugged) worms shows a lime count in the team panel */
  function infTeam(S, t) {
    let n = 0;
    for (const w of S.worms)
      if (w.team === t && !w.dead && (w.embryo || (w.hug != null && w.hug >= 0))) n++;
    return n ? ` <em class="tinf" title="infected by the alien parasite">☣${n}</em>` : '';
  }
  /* the team panel's HP: every worm of the team (unlike WM.team_hp, the worms still waiting to be placed in a fort
   * match count, so the bar starts full; a dead worm has 0 HP) */
  function teamHP(S, t) {
    let h = 0;
    for (let i = 0; i < S.worms.length; i++)
      if (S.worms[i].team === t) h += Math.max(0, S.worms[i].hp);
    return h;
  }
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
  // the slow, continuous sudden death shown quietly next to the label: how far the sea has come up (dry worlds:
  // the play circle's radius left)
  function sdTrend(S) {
    const w = SS.world;
    if (!w || w.under || w.eow) return '';
    if (w.dry) return ` <span class="sdt">◌ ${Math.round(S.playR)} m</span>`;
    return (S.sdRise || 0) >= 0.05 ? ` <span class="sdt">▲ ${(S.sdRise).toFixed(1)} m</span>` : '';
  }
  /* the height of the top bar is a CSS variable (--tb-h): the win title sits right under it, and a fixed overlay cannot
   * know it */
  let tbH = 0;
  function fitTop() {
    const h = $('topbar').offsetHeight;
    if (h && h !== tbH) {
      tbH = h;
      document.documentElement.style.setProperty('--tb-h', h + 'px');
    }
  }
  addEventListener('resize', () => setTimeout(fitTop, 0));
  /* the top bar: turn · time · wind · weather */
  function drawTop(S, a, team, tc) {
    let moved = setHTML(
      'tbTurn',
      `<div class="lbl">Turn</div><div class="tn" style="--team:${tc}">${esc(team.name)}</div><div class="wn">${esc(a.name)}${SS.game && SS.game.is_cpu(S, a.team) ? ' · CPU' : SS.net && SS.net.active ? (a.team === SS.net.team ? ' · you' : ' · friend') : ''}</div>`
    );
    const retreat = S.retreatT > 0,
      place = S.phase === PHASE.PLACE,
      t = place ? S.placeT : retreat ? S.retreatT : S.turnT,
      lim = S.settings.turnTime > 0;
    const tlow = retreat || ((lim || place) && t < 10),
      tfrac = lim && S.phase === PHASE.PLAY && !retreat && !place ? Math.max(0, Math.min(1, Math.ceil(t) / S.settings.turnTime)) : 0;
    const label = place ? 'Deploy' : retreat ? 'Retreat' : S.sudden ? 'Sudden death' + sdTrend(S) : 'Time',
      num = place || retreat || (lim && S.phase === PHASE.PLAY) ? Math.max(0, Math.ceil(t)) : S.phase === PHASE.PLAY ? '∞' : '–',
      bar = tfrac > 0 ? `<i class="tbar${tlow ? ' low' : ''}" style="width:${(tfrac * 100).toFixed(1)}%"></i>` : '';
    const timeMoved = setHTML('tbTime', `<div class="lbl">${label}</div><b class="${tlow ? 'low' : ''}">${num}</b>${bar}`);
    const w = S.wind, d = P.dir(S);
    let along = 0, sp = 0;
    if (w && !SS.world.under) {
      along = w.mean.x * d.x + w.mean.z * d.z;
      sp = Math.hypot(w.mean.x, w.mean.z);
    }
    const f = Math.min(1, Math.abs(along) / 12) * 50;
    const wtxt = Math.abs(along) < 0.3
      ? (SS.world.eow ? 'no air' : 'calm')
      : (along < 0 ? '◀ ' : '') + Math.abs(along).toFixed(1) + ' m/s' + (along > 0 ? ' ▶' : '');
    const windMoved = setHTML(
      'tbWind',
      `<div class="lbl">Wind</div><div class="wbar"><i class="${along < 0 ? 'l' : 'r'}" style="left:${along < 0 ? 50 - f : 50}%;`
        + `width:${f.toFixed(1)}%"></i></div><div class="wt">${wtxt}</div>`
    );
    const we = S.weather, name = we ? ((C.WEATHER_NAME && C.WEATHER_NAME[we.kind]) || we.kind) : 'Caves';
    const world = SS.world, tod = SS.sim.time_of_day(S);
    const wxn = world.eow ? 'Open space' : world.under ? 'Underground' : (WX_ICON[we && we.kind] || '') + ' ' + name;
    const wxs = world.eow
      ? 'vacuum, no wind'
      : world.under
      ? 'no wind'
      : (SS.ice && SS.ice.air_temp ? Math.round(SS.ice.air_temp(S)) + ' °C · ' : '') + sp.toFixed(1) + ' m/s full wind';
    setHTML(
      'tbWx',
      `<div class="wxn">${wxn}</div><div class="wxs">${wxs}${!world.under && !world.eow && tod !== 'day' ? ' · ' + tod : ''}</div>`
    );
    if (moved || timeMoved || windMoved || !tbH) fitTop();
  }
  /* the active worm's skills (tool deliveries): icon + turns left (the hat: for the rest of the game) */
  const SKILL_ORDER = ['freerot', 'laser', 'fastwalk', 'lowgrav', 'tinfoil'];
  function skillsRow(a) {
    const s = a.skills;
    if (!s || !SS.icons) return '';
    let out = '';
    for (const k of SKILL_ORDER)
      if (s[k] > 0)
        out += `<span class="sk" title="${esc(C.SKILL.NAMES[k])}: ${esc(C.SKILL.INFO[k])}"><svg viewBox="0 0 24 24" class="vi">${SS.icons['skill_' + k]}</svg><b>${k === 'tinfoil' ? '∞' : s[k]}</b><i>${esc(C.SKILL.NAMES[k])}</i></span>`;
    return out ? `<div class="skills">${out}</div>` : '';
  }
  /* game over: the winner, the rounds, Rematch / Change setup. A title strip at once (no dimming: the camera frames
   * the winners, render/view.js 'victory', with confetti and fireworks, render/fx.js celebrate); the results card
   * (standings, Rematch, Change setup) slides in when the celebration is over (view.panelReady: ~5 s, or any click /
   * key skips it); nothing covers the picture. */
  let overShown = false, overRes = false, overGuest = false, overFocusT = 0;
  function drawOver(S) {
    const show = S.phase === PHASE.OVER, el = $('over');
    if (show !== overShown) {
      overShown = show;
      overRes = false;
      clearTimeout(overFocusT);
      el.classList.toggle('hidden', !show);
      el.classList.remove('res');
      document.body.classList.toggle('over', show); document.body.classList.remove('overcard');
      if (!show) return;
      const t = S.over, names = S.worms.filter(w => !w.dead).map(w => w.name).join(', ');
      el.style.setProperty('--team', t >= 0 ? css(SS.sim.team_rgb(S, t)) : 'var(--accent)');
      el.classList.toggle('draw', t < 0);
      el.querySelector('h2').textContent = t >= 0 ? `${SS.sim.team_name(S, t)} win` : 'Nobody wins';
      el.querySelector('p').textContent = t >= 0
        ? `${names} ${names.indexOf(',') > 0 ? 'are' : 'is'} the last worm${names.indexOf(',') > 0 ? 's' : ''} standing after ${S.round} round${S.round > 1 ? 's' : ''}.`
        : 'Everyone went down together.';
      el.querySelector('.stand').innerHTML = (S.teams || []).map((tm, i) => {
        const alive = S.worms.filter(w => w.team === i && !w.dead), hp = alive.reduce((s, w) => s + Math.max(0, Math.round(w.hp)), 0);
        return `<div class="st${i === t ? ' win' : ''}" style="--team:${css(tm.rgb)}"><span>${esc(SS.sim.team_name(S, i))}</span><em>${alive.length} left · ${hp} HP</em></div>`;
      }).join('');
      overGuest = !!(SS.net && SS.net.active && !SS.net.isHost);
      $('bRematch').style.display = overGuest ? 'none' : ''; $('bSetup').style.display = overGuest ? 'none' : '';
      el.querySelector('.hint').textContent = overGuest ? 'The host starts the next map.' : 'Enter: rematch';
    }
    if (!show) return;
    const ready = view.panelReady(S);
    if (ready !== overRes) {
      overRes = ready; el.classList.toggle('res', ready); document.body.classList.toggle('overcard', ready);
      if (ready) {
        overT0 = performance.now();
        overFocusT = setTimeout(() => {
          if (overShown && overRes && !overGuest) $('bRematch').focus();
        }, 500);
      }
    }
  }
  /* the team panel: persistent rows (the bars animate); only the parts that changed are written */
  let teamEls = [], teamN = -1;
  // the bar's full length: the team's starting HP (a loop: it runs every frame, no temporary arrays)
  function teamMax(S, t) {
    let m = 0;
    for (let i = 0; i < S.worms.length; i++)
      if (S.worms[i].team === t) m += S.worms[i].hp0 || 100;
    return m || 1;
  }
  function drawTeams(S, a, tot) {
    const T = S.teams || [], root = $('teams');
    if (teamN !== T.length) {
      root.innerHTML = ''; teamEls = []; teamN = T.length;
      for (let i = 0; i < T.length; i++) {
        const row = document.createElement('div');
        row.className = 'tm';
        row.style.setProperty('--team', css(T[i].rgb));
        row.innerHTML = '<span></span><button type="button" class="jk"></button><div class="bar"><i></i></div><b></b>';
        root.appendChild(row);
        // the active team's own life jacket switch
        const jk = row.children[1];
        jk.onclick = () => {
          const q = drawS;
          if (q && q.active && q.active.team === i && U.onGear) U.onGear(0);
          jk.blur();
        };
        teamEls.push({
          row,
          nm: row.children[0],
          jk,
          bar: row.children[2].firstChild,
          hp: row.children[3],
          n: '',
          w: '',
          v: -1,
          c: '',
          j: ''
        });
      }
    }
    for (let i = 0; i < T.length; i++) {
      const t = T[i], g = teamEls[i], max = teamMax(S, i);
      const n = esc(t.name) + (t.ctl === 'cpu' ? ' · CPU' : '') + infTeam(S, i) + labTeam(S, i),
        w = (100 * tot[i] / max).toFixed(1) + '%',
        c = 'tm' + (a.team === i ? ' cur' : '') + (tot[i] <= 0 ? ' out' : '');
      if (g.n !== n) {
        g.n = n;
        g.nm.innerHTML = n;
      }
      if (g.w !== w) {
        g.w = w;
        g.bar.style.width = w;
      }
      if (g.v !== tot[i]) {
        g.v = tot[i];
        g.hp.textContent = tot[i];
      }
      if (g.c !== c) {
        g.c = c;
        g.row.className = c;
      }
      const jh = jacketChip(S, i, a);
      if (g.j !== jh) {
        g.j = jh;
        g.jk.className = 'jk ' + jh.split('|')[0];
        g.jk.title = jh.split('|')[1];
        g.jk.innerHTML = jh.split('|')[2];
        g.jk.style.display = jh.charAt(0) === '-' ? 'none' : '';
      }
    }
  }
  /* the team's life jacket chip: vest icon + charges; 'on' lit orange, 'off' grey (switched off), 'none' (no
   * charges); the active human team's chip is a button (key ;) */
  const VEST = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.2 1.8h3L8 3.6l1.8-1.8h3l1.1 4.2-2 1V14H4.1V7l-2-1z"/><path fill="#fff" opacity=".55" d="M5.6 8.6h4.8v1H5.6z"/></svg>';
  function jacketChip(S, t, a) {
    // (no water in space: the jetpack chips are the rescue gear there)
    const G = SS.gear;
    if (!G || S.eow) return '-|||';
    const g = G.get(S, t, G.JACKET);
    if (!g || (g.n === 0 && g.ch === 0 && !S.settings.jackets)) return '-|||';
    const mine = a && a.team === t && S.teams[t].ctl !== 'cpu', st = g.n <= 0 ? 'none' : g.on ? 'on' : 'off';
    const tip = 'Life jackets: '
      + g.n
      + ' left, '
      + (g.on ? 'on' : 'off')
      + (mine ? ' (click or ; to switch)' : '')
      + '. A worm that lands in water inflates one and swims back to the shore.';
    return st + (mine ? ' mine' : '') + '|' + tip + '|' + VEST + '<em>' + g.n + '</em>';
  }
  /* the aim line: the one thing the panel always says, in plain words (the weapon and what matters about it right
   * now) */
  function aimLine(S, wp, pd) {
    if (S.phase === PHASE.PLACE) return 'Place your worm';
    if (S.phase === PHASE.PERK) return 'Choosing perks';
    if (S.phase === PHASE.OVER) return 'Match over';
    const name = (C.ARSENAL[S.weapon] || wp).name;
    if (S.phase !== PHASE.PLAY) return S.retreatT > 0 ? 'Retreat to cover' : 'Waiting for the shot to land';
    if (S.charging) return name + ' · power ' + Math.round(100 * Math.max(C.WORM_DYN.MIN_POWER, S.power)) + ' %';
    if (S.rope) return 'Rope ' + (S.rope.hooked ? 'hooked' : 're-hooking') + ' · ' + S.rope.len.toFixed(1) + ' m';
    const par = SS.weaponsA && SS.weaponsA.param(S, S.weapon);
    if (par) return name + ' · ' + par.name + ' ' + par.value + ' ' + par.unit;
    if (pd.W) return pd.fuse ? name + ' · ' + pd.fuse + ' s fuse' : name + ' · explodes on contact';
    if (wp.kind === 'rope') return name + ' · reaches ' + C.ROPE_MAX.toFixed(0) + ' m';
    return name;
  }
  const COMPASS8 = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  /* the detail rows (F3 / the i button): aim angle, height, which way the view faces, the target's distance, whether
   * the view may turn */
  function detailRows(S, a, tg, flat, brg) {
    const up = S.aim * 180 / Math.PI;
    const deg = Math.round(Math.abs(up));
    const aim = deg < 2 ? 'level' : deg + '° ' + (up > 0 ? 'up' : 'down');
    const off = tg ? Math.abs(P.to_plane(S, tg.pos).t) : 0;
    let view = '<span class="ok">free to rotate (Q / E)</span>';
    if (S.phase !== PHASE.PLAY) view = '<span class="lock">locked while the shot resolves</span>';
    else if (SS.sim.heading_window && SS.sim.heading_window(S)) view = '<span class="ok">turns only toward the play area or a worm</span>';
    let target = '<b>none</b>' + (flat ? '' : ' (Tab picks one)');
    if (tg) {
      target = '<b>' + esc(tg.name) + '</b>, ' + M.v3_dist(tg.pos, a.pos).toFixed(1) + ' m away';
      target += off < 0.5 ? ', in line' : ', ' + off.toFixed(1) + ' m off the view';
    }
    let compass = '';
    if (!flat) {
      compass = '<div class="compass" title="The view faces ' + COMPASS8[Math.round(brg / 45) % 8] + '">'
        + '<div class="needle" style="transform:rotate(' + brg + 'deg)"></div><span>' + brg.toFixed(0).padStart(3, '0') + '°</span></div>';
    }
    return '<div class="hrow">' + compass + '<div class="facts">'
      + '<div>Aim <b>' + aim + '</b> · height <b>' + a.pos.y.toFixed(1) + ' m</b></div>'
      + '<div>Target ' + target + '</div>'
      + '<div>' + (flat ? 'Fixed side view' : 'View ' + view) + '</div>'
      + '</div></div>';
  }
  function drawHUD(S) {
    const a = S.active;
    if (!a) return;
    const team = { name: SS.sim.team_name(S, a.team), rgb: SS.sim.team_rgb(S, a.team) }, tc = css(team.rgb);
    const tg = S.target && !S.target.dead ? S.target : null;
    const wp = C.WEAPONS[S.weapon];
    const brg = bearing(S.theta), flat = SS.world.flat;                // (2D: one fixed plane)
    drawTop(S, a, team, tc);
    SS.weaponbar.draw(S, a);
    drawOver(S);
    const pd = C.PROJ[S.weapon] || {};
    const fill = (S.power * 100).toFixed(0);
    setHTML('hudl', '<div class="power ' + (S.charging ? 'on' : '') + '"><i style="width:' + fill + '%"></i>'
      + '<span>' + esc(aimLine(S, wp, pd)) + '</span></div>');
    setHTML('hudb', `${hotRow(S, a)}${iceRow(S, a)}${detailOpen ? detailRows(S, a, tg, flat, brg) : ''}${skillsRow(a)}`);
    const tot = (S.teams || []).map((t, i) => teamHP(S, i));
    // the bars relative to the team's starting total (worms x starting HP)
    drawTeams(S, a, tot);
    SS.combatlog.draw(S);
  }

})(window.SS = window.SS || {});
