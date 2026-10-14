/* ui/labels.js — the world-anchored labels of the HUD: each worm's label (name, HP bar and number, the distance off
 * the section, the alien parasite's countdown; the later of two stacked worms moves up), the pops over the worms
 * (damage numbers, pickups, the life jacket) and their speech bubbles, the grenade's fuse, the alien's bars (an
 * opening egg, its sleep) and its own label, and the planted gadgets' counters (the dog, the claymore, the sentry).
 * Each frame every label is projected through the camera and written only on change (ui/dom.js). Reads the sim
 * state only; the view's shown-at tests come in through LB.init.
 * C: world-space widgets of the engine's UI. */
(function (SS) {
  'use strict';
  const C = SS.CFG, P = SS.plane, M = SS.math, D = SS.dom, EV = C.EV, css = C.css;
  const LB = SS.labels = {};
  let root = null, camera = null, canvas = null, view = null, fuseEl = null, curS = null;
  let eggs = null, xenos = null, sleeps = null, gadgets = null;
  const v3 = new THREE.Vector3();

  const sp = { x: 0, y: 0, front: false };
  // the screen point of a world point into sp (front: in front of the camera)
  function project(x, y, z) {
    const vs = D.view_size(canvas);
    v3.set(x, y, z).project(camera);
    sp.x = (v3.x + 1) / 2 * vs.w;
    sp.y = (1 - v3.y) / 2 * vs.h;
    sp.front = v3.z < 1;
    return sp;
  }

  /* ---------- pops and speech bubbles ---------- */
  /* speech bubbles: a dying worm's last words, a few yelps, a turn opener (original lines) */
  const SAY = {
    die: [
      'Back to the soil…', 'Tell the compost heap I loved it', 'I regret nothing!', 'Make it quick', 'Not like this…',
      'Plant something nice over me'
    ],
    ouch: ['Ow!', 'Hey!', 'That stung', 'My segments!', 'Watch it!', 'Rude.'],
    start: ['My turn!', 'Watch this', 'Steady…', 'Here goes', 'Leave it to me', 'Hold my dirt'],
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
    hugged: ['Mmmph! Get it off!', 'MMPH!!', 'Hmmf! Hmmf!'],
    sick: ['I do not feel so good…', 'Something is moving in my chest', 'Is it hot in here?', 'My tummy hurts…', 'Whoa… dizzy…']
  };
  // a pop lives POP_S (a bubble BUBBLE_S); a damage-over-time tick is skipped within DOT_GAP of the last one
  const POP_S = 1.6, BUBBLE_S = 1.9, DOT_GAP = 0.5;
  /* the floating things over the worms: one array (no DOM query per frame); { el, w, t, dx, bub, dot } */
  const pops = [];
  let popN = 0;
  function dropPop(i) {
    pops[i].el.remove();
    pops.splice(i, 1);
  }
  function addPop(w, t, cls, html, color, dx) {
    const el = D.el('div', cls, html, root);
    if (color) el.style.color = color;
    const p = { el, w, t, dx: dx || 0, bub: false, dot: false };
    pops.push(p);
    return p;
  }
  // a worm says a random line of a kind (one bubble per worm)
  function say(w, kind, arg) {
    for (let i = pops.length - 1; i >= 0; i--)
      if (pops[i].bub && pops[i].w === w) dropPop(i);
    const L = SAY[kind], p = addPop(w, curS ? curS.time : 0, 'pop bubble', null);
    p.el.textContent = L[Math.floor(Math.random() * L.length)].replace('{w}', arg || '');
    p.bub = true;
  }
  /* the ACTIVE worm's bubbles come from its own events (start, fire, pass, pickup); everybody else's only when
   * render/reactq.js lets that worm speak (affected by the attack, one at a time, with its voice and the camera) */
  function react(S, it) {
    const w = S.worms[it.wid];
    if (
      w
      && it.kind
      && !(w.dead && it.kind !== 'die')
      && (it.kind === 'die' || it.kind === 'shock' || it.kind === 'fall' || Math.random() < 0.7)
    ) say(w, it.kind);
  }
  /* a damage number in the hurt worm's team colour, bigger for hard hits (>= 30) and crits (>= 60), small for burning
   * / poison ticks; neighbours spread sideways */
  function damagePop(S, e) {
    const amt = Math.round(e.amount);
    if (!(amt > 0)) return;
    if (e.dot)
      for (let i = pops.length - 1; i >= 0; i--)
        if (pops[i].dot && pops[i].w === e.worm && S.time - pops[i].t < DOT_GAP) return;
    const cls = 'pop' + (e.dot ? ' dot' : amt >= 60 ? ' crit' : amt >= 30 ? ' big' : '');
    const p = addPop(
      e.worm,
      S.time,
      cls,
      '<span class="pn">-' + amt + '</span>',
      css(C.TEAMS[e.worm.team].rgb),
      ((popN++ % 3) - 1) * 24 * D.unit()
    );
    p.dot = !!e.dot;
  }
  function gainPop(S, e) {
    const what = e.kind === 'health'
      ? '+' + e.amount
      : e.kind === 'tool'
      ? (C.SKILL.NAMES[e.tool] || 'Tool')
      : C.ARSENAL[e.weapon].name;
    addPop(
      e.worm,
      S.time,
      'pop gain',
      '<span class="pn">' + D.esc(what) + '</span>',
      e.kind === 'health' ? '#79d98b' : e.kind === 'tool' ? '#9fe8ff' : '#ffb02e'
    );
  }
  LB.onEvent = function (S, e) {
    curS = S;
    const a = S.active, own = e.worm && a && e.worm.id === a.id;
    switch (e.type) {
      case EV.TURN:
        if (own) say(e.worm, 'start');
        break;
      case EV.FIRE:
        if (a && Math.random() < 0.3) say(a, 'fire');
        break;
      case EV.USE:
        if (e.weapon === 'skip' && a) say(a, 'pass');
        break;
      case EV.PICKUP:
        if (own) say(e.worm, e.kind === 'health' ? 'health' : 'crate', e.weapon && C.ARSENAL[e.weapon] ? C.ARSENAL[e.weapon].name : '');
        if (e.worm) gainPop(S, e);
        break;
      case EV.HUGGER_ATTACH:
        if (e.worm && !e.worm.dead) say(e.worm, 'hugged');
        break;
      case EV.HUGGER_DETACH:
        if (e.worm && !e.worm.dead) say(e.worm, 'sick');
        break;
      case EV.HURT:
        if (e.worm) damagePop(S, e);
        break;
      // the life jacket inflated: a small orange label over the worm (no bubble: the voice rules)
      case EV.JACKET:
        if (e.worm) addPop(e.worm, S.time, 'pop gain', '<span class="pn">LIFE JACKET</span>', '#ffa24a');
        break;
      case EV.RESET:
        LB.clear();
        break;
    }
  };
  function drawPops(S) {
    const u = D.unit();
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i], age = S.time - p.t, w = p.w.pos;
      if (age > (p.bub ? BUBBLE_S : POP_S) || age < 0) {
        dropPop(i);
        continue;
      }
      if (p.bub) {
        project(w.x, w.y + 1.25, w.z);
        D.place(p.el, sp.x, sp.y - 58 * u, D.ABOVE);
        D.style(p.el, 'opacity', String(Math.min(1, (BUBBLE_S - age) * 3)));
        continue;
      }
      project(w.x, w.y + 1.5 + age * 0.8, w.z);
      D.place(p.el, sp.x + p.dx, sp.y, D.ABOVE);
      D.style(p.el, 'opacity', String(age < 1 ? 1 : Math.max(0, 1 - (age - 1) / 0.6)));
    }
  }

  /* ---------- the worms ---------- */
  const wl = new Map(); // worm -> label
  function wormLabel(w) {
    let L = wl.get(w);
    if (!L) {
      const el = D.el(
        'div',
        'wlabel',
        '<span class="nm"></span><span class="off"></span><div class="hpbar"><i></i></div><b class="hpn"></b><span class="inf"></span>',
        root
      );
      el.style.setProperty('--team', css(C.TEAMS[w.team].rgb));
      L = { el, nm: el.children[0], off: el.children[1], bar: el.children[2].firstChild, hp: el.children[3], inf: el.children[4] };
      wl.set(w, L);
    }
    return L;
  }
  /* the parasite line under a worm's label: a face hugger on, or the infection with the countdown to the next hit
   * (red when that hit kills) */
  const INF = { stage: 0, left: 0, ttd: 0, sev: 0, pulses: 0 };
  const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  function infoLabel(S, w, el) {
    SS.alien.infection(S, w, INF);
    let txt = '', cls = 'inf';
    if (INF.stage === 1) {
      txt = '☣ FACE HUGGER · −' + SS.alien.K.PARA_HP + ' HP in ' + mmss(Math.ceil(INF.left));
      cls += ' hug';
    } else if (INF.stage === 2) {
      const lethal = w.hp <= SS.alien.K.PARA_HP;
      txt = `☣ ${lethal ? 'BURSTING' : '−' + SS.alien.K.PARA_HP + ' HP'} in ${mmss(Math.ceil(INF.left))}`;
      cls += lethal ? ' lethal' : ' sick';
      if (INF.left < 10) cls += ' soon';
    }
    D.text(el, txt);
    D.cls(el, cls);
  }
  // labels of stacked worms never overlap: the later one moves up (placed: the screen points so far)
  const placed = [];
  function drawWorms(S) {
    const a = S.active, insp = M.clamp(S.inspect, 0, 1), u = D.unit();
    placed.length = 0;
    for (const w of S.worms) {
      const L = wormLabel(w), el = L.el;
      if (w.dead || w.eaten) {
        D.show(el, false);
        continue;
      }
      const inSec = view.inSlab(S, w.pos) || w === a, show = inSec || insp > 0.05;
      project(w.pos.x, w.pos.y + 0.85, w.pos.z);
      D.show(el, show && sp.front);
      if (!show) continue;
      D.text(L.nm, w.name);
      infoLabel(S, w, L.inf);
      D.text(L.off, inSec ? '' : ` ${Math.abs(P.to_plane(S, w.pos).t).toFixed(1)} m off`);
      D.style(L.bar, 'width', Math.max(0, Math.min(100, 100 * w.hp / (w.hp0 || 100))) + '%');
      D.text(L.hp, String(Math.max(0, Math.round(w.hp))));
      D.style(el, 'opacity', String(inSec ? 1 : insp));
      let ly = sp.y;
      for (let g = 0; g < 4; g++) {
        let hit = false;
        for (let j = 0; j < placed.length; j += 2)
          if (Math.abs(placed[j] - sp.x) < 84 * u && Math.abs(placed[j + 1] - ly) < 40 * u) {
            ly = placed[j + 1] - 40 * u;
            hit = true;
          }
        if (!hit) break;
      }
      placed.push(sp.x, ly);
      D.place(el, sp.x, ly, D.ABOVE);
      D.flag(el, 'ghost', !inSec);
      D.flag(el, 'active', w === a);
      D.flag(el, 'low', w.hp > 0 && w.hp <= 0.3 * (w.hp0 || 100));
    }
  }
  // the fuse over the first grenade / gas canister in flight
  function drawFuse(S) {
    let g = null;
    for (const p of S.proj)
      if (p.type === 'grenade' || p.type === 'gas') {
        g = p;
        break;
      }
    D.show(fuseEl, !!g);
    if (!g) return;
    const wp = P.to_world(S, g.s, g.y);
    project(wp.x, wp.y + 0.6, wp.z);
    D.text(fuseEl, Math.max(0, g.fuse).toFixed(1));
    D.place(fuseEl, sp.x, sp.y, D.ABOVE);
  }

  /* ---------- the alien: the bar under an opening egg and under the sleeping alien, the alien's own label
   * ---------- */
  const BAR = '<div class="eb"><i></i></div><b></b>';
  function bar(el, pct, color, text, at) {
    D.style(el.firstChild.firstChild, 'width', pct.toFixed(1) + '%');
    D.style(el.firstChild.firstChild, 'background', color);
    D.text(el.lastChild, text);
    D.place(el, sp.x, sp.y, at);
  }
  function drawAlien(S) {
    const A = S.alien;
    let ne = 0, nx = 0, ns = 0;
    if (A && SS.alien) {
      for (const e of A.eggs) {
        if (e.st !== 1) continue;
        const el = eggs.at(ne++), p = SS.alien.egg_progress(S, e), pt = { x: e.x, y: e.y + 0.02, z: e.z };
        project(pt.x, pt.y, pt.z);
        const shown = view.shownAt(S, pt, 0.6) && sp.front;
        D.show(el, shown);
        if (!shown) continue;
        const hue = Math.round(92 - 92 * M.sat((p - 0.72) / 0.28));
        bar(el, p * 100, `hsl(${hue},85%,50%)`, 'EGG ' + Math.floor(p * 100) + '%', D.BELOW);
        D.flag(el, 'ripe', p > 0.92);
      }
      for (const X of A.xenos) {
        const el = xenos.at(nx++);
        // the sleep bar under the curled-up alien (the egg's bar)
        if (X.st === 7) {
          const h7 = X.n[X.n.length >> 1], p7 = M.sat((S.time - X.t0) / SS.alien.K.SLEEP_T), eb = sleeps.at(ns++);
          project(X.home.x, h7.y - 0.1, X.home.z);
          const sh7 = view.shownAt(S, h7, 0.6) && sp.front;
          D.show(eb, sh7);
          if (sh7) {
            const woke = X.wkT - X.t0 < SS.alien.K.SLEEP_T - 0.01 && X.gp === 0;
            bar(
              eb,
              p7 * 100,
              woke ? 'hsl(8,85%,50%)' : 'hsl(205,80%,58%)',
              woke ? 'WAKING!' : 'ZZZ ' + Math.floor(p7 * 100) + '%',
              D.BELOW
            );
          }
        }
        const h = X.n[0];
        project(h.x, h.y + 0.9 * X.size + 0.3, h.z);
        const shown = view.shownAt(S, h, 0.6) && sp.front;
        D.show(el, shown);
        if (!shown) continue;
        D.style(el.children[1].firstChild, 'width', Math.max(0, Math.min(100, 100 * X.hp / X.hpMax)) + '%');
        D.text(el.lastChild, Math.max(0, Math.round(X.hp)) + (X.kills ? ' · ' + X.kills + ' kill' + (X.kills > 1 ? 's' : '') : ''));
        D.place(el, sp.x, sp.y, D.ABOVE);
      }
    }
    eggs.end(ne);
    xenos.end(nx);
    sleeps.end(ns);
  }

  /* ---------- the planted gadgets: the dog's timer, the claymore's arming countdown, the sentry's rounds ---------- */
  function gadget(n, x, y, z, text, cls) {
    const el = gadgets.at(n);
    project(x, y, z);
    D.cls(el, cls);
    D.text(el, text);
    D.show(el, sp.front);
    D.place(el, sp.x, sp.y, D.ABOVE);
  }
  function drawGadgets(S) {
    let n = 0;
    for (const d of S.dogs || []) {
      const wp = P.to_world(S, d.s, d.y);
      gadget(n++, wp.x, wp.y + 0.7, wp.z, Math.max(0, d.life).toFixed(1), 'fuse');
    }
    for (const c of S.claymores || []) {
      const t = c.armAt - S.time;
      if (view.shownAt(S, c.pos, 0.6))
        gadget(n++, c.pos.x, c.pos.y + 0.55, c.pos.z, t > 0 ? 'arms ' + Math.ceil(t) : 'armed', t > 0 ? 'fuse' : 'fuse armed');
    }
    for (const s of S.sentries || [])
      if (s.state === 0 && view.shownAt(S, s.pos, 0.8)) gadget(n++, s.pos.x, s.pos.y + 1.15, s.pos.z, s.ammo + '', 'fuse sentry');
    gadgets.end(n);
  }

  /* host: the labels layer; cam / cv: the camera and the canvas it draws on; v: the view API (render/view.js V.hud:
   * the slab tests inSlab(S, p) / shownAt(S, p, r), react(fn) the reaction queue's listener) */
  LB.init = function (host, cam, cv, v) {
    root = host;
    camera = cam;
    canvas = cv;
    view = v;
    view.react(react);
    fuseEl = D.el('div', 'fuse', null, root);
    eggs = D.pool(root, 'eggbar', BAR);
    sleeps = D.pool(root, 'eggbar', BAR);
    xenos = D.pool(root, 'alabel', '<span class="nm">ALIEN</span><div class="hpbar"><i></i></div><b class="hpn"></b>');
    gadgets = D.pool(root, 'fuse', null);
  };
  LB.draw = function (S) {
    curS = S;
    drawAlien(S);
    drawWorms(S);
    drawPops(S);
    drawFuse(S);
    drawGadgets(S);
  };
  /* drop every worm label, pop and bubble (they hold worm objects: a replay restore or a new game replaces those, the
   * old ones would stay frozen on screen next to the new ones) */
  LB.clear = function () {
    for (const L of wl.values()) L.el.remove();
    wl.clear();
    while (pops.length) dropPop(pops.length - 1);
  };
})(window.SS = window.SS || {});
